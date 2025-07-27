import os
import json
import numpy as np

from datetime import datetime
from flask import Blueprint, jsonify, request
from ..utils.tetramm import tetram_controller

from app import db
from ..models.run_metadata import RunMetadata
from ..utils.jwt_utils import jwt_required_custom

bp = Blueprint('current', __name__)

#TEST_FLAG = True
TEST_FLAG = os.getenv('TEST_FLAG', False)

# Default settings
accumulated = 0
previous_time = 0
current_accumulating_run_number = 0
running = False

# Open conf/settings.json if exists
if( os.path.exists("conf/current.json") ):
    with open("conf/current.json") as f:
        settings = json.load(f)
else:
    settings = { "tetramm_ip": "169.254.145.10", "tetramm_port": 10001, "total_accumulated": 0 }

# Initialize TetrAMMController
controller = tetram_controller( ip=settings["tetramm_ip"], port=settings["tetramm_port"] )
#controller.initialize( )

# Set ip and port
@bp.route('/current/set_ip_port/<ip>/<port>', methods=['GET'])
@jwt_required_custom
def set_ip_port(ip, port):
    global settings
    controller.set_ip(ip)
    controller.set_port(int(port))
    settings["tetramm_ip"] = ip
    settings["tetramm_port"] = port
    with open("conf/current.json", "w") as f:
        json.dump(settings, f)
    return jsonify({"message": "IP and port set"}), 200

# Get ip
@bp.route('/current/get_ip', methods=['GET'])
@jwt_required_custom
def get_ip_port():
    global settings
    return jsonify(settings["tetramm_ip"])

# Get port
@bp.route('/current/get_port', methods=['GET'])
@jwt_required_custom
def get_port():
    global settings
    return jsonify(settings["tetramm_port"])

# Connect to TetrAMM
@bp.route('/current/connect', methods=['GET'])
@jwt_required_custom
def connect():
    controller.initialize()
    if( controller.is_connected() ):
        return jsonify({"message": "Connected"}), 200
    return jsonify({"message": "Can not connect to TetrAMM"}), 400

# Check if connected
@bp.route('/current/is_connected', methods=['GET'])
@jwt_required_custom
def is_connected():
    if( controller.is_connected() ):
        return jsonify(True)
    return jsonify(False)

# Start acquisition thread
@bp.route('/current/start/<run_number>', methods=['GET'])
@jwt_required_custom
def start_acquisition(run_number):
    global accumulated, running, previous_time, current_accumulating_run_number
    if( not controller.is_connected() ):
        return jsonify({"message": "TetrAMM not connected"}), 200
    accumulated = 0
    current_accumulating_run_number = int(run_number)
    previous_time = datetime.now().timestamp()
    run = int(run_number)
    if( not controller.is_acquiring ):
        return jsonify({"message": "Can not start TetrAMM. Device not initialized"}), 400
    if( not os.path.exists("./data/run{}".format(run)) ):
        os.makedirs("./data/run{}".format(run))
    controller.set_save_data(True, "./data/run{}/".format(run))
    running = True
    return jsonify({"message": "Acquisition started"}), 200

@bp.route('/current/stop', methods=['POST'])
@jwt_required_custom
def stop_acquisition():
    global running, current_accumulating_run_number, accumulated
    if( not controller.is_connected() ):
        return jsonify({"message": "TetrAMM not connected"}), 200
    controller.set_save_data(False, "./")
    running = False
    run_number = current_accumulating_run_number
    run_metadata = RunMetadata.query.filter_by(run_number=run_number).first()
    run_metadata.accumulated_charge = accumulated
    db.session.commit()
    return jsonify({"message": "Acquisition stopped"}), 200

@bp.route('/current/set/<settings>/<value>', methods=['GET'])
@jwt_required_custom
def set_setting(settings, value):
    if( not controller.is_connected() ):
        return jsonify({"message": "TetrAMM not connected"}), 200
    if( not controller.is_acquiring):
        return jsonify({"message": "Can not set setting. Device not initialized"}), 400
    controller.set_setting(settings, value)
    return jsonify({"message": "Setting set"}), 200

@bp.route('/current/get/<settings>', methods=['GET'])
@jwt_required_custom
def get_setting(settings):
    if( not controller.is_connected() ):
        return jsonify({"message": "TetrAMM not connected"}), 200
    if( not controller.is_acquiring):
        return jsonify({"message": "Can not get setting. Device not initialized"}), 400
    response = controller.get_setting(settings)
    return jsonify(response)

@bp.route('/current/reset', methods=['POST'])
@jwt_required_custom
def reset_device():
    global running
    controller.set_save_data(False, "./")
    controller.reset()
    running = False
    return jsonify({"message": "Device reset"}), 200

@bp.route('/current/data', methods=['GET'])
@jwt_required_custom
def get_data():
    data = controller.get_data()["0"]
    if( data < 1e-9 ): data = 0
    return jsonify(data)

@bp.route('/current/collimator/1', methods=['GET'])
@jwt_required_custom
def get_data_1():
    data = controller.get_data()["1"]
    if( data < 1e-9 ): data = 0
    return jsonify(data)

@bp.route('/current/collimator/2', methods=['GET'])
@jwt_required_custom
def get_data_2():
    data = controller.get_data()["2"]
    if( data < 1e-9 ): data = 0
    return jsonify(data)

@bp.route('/current/data_array', methods=['GET'])
@jwt_required_custom
def get_data_array():
    # Real thing
    data = controller.get_data_array()["0"].tolist()
    # For test: sample 100 points from normal distribution with mean 100 and std 10
    #data = np.random.normal(100, 10, 100)
    #data = data.tolist()
    return jsonify(data)

@bp.route('/current/accumulated', methods=['GET'])
@jwt_required_custom
def get_accumulated():
    global accumulated, previous_time, running, settings
    if( not controller.is_connected() ):
        return jsonify(accumulated)
    data = controller.get_data()["0"]
    if( data < 1e-9 ): data = 0
    if( not running ):
        current_time = datetime.now().timestamp()
        settings["total_accumulated"] += (current_time - previous_time) * data
        previous_time = current_time
        return jsonify(accumulated)
    # If thread dead, reset controller
    if( not controller.check_thread() ):
        controller.reset( )
    current_time = datetime.now().timestamp()
    accumulated += (current_time - previous_time) * data
    settings["total_accumulated"] += (current_time - previous_time) * data
    previous_time = current_time
    return jsonify(accumulated)

@bp.route('/current/total_accumulated', methods=['GET'])
@jwt_required_custom
def get_total_accumulated():
    global settings
    with open("conf/current.json", "w") as f:
        json.dump(settings, f)
    return jsonify(settings["total_accumulated"])

# Reset total accumulated
@bp.route('/current/reset_total_accumulated', methods=['POST'])
@jwt_required_custom
def reset_total_accumulated():
    global settings
    settings["total_accumulated"] = 0
    return jsonify({"message": "Total accumulated reset"}), 200