"""Authenticated experiment-local analysis and serial batch conversion."""
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
from .data import _boards_of

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


def workflow_path():
    return Path('conf/analysis-workflow.json')


def library_path():
    return workflow_path().with_name('analysis-workflows.json')


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
    path = workflow_path()
    saved, warning = None, None
    if path.exists():
        try:
            saved = json.loads(path.read_text())
        except (OSError, ValueError):
            warning = 'The saved workflow could not be read. Import a backup or save a new workflow.'
    active = None
    try:
        library = analysis_workflows.read(library_path())
        active = next((w for w in library['workflows'] if w['id'] == library.get('active_id')), None)
        if active:
            saved = active['graph']
    except analysis.AnalysisError as exc:
        warning = str(exc)
    from ..services.analysis_examples import examples
    identity = f'{Path.cwd()}|{current_app.config["SQLALCHEMY_DATABASE_URI"]}'
    return jsonify({'project_id': hashlib.sha256(identity.encode()).hexdigest()[:16],
                    'project_name': Path.cwd().name, 'catalog': analysis.CATALOG,
                    'examples': examples(), 'workflow': saved, 'active_workflow': {k: v for k, v in active.items() if k != 'graph'} if active else None, 'warning': warning})


@bp.put('/analysis/workflow')
@jwt_required_custom
def save_workflow():
    graph = payload()
    # Drafts can have unconnected nodes/empty run selectors. Validate at execution.
    if graph.get('version') != 1 or not isinstance(graph.get('nodes'), list) or not isinstance(graph.get('edges'), list):
        raise analysis.AnalysisError('Expected a version 1 workflow with nodes and edges.')
    if len(graph['nodes']) > 50 or len(graph['edges']) > 150:
        raise analysis.AnalysisError('Workflow exceeds node/connection limits.')
    path = workflow_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f'.{uuid.uuid4().hex}.tmp')
    try:
        temporary.write_text(json.dumps(graph, allow_nan=False, indent=2))
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return jsonify({'saved': True})


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
            result = analysis.execute(graph, metadata, progress)
            # Refuse non-finite output instead of returning invalid JSON.
            json.dumps(result, allow_nan=False)
            with _lock:
                _jobs[ident].update(state='done', result=result)
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
                _batch['state'] = 'failed' if any(row['state'] == 'failed' for row in rows) else 'done'
        except Exception as exc:
            with _lock:
                for row in rows:
                    if row['state'] in ('queued', 'running'):
                        row.update(state='failed', message=str(exc))
                _batch['state'] = 'failed'
    threading.Thread(target=worker, name='batch-root-conversion', daemon=True).start()
    return jsonify({'state': 'running'}), 202
