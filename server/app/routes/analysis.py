"""Authenticated experiment-local analysis and serial batch conversion.

Nothing here may compete with a run for the disk or the CPU: a job or a batch
is refused while a run is going, and one already going stops (at its next
chunk of events, or before its next conversion) as soon as a run starts.

Workflows are stored in conf/ of the working directory, which is the
experiment's directory: the page's launcher starts the server there
(frontend/src/app/api/server-control), so each experiment keeps its own.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import threading
import time
import uuid

from flask import Blueprint, current_app, jsonify, request

from ..models.run_metadata import RunMetadata
from ..utils.jwt_utils import jwt_required_custom
from ..services import analysis, run_data, analysis_workflows
from ..services.daq_manager import get_daq_manager
from .data import _boards_of

TEST_FLAG = str(os.getenv('TEST_FLAG', '')).strip().lower() in ('1', 'true', 'yes', 'on')
RUN_ACTIVE = 'A run is in progress: analysis and batch conversion wait until it stops, so they never compete with the acquisition.'
RUN_STARTED = 'Stopped: a run started. Run it again when the run has ended.'


def run_active():
    return get_daq_manager(test_flag=TEST_FLAG).is_running()


def stop_reason():
    """Asked by a job between chunks of events."""
    return RUN_STARTED if run_active() else None

bp = Blueprint('analysis', __name__)
_lock = threading.Lock()
_jobs = {}
_batch = {'state': 'idle', 'runs': []}


def metadata_snapshot():
    return {r.run_number: {'run_number': r.run_number, 'complete': r.end_time is not None,
                          'charge_uC': r.accumulated_charge, 'terminal_voltage': r.terminal_voltage,
                          'probe_voltage': r.probe_voltage, 'target_name': r.target_name, 'run_type': r.run_type, 'flag': r.flag,
                          'start_time': r.start_time.isoformat() if r.start_time else None,
                          'end_time': r.end_time.isoformat() if r.end_time else None}
            for r in RunMetadata.query.all()}


def library_path():
    # A single-workflow file of the first version of this page,
    # conf/analysis-workflow.json, is read once as "Previous workflow".
    return Path('conf/analysis-workflows.json')


def payload():
    if request.content_length and request.content_length > 1_000_000:
        raise analysis.AnalysisError('Workflow exceeds the 1 MB limit.')
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        raise analysis.AnalysisError('Expected a JSON object.')
    return body


@bp.errorhandler(analysis.AnalysisError)
def invalid(error):
    return jsonify({'message': str(error)}), 400


@bp.get('/analysis/context')
@jwt_required_custom
def context():
    saved, warning, active = None, None, None
    try:
        library = analysis_workflows.read(library_path())
        active = next((w for w in library['workflows'] if w['id'] == library.get('active_id')), None)
        if active:
            saved = active['graph']
    except analysis.AnalysisError as exc:
        warning = str(exc)
    from ..services.analysis_examples import examples
    identity = f'{Path.cwd()}|{current_app.config["SQLALCHEMY_DATABASE_URI"]}'
    try:
        analysis.root_module(); uproot_missing = None
    except analysis.AnalysisError as exc:
        uproot_missing = str(exc)
    return jsonify({'project_id': hashlib.sha256(identity.encode()).hexdigest()[:16],
                    'project_name': Path.cwd().name, 'catalog': analysis.CATALOG,
                    'examples': examples(), 'workflow': saved, 'active_workflow': {k: v for k, v in active.items() if k != 'graph'} if active else None,
                    'warning': warning, 'uproot_missing': uproot_missing, 'run_active': run_active()})


@bp.get('/analysis/runs')
@jwt_required_custom
def run_formats():
    """Which completed runs this page can analyse, and why not the others."""
    out = {}
    for record in RunMetadata.query.all():
        kind = analysis.run_format(record.run_number)
        converted = bool(run_data.list_files(record.run_number)['root'])
        reason = None
        if kind == 'hdf5' and not converted:
            reason = analysis.SIS3316_REASON
        out[record.run_number] = {'format': kind, 'converted': converted, 'analysable': reason is None, 'reason': reason}
    return jsonify({'runs': out})


@bp.get('/analysis/workflows')
@jwt_required_custom
def workflows():
    data = analysis_workflows.read(library_path())
    return jsonify({'workflows': [{k: v for k, v in w.items() if k != 'graph'}
                                  for w in data['workflows']]})


@bp.post('/analysis/workflows')
@jwt_required_custom
def create_workflow():
    return jsonify(analysis_workflows.save(library_path(), payload())), 201


@bp.put('/analysis/workflows/<ident>')
@jwt_required_custom
def update_workflow(ident):
    return jsonify(analysis_workflows.save(library_path(), payload(), ident))


@bp.post('/analysis/workflows/<ident>/load')
@jwt_required_custom
def load_workflow(ident):
    with analysis_workflows.lock:
        data = analysis_workflows.read(library_path())
        row = next((w for w in data['workflows'] if w['id'] == ident), None)
        if row is None:
            return jsonify({'message': 'Workflow not found.'}), 404
        data['active_id'] = ident
        analysis_workflows.write(library_path(), data)
    return jsonify(row)


@bp.post('/analysis/query')
@jwt_required_custom
def query_runs():
    params = payload()
    known = analysis.CATALOG['load_runs']['params']
    if set(params) - set(known) or any(not isinstance(v, str) for v in params.values()):
        raise analysis.AnalysisError('Invalid query fields.')
    metadata = metadata_snapshot()
    runs = analysis.resolve_runs(params, metadata)
    return jsonify({'runs': runs})


@bp.get('/analysis/runs/<int:run>/schema')
@jwt_required_custom
def schema(run):
    record = RunMetadata.query.filter_by(run_number=run).first()
    if not record or not record.end_time:
        raise analysis.AnalysisError('Select a completed run.')
    if run_data.get_conversion_manager().status(run)['state'] in ('running', 'failed'):
        return jsonify({'message': 'Finish a successful conversion before inspecting this run.'}), 409
    try:
        return jsonify({'files': analysis.inspect_run(run)})
    except (OSError, ValueError, KeyError) as exc:
        raise analysis.AnalysisError(str(exc)) from exc


@bp.post('/analysis/execute')
@jwt_required_custom
def execute():
    if run_active():
        return jsonify({'message': RUN_ACTIVE}), 409
    graph = payload()
    analysis.validate_graph(graph)
    metadata = metadata_snapshot()
    with _lock:
        if _batch['state'] == 'running' or any(j['state'] == 'running' for j in _jobs.values()):
            return jsonify({'message': 'Wait for the current analysis or batch conversion to finish.'}), 409
        while len(_jobs) >= 10:
            del _jobs[next(iter(_jobs))]
        ident = uuid.uuid4().hex
        _jobs[ident] = {'id': ident, 'state': 'running', 'node': None}
    def worker():
        def progress(node):
            with _lock:
                _jobs[ident]['node'] = node
        try:
            result = analysis.execute(graph, metadata, progress, stop_reason)
            # Refuse non-finite output instead of returning invalid JSON.
            json.dumps(result, allow_nan=False)
            with _lock:
                _jobs[ident].update(state='done', result=result)
        except analysis.AnalysisStopped as exc:
            with _lock:
                _jobs[ident].update(state='stopped', message=str(exc))
        except Exception as exc:
            with _lock:
                _jobs[ident].update(state='failed', message=str(exc))
    threading.Thread(target=worker, name='offline-analysis', daemon=True).start()
    return jsonify({'id': ident}), 202


@bp.get('/analysis/jobs/<ident>')
@jwt_required_custom
def job(ident):
    with _lock:
        state = copy.deepcopy(_jobs.get(ident))
    if state is None:
        return jsonify({'message': 'Analysis job expired or server restarted. Run the workflow again.'}), 404
    return jsonify(state)


@bp.get('/analysis/conversions')
@jwt_required_custom
def conversion_status():
    with _lock:
        result = copy.deepcopy(_batch)
    return jsonify(result)


@bp.post('/analysis/conversions')
@jwt_required_custom
def convert_batch():
    if run_active():
        return jsonify({'message': RUN_ACTIVE}), 409
    body = payload()
    runs = analysis.parse_runs(body.get('runs', []))
    metadata = metadata_snapshot()
    manager = run_data.get_conversion_manager()
    if not manager.available():
        return jsonify({'message': 'RUReader is unavailable. Install it or set RUREADER_BIN.'}), 409
    rows, options = [], {}
    for run in runs:
        files = run_data.list_files(run)
        if run not in metadata or not metadata[run]['complete'] or not files['data']:
            raise analysis.AnalysisError(f'Run {run}: conversion requires a completed run with raw data.')
        if analysis.run_format(run) == 'hdf5':
            rows.append({'run': run, 'state': 'skipped', 'message': analysis.SIS3316_REASON})
            continue
        state = manager.status(run)['state']
        if state in ('running', 'failed'):
            raise analysis.AnalysisError(f'Run {run}: conversion is {state}. Check its logbook conversion tab before batching.')
        rows.append({'run': run, 'state': 'skipped' if files['root'] else 'queued',
                     'message': 'Existing ROOT output preserved.' if files['root'] else ''})
        options[run] = {'boards': _boards_of(run)}
    with _lock:
        if _batch['state'] == 'running' or any(j['state'] == 'running' for j in _jobs.values()):
            return jsonify({'message': 'Wait for the current analysis or batch conversion to finish.'}), 409
        _batch.update(state='running', runs=rows)
    def worker():
        try:
            for row in rows:
                if row['state'] == 'skipped':
                    continue
                # A conversion already going finishes (RUReader cannot be
                # paused), but none is started once a run is on.
                if run_active():
                    with _lock:
                        for rest in rows:
                            if rest['state'] == 'queued':
                                rest.update(state='stopped', message=RUN_STARTED)
                    break
                run = row['run']
                # Also cooperate with conversions started from the logbook.
                started, message = manager.start(run, options[run])
                with _lock:
                    row.update(state='running' if started else 'failed', message=message)
                if not started:
                    continue
                while True:
                    state = manager.status(run)
                    if state['state'] != 'running':
                        with _lock:
                            row.update(state=state['state'], message='\n'.join(state.get('log', [])))
                        break
                    time.sleep(0.5)
            with _lock:
                _batch['state'] = ('failed' if any(row['state'] == 'failed' for row in rows)
                                   else 'stopped' if any(row['state'] == 'stopped' for row in rows) else 'done')
        except Exception as exc:
            with _lock:
                for row in rows:
                    if row['state'] in ('queued', 'running'):
                        row.update(state='failed', message=str(exc))
                _batch['state'] = 'failed'
    threading.Thread(target=worker, name='batch-root-conversion', daemon=True).start()
    return jsonify({'state': 'running'}), 202
