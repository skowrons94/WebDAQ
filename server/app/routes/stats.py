from flask import Blueprint, jsonify, request
from flask_cors import CORS
from app.services.graphite import GraphiteClient
from typing import Dict, Any
import os

bp = Blueprint('stats', __name__)

# Initialize GraphiteClient
GRAPHITE_HOST = 'lunaserver'
GRAPHITE_PORT = 80

client = GraphiteClient(GRAPHITE_HOST, GRAPHITE_PORT)

def get_metric_data(metric: str, from_time: str = '-1h', until_time: str = 'now') -> Dict[str, Any]:
    try:
        data = client.get_data(metric, from_time, until_time)
        return {'success': True, 'data': data}
    except Exception as e:
        return {'success': False, 'error': str(e)}

@bp.route('/stats/terminal_voltage', methods=['GET'])
def get_terminal_voltage():
    from_time = request.args.get('from', '-1h')
    until_time = request.args.get('until', 'now')
    result = get_metric_data('accelerator.terminal_voltage', from_time, until_time)
    if result['success']:
        return jsonify(result['data']), 200
    else:
        return jsonify({'error': result['error']}), 500

@bp.route('/stats/extraction_voltage', methods=['GET'])
def get_extraction_voltage():
    from_time = request.args.get('from', '-1h')
    until_time = request.args.get('until', 'now')
    result = get_metric_data('accelerator.extraction_voltage', from_time, until_time)
    if result['success']:
        return jsonify(result['data']), 200
    else:
        return jsonify({'error': result['error']}), 500

@bp.route('/stats/column_current', methods=['GET'])
def get_column_current():
    from_time = request.args.get('from', '-1h')
    until_time = request.args.get('until', 'now')
    result = get_metric_data('accelerator.upcharge_current', from_time, until_time)
    if result['success']:
        return jsonify(result['data']), 200
    else:
        return jsonify({'error': result['error']}), 500

@bp.route('/stats/board_rates', methods=['GET'])
def get_board_rates():
    board_id = request.args.get('board_id')
    board_name = request.args.get('board_name')
    channel = request.args.get('channel')
    from_time = request.args.get('from', '-1h')
    until_time = request.args.get('until', 'now')

    if not all([board_id, board_name, channel]):
        return jsonify({'error': 'Missing required parameters: board_id, board_name, or channel'}), 400

    metric = f'ancillary.rates.{board_name}.ch_{channel}.totalRate'
    result = get_metric_data(metric, from_time, until_time)
    
    if result['success']:
        return jsonify(result['data']), 200
    else:
        return jsonify({'error': result['error']}), 500
    
@bp.route('/stats/board_rates_pu', methods=['GET'])
def get_board_rates_pu():
    board_id = request.args.get('board_id')
    board_name = request.args.get('board_name')
    channel = request.args.get('channel')
    from_time = request.args.get('from', '-1h')
    until_time = request.args.get('until', 'now')

    if not all([board_id, board_name, channel]):
        return jsonify({'error': 'Missing required parameters: board_id, board_name, or channel'}), 400

    metric = f'ancillary.rates.{board_name}.ch_{channel}.pileRate'
    result = get_metric_data(metric, from_time, until_time)
    
    if result['success']:
        return jsonify(result['data']), 200
    else:
        return jsonify({'error': result['error']}), 500
    
@bp.route('/stats/board_rates_satu', methods=['GET'])
def get_board_rates_satu():
    board_id = request.args.get('board_id')
    board_name = request.args.get('board_name')
    channel = request.args.get('channel')
    from_time = request.args.get('from', '-1h')
    until_time = request.args.get('until', 'now')

    if not all([board_id, board_name, channel]):
        return jsonify({'error': 'Missing required parameters: board_id, board_name, or channel'}), 400

    metric = f'ancillary.rates.{board_name}.ch_{channel}.satuRate'
    result = get_metric_data(metric, from_time, until_time)
    
    if result['success']:
        return jsonify(result['data']), 200
    else:
        return jsonify({'error': result['error']}), 500
    
@bp.route('/stats/board_rates_lost', methods=['GET'])
def get_board_rates_lost():
    board_id = request.args.get('board_id')
    board_name = request.args.get('board_name')
    channel = request.args.get('channel')
    from_time = request.args.get('from', '-1h')
    until_time = request.args.get('until', 'now')

    if not all([board_id, board_name, channel]):
        return jsonify({'error': 'Missing required parameters: board_id, board_name, or channel'}), 400

    metric = f'ancillary.rates.{board_name}.ch_{channel}.lostRate'
    result = get_metric_data(metric, from_time, until_time)
    
    if result['success']:
        return jsonify(result['data']), 200
    else:
        return jsonify({'error': result['error']}), 500
    
@bp.route('/stats/board_rates_dt', methods=['GET'])
def get_board_rates_dt():
    board_id = request.args.get('board_id')
    board_name = request.args.get('board_name')
    channel = request.args.get('channel')
    from_time = request.args.get('from', '-1h')
    until_time = request.args.get('until', 'now')

    if not all([board_id, board_name, channel]):
        return jsonify({'error': 'Missing required parameters: board_id, board_name, or channel'}), 400

    metric = f'ancillary.rates.{board_name}.ch_{channel}.deadTime'
    result = get_metric_data(metric, from_time, until_time)
    
    if result['success']:
        return jsonify(result['data']), 200
    else:
        return jsonify({'error': result['error']}), 500

@bp.errorhandler(404)
def not_found(error):
    return jsonify({'error': 'Not found'}), 404

@bp.errorhandler(500)
def internal_error(error):
    return jsonify({'error': 'Internal server error'}), 500