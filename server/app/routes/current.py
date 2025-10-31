import os
import json
import numpy as np

from datetime import datetime
from flask import Blueprint, jsonify, request
from ..utils.tetramm import tetram_controller, TetrAMMController
from ..utils.rbd9103 import rbd9103_controller, RBD9103Controller

from app import db
from ..models.run_metadata import RunMetadata
from ..utils.jwt_utils import jwt_required_custom

bp = Blueprint('current', __name__)

#TEST_FLAG = True
TEST_FLAG = os.getenv('TEST_FLAG', False)

# Default settings
current_accumulating_run_number = 0
running = False

# Open conf/current.json if exists, create default if not
if os.path.exists("conf/current.json"):
    with open("conf/current.json") as f:
        settings = json.load(f)
else:
    settings = {
        "module_type": "tetramm",  # "tetramm" or "rbd9103"
        "tetramm_ip": "169.254.145.10",
        "tetramm_port": 10001,
        "rbd9103_port": "/dev/tty.usbserial-A50285BI",
        "rbd9103_baudrate": 57600,
        "rbd9103_high_speed": False,
        "total_accumulated": 0
    }
    os.makedirs("conf", exist_ok=True)
    with open("conf/current.json", "w") as f:
        json.dump(settings, f, indent=2)

# Initialize controllers
tetramm_ctrl = None
rbd9103_ctrl = None
controller = None  # Active controller

# Initialize the selected module
module_type = settings.get("module_type", "tetramm")

if module_type == "tetramm":
    tetramm_ctrl = tetram_controller(ip=settings["tetramm_ip"], port=settings["tetramm_port"])
    tetramm_ctrl.set_total_accumulated_charge(settings.get("total_accumulated", 0))
    # Don't initialize at startup - initialize only when needed
    # This prevents hanging when device is disconnected at startup
    controller = tetramm_ctrl
elif module_type == "rbd9103":
    rbd9103_ctrl = rbd9103_controller
    rbd9103_ctrl.set_port(settings.get("rbd9103_port", "/dev/tty.usbserial-A50285BI"))
    rbd9103_ctrl.set_baudrate(settings.get("rbd9103_baudrate", 57600))
    rbd9103_ctrl.set_high_speed(settings.get("rbd9103_high_speed", False))
    rbd9103_ctrl.set_total_accumulated_charge(settings.get("total_accumulated", 0))
    # Don't initialize at startup - initialize only when needed
    # This prevents hanging when device is disconnected at startup
    controller = rbd9103_ctrl

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
    global running, current_accumulating_run_number
    if( not controller.is_connected() ):
        return jsonify({"message": "TetrAMM not connected"}), 200
    
    # Reset accumulated charge for this new run
    controller.reset_accumulated_charge()
    current_accumulating_run_number = int(run_number)
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
    global running, current_accumulating_run_number
    if( not controller.is_connected() ):
        return jsonify({"message": "TetrAMM not connected"}), 200
    controller.set_save_data(False, "./")
    running = False
    run_number = current_accumulating_run_number
    run_metadata = RunMetadata.query.filter_by(run_number=run_number).first()
    if run_metadata:
        run_metadata.accumulated_charge = controller.get_accumulated_charge()
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
    if( "rbd9103" in settings.get("module_type", "") ):
        data = controller.get_data()
        if( data < 1e-9 ): data = 0
        return jsonify(data)
    else:
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
    if( "rbd9103" in settings.get("module_type", "") ):
        data = controller.get_data_array().tolist()
    else:
        data = controller.get_data_array()["0"].tolist()
    # For test: sample 100 points from normal distribution with mean 100 and std 10
    #data = np.random.normal(100, 10, 100)
    #data = data.tolist()
    return jsonify(data)

@bp.route('/current/accumulated', methods=['GET'])
@jwt_required_custom
def get_accumulated():
    if( not controller.is_connected() ):
        return jsonify(controller.get_accumulated_charge())
    
    # If thread dead, reset controller
    if( not controller.check_thread() ):
        controller.reset( )
    
    # Update accumulated charge in TetrAMM controller
    accumulated_charge = controller.get_accumulated_charge()
    return jsonify(accumulated_charge)

