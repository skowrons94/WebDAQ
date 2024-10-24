import os

import numpy as np

from flask import Blueprint, jsonify, request
from app.utils.jwt_utils import jwt_required_custom

bp = Blueprint('calib', __name__)

@bp.route('/calib/get/<board_name>/<board_id>/<channel>', methods=['GET'])
@jwt_required_custom
def get_calib(board_name, board_id, channel):

    if( os.path.exists('calib/' + board_name + '_' + board_id + '.cal') ):
        lines = np.loadtxt('calib/' + board_name + '_' + board_id + '.cal', dtype=float)
        try:
            calib = lines[int(channel)]
            a, b = calib[0], calib[1]
            return jsonify({'status': 'success', 'a': str(a), 'b': str(b)})
        except:
            return jsonify({'status': 'error', 'message': 'Channel not found in calibration file'})
    else:
        return jsonify({'status': 'error', 'message': 'Calibration file not found'})
    
@bp.route('/calib/set/<board_name>/<board_id>/<channel>', methods=['POST'])
@jwt_required_custom
def set_calib(board_name, board_id, channel):
    board_name = request.json['board_name']
    board_id = request.json['board_id']
    channel = request.json['channel']
    a = request.json['a']
    b = request.json['b']
    if( os.path.exists('calib/' + board_name + '_' + board_id + '.cal') ):
        lines = np.loadtxt('calib/' + board_name + '_' + board_id + '.cal', dtype=float)
        try:
            lines[int(channel)][0] = float(a)
            lines[int(channel)][1] = float(b)
            with open('calib/' + board_name + '_' + board_id + '.cal', 'w') as f:
                for line in lines:
                    f.write('{} {}\n'.format(line[0], line[1]))
            return jsonify({'status': 'success'})
        except:
            return jsonify({'status': 'error', 'message': 'Channel not found in calibration file'})
    else:
        return jsonify({'status': 'error', 'message': 'Calibration file not found'})