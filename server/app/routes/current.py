import os

from flask import Blueprint, jsonify, request
from flask_cors import CORS
from app.services.tetramm import tetram_controller

from app.utils.jwt_utils import jwt_required_custom

from datetime import datetime

bp = Blueprint('current', __name__)

TEST_FLAG = False

# Default settings
accumulated = 0
previous_time = 0
running = False

# Initialize TetrAMMController
controller = tetram_controller()
controller.initialize( )

@bp.route('/current/start/<run_number>', methods=['GET'])
@jwt_required_custom
def start_acquisition(run_number):
    global accumulated, running, previous_time
    accumulated = 0
    previous_time = datetime.now().timestamp()
    run = int(run_number)
    #if( not controller.is_acquiring):
    #    return jsonify({"message": "Can not start acquisition. Device not initialized"}), 400
    if( not os.path.exists("./data/run{}".format(run)) ):
        os.makedirs("./data/run{}".format(run))
    controller.set_save_data(True, "./data/run{}/".format(run))
    running = True
    return jsonify({"message": "Acquisition started"}), 200

@bp.route('/current/stop', methods=['POST'])
@jwt_required_custom
def stop_acquisition():
    global running
    #if( not controller.is_acquiring):
    #    return jsonify({"message": "Can not stop acquisition. Device not initialized"}), 400
    controller.set_save_data(False, "./")
    running = False
    return jsonify({"message": "Acquisition stopped"}), 200

@bp.route('/current/set/<settings>/<value>', methods=['GET'])
@jwt_required_custom
def set_setting(settings, value):
    if( not controller.is_acquiring):
        return jsonify({"message": "Can not set setting. Device not initialized"}), 400
    controller.set_setting(settings, value)
    return jsonify({"message": "Setting set"}), 200

@bp.route('/current/get/<settings>', methods=['GET'])
@jwt_required_custom
def get_setting(settings):
    if( not controller.is_acquiring):
        return jsonify({"message": "Can not get setting. Device not initialized"}), 400
    response = controller.get_setting(settings)
    return jsonify(response)

@bp.route('/current/reset', methods=['POST'])
@jwt_required_custom
def reset_device():
    controller.reset()
    return jsonify({"message": "Device reset"}), 200

@bp.route('/current/data', methods=['GET'])
@jwt_required_custom
def get_data():
    data = controller.get_data()["0"] * 1e5
    return jsonify(data)

@bp.route('/current/accumulated', methods=['GET'])
@jwt_required_custom
def get_accumulated():
    global accumulated, previous_time, running
    if( not running):
        return jsonify(accumulated)
    current_time = datetime.now().timestamp()
    accumulated += (current_time - previous_time) * controller.get_data()['0'] * 1e5
    previous_time = current_time
    return jsonify(accumulated)