@bp.route('/current/total_accumulated', methods=['GET'])
@jwt_required_custom
def get_total_accumulated():
    global settings
    # Update settings with current total from controller
    settings["total_accumulated"] = controller.get_total_accumulated_charge()
    with open("conf/current.json", "w") as f:
        json.dump(settings, f)
    return jsonify(settings["total_accumulated"])

# Reset total accumulated
@bp.route('/current/reset_total_accumulated', methods=['POST'])
@jwt_required_custom
def reset_total_accumulated():
    global settings
    settings["total_accumulated"] = 0
    controller.set_total_accumulated_charge(0)
    return jsonify({"message": "Total accumulated reset"}), 200

# Get current module type
@bp.route('/current/module_type', methods=['GET'])
@jwt_required_custom
def get_module_type():
    global settings
    return jsonify({"module_type": settings.get("module_type", "tetramm")})

# Set module type (switch between tetramm and rbd9103)
@bp.route('/current/module_type', methods=['POST'])
@jwt_required_custom
def set_module_type():
    global settings, controller, tetramm_ctrl, rbd9103_ctrl, running

    data = request.get_json()
    new_module_type = data.get('module_type')

    if new_module_type not in ['tetramm', 'rbd9103']:
        return jsonify({"error": "Invalid module type. Must be 'tetramm' or 'rbd9103'"}), 400

    if new_module_type == settings.get("module_type"):
        return jsonify({"message": "Module type already set"}), 200

    # Stop current controller if running
    if controller:
        try:
            if running:
                controller.set_save_data(False, "./")
                running = False
            if controller.is_acquiring:
                controller.stop_acquisition()
            controller.disconnect()
        except Exception as e:
            print(f"Error stopping current controller: {e}")

    # Save total accumulated charge before switching
    if controller:
        settings["total_accumulated"] = controller.get_total_accumulated_charge()

    # Update settings
    settings["module_type"] = new_module_type
    with open("conf/current.json", "w") as f:
        json.dump(settings, f, indent=2)

    # Initialize new controller
    try:
        if new_module_type == "tetramm":
            if not tetramm_ctrl:
                tetramm_ctrl = TetrAMMController(
                    ip=settings.get("tetramm_ip", "169.254.145.10"),
                    port=settings.get("tetramm_port", 10001)
                )
            tetramm_ctrl.set_total_accumulated_charge(settings.get("total_accumulated", 0))
            tetramm_ctrl.initialize()
            controller = tetramm_ctrl
        else:  # rbd9103
            if not rbd9103_ctrl:
                rbd9103_ctrl = RBD9103Controller(
                    port=settings.get("rbd9103_port", "/dev/tty.usbserial-A50285BI"),
                    baudrate=settings.get("rbd9103_baudrate", 57600),
                    high_speed=settings.get("rbd9103_high_speed", False)
                )
            rbd9103_ctrl.set_total_accumulated_charge(settings.get("total_accumulated", 0))
            rbd9103_ctrl.initialize()
            controller = rbd9103_ctrl

        return jsonify({"message": f"Switched to {new_module_type}"}), 200

    except Exception as e:
        return jsonify({"error": f"Failed to initialize {new_module_type}: {str(e)}"}), 500

# Get module-specific settings
@bp.route('/current/module_settings', methods=['GET'])
@jwt_required_custom
def get_module_settings():
    global settings

    module_type = settings.get("module_type", "tetramm")
    
    # Safely get controller settings
    controller_settings = {}
    if controller:
        try:
            controller_settings = getattr(controller, 'settings', {})
            if controller_settings is None:
                controller_settings = {}
        except Exception as e:
            print(f"Error accessing controller settings: {e}")
            controller_settings = {}

    if module_type == "tetramm":
        return jsonify({
            "module_type": "tetramm",
            "ip": settings.get("tetramm_ip", "169.254.145.10"),
            "port": settings.get("tetramm_port", 10001),
            "settings": controller_settings
        })
    else:  # rbd9103
        return jsonify({
            "module_type": "rbd9103",
            "port": settings.get("rbd9103_port", "/dev/tty.usbserial-A50285BI"),
            "baudrate": settings.get("rbd9103_baudrate", 57600),
            "high_speed": settings.get("rbd9103_high_speed", False),
            "settings": controller_settings
        })

