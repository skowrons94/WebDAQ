# app/routes/tuning.py
"""
Resolution Tuning API Routes

Provides endpoints for automated resolution tuning of CAEN DPP-PHA digitizer boards.
"""

import os
from flask import Blueprint, request, jsonify
from app.utils.jwt_utils import jwt_required_custom

from ..services.daq_manager import get_daq_manager
from ..services.spy_manager import get_spy_manager
from ..services.resolution_tuner import get_resolution_tuner

TEST_FLAG = os.getenv('TEST_FLAG', False)

bp = Blueprint('tuning', __name__, url_prefix='/tuning')

# Initialize managers
daq_mgr = get_daq_manager(test_flag=TEST_FLAG)
spy_mgr = get_spy_manager(test_flag=TEST_FLAG)
tuner = get_resolution_tuner(daq_mgr, spy_mgr, test_flag=TEST_FLAG)


@bp.route('/start', methods=['POST'])
@jwt_required_custom
def start_tuning():
    """
    Start a new tuning session.

    Request JSON:
        {
            "board_id": "0",
            "channel": 0,
            "parameter_name": "Trapezoid Rise Time",
            "param_min": 100,
            "param_max": 1000,
            "num_steps": 10,
            "run_duration": 30,
            "fit_range_min": 500,
            "fit_range_max": 600
        }

    Returns:
        JSON with session_id or error message
    """
    try:
        data = request.get_json()

        if not data:
            return jsonify({'error': 'No configuration provided'}), 400

        required_fields = [
            'board_id', 'channel', 'parameter_name',
            'param_min', 'param_max', 'num_steps',
            'run_duration', 'fit_range_min', 'fit_range_max'
        ]

        for field in required_fields:
            if field not in data:
                return jsonify({'error': f'Missing required field: {field}'}), 400

        result = tuner.start_tuning(data)

        if 'error' in result:
            return jsonify(result), 400

        return jsonify(result), 200

    except Exception as e:
        return jsonify({'error': f'Failed to start tuning: {str(e)}'}), 500


@bp.route('/stop', methods=['POST'])
@jwt_required_custom
def stop_tuning():
    """
    Stop the current tuning session.

    Returns:
        JSON with status message
    """
    try:
        result = tuner.stop_tuning()

        if 'error' in result:
            return jsonify(result), 400

        return jsonify(result), 200

    except Exception as e:
        return jsonify({'error': f'Failed to stop tuning: {str(e)}'}), 500


@bp.route('/status', methods=['GET'])
@jwt_required_custom
def get_status():
    """
    Get current tuning status.

    Returns:
        JSON with status and session info
    """
    try:
        status = tuner.get_status()
        return jsonify(status), 200

    except Exception as e:
        return jsonify({'error': f'Failed to get status: {str(e)}'}), 500


@bp.route('/data', methods=['GET'])
@jwt_required_custom
def get_data():
    """
    Get data from current tuning session.

    Returns:
        JSON with points and best_point
    """
    try:
        data = tuner.get_current_data()
        return jsonify(data), 200

    except Exception as e:
        return jsonify({'error': f'Failed to get tuning data: {str(e)}'}), 500


@bp.route('/history', methods=['GET'])
@jwt_required_custom
def get_history():
    """
    Get tuning history.

    Query parameters:
        board_id: Optional filter by board ID
        limit: Maximum number of sessions (default 50)

    Returns:
        JSON with list of tuning sessions
    """
    try:
        board_id = request.args.get('board_id')
        limit = int(request.args.get('limit', 50))

        history = tuner.get_history(board_id=board_id, limit=limit)
        return jsonify({'sessions': history}), 200

    except Exception as e:
        return jsonify({'error': f'Failed to get history: {str(e)}'}), 500


@bp.route('/parameters', methods=['GET'])
@jwt_required_custom
def get_parameters():
    """
    Get list of tunable parameters.

    Returns:
        JSON with list of parameter names and addresses
    """
    try:
        parameters = tuner.get_tunable_parameters()
        return jsonify({'parameters': parameters}), 200

    except Exception as e:
        return jsonify({'error': f'Failed to get parameters: {str(e)}'}), 500


@bp.route('/histogram/<board_id>/<channel>', methods=['GET'])
@jwt_required_custom
def get_histogram_preview(board_id, channel):
    """
    Get histogram preview for a board/channel.

    Args:
        board_id: Board ID string
        channel: Channel number

    Returns:
        JSON representation of histogram
    """
    try:
        boards = daq_mgr.get_boards()
        histogram = spy_mgr.get_histogram(board_id, int(channel), boards)
        json_data = spy_mgr.convert_histogram_to_json(histogram)
        return json_data if json_data else ""

    except Exception as e:
        return jsonify({'error': f'Failed to get histogram: {str(e)}'}), 500


@bp.route('/reset_history', methods=['POST'])
@jwt_required_custom
def reset_history():
    """
    Clear all tuning history.

    Returns:
        JSON with status message
    """
    try:
        result = tuner.reset_history()

        if 'error' in result:
            return jsonify(result), 400

        return jsonify(result), 200

    except Exception as e:
        return jsonify({'error': f'Failed to reset history: {str(e)}'}), 500


@bp.route('/session/<session_id>', methods=['GET'])
@jwt_required_custom
def get_session(session_id):
    """
    Get details of a specific tuning session.

    Args:
        session_id: Session ID string

    Returns:
        JSON with session details
    """
    try:
        history = tuner.get_history(limit=1000)

        for session in history:
            if session['session_id'] == session_id:
                return jsonify({'session': session}), 200

        return jsonify({'error': 'Session not found'}), 404

    except Exception as e:
        return jsonify({'error': f'Failed to get session: {str(e)}'}), 500


@bp.route('/boards', methods=['GET'])
@jwt_required_custom
def get_pha_boards():
    """
    Get list of DPP-PHA boards available for tuning.

    Returns:
        JSON with list of boards filtered to DPP-PHA only
    """
    try:
        boards = daq_mgr.get_boards()
        pha_boards = [b for b in boards if b.get('dpp') == 'DPP-PHA']
        return jsonify({'boards': pha_boards}), 200

    except Exception as e:
        return jsonify({'error': f'Failed to get boards: {str(e)}'}), 500
