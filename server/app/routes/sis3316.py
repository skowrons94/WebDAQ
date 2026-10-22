"""
Routes for Struck SIS3316 boards: settings, board info and the board's own
utilities (on-board energy histograms, trigger statistic counters, the last
trapezoid/MAW trace), plus probing an address before adding a board.

CAEN boards keep using /digitizer/...; these routes refuse any board that is
not an SIS3316.
"""

import os

import numpy as np
from flask import Blueprint, jsonify, request

from app.utils.jwt_utils import jwt_required_custom

from ..services.daq_manager import get_daq_manager
from ..services.sis3316_acquisition import (DEFAULT_HOST, VENDOR, get_sis3316_acquisition,
                                            is_sis3316)
from ..services.spy_manager import get_spy_manager

TEST_FLAG = str(os.getenv('TEST_FLAG', '')).strip().lower() in ('1', 'true', 'yes', 'on')

bp = Blueprint('sis3316', __name__)

daq_mgr = get_daq_manager(test_flag=TEST_FLAG)
spy_mgr = get_spy_manager(test_flag=TEST_FLAG)
sis = get_sis3316_acquisition(test_flag=bool(TEST_FLAG))

STATISTIC_NAMES = ("internal", "hit", "deadtime", "pileup", "veto", "high_energy")


def _board(board_id):
    board = daq_mgr.find_board_with_id(board_id)
    if board is None:
        return None, (jsonify({'error': f'No board with id {board_id}'}), 404)
    if not is_sis3316(board):
        return None, (jsonify({'error': f'Board {board_id} is not an SIS3316'}), 400)
    return board, None


def _root_json(name, arr, empty_reason):
    hist = spy_mgr.ru_spy._build(name, arr, nbins=(len(arr) if arr is not None and len(arr) else None),
                                 empty_reason=empty_reason)
    return spy_mgr.convert_histogram_to_json(hist)


@bp.route('/sis3316/probe', methods=['POST'])
@jwt_required_custom
def probe():
    """Identify the SIS3316 at an address without adding it."""
    host = str((request.get_json(silent=True) or {}).get('host') or DEFAULT_HOST).strip()
    configured = next((b for b in daq_mgr.get_boards()
                       if is_sis3316(b) and str(b.get('link_num')) == host), None)
    if configured is None and daq_mgr.is_running():
        return jsonify({'error': 'Cannot probe a new board while a run is in progress.'}), 409
    board = configured or {'id': -1, 'name': 'SIS3316', 'vendor': VENDOR, 'link_num': host}
    try:
        info = sis.identify(board, daq_mgr.get_boards())
    except Exception as e:
        return jsonify({'error': f'No SIS3316 answered at {host}: {e}'}), 404
    finally:
        if configured is None:
            sis.forget(-1)
    info['already_configured'] = configured is not None
    return jsonify(info)


@bp.route('/sis3316/<board_id>/info', methods=['GET'])
@jwt_required_custom
def info(board_id):
    board, err = _board(board_id)
    if err:
        return err
    try:
        return jsonify(sis.identify(board, daq_mgr.get_boards()))
    except Exception as e:
        return jsonify({'error': f'SIS3316 {board_id} did not answer: {e}'}), 503


@bp.route('/sis3316/<board_id>/settings', methods=['GET'])
@jwt_required_custom
def get_settings(board_id):
    board, err = _board(board_id)
    if err:
        return err
    import sis3316daq
    return jsonify({
        'settings': sis.load_settings(board),
        'defaults': sis3316daq.default_settings(),
        'clock_choices': sorted(sis3316daq.settings.CLOCK_TABLE),
        'input_ranges': sorted(sis3316daq.settings.GAIN_CODES),
        'running': daq_mgr.is_running(),
    })


@bp.route('/sis3316/<board_id>/settings', methods=['POST'])
@jwt_required_custom
def set_settings(board_id):
    """Save new settings. During a run they reach the board at the next bank
    swap; settings that would change the run file layout are refused (409)."""
    board, err = _board(board_id)
    if err:
        return err
    body = request.get_json(silent=True) or {}
    settings = body.get('settings', body)
    try:
        clean = sis.apply_settings(board, settings, daq_mgr.get_boards())
    except ValueError as e:
        status = 409 if 'while a run is running' in str(e) else 400
        return jsonify({'error': str(e)}), status
    except Exception as e:
        # Not reachable: the settings are still saved for the next run.
        try:
            clean = sis.save_settings(board, settings)
        except ValueError as ve:
            return jsonify({'error': str(ve)}), 400
        return jsonify({'settings': clean, 'applied': False,
                        'warning': f'Saved, but the board was not reached: {e}'}), 200
    return jsonify({'settings': clean, 'applied': True,
                    'online': daq_mgr.is_running()})


@bp.route('/sis3316/<board_id>/onboard_histogram/<int:channel>', methods=['GET'])
@jwt_required_custom
def onboard_histogram(board_id, channel):
    """The board's own 64K-bin energy histogram (bin = max energy / divider).

    ?bins=N reads the first N bins (default 16384); ?format=json returns the
    counts as a list instead of a ROOT histogram."""
    board, err = _board(board_id)
    if err:
        return err
    if not 0 <= channel < 16:
        return jsonify({'error': 'channel must be 0-15'}), 400
    nbins = request.args.get('bins', default=16384, type=int)
    try:
        arr = sis.onboard_histogram(board, channel, nbins, daq_mgr.get_boards())
    except Exception as e:
        return jsonify({'error': f'Could not read the on-board histogram: {e}'}), 503
    if request.args.get('format') == 'json':
        return jsonify({'channel': channel, 'counts': arr.astype(int).tolist(),
                        'entries': int(arr.sum())})
    return _root_json(f"onboard_b{board_id}_ch{channel}", arr.astype(np.float64),
                      f"No counts in the on-board histogram of channel {channel}")


@bp.route('/sis3316/<board_id>/onboard_histogram/clear', methods=['POST'])
@jwt_required_custom
def clear_onboard_histograms(board_id):
    board, err = _board(board_id)
    if err:
        return err
    channels = (request.get_json(silent=True) or {}).get('channels')
    try:
        sis.clear_onboard_histograms(board, channels, daq_mgr.get_boards())
    except Exception as e:
        return jsonify({'error': f'Could not clear the on-board histograms: {e}'}), 503
    return jsonify({'message': 'On-board histograms cleared'})


@bp.route('/sis3316/<board_id>/counters', methods=['GET'])
@jwt_required_custom
def counters(board_id):
    """Trigger statistic counters of the 16 channels (since the run start)."""
    board, err = _board(board_id)
    if err:
        return err
    try:
        data = sis.statistic_counters(board, daq_mgr.get_boards())
    except Exception as e:
        return jsonify({'error': f'Could not read the counters: {e}'}), 503
    return jsonify({'names': list(STATISTIC_NAMES),
                    'channels': [dict(zip(STATISTIC_NAMES, map(int, row))) for row in data]})


@bp.route('/sis3316/<board_id>/maw/<int:channel>', methods=['GET'])
@jwt_required_custom
def maw_trace(board_id, channel):
    """The last recorded MAW (trapezoid) test trace of a channel, as a ROOT
    histogram; needs a MAW test buffer length > 0 in the settings."""
    board, err = _board(board_id)
    if err:
        return err
    idx = sis.local_index(board['id'])
    arr = sis.array(idx, 'maw', channel) if idx is not None else None
    return _root_json(f"maw_b{board_id}_ch{channel}",
                      None if arr is None or not len(arr) else arr.astype(np.float64),
                      "No trapezoid trace — set a MAW test buffer length and start a run")
