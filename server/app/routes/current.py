import os
import json

from flask import Blueprint, jsonify, request
from flask_cors import CORS
from app.services.tetramm import tetram_controller

from app import db
from app.models.run_metadata import RunMetadata
from app.utils.jwt_utils import jwt_required_custom

from datetime import datetime

bp = Blueprint('current', __name__)

TEST_FLAG = False

# Default settings
accumulated = 0
total_accumulated = 0
previous_time = 0
current_accumulating_run_number = 0
running = False

# Open conf/settings.json if exists
if( os.path.exists("conf/settings.json") ):
    with open("conf/settings.json") as f:
        settings = json.load(f)
    # If total_accumulated is in settings, set it
    if( "total_accumulated" in settings ):
        total_accumulated = settings["total_accumulated"]

# Initialize TetrAMMController
controller = tetram_controller()
controller.initialize( )

@bp.route('/current/start/<run_number>', methods=['GET'])
@jwt_required_custom
def start_acquisition(run_number):
    global accumulated, running, previous_time, current_accumulating_run_number
    accumulated = 0
    current_accumulating_run_number = int(run_number)
    previous_time = datetime.now().timestamp()
    run = int(run_number)
    print("Starting acquisition for run {}".format(run))
    if( not controller.is_acquiring ):
        return jsonify({"message": "Can not start TetrAMM. Device not initialized"}), 400
    if( not os.path.exists("./data/run{}".format(run)) ):
        os.makedirs("./data/run{}".format(run))
    controller.set_save_data(True, "./data/run{}/".format(run))
    print("Starting acquisition for run {}".format(run))
    running = True
    return jsonify({"message": "Acquisition started"}), 200

@bp.route('/current/stop', methods=['POST'])
@jwt_required_custom
def stop_acquisition():
    global running, current_accumulating_run_number, accumulated
    #if( not controller.is_acquiring):
    #    return jsonify({"message": "Can not stop acquisition. Device not initialized"}), 400
    controller.set_save_data(False, "./")
    running = False
    # Open conf/settings.json if exists
    if( os.path.exists("conf/settings.json") ):
        with open("conf/settings.json") as f:
            settings = json.load(f)
        settings["total_accumulated"] = total_accumulated
        with open("conf/settings.json", "w") as f:
            json.dump(settings, f)

    run_number = current_accumulating_run_number
    run_metadata = RunMetadata.query.filter_by(run_number=run_number).first()
    run_metadata.accumulated_charge = accumulated
    db.session.commit()
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

@bp.route('/current/accumulated', methods=['GET'])
@jwt_required_custom
def get_accumulated():
    global accumulated, previous_time, running, total_accumulated
    return jsonify(accumulated)
    # If not running, return accumulated value
    data = controller.get_data()["0"]
    if( data < 1e-9 ): data = 0
    if( not running ):
        current_time = datetime.now().timestamp()
        total_accumulated += (current_time - previous_time) * data
        previous_time = current_time
        return jsonify(accumulated)
    # If thread dead, reset controller
    if( not controller.check_thread() ):
        controller.reset( )
    current_time = datetime.now().timestamp()
    accumulated += (current_time - previous_time) * data
    total_accumulated += (current_time - previous_time) * data
    previous_time = current_time
    return jsonify(accumulated)

@bp.route('/current/total_accumulated', methods=['GET'])
@jwt_required_custom
def get_total_accumulated():
    return jsonify(total_accumulated)

# Reset total accumulated
@bp.route('/current/reset_total_accumulated', methods=['POST'])
@jwt_required_custom
def reset_total_accumulated():
    global total_accumulated
    total_accumulated = 0
    return jsonify({"message": "Total accumulated reset"}), 200
