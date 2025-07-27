# app/routes/digitizer.py
import os
import json

from flask import Blueprint, request, jsonify

from ..utils.jwt_utils import jwt_required_custom
from ..services.daq_manager import get_daq_manager

bp = Blueprint('digitizer', __name__)

TEST_FLAG = os.getenv('TEST_FLAG', False)

# Initialize DAQ manager
daq_mgr = get_daq_manager(test_flag=TEST_FLAG)

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
    key = f"reg_{setting}"

    config = load_board_config(id)
    if not config:
        return jsonify(-1)

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
                'description': reg_data.get('description', 'No description')
            }
        except Exception:
            registers[reg_name] = {
                'value_hex': reg_data['value'],
                'value_dec': 0,
                'description': reg_data.get('description', 'No description')
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