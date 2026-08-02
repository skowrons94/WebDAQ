import os
from typing import Dict, Any
from flask import Blueprint, jsonify, request

from ..services.stats_manager import StatsManager
from ..services.daq_manager import get_daq_manager
from ..utils.jwt_utils import jwt_required_custom

bp = Blueprint('stats', __name__)

# Initialize StatsManager with single Graphite client
stats_manager = StatsManager(graphite_host='localhost', graphite_port=80)

# Initialize DAQ manager for accessing save flag
TEST_FLAG = os.getenv('TEST_FLAG', False)
daq_mgr = get_daq_manager(test_flag=TEST_FLAG)

DEBUG = os.getenv('DEBUG', False)

# Configuration Management Endpoints

@bp.route('/stats/graphite_config', methods=['GET'])
@jwt_required_custom
def get_graphite_config():
    """Get current Graphite server configuration."""
    try:
        config = stats_manager.get_config_info()
        return jsonify({
            'graphite_host': config['graphite_host'],
            'graphite_port': config['graphite_port'],
            'graphite_prefix': config['graphite_prefix']
        }), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/stats/graphite_config', methods=['POST'])
@jwt_required_custom
def set_graphite_config():
    """Update Graphite server configuration.

    'graphite_prefix' is optional and independent of host/port: it is the root
    of the metric tree caendaq publishes rates under, and it names the
    experiment ('ancillary.rates.12c12c'), not a board. Sending it alone is
    allowed, so switching campaign does not mean re-entering the server.
    """
    try:
        data = request.get_json()
        graphite_host = data.get('graphite_host')
        graphite_port = data.get('graphite_port')
        graphite_prefix = data.get('graphite_prefix')

        if graphite_prefix is None and (not graphite_host or not graphite_port):
            return jsonify({'error': 'Missing graphite_host or graphite_port'}), 400

        if graphite_host and graphite_port:
            # Update the stats_manager's graphite client
            stats_manager.graphite_client.host = graphite_host
            stats_manager.graphite_client.port = int(graphite_port)
            # IMPORTANT: Update base_url as well since it's cached
            stats_manager.graphite_client.base_url = f"http://{graphite_host}:{int(graphite_port)}"

            # Update the config file
            stats_manager.stats_config['graphite_host'] = graphite_host
            stats_manager.stats_config['graphite_port'] = int(graphite_port)
            stats_manager._save_config(stats_manager.stats_config)

        if graphite_prefix is not None:
            try:
                graphite_prefix = stats_manager.set_graphite_prefix(graphite_prefix)
            except ValueError as e:
                return jsonify({'error': str(e)}), 400

        # Push the new settings to a running acquisition so caendaq's rate
        # publisher retargets immediately (Carbon port from stats.json). Read
        # host back from the config so a prefix-only change keeps the server.
        try:
            from ..services.caen_acquisition import get_caen_acquisition
            get_caen_acquisition(TEST_FLAG).set_graphite(
                stats_manager.stats_config.get('graphite_host', ''),
                prefix=stats_manager.get_graphite_prefix())
        except Exception:
            pass

        return jsonify({'message': 'Graphite configuration updated',
                        'graphite_prefix': stats_manager.get_graphite_prefix()}), 200

    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/stats/sampling', methods=['GET'])
@jwt_required_custom
def get_sampling():
    """Rate sampling cadence, in ms, plus the range the backend accepts.

    'active_interval_ms' is what the RUNNING collector is using, which differs
    from the stored value only in the window between changing the setting and
    starting the next run (or when no run is active, where it is null).
    """
    try:
        sampling = stats_manager.get_sampling()
        try:
            from ..services.caen_acquisition import get_caen_acquisition
            sampling['active_interval_ms'] = get_caen_acquisition(TEST_FLAG).stats_interval()
        except Exception:
            sampling['active_interval_ms'] = None
        return jsonify(sampling), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/stats/sampling', methods=['POST'])
