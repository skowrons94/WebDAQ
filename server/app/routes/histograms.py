# app/routes/histograms.py
import os
from flask import Blueprint, request, jsonify
from app.utils.jwt_utils import jwt_required_custom

from ..services.daq_manager import get_daq_manager
from ..services.spy_manager import get_spy_manager

TEST_FLAG = os.getenv('TEST_FLAG', False)

bp = Blueprint('histograms', __name__)

# Initialize managers
daq_mgr = get_daq_manager(test_flag=TEST_FLAG)
spy_mgr = get_spy_manager(test_flag=TEST_FLAG)

@bp.route('/histograms/rebin', methods=['POST'])
@jwt_required_custom
def set_rebin_factor():
    spy_mgr.set_rebin_factor(request.json.get('factor', 1))
    return jsonify({'message': 'Rebin factor set successfully'}), 200

# Histogram Routes
@bp.route('/histograms/<board_id>/<channel>', methods=['GET'])
@jwt_required_custom
def get_histogram(board_id, channel):
    """
    Get histogram data for a specific board and channel.
    
    Args:
        board_id: Board ID string
        channel: Channel number
        
    Returns:
        JSON representation of histogram or empty string if not available
    """
    try:
        boards = daq_mgr.get_boards()
        histo = spy_mgr.get_histogram(board_id, channel, boards)
        json_data = spy_mgr.convert_histogram_to_json(histo)
        return json_data if json_data else ""
    except Exception as e:
        return jsonify({'error': f'Failed to get histogram: {str(e)}'}), 500

@bp.route('/histograms/<board_id>/<channel>/<histogram_type>', methods=['GET'])
@jwt_required_custom
def get_histogram_by_type(board_id, channel, histogram_type):
    """
    Get specific type of histogram (energy, qlong, qshort).
    
    Args:
        board_id: Board ID string
        channel: Channel number
        histogram_type: Type of histogram ('energy', 'qlong', 'qshort')
        
    Returns:
        JSON representation of histogram or error message
    """
    try:
        boards = daq_mgr.get_boards()
        histo = spy_mgr.get_histogram(board_id, channel, boards, histogram_type=histogram_type)
        json_data = spy_mgr.convert_histogram_to_json(histo)
        return json_data if json_data else ""
    except Exception as e:
        return jsonify({'error': f'Failed to get {histogram_type} histogram: {str(e)}'}), 500

@bp.route('/histograms/<board_id>/<channel>/rebin/<int:rebin_factor>', methods=['GET'])
@jwt_required_custom
def get_histogram_rebinned(board_id, channel, rebin_factor):
    """
    Get histogram with custom rebin factor.
    
    Args:
        board_id: Board ID string
        channel: Channel number
        rebin_factor: Rebin factor (integer)
        
    Returns:
        JSON representation of rebinned histogram
    """
    try:
        boards = daq_mgr.get_boards()
        histo = spy_mgr.get_histogram(board_id, channel, boards, rebin=rebin_factor)
        json_data = spy_mgr.convert_histogram_to_json(histo)
        return json_data if json_data else ""
    except Exception as e:
        return jsonify({'error': f'Failed to get rebinned histogram: {str(e)}'}), 500

# ROI (Region of Interest) Routes
@bp.route('/histograms/<board_id>/<channel>/<int:roi_min>/<int:roi_max>', methods=['GET'])
@jwt_required_custom
def get_roi_histogram(board_id, channel, roi_min, roi_max):
    """
    Get histogram with ROI highlighting.
    
    Args:
        board_id: Board ID string
        channel: Channel number
        roi_min: Minimum ROI value
        roi_max: Maximum ROI value
        
    Returns:
        JSON representation of histogram with ROI
    """
    try:
        boards = daq_mgr.get_boards()
        histo = spy_mgr.get_roi_histogram(board_id, channel, boards, roi_min, roi_max)
        json_data = spy_mgr.convert_histogram_to_json(histo)
        return json_data if json_data else ""
    except Exception as e:
        return jsonify({'error': f'Failed to get ROI histogram: {str(e)}'}), 500

@bp.route('/roi/<board_id>/<channel>/<int:roi_min>/<int:roi_max>', methods=['GET'])
@jwt_required_custom
def get_roi_integral(board_id, channel, roi_min, roi_max):
    """
    Calculate ROI integral for a histogram.
    
    Args:
        board_id: Board ID string
        channel: Channel number
        roi_min: Minimum ROI value
        roi_max: Maximum ROI value
        
    Returns:
        ROI integral value
    """
    try:
        boards = daq_mgr.get_boards()
        integral = spy_mgr.get_roi_integral(board_id, channel, boards, roi_min, roi_max)
        return jsonify(integral)
    except Exception as e:
        return jsonify({'error': f'Failed to calculate ROI integral: {str(e)}'}), 500

