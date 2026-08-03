# app/routes/digitizer.py
import os
import json

from flask import Blueprint, request, jsonify

from ..utils.jwt_utils import jwt_required_custom
from ..services.daq_manager import get_daq_manager
from ..services.board_scanner import get_board_scanner, detect_a4818_pids
from ..utils.safe_registers import safe_register_names

bp = Blueprint('digitizer', __name__)

TEST_FLAG = os.getenv('TEST_FLAG', False)

# Initialize DAQ manager
daq_mgr = get_daq_manager(test_flag=TEST_FLAG)

# Board discovery ("what is plugged in?"), shared process-wide: one scan at a time
scanner = get_board_scanner(test_flag=TEST_FLAG)

# Register map for common settings
register_map = {
    "Invert Input": 1080,
    "Channel Enable Mask": 8120
}

def load_board_config(board_id: str) -> dict:
    """
    Load configuration for a specific board.
    
    Args:
        board_id: Board ID string
        
    Returns:
        Board configuration dictionary
    """
    board_info = daq_mgr.get_board_info(board_id)
    if not board_info:
        return None
    
    filename = f"conf/{board_info['name']}_{board_info['id']}.json"
    try:
        with open(filename, 'r') as f:
            return json.load(f)
    except Exception:
        return None

def save_board_config(board_id: str, config: dict) -> bool:
    """
    Save configuration for a specific board.
    
    Args:
        board_id: Board ID string
        config: Configuration dictionary
        
    Returns:
        True if successful, False otherwise
    """
    board_info = daq_mgr.get_board_info(board_id)
    if not board_info:
        return False
    
    filename = f"conf/{board_info['name']}_{board_info['id']}.json"
    try:
        with open(filename, 'w') as f:
            json.dump(config, f, indent=4)
        return True
    except Exception:
        return False

@bp.route('/digitizer/boards', methods=['GET'])
@jwt_required_custom
def get_boards():
    """Get list of all configured boards."""
    boards = daq_mgr.get_boards()
    if boards is None:
        return jsonify(-1)
    return jsonify(boards)

@bp.route('/digitizer/update', methods=['GET'])
@jwt_required_custom
def update():
    """Force update of board configurations."""
    # DAQ manager automatically keeps configurations up to date
    return jsonify(0)

@bp.route('/digitizer/connectivity', methods=['GET'])
@jwt_required_custom
def get_board_connectivity():
    """Get connectivity status of all boards."""
    try:
        connectivity = daq_mgr.check_board_connectivity()
        return jsonify(connectivity)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@bp.route('/digitizer/scan', methods=['POST'])
@jwt_required_custom
def start_board_scan():
    """
    Scan the links for digitizers.

    Probing opens boards, so it cannot happen during a run: while the DAQ is
    running the boards belong to caendaq, and a probe would either fail or
    disturb the acquisition.
    """
    if daq_mgr.is_running():
        return jsonify({'message': 'Cannot scan for boards while a run is in progress. '
                                   'Stop the run first.'}), 409

    options = request.get_json(silent=True) or {}

    try:
        status = scanner.start(options, daq_mgr.get_boards())
    except ValueError as e:
        # Bad options (an impossible VME range, nothing enabled) — the message
        # says what to change.
        return jsonify({'message': str(e)}), 400
    except RuntimeError as e:
        return jsonify({'message': str(e)}), 409

    return jsonify(status), 202


@bp.route('/digitizer/scan', methods=['GET'])
@jwt_required_custom
def get_board_scan_status():
    """Progress and results of the current or last scan."""
    return jsonify(scanner.get_status())


@bp.route('/digitizer/scan/cancel', methods=['POST'])
@jwt_required_custom
def cancel_board_scan():
    """Stop a running scan after the probe in flight."""
    cancelled = scanner.cancel()
    if not cancelled:
        return jsonify({'message': 'No scan is running.'}), 409
    return jsonify(scanner.get_status())


@bp.route('/digitizer/scan/a4818', methods=['GET'])
@jwt_required_custom
def get_a4818_pids():
    """PIDs of A4818 adapters found on the USB bus, to pre-fill the scan options."""
    return jsonify({'pids': detect_a4818_pids()})


