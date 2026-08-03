# app/routes/data.py
"""
Read-side API for completed runs — the Data dashboard.

Joins what the database knows about a run (metadata, board snapshot, software
versions) with what is actually on disk (data files, current log, ROOT output),
so a finished run can be inspected, its charge integrated and its data converted
without touching the acquisition path.
"""

import json
import logging
import os

from flask import Blueprint, jsonify, request

from ..models.run_metadata import RunMetadata
from ..utils.jwt_utils import jwt_required_custom
from ..services import run_data
from ..services.run_data import get_conversion_manager

bp = Blueprint('data', __name__)
logger = logging.getLogger(__name__)


def _iso(value):
    return value.isoformat() if value else None


def _summary(run: RunMetadata) -> dict:
    """The row shown in the run list — cheap enough to build for every run."""
    files = run_data.list_files(run.run_number)
    duration = None
    if run.start_time and run.end_time:
        duration = round((run.end_time - run.start_time).total_seconds(), 3)
    return {
        'run_number': run.run_number,
        'start_time': _iso(run.start_time),
        'end_time': _iso(run.end_time),
        'duration_s': duration,
        'run_type': run.run_type,
        'target_name': run.target_name,
        'terminal_voltage': run.terminal_voltage,
        'accumulated_charge': run.accumulated_charge,
        'flag': run.flag,
        'notes': run.notes,
        'sync_mode': run.sync_mode,
        # On-disk state, so the list can show what is actually available.
        'has_data': bool(files['data']),
        'has_current': files['current'] is not None,
        'converted': bool(files['root']),
        'n_data_files': len(files['data']),
        'total_bytes': files['total_bytes'],
        # A run still being taken has no end time yet.
        'complete': run.end_time is not None,
    }


@bp.route('/data/runs', methods=['GET'])
@jwt_required_custom
def list_runs():
    """Every recorded run, newest first."""
    runs = RunMetadata.query.order_by(RunMetadata.run_number.desc()).all()
    return jsonify({
        'runs': [_summary(r) for r in runs],
        # Told once here so the UI can disable conversion up front rather than
        # failing at the click.
        'rureader_available': get_conversion_manager().available() is not None,
    })


@bp.route('/data/runs/<int:run_number>', methods=['GET'])
@jwt_required_custom
def run_detail(run_number):
    """Everything known about one run: database record + what is on disk."""
    run = RunMetadata.query.filter_by(run_number=run_number).first()
    if not run:
        return jsonify({'message': f'Run {run_number} not found'}), 404

    detail = _summary(run)
    detail.update({
        'probe_voltage': run.probe_voltage,
        'user_id': run.user_id,
        # Captured at run start from the CAEN API — model, serial, firmware and
        # the acquisition registers each board actually ran with.
        'board_info': run.get_board_info(),
        'software_versions': run.get_software_versions(),
        'files': run_data.list_files(run_number),
        'directory': run_data.run_dir(run_number),
    })

    # The full per-board register dumps copied into the run directory at start.
    # These are the complete configuration, beyond the key registers in
    # board_info, and are what make the run reproducible.
    detail['board_configs'] = _read_board_configs(run_number, detail['files'])
    return jsonify(detail)


def _read_board_configs(run_number: int, files: dict) -> list:
    """Register dumps stored alongside the data, one entry per board."""
    out = []
    directory = run_data.run_dir(run_number)
    for entry in files['board_config']:
        path = os.path.join(directory, entry['name'])
        try:
            with open(path) as f:
                config = json.load(f)
        except (OSError, ValueError) as e:
            logger.warning(f"Could not read {path}: {e}")
            continue
        registers = config.get('registers', {})
        out.append({
            'file': entry['name'],
            'board': config.get('dgtzs', {}),
            'n_registers': len(registers),
            'registers': registers,
        })
    return out


@bp.route('/data/runs/<int:run_number>/current', methods=['GET'])
@jwt_required_custom
def run_current(run_number):
    """
    The beam current logged during the run, plus the integrated charge.

    `max_points` bounds what is sent for plotting; the integral is always
    computed on every sample regardless.
    """
    if not run_data.run_exists(run_number):
        return jsonify({'message': f'Run {run_number} has no data directory'}), 404
    try:
        max_points = max(100, min(20000, int(request.args.get('max_points', 2000))))
    except (TypeError, ValueError):
        max_points = 2000
    return jsonify(run_data.read_current(run_number, max_points=max_points))


def _boards_of(run_number: int) -> list:
    """The boards this run was taken with, as {name, id} pairs.

    Prefers the snapshot stored in the database; falls back to the register
    dumps in the run directory, whose filenames are '<name>_<id>.json'.
    """
    run = RunMetadata.query.filter_by(run_number=run_number).first()
    if run:
        boards = [
            {'name': b.get('configured_name') or b.get('model_name'), 'id': b.get('board_id')}
            for b in run.get_board_info()
        ]
        boards = [b for b in boards if b['name'] and b['id'] is not None]
        if boards:
            return boards

    out = []
    for entry in run_data.list_files(run_number)['board_config']:
        stem = entry['name'][:-len('.json')]
        name, _, board_id = stem.rpartition('_')
        if name and board_id.isdigit():
            out.append({'name': name, 'id': board_id})
    return out


@bp.route('/data/runs/<int:run_number>/convert', methods=['GET'])
@jwt_required_custom
def conversion_status(run_number):
    """Whether this run has been (or is being) converted to ROOT."""
    return jsonify(get_conversion_manager().status(run_number))


@bp.route('/data/runs/<int:run_number>/convert', methods=['POST'])
@jwt_required_custom
def start_conversion(run_number):
    """Launch RUReader on this run's .caendat files. Returns immediately."""
    options = request.get_json(silent=True) or {}
    # An older RUReader needs the boards named explicitly (-d name id). The run
    # recorded them, so pass them along; a newer build reads them from the file
    # header and ignores this.
    options.setdefault('boards', _boards_of(run_number))
    started, message = get_conversion_manager().start(run_number, options)
    status = get_conversion_manager().status(run_number)
    status['message'] = message
    # 409: nothing is wrong with the request, the run just cannot be converted
    # right now (already running, no data, converter not installed).
    return jsonify(status), (202 if started else 409)
