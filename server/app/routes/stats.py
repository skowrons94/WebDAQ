import os
from typing import Dict, Any
from flask import Blueprint, jsonify, request

from ..services.stats_manager import StatsManager
from ..utils.jwt_utils import jwt_required_custom

bp = Blueprint('stats', __name__)

# Initialize StatsManager with single Graphite client
stats_manager = StatsManager(graphite_host='lunaserver', graphite_port=80)

DEBUG = os.getenv('DEBUG', False)

# Configuration Management Endpoints

@bp.route('/stats/paths', methods=['GET'])
@jwt_required_custom
def get_paths():
    """Get all configured metric paths."""
    try:
        paths = stats_manager.get_paths()
        return jsonify(paths), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/stats/paths', methods=['POST'])
@jwt_required_custom
def add_path():
    """Add a new metric path to the configuration."""
    try:
        data = request.get_json()
        path = data.get('path')
        alias = data.get('alias')

        if not path:
            return jsonify({'error': 'Missing required field: path'}), 400

        if stats_manager.add_path(path, alias):
            return jsonify({'message': 'Path added successfully', 'path': path}), 201
        else:
            return jsonify({'error': 'Failed to add path or path already exists'}), 400
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/stats/paths/<path:path>', methods=['DELETE'])
@jwt_required_custom
def remove_path(path):
    """Remove a metric path from the configuration."""
    try:
        if stats_manager.remove_path(path):
            return jsonify({'message': 'Path removed successfully'}), 200
        else:
            return jsonify({'error': 'Path not found'}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/stats/paths/<path:path>', methods=['PUT'])
@jwt_required_custom
def update_path(path):
    """Update a metric path configuration."""
    try:
        data = request.get_json()
        alias = data.get('alias')
        enabled = data.get('enabled')

        if stats_manager.update_path(path, alias, enabled):
            return jsonify({'message': 'Path updated successfully'}), 200
        else:
            return jsonify({'error': 'Path not found'}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# Run Management Endpoints

@bp.route('/stats/run/<int:run_number>/start', methods=['POST'])
@jwt_required_custom
def start_stats_run(run_number):
    """Start statistics collection for a new run."""
    try:
        if stats_manager.start_run(run_number):
            return jsonify({
                'message': 'Stats collection started',
                'run_number': run_number
            }), 200
        else:
            return jsonify({'error': 'Failed to start stats collection'}), 400
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/stats/run/stop', methods=['POST'])
@jwt_required_custom
def stop_stats_run():
    """Stop statistics collection for current run."""
    try:
        if stats_manager.stop_run():
            return jsonify({'message': 'Stats collection stopped'}), 200
        else:
            return jsonify({'error': 'Not currently collecting stats'}), 400
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/stats/run/status', methods=['GET'])
@jwt_required_custom
def get_stats_run_status():
    """Get current stats collection status."""
    try:
        info = stats_manager.get_config_info()
        return jsonify(info), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# Data Retrieval Endpoints

@bp.route('/stats/metric/<path:metric>', methods=['GET'])
@jwt_required_custom
def get_metric(metric):
    """
    Get data for a specific metric.

    Query parameters:
    - from: Start time (default: '-10s')
    - until: End time (default: 'now')
    """
    try:
        from_time = request.args.get('from', '-10s')
        until_time = request.args.get('until', 'now')

        if DEBUG:
            return jsonify([]), 200

        data = stats_manager.graphite_client.get_data(metric, from_time, until_time)
        return jsonify(data), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/stats/metric/<path:metric>/last', methods=['GET'])
@jwt_required_custom
def get_metric_last_value(metric):
    """Get the last non-null value for a metric."""
    try:
        from_time = request.args.get('from', '-10s')
        value, timestamp = stats_manager.get_last_value(metric, from_time)

        if value is None:
            return jsonify({
                'value': None,
                'timestamp': None
            }), 200

        return jsonify({
            'value': value,
            'timestamp': timestamp.isoformat() if timestamp else None
        }), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# Legacy convenience endpoints for backward compatibility

@bp.route('/stats/terminal_voltage', methods=['GET'])
def get_terminal_voltage():
    """Get terminal voltage (legacy endpoint)."""
    try:
        from_time = request.args.get('from', '-10s')
        until_time = request.args.get('until', 'now')
        data = stats_manager.graphite_client.get_data('accelerator.terminal_voltage', from_time, until_time)
        return jsonify(data), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/stats/extraction_voltage', methods=['GET'])
def get_extraction_voltage():
    """Get extraction voltage (legacy endpoint)."""
    try:
        from_time = request.args.get('from', '-10s')
        until_time = request.args.get('until', 'now')
        data = stats_manager.graphite_client.get_data('accelerator.extraction_voltage', from_time, until_time)
        return jsonify(data), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/stats/column_current', methods=['GET'])
def get_column_current():
    """Get column current (legacy endpoint)."""
    try:
        from_time = request.args.get('from', '-10s')
        until_time = request.args.get('until', 'now')
        data = stats_manager.graphite_client.get_data('accelerator.upcharge_current', from_time, until_time)
        return jsonify(data), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/stats/board_rates', methods=['GET'])
def get_board_rates():
    """Get board total rate (legacy endpoint)."""
    try:
        board_id = request.args.get('board_id')
        board_name = request.args.get('board_name')
        channel = request.args.get('channel')
        from_time = request.args.get('from', '-10s')
        until_time = request.args.get('until', 'now')

        if not all([board_id, board_name, channel]):
            return jsonify({'error': 'Missing required parameters: board_id, board_name, or channel'}), 400

        metric = f'ancillary.rates.{board_name}.ch_{channel}.totalRate'
        data = stats_manager.graphite_client.get_data(metric, from_time, until_time)
        return jsonify(data), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/stats/board_rates_pu', methods=['GET'])
def get_board_rates_pu():
    """Get board pile-up rate (legacy endpoint)."""
    try:
        board_id = request.args.get('board_id')
        board_name = request.args.get('board_name')
        channel = request.args.get('channel')
        from_time = request.args.get('from', '-10s')
        until_time = request.args.get('until', 'now')

        if not all([board_id, board_name, channel]):
            return jsonify({'error': 'Missing required parameters: board_id, board_name, or channel'}), 400

        metric = f'ancillary.rates.{board_name}.ch_{channel}.pileRate'
        data = stats_manager.graphite_client.get_data(metric, from_time, until_time)
        return jsonify(data), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/stats/board_rates_satu', methods=['GET'])
def get_board_rates_satu():
    """Get board saturation rate (legacy endpoint)."""
    try:
        board_id = request.args.get('board_id')
        board_name = request.args.get('board_name')
        channel = request.args.get('channel')
        from_time = request.args.get('from', '-10s')
        until_time = request.args.get('until', 'now')

        if not all([board_id, board_name, channel]):
            return jsonify({'error': 'Missing required parameters: board_id, board_name, or channel'}), 400

        metric = f'ancillary.rates.{board_name}.ch_{channel}.satuRate'
        data = stats_manager.graphite_client.get_data(metric, from_time, until_time)
        return jsonify(data), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/stats/board_rates_lost', methods=['GET'])
def get_board_rates_lost():
    """Get board lost rate (legacy endpoint)."""
    try:
        board_id = request.args.get('board_id')
        board_name = request.args.get('board_name')
        channel = request.args.get('channel')
        from_time = request.args.get('from', '-10s')
        until_time = request.args.get('until', 'now')

        if not all([board_id, board_name, channel]):
            return jsonify({'error': 'Missing required parameters: board_id, board_name, or channel'}), 400

        metric = f'ancillary.rates.{board_name}.ch_{channel}.lostRate'
        data = stats_manager.graphite_client.get_data(metric, from_time, until_time)
        return jsonify(data), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/stats/board_rates_dt', methods=['GET'])
def get_board_rates_dt():
    """Get board dead time (legacy endpoint)."""
    try:
        board_id = request.args.get('board_id')
        board_name = request.args.get('board_name')
        channel = request.args.get('channel')
        from_time = request.args.get('from', '-10s')
        until_time = request.args.get('until', 'now')

        if not all([board_id, board_name, channel]):
            return jsonify({'error': 'Missing required parameters: board_id, board_name, or channel'}), 400

        metric = f'ancillary.rates.{board_name}.ch_{channel}.deadTime'
        data = stats_manager.graphite_client.get_data(metric, from_time, until_time)

        # Convert to percentage
        for i in range(len(data)):
            timestamp, value = data[i]
            if value is not None:
                data[i] = (timestamp, value * 100)

        return jsonify(data), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@bp.errorhandler(404)
def not_found(error):
    return jsonify({'error': 'Not found'}), 404


@bp.errorhandler(500)
def internal_error(error):
    return jsonify({'error': 'Internal server error'}), 500