# Update module-specific settings
@bp.route('/current/module_settings', methods=['POST'])
@jwt_required_custom
def update_module_settings():
    global settings, controller

    data = request.get_json()
    module_type = settings.get("module_type", "tetramm")

    try:
        if module_type == "tetramm":
            # Update TetrAMM settings
            if "ip" in data:
                settings["tetramm_ip"] = data["ip"]
                if controller:
                    controller.set_ip(data["ip"])

            if "port" in data:
                settings["tetramm_port"] = int(data["port"])
                if controller:
                    controller.set_port(int(data["port"]))

            # Update device-specific settings (CHN, RNG, ASCII, etc.)
            if "device_settings" in data:
                for key, value in data["device_settings"].items():
                    if controller:
                        # Always update local settings first (for persistence)
                        if hasattr(controller, 'settings') and key in controller.settings:
                            controller.settings[key] = value
                            
                        # Try to send to device if we have a socket connection
                        device_updated = False
                        try:
                            if hasattr(controller, 'socket') and controller.socket:
                                # Send command to device and let set_setting handle the file save
                                response = controller._send_command(f'{key}:{value}')
                                device_updated = True
                                print(f"TetrAMM setting sent to device: {key}={value}")
                        except Exception as e:
                            print(f"Failed to send setting to device: {e}")
                            
                        # Always save to file (whether device update succeeded or not)
                        try:
                            controller.write_settings()  # Save to tetram.json
                            if not device_updated:
                                print(f"TetrAMM disconnected, saved setting {key}={value} to file only")
                        except Exception as e:
                            print(f"Failed to save settings to file: {e}")

        else:  # rbd9103
            # Update RBD 9103 settings
            if "port" in data:
                settings["rbd9103_port"] = data["port"]
                # Requires reconnection

            if "baudrate" in data:
                settings["rbd9103_baudrate"] = int(data["baudrate"])
                # Requires reconnection

            if "high_speed" in data:
                settings["rbd9103_high_speed"] = bool(data["high_speed"])
                # Requires reconnection

            # Update device-specific settings (range, filter, bias, etc.)
            if "device_settings" in data:
                for key, value in data["device_settings"].items():
                    if controller and controller.is_connected():
                        if key == "range":
                            controller.set_range(value)
                        elif key == "filter":
                            controller.set_filter(value)
                        elif key == "input_mode":
                            controller.set_input_mode(value)
                        elif key == "bias":
                            controller.set_bias(value)

        # Save settings to file
        with open("conf/current.json", "w") as f:
            json.dump(settings, f, indent=2)

        return jsonify({"message": "Settings updated successfully"}), 200

    except Exception as e:
        return jsonify({"error": f"Failed to update settings: {str(e)}"}), 500

# Get comprehensive status including module type
@bp.route('/current/status', methods=['GET'])
@jwt_required_custom
def get_status():
    global settings, controller, running

    if not controller:
        return jsonify({
            "module_type": settings.get("module_type", "tetramm"),
            "connected": False,
            "running": False,
            "acquiring": False,
            "thread_alive": False
        })

    try:
        # Get basic status without calling potentially hanging methods
        module_type = settings.get("module_type", "tetramm")
        
        # Safely check basic controller state without socket operations
        basic_status = {
            "module_type": module_type,
            "running": running,
            "acquiring": getattr(controller, 'is_acquiring', False),
            "thread_alive": False,
            "connected": False,
            "settings": getattr(controller, 'settings', {})
        }
        
        # Safely check thread status
        try:
            if hasattr(controller, 'acquisition_thread') and controller.acquisition_thread:
                basic_status["thread_alive"] = controller.acquisition_thread.is_alive()
        except:
            pass
            
        # Try to get connection status with timeout protection
        try:
            # Only check connection if we have a valid socket/port
            if module_type == "tetramm" and hasattr(controller, 'socket') and controller.socket:
                basic_status["connected"] = True  # Socket exists, assume connected
            elif module_type == "rbd9103" and hasattr(controller, 'serial_port') and controller.serial_port:
                basic_status["connected"] = controller.serial_port.is_open if controller.serial_port else False
        except:
            basic_status["connected"] = False

        return jsonify(basic_status)
        
    except Exception as e:
        print(f"Error getting controller status: {e}")
        # Return default status if controller fails
        return jsonify({
            "module_type": settings.get("module_type", "tetramm"),
            "connected": False,
            "running": False,
            "acquiring": False,
            "thread_alive": False,
            "error": str(e)
        })