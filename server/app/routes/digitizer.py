# app/routes/experiment.py
import os
import gc
import csv
import json
import time as time_lib

from datetime import datetime

from flask import Blueprint, request, jsonify, send_from_directory
from app import db
from app.models.run_metadata import RunMetadata
from app.utils.jwt_utils import jwt_required_custom, get_current_user

from app.services.dgtz import digitizer

bp = Blueprint('digitizer', __name__)

register_map = { "Invert Input": 1080 }

daq_state = {}
config = {}

def load():
    daq_state = {}
    if os.path.exists('conf/settings.json'):
        with open('conf/settings.json', 'r') as f: 
                daq_state = json.load(f)
    return daq_state
    
def load_config():
    config = {}
    for board in daq_state['boards']:
        filename = "conf/{}_{}.json".format(board['name'], board['id'])
        with open(filename,'r') as f:
            data = json.load(f)
            config[board['id']] = data
    return config

def save_config(config):
    for board in daq_state['boards']:
        filename = "conf/{}_{}.json".format(board['name'], board['id'])
        with open(filename,'w') as f:
            json.dump(config[board['id']], f, indent=4)
    
daq_state = load()
config = load_config()
    
@bp.route('/digitizer/boards', methods=['GET'])
@jwt_required_custom
def get_boards():
    daq_state = load()
    if daq_state is None:
        return jsonify(-1)
    return jsonify(daq_state['boards'])

@bp.route('/digitizer/update', methods=['GET'])
@jwt_required_custom
def update():
    global daq_state, config
    daq_state = load()
    config = load_config()
    return jsonify(0)

@bp.route('/digitizer/polarity/<id>/<channel>', methods=['GET'])
@jwt_required_custom
def get_polarity( id, channel ):
    key = register_map["Invert Input"]
    key += int(channel) * 100
    key = "reg_{}".format(key)

    conf = config[id]
    try: value = conf['registers'][key]['value']
    except: return jsonify(-1)

    value = int(value, 16)
    value = (value >> 16) & 1

    return jsonify(value)

@bp.route('/digitizer/polarity/<id>/<channel>/<value>', methods=['GET'])
@jwt_required_custom
def set_polarity( id, channel, value ):

    # If value is not 0 or 1, return error
    if int(value) != 0 and int(value) != 1:
        return jsonify(-1)

    key = register_map["Invert Input"]
    key += int(channel) * 100
    key = "reg_{}".format(key)

    conf = config[id]
    try: prev_value = conf['registers'][key]['value']
    except: return jsonify(-1)
    
    prev_value = int(prev_value, 16)
    value = (prev_value & 0xFFFEFFFF) | (int(value) << 16)
    conf['registers'][key]['value'] = hex(value)
    save_config(config)

    return jsonify(0)

@bp.route('/digitizer/<id>/<setting>', methods=['GET'])
@jwt_required_custom
def get_setting( id, setting ):
    key = "reg_{}".format(setting)

    conf = config[id]
    try: value = conf['registers'][key]['value']
    except: return jsonify(-1)

    value = int(value, 16)

    return jsonify(value)

@bp.route('/digitizer/<id>/<setting>/<value>', methods=['GET'])
@jwt_required_custom
def set_setting( id, setting, value ):
    key = "reg_{}".format(setting)

    conf = config[id]
    try: conf['registers'][key]['value']
    except: return jsonify(-1)

    # Convert value in decimal to hex
    value_string = hex(int(value))
    conf['registers'][key]['value'] = str(value_string)
    save_config(config)

    return jsonify(0)