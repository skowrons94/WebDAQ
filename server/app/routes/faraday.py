import requests
from flask import Blueprint, jsonify, request

bp = Blueprint('faraday', __name__)

# URL to the Arduino
FC_API = 'http://192.168.0.30/'

@bp.route('/faraday/open', methods=['GET'])
def open_fc():
    results = requests.get(f'{FC_API}on/1')    
    if results.status_code == 200:
        return jsonify({'success': True}), 200
    else:
        return jsonify({'error': 'Failed to open Faraday cup'}), 500

@bp.route('/faraday/close', methods=['GET'])
def close_fc():
    results = requests.get(f'{FC_API}off/1')    
    if results.status_code == 200:
        return jsonify({'success': True}), 200
    else:
        return jsonify({'error': 'Failed to close Faraday cup'}), 500