@bp.route('/roi/<board_id>/<channel>/<int:roi_min>/<int:roi_max>/rebin/<int:rebin_factor>', methods=['GET'])
@jwt_required_custom
def get_roi_integral_rebinned(board_id, channel, roi_min, roi_max, rebin_factor):
    """
    Calculate ROI integral with custom rebin factor.
    
    Args:
        board_id: Board ID string
        channel: Channel number
        roi_min: Minimum ROI value
        roi_max: Maximum ROI value
        rebin_factor: Rebin factor
        
    Returns:
        ROI integral value
    """
    try:
        boards = daq_mgr.get_boards()
        integral = spy_mgr.get_roi_integral(board_id, channel, boards, roi_min, roi_max, rebin=rebin_factor)
        return jsonify(integral)
    except Exception as e:
        return jsonify({'error': f'Failed to calculate rebinned ROI integral: {str(e)}'}), 500

# Waveform Routes
@bp.route('/waveforms/1/<board_id>/<channel>', methods=['GET'])
@jwt_required_custom
def get_waveform1(board_id, channel):
    """
    Get waveform data (type 1) for a specific board and channel.
    
    Args:
        board_id: Board ID string
        channel: Channel number
        
    Returns:
        JSON representation of waveform
    """
    try:
        boards = daq_mgr.get_boards()
        waveform = spy_mgr.get_waveform(board_id, channel, boards, "wave1")
        json_data = spy_mgr.convert_histogram_to_json(waveform)
        return json_data if json_data else ""
    except Exception as e:
        return jsonify({'error': f'Failed to get waveform1: {str(e)}'}), 500

@bp.route('/waveforms/2/<board_id>/<channel>', methods=['GET'])
@jwt_required_custom
def get_waveform2(board_id, channel):
    """
    Get waveform data (type 2) for a specific board and channel.
    
    Args:
        board_id: Board ID string
        channel: Channel number
        
    Returns:
        JSON representation of waveform
    """
    try:
        boards = daq_mgr.get_boards()
        waveform = spy_mgr.get_waveform(board_id, channel, boards, "wave2")
        json_data = spy_mgr.convert_histogram_to_json(waveform)
        return json_data if json_data else ""
    except Exception as e:
        return jsonify({'error': f'Failed to get waveform2: {str(e)}'}), 500

@bp.route('/waveforms/<waveform_type>/<board_id>/<channel>', methods=['GET'])
@jwt_required_custom
def get_waveform_by_type(waveform_type, board_id, channel):
    """
    Get waveform data by type (wave1 or wave2).
    
    Args:
        waveform_type: Type of waveform ('wave1' or 'wave2')
        board_id: Board ID string
        channel: Channel number
        
    Returns:
        JSON representation of waveform
    """
    try:
        if waveform_type not in ['wave1', 'wave2']:
            return jsonify({'error': 'Invalid waveform type. Use wave1 or wave2.'}), 400
        
        boards = daq_mgr.get_boards()
        waveform = spy_mgr.get_waveform(board_id, channel, boards, waveform_type)
        json_data = spy_mgr.convert_histogram_to_json(waveform)
        return json_data if json_data else ""
    except Exception as e:
        return jsonify({'error': f'Failed to get {waveform_type}: {str(e)}'}), 500

# Waveform Control Routes
@bp.route('/waveforms/activate', methods=['POST'])
@jwt_required_custom
def activate_waveforms():
    """
    Activate waveform recording for all boards.
    
    Returns:
        Success/failure message
    """
    try:
        boards = daq_mgr.get_boards()
        if spy_mgr.activate_waveforms(boards):
            return jsonify({'message': 'Waveforms activated successfully!'}), 200
        else:
            return jsonify({'message': 'Failed to activate waveforms'}), 500
    except Exception as e:
        return jsonify({'error': f'Failed to activate waveforms: {str(e)}'}), 500