@bp.route('/digitizer/polarity/<id>/<channel>', methods=['GET'])
@jwt_required_custom
def get_polarity(id, channel):
    """Get input polarity setting for a specific channel."""
    key = register_map["Invert Input"]
    key += int(channel) * 100
    key = f"reg_{key}"

    config = load_board_config(id)
    if not config:
        return jsonify(-1)

    try:
        value = config['registers'][key]['value']
        value = int(value, 16)
        value = (value >> 16) & 1
        return jsonify(value)
    except Exception:
        return jsonify(-1)

@bp.route('/digitizer/polarity/<id>/<channel>/<value>', methods=['GET'])
@jwt_required_custom
def set_polarity(id, channel, value):
    """Set input polarity for a specific channel."""
    # Validate input
    if int(value) not in [0, 1]:
        return jsonify(-1)

    key = register_map["Invert Input"]
    key += int(channel) * 100
    key = f"reg_{key}"

    config = load_board_config(id)
    if not config:
        return jsonify(-1)

    try:
        prev_value = config['registers'][key]['value']
        prev_value = int(prev_value, 16)
        new_value = (prev_value & 0xFFFEFFFF) | (int(value) << 16)
        config['registers'][key]['value'] = hex(new_value)
        
        if save_board_config(id, config):
            return jsonify(0)
        else:
            return jsonify(-1)
    except Exception:
        return jsonify(-1)

@bp.route('/digitizer/channel/<id>/<channel>', methods=['GET'])
@jwt_required_custom
def get_channel_enable(id, channel):
    """Get channel enable status."""
    key = register_map["Channel Enable Mask"]
    key = f"reg_{key}"

    config = load_board_config(id)
    if not config:
        return jsonify(-1)

    try:
        value = config['registers'][key]['value']
        value = int(value, 16)
        value = (value >> int(channel)) & 1
        return jsonify(value)
    except Exception:
        return jsonify(-1)

@bp.route('/digitizer/channel/<id>/<channel>/<value>', methods=['GET'])
@jwt_required_custom
def set_channel_enable(id, channel, value):
    """Set channel enable status."""
    # Validate input
    if int(value) not in [0, 1]:
        return jsonify(-1)

    key = register_map["Channel Enable Mask"]
    key = f"reg_{key}"

    config = load_board_config(id)
    if not config:
        return jsonify(-1)

    try:
        prev_value = config['registers'][key]['value']
        prev_value = int(prev_value, 16)
        new_value = (prev_value & ~(1 << int(channel))) | (int(value) << int(channel))
        config['registers'][key]['value'] = hex(new_value)
        
        if save_board_config(id, config):
            return jsonify(0)
        else:
            return jsonify(-1)
    except Exception:
        return jsonify(-1)

@bp.route('/digitizer/<id>/<setting>', methods=['GET'])
@jwt_required_custom
def get_setting(id, setting):
    """Get a generic register setting."""
    key = f"reg_{setting}"

    config = load_board_config(id)
    if not config:
        return jsonify(-1)

    try:
        value = config['registers'][key]['value']
        value = int(value, 16)
        return jsonify(value)
    except Exception:
        return jsonify(-1)

@bp.route('/digitizer/<id>/<setting>/<value>', methods=['GET'])
@jwt_required_custom
def set_setting(id, setting, value):
    """Set a generic register setting."""
    key = f"{setting}"

    config = load_board_config(id)
    if not config:
        return jsonify(-1)
    
    print(f"Setting {key} to {value} for board {id}")

    try:
        # Validate that the register exists
        if key not in config['registers']:
            return jsonify(-1)
        
        # Convert value to hex string
        value_string = hex(int(value))
        config['registers'][key]['value'] = value_string
        
        if save_board_config(id, config):
            return jsonify(0)
        else:
            return jsonify(-1)
    except Exception:
        return jsonify(-1)

