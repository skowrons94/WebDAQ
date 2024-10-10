from flask import Blueprint, jsonify, request
from flask_cors import CORS
from app.services.tetramm import TetrAMMController
import threading
import time
from collections import deque
from datetime import datetime, timedelta

from app.utils.jwt_utils import jwt_required_custom

TEST_FLAG = False

bp = Blueprint('current', __name__)

# Default settings
save_data = False
n_channels = 1
rng = 1

# Initialize TetrAMMController
controller = TetrAMMController()
if( not TEST_FLAG ): 
    controller.connect()
    controller.set_setting('RNG', rng)
    controller.set_setting('CHN', n_channels)
    controller.set_setting('ASCII', 'OFF')
    controller.set_setting('TRG', 'OFF')

# Initialize data buffer
buffer_lock = threading.Lock()
data_buffer = deque(maxlen=86400)  # Store 1 value per second for a day

# Global variables
acquisition_thread = None
is_acquiring = False

def acquisition_loop():
    global is_acquiring
    while is_acquiring:
        data = controller.get_data()
        if data:
            timestamp = datetime.now().isoformat()
            with buffer_lock:
                data_buffer.append((timestamp, sum(data) / len(data)))  # Store average of all channels
        time.sleep(1)  # Wait for 1 second before next acquisition

@bp.route('/current/start_acquisition', methods=['POST'])
def start_acquisition():
    global is_acquiring, acquisition_thread
    if not is_acquiring:
        is_acquiring = True
        controller.start_acquisition()
        acquisition_thread = threading.Thread(target=acquisition_loop)
        acquisition_thread.start()
        return jsonify({"message": "Acquisition started"}), 200
    return jsonify({"message": "Acquisition already running"}), 400

@bp.route('/current/stop_acquisition', methods=['POST'])
@jwt_required_custom
def stop_acquisition():
    global is_acquiring, acquisition_thread
    if is_acquiring:
        is_acquiring = False
        controller.stop_acquisition()
        if acquisition_thread:
            acquisition_thread.join()
        return jsonify({"message": "Acquisition stopped"}), 200
    return jsonify({"message": "No acquisition running"}), 400

@bp.route('/current/get_data', methods=['GET'])
@jwt_required_custom
def get_data():
    with buffer_lock:
        return jsonify(list(data_buffer)), 200

@bp.route('/current/get_latest_data', methods=['GET'])
@jwt_required_custom
def get_latest_data():
    with buffer_lock:
        if data_buffer:
            return jsonify(data_buffer[-1]), 200
        else:
            return jsonify({"message": "No data available"}), 404

@bp.route('/current/set_setting', methods=['POST'])
@jwt_required_custom
def set_setting():
    setting = request.json.get('setting')
    value = request.json.get('value')
    if setting and value:
        response = controller.set_setting(setting, value)
        return jsonify({"message": "Setting updated", "response": response.decode()}), 200
    return jsonify({"message": "Invalid request"}), 400

@bp.route('/current/get_setting', methods=['GET'])
@jwt_required_custom
def get_setting():
    setting = request.args.get('setting')
    if setting:
        response = controller.get_setting(setting)
        return jsonify({"setting": setting, "value": response.decode()}), 200
    return jsonify({"message": "Invalid request"}), 400

@bp.route('/current/reset', methods=['POST'])
@jwt_required_custom
def reset():
    global is_acquiring, acquisition_thread
    if is_acquiring:
        is_acquiring = False
        controller.stop_acquisition()
        if acquisition_thread:
            acquisition_thread.join()
    controller.reset()
    return jsonify({"message": "Controller reset"}), 200

@bp.route('/current/set_save_data', methods=['POST'])
@jwt_required_custom
def set_save_data():
    global save_data
    save_data = request.json.get('save_data')
    save_folder = request.json.get('save_folder', '')
    if save_data is not None:
        controller.set_save_data(save_data, save_folder)
        return jsonify({"message": f"Save data set to {save_data}"}), 200
    return jsonify({"message": "Invalid request"}), 400

@bp.route('/current/get_save_data', methods=['GET'])
@jwt_required_custom
def get_save_data():
    global save_data
    return jsonify({"save_data": save_data}), 200

@bp.route('/current/get_channels', methods=['GET'])
@jwt_required_custom
def get_channels():
    global n_channels
    return jsonify({"n_channels": n_channels}), 200

@bp.route('/current/set_channels', methods=['POST'])
@jwt_required_custom
def set_channels():
    global n_channels
    n_channels = request.json.get('n_channels')
    if n_channels:
        response = controller.set_setting('CHN', n_channels)
        return jsonify({"message": "Channels updated", "response": response.decode()}), 200
    return jsonify({"message": "Invalid request"}), 400

@bp.route('/current/get_rng', methods=['GET'])
@jwt_required_custom
def get_rng():
    global rng
    return jsonify({"rng": rng}), 200

@bp.route('/current/set_rng', methods=['POST'])
@jwt_required_custom
def set_rng():
    global rng
    rng = request.json.get('rng')
    if rng:
        response = controller.set_setting('RNG', rng)
        return jsonify({"message": "Range updated", "response": response.decode()}), 200
    return jsonify({"message": "Invalid request"}), 400