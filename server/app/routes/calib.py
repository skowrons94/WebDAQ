# calib.py
"""
Energy calibration of the board channels (E = offset + slope × channel).

The Histograms page calibrates a channel where its spectrum is: it fits peaks
in the raw spectrum, solves the line through them, and saves it, or takes the
two numbers typed in. See services/calibration.py.
"""
import os

import numpy as np
from flask import Blueprint, jsonify, request

from ..services import calibration
from ..services.daq_manager import get_daq_manager
from ..utils.jwt_utils import jwt_required_custom

TEST_FLAG = str(os.getenv('TEST_FLAG', '')).strip().lower() in ('1', 'true', 'yes', 'on')

bp = Blueprint('calib', __name__)


def _board(board_id):
    for b in get_daq_manager(test_flag=TEST_FLAG).get_boards():
        if str(b['id']) == str(board_id):
            return b
    return None


def _channels(board):
    return int(board.get('chan', 16) or 16)


def _run_dir():
    """The directory of the run being saved, where changes are logged; None
    when no run is recording."""
    state = get_daq_manager(test_flag=TEST_FLAG).daq_state
    if state.get('running') and state.get('save'):
        path = f"data/run{state.get('run')}"
        return path if os.path.isdir(path) else None
    return None


@bp.route('/calib/status', methods=['GET'])
@jwt_required_custom
def status():
    """Every channel's coefficients, for the badges on the histogram cards."""
    out = {}
    for b in get_daq_manager(test_flag=TEST_FLAG).get_boards():
        table = calibration.read_table(str(b['name']), str(b['id']), _channels(b))
        out[str(b['id'])] = [{'offset': o, 'slope': s, 'calibrated': calibration.is_calibrated(o, s)}
                             for o, s in table]
    return jsonify(out), 200


@bp.route('/calib/lines', methods=['GET'])
@jwt_required_custom
def lines():
    return jsonify(calibration.REFERENCE_LINES), 200


@bp.route('/calib/<board_id>/<int:channel>', methods=['GET'])
@jwt_required_custom
def get_channel(board_id, channel):
    board = _board(board_id)
    if board is None:
        return jsonify({'error': f'No board {board_id}'}), 404
    offset, slope = calibration.read_table(str(board['name']), str(board['id']),
                                           max(_channels(board), channel + 1))[channel]
    stored = calibration.read_points(str(board['name']), str(board['id'])).get(str(channel), {})
    return jsonify({'offset': offset, 'slope': slope,
                    'calibrated': calibration.is_calibrated(offset, slope),
                    'points': stored.get('points', []), 'updated': stored.get('updated')}), 200


@bp.route('/calib/<board_id>/<int:channel>', methods=['PUT'])
@jwt_required_custom
def put_channel(board_id, channel):
    board = _board(board_id)
    if board is None:
        return jsonify({'error': f'No board {board_id}'}), 404
    payload = request.get_json(silent=True) or {}
    try:
        offset, slope = float(payload['offset']), float(payload['slope'])
    except (KeyError, TypeError, ValueError):
        return jsonify({'error': 'offset and slope must be numbers'}), 400
    points = payload.get('points')
    if points is not None and not isinstance(points, list):
        return jsonify({'error': 'points must be a list'}), 400
    try:
        result = calibration.save(board, channel, offset, slope, points, run_dir=_run_dir())
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    return jsonify(result), 200


@bp.route('/calib/<board_id>/<int:channel>/fit', methods=['POST'])
@jwt_required_custom
def fit(board_id, channel):
    """Fit the peak between xmin and xmax (raw channels) of the live spectrum."""
    board = _board(board_id)
    if board is None:
        return jsonify({'error': f'No board {board_id}'}), 404
    payload = request.get_json(silent=True) or {}
    try:
        xmin, xmax = float(payload['xmin']), float(payload['xmax'])
    except (KeyError, TypeError, ValueError):
        return jsonify({'error': 'xmin and xmax must be numbers'}), 400

    from ..services.caen_acquisition import get_caen_acquisition
    acq = get_caen_acquisition()
    daq, index = acq.get_daq(), acq.board_index(board_id)
    if daq is None or index is None:
        return jsonify({'error': 'No spectrum: start a run with this board'}), 409
    kind = 'qlong' if str(board.get('dpp', '')).upper().endswith('PSD') else 'energy'
    try:
        spectrum = np.asarray(getattr(daq, kind)(index, channel))
        return jsonify(calibration.fit_peak(spectrum, xmin, xmax)), 200
    except ValueError as e:
        return jsonify({'error': str(e)}), 422


@bp.route('/calib/solve', methods=['POST'])
@jwt_required_custom
def solve():
    payload = request.get_json(silent=True) or {}
    try:
        return jsonify(calibration.solve(payload.get('points') or [])), 200
    except (ValueError, KeyError, TypeError) as e:
        return jsonify({'error': str(e)}), 400


# ── The routes of the old calibration page, kept for it ────────────────────

@bp.route('/calib/get/<board_name>/<board_id>/<channel>', methods=['GET'])
@jwt_required_custom
def get_calib(board_name, board_id, channel):
    ch = int(channel)
    offset, slope = calibration.read_table(board_name, board_id, ch + 1)[ch]
    return jsonify({'status': 'success', 'a': str(offset), 'b': str(slope)})


@bp.route('/calib/set/<board_name>/<board_id>/<channel>', methods=['POST'])
@jwt_required_custom
def set_calib(board_name, board_id, channel):
    board = _board(board_id) or {'name': board_name, 'id': board_id, 'chan': 16}
    try:
        calibration.save(board, int(channel), float(request.json['a']), float(request.json['b']),
                         run_dir=_run_dir())
    except (ValueError, KeyError, TypeError) as e:
        return jsonify({'status': 'error', 'message': str(e)})
    return jsonify({'status': 'success'})