@bp.route('/waveforms/deactivate', methods=['POST'])
@jwt_required_custom
def deactivate_waveforms():
    """
    Deactivate waveform recording for all boards.
    
    Returns:
        Success/failure message
    """
    try:
        boards = daq_mgr.get_boards()
        if spy_mgr.deactivate_waveforms(boards):
            return jsonify({'message': 'Waveforms deactivated successfully!'}), 200
        else:
            return jsonify({'message': 'Failed to deactivate waveforms'}), 500
    except Exception as e:
        return jsonify({'error': f'Failed to deactivate waveforms: {str(e)}'}), 500

@bp.route('/waveforms/status', methods=['GET'])
@jwt_required_custom
def get_waveform_status():
    """
    Get current waveform activation status.
    
    Returns:
        Boolean indicating if waveforms are enabled
    """
    try:
        boards = daq_mgr.get_boards()
        status = spy_mgr.get_waveform_status(boards)
        return jsonify(status)
    except Exception as e:
        return jsonify({'error': f'Failed to get waveform status: {str(e)}'}), 500

# Monitoring and Status Routes
@bp.route('/spy/status', methods=['GET'])
@jwt_required_custom
def get_spy_status():
    """
    Get current spy server status.
    
    Returns:
        Spy server status information
    """
    try:
        status = spy_mgr.get_spy_status()
        return jsonify(status)
    except Exception as e:
        return jsonify({'error': f'Failed to get spy status: {str(e)}'}), 500

@bp.route('/histograms/available_types', methods=['GET'])
@jwt_required_custom
def get_available_histogram_types():
    """
    Get list of available histogram types.
    
    Returns:
        List of available histogram types and descriptions
    """
    return jsonify({
        'histogram_types': [
            {'type': 'energy', 'description': 'Energy spectrum (DPP-PHA)'},
            {'type': 'qlong', 'description': 'Long gate charge (DPP-PSD)'},
            {'type': 'qshort', 'description': 'Short gate charge (DPP-PSD)'}
        ],
        'waveform_types': [
            {'type': 'wave1', 'description': 'Primary waveform'},
            {'type': 'wave2', 'description': 'Secondary waveform'}
        ]
    })

@bp.route('/histograms/board/<board_id>/channels', methods=['GET'])
@jwt_required_custom
def get_board_channels(board_id):
    """
    Get available channels for a specific board.
    
    Args:
        board_id: Board ID string
        
    Returns:
        List of available channels and their status
    """
    try:
        board_info = daq_mgr.get_board_info(board_id)
        if not board_info:
            return jsonify({'error': 'Board not found'}), 404
        
        channels = []
        for i in range(board_info.get('chan', 0)):
            channels.append({
                'channel': i,
                'board_id': board_id,
                'board_name': board_info.get('name', 'Unknown'),
                'dpp_type': board_info.get('dpp', 'Unknown')
            })
        
        return jsonify({
            'board_id': board_id,
            'board_info': board_info,
            'channels': channels
        })
    except Exception as e:
        return jsonify({'error': f'Failed to get board channels: {str(e)}'}), 500

@bp.route('/histograms/all_boards/summary', methods=['GET'])
@jwt_required_custom
def get_all_boards_summary():
    """
    Get summary of all boards and their monitoring capabilities.
    
    Returns:
        Summary of all configured boards
    """
    try:
        boards = daq_mgr.get_boards()
        summary = []
        
        for board in boards:
            board_summary = {
                'id': board.get('id'),
                'name': board.get('name'),
                'channels': board.get('chan', 0),
                'dpp_type': board.get('dpp'),
                'link_type': board.get('link_type'),
                'available_histograms': ['energy'] if board.get('dpp') == 'DPP-PHA' else ['qlong', 'qshort', 'psd'],
                'waveforms_available': True
            }
            summary.append(board_summary)
        
        return jsonify({
            'total_boards': len(boards),
            'boards': summary,
            'spy_status': spy_mgr.get_spy_status()
        })
    except Exception as e:
        return jsonify({'error': f'Failed to get boards summary: {str(e)}'}), 500
    
@bp.route('/psd/<board_id>/<channel>', methods=['GET'])
@jwt_required_custom
def get_psd_histogram(board_id, channel):
    """
    Get PSD histogram data for a specific board and channel.
    
    Args:
        board_id: Board ID string
        channel: Channel number
    """
    try:
        boards = daq_mgr.get_boards()
        histo = spy_mgr.get_histogram(board_id, channel, boards, histogram_type='psd')
        histo.RebinX(100)
        json_data = spy_mgr.convert_histogram_to_json(histo)
        return json_data if json_data else ""
    except Exception as e:
        return jsonify({'error': f'Failed to get PSD histogram: {str(e)}'}), 500