@jwt_required_custom
def set_sampling():
    """Set the rate sampling cadence and apply it to a live run.

    One number drives three things, because caendaq does them in one tick: how
    often rates are recomputed, the window they are averaged over, and how often
    they reach Graphite. It is persisted to conf/stats.json so the next run
    starts with it, AND pushed to a running collector, which applies it to the
    tick already in flight.

    Body: {"stats_interval_ms": 10000, "stats_first_interval_ms": 2000}
    Either field may be sent alone.
    """
    try:
        data = request.get_json(silent=True) or {}
        interval = data.get('stats_interval_ms')
        first = data.get('stats_first_interval_ms')
        if interval is None and first is None:
            return jsonify({'error': 'Missing stats_interval_ms or stats_first_interval_ms'}), 400

        try:
            sampling = stats_manager.set_sampling(interval, first)
        except ValueError as e:
            return jsonify({'error': str(e)}), 400

        # Apply to a live run so the operator sees the page change pace now,
        # rather than only from the next run. Changing only the first-tick pacing
        # has nothing to apply — it is consumed when a collector is created.
        active = None
        if interval is not None:
            try:
                from ..services.caen_acquisition import get_caen_acquisition
                active = get_caen_acquisition(TEST_FLAG).set_stats_interval(
                    sampling['stats_interval_ms'])
            except Exception:
                active = None
        sampling['active_interval_ms'] = active
        return jsonify(sampling), 200

    except Exception as e:
        return jsonify({'error': str(e)}), 500


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
        unit = data.get('unit')

        if not path:
            return jsonify({'error': 'Missing required field: path'}), 400

        if stats_manager.add_path(path, alias, unit):
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
        unit = data.get('unit')

        if stats_manager.update_path(path, alias, enabled, unit):
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
        # Only start stats collection if save data is enabled
        if not daq_mgr.get_save_data():
            return jsonify({'error': 'Cannot start stats collection when save data is disabled'}), 400

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

@bp.route('/stats/connection', methods=['GET'])
@jwt_required_custom
def get_connection_status():
    """
    Is the Graphite server answering?

    The metrics page shows this as a light: without it, a server that is down
    looks exactly like a set of metrics that happen to have no data.
    """
    config = stats_manager.get_config_info()
    try:
        reachable = stats_manager.graphite_client.check_connection()
    except Exception as e:
        return jsonify({
            'reachable': False,
            'host': config.get('graphite_host'),
            'port': config.get('graphite_port'),
            'error': str(e),
        }), 200

    return jsonify({
        'reachable': bool(reachable),
        'host': config.get('graphite_host'),
        'port': config.get('graphite_port'),
        'error': '' if reachable else 'No answer from the Graphite server.',
    }), 200


@bp.route('/stats/browse', methods=['GET'])
@jwt_required_custom
def browse_metrics():
    """
    One level of the Graphite metric tree, for picking metrics instead of
    typing their paths.

    Query parameters:
    - prefix: the branch to open ('' for the root, 'accelerator' for its children)
    - search: match anywhere in the tree instead of walking it level by level

    Returns {'nodes': [{'path', 'is_leaf'}], 'prefix': str}.
    """
    prefix = (request.args.get('prefix') or '').strip('.')
    search = (request.args.get('search') or '').strip()

    try:
        if search:
            # Graphite matches one level at a time, so a free-text search has to
            # be asked for at each depth. Three levels covers the trees in use
            # here and keeps this to a few quick queries.
            nodes = []
            seen = set()
            for depth in range(3):
                pattern = '.'.join(['*'] * depth + [f'*{search}*']) if depth else f'*{search}*'
                for node in stats_manager.graphite_client.find_metrics(pattern):
                    if node['path'] not in seen:
                        seen.add(node['path'])
                        nodes.append(node)
            nodes.sort(key=lambda n: n['path'])
            return jsonify({'nodes': nodes, 'prefix': ''}), 200

        query = f'{prefix}.*' if prefix else '*'
        return jsonify({
            'nodes': stats_manager.graphite_client.find_metrics(query),
            'prefix': prefix,
        }), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


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