@bp.route('/digitizer/<id>/setting/<setting>', methods=['POST'])
@jwt_required_custom
def set_setting_online(id, setting):
    """
    Change a register, optionally writing it straight to the board.

    Without 'online' this is the plain configuration edit: the value lands in
    the board's JSON and takes effect the next time a run configures the board.
    With 'online' the value is *also* written to the board itself, so the effect
    is immediate — the point of tuning while watching a spectrum.

    The configuration is always updated, even when the board write is refused or
    fails, so the two never drift apart: what you see in the tuner is what the
    next run will apply.
    """
    data = request.get_json(silent=True) or {}
    if 'value' not in data:
        return jsonify({'message': 'A value is required.'}), 400

    try:
        value = int(data['value'])
    except (TypeError, ValueError):
        return jsonify({'message': f"'{data['value']}' is not a whole number."}), 400
    if value < 0:
        return jsonify({'message': 'Register values cannot be negative.'}), 400

    online = bool(data.get('online', False))

    config = load_board_config(id)
    if not config or 'registers' not in config:
        return jsonify({'message': 'No register configuration for this board.'}), 404
    if setting not in config['registers']:
        return jsonify({'message': f"Board has no register '{setting}'."}), 404

    register = config['registers'][setting]
    config['registers'][setting]['value'] = hex(value)
    if not save_board_config(id, config):
        return jsonify({'message': 'Could not save the configuration.'}), 500

    result = {'saved': True, 'written': False, 'reason': '', 'via': '',
              'address': register.get('address', ''), 'value': hex(value)}

    if online:
        try:
            address = int(str(register.get('address', '0')), 16)
        except ValueError:
            result['reason'] = 'This register has no usable address in the configuration.'
            return jsonify(result)
        result.update(daq_mgr.write_board_register(str(id), address, value))

    return jsonify(result)


@bp.route('/digitizer/<id>/online_registers', methods=['GET'])
@jwt_required_custom
def get_online_registers(id):
    """
    The registers of this board that may be written while it is acquiring.

    The tuner asks for this once so it can mark which fields are tunable online
    before the operator changes anything, rather than finding out per write.
    """
    board_info = daq_mgr.get_board_info(id)
    if not board_info:
        return jsonify({'message': 'Board not found'}), 404
    dpp = board_info.get('dpp', 'DPP-PSD')
    return jsonify({'dpp': dpp, 'registers': safe_register_names(dpp)})


@bp.route('/digitizer/<id>/info', methods=['GET'])
@jwt_required_custom
def get_board_info(id):
    """Get detailed information about a specific board."""
    board_info = daq_mgr.get_board_info(id)
    if board_info:
        return jsonify(board_info)
    else:
        return jsonify({'message': 'Board not found'}), 404

@bp.route('/digitizer/<id>/config', methods=['GET'])
@jwt_required_custom
def get_full_config(id):
    """Get complete configuration for a board."""
    config = load_board_config(id)
    if config:
        return jsonify(config)
    else:
        return jsonify({'message': 'Configuration not found'}), 404

@bp.route('/digitizer/<id>/config', methods=['POST'])
@jwt_required_custom
def set_full_config(id):
    """Set complete configuration for a board."""
    new_config = request.get_json()
    
    if not new_config:
        return jsonify({'message': 'Invalid configuration'}), 400
    
    if save_board_config(id, new_config):
        return jsonify({'message': 'Configuration updated successfully'})
    else:
        return jsonify({'message': 'Failed to update configuration'}), 500

@bp.route('/digitizer/<id>/registers', methods=['GET'])
@jwt_required_custom
def get_all_registers(id):
    """Get all register values for a board."""
    config = load_board_config(id)
    if not config or 'registers' not in config:
        return jsonify({'message': 'Registers not found'}), 404
    
    # Convert hex values to decimal for easier frontend use
    registers = {}
    for reg_name, reg_data in config['registers'].items():
        try:
            registers[reg_name] = {
                'value_hex': reg_data['value'],
                'value_dec': int(reg_data['value'], 16),
                'name': reg_data.get('name', 'No description'),
                'channel': reg_data.get('channel', 0),
                'address': reg_data.get('address', 'N/A')
            }
        except Exception:
            registers[reg_name] = {
                'value_hex': reg_data['value'],
                'value_dec': 0,
                'name': reg_data.get('name', 'No description'),
                'channel': reg_data.get('channel', 0),
                'address': reg_data.get('address', 'N/A')
            }
    
    return jsonify(registers)

@bp.route('/digitizer/available_settings', methods=['GET'])
@jwt_required_custom
def get_available_settings():
    """Get list of available register settings."""
    return jsonify({
        'common_registers': register_map,
        'description': 'Common digitizer register mappings'
    })