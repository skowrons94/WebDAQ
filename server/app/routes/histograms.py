# app/routes/histograms.py
import os
from flask import Blueprint, request, jsonify
from app.utils.jwt_utils import jwt_required_custom

from ..services.daq_manager import get_daq_manager
from ..services.spy_manager import get_spy_manager
from ..services import roi_analysis
from ..services.histogram_config import get_histogram_config

TEST_FLAG = os.getenv('TEST_FLAG', False)

bp = Blueprint('histograms', __name__)

# Initialize managers
daq_mgr = get_daq_manager(test_flag=TEST_FLAG)
spy_mgr = get_spy_manager(test_flag=TEST_FLAG)
histogram_config = get_histogram_config()

# Record every run's ROIs into its data directory when it stops.
roi_analysis.register_run_hook()


# ─────────────────────────────────────────────── dashboard configuration
# The dashboard's own state — which histograms exist, their ROIs, their zooms —
# lives here rather than in the browser, so it survives a restart, is the same
# for every operator, and can be recorded with the run.

@bp.route('/histograms/config', methods=['GET'])
@jwt_required_custom
def get_dashboard_config():
    """The whole dashboard: settings and every histogram with its ROIs and zoom."""
    return jsonify(histogram_config.get_config()), 200


@bp.route('/histograms/config', methods=['PUT'])
@jwt_required_custom
def replace_dashboard_config():
    """Replace the whole dashboard. Used for import and for 'reset to defaults'."""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({'error': 'Expected a configuration object'}), 400
    return jsonify(histogram_config.replace_config(payload)), 200


@bp.route('/histograms/config/settings', methods=['PUT'])
@jwt_required_custom
def update_dashboard_settings():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({'error': 'Expected a settings object'}), 400
    return jsonify(histogram_config.update_settings(payload)), 200


@bp.route('/histograms/config/histograms', methods=['POST'])
@jwt_required_custom
def add_dashboard_histogram():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({'error': 'Expected a histogram object'}), 400
    if not str(payload.get('boardId', '')).strip():
        return jsonify({'error': 'A histogram needs a boardId'}), 400
    return jsonify(histogram_config.add_histogram(payload)), 201


@bp.route('/histograms/config/histograms/<histogram_id>', methods=['PUT'])
@jwt_required_custom
def update_dashboard_histogram(histogram_id):
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({'error': 'Expected a histogram object'}), 400
    updated = histogram_config.update_histogram(histogram_id, payload)
    if updated is None:
        return jsonify({'error': f'No histogram {histogram_id}'}), 404
    return jsonify(updated), 200


@bp.route('/histograms/config/histograms/<histogram_id>', methods=['DELETE'])
@jwt_required_custom
def delete_dashboard_histogram(histogram_id):
    if not histogram_config.delete_histogram(histogram_id):
        return jsonify({'error': f'No histogram {histogram_id}'}), 404
    return jsonify({'message': 'Histogram removed'}), 200


@bp.route('/histograms/config/order', methods=['PUT'])
@jwt_required_custom
def reorder_dashboard_histograms():
    payload = request.get_json(silent=True) or {}
    order = payload.get('order')
    if not isinstance(order, list):
        return jsonify({'error': 'Expected {"order": [histogramId, ...]}'}), 400
    return jsonify(histogram_config.reorder([str(value) for value in order])), 200


@bp.route('/histograms/config/histograms/<histogram_id>/zoom', methods=['PUT'])
@jwt_required_custom
def set_dashboard_zoom(histogram_id):
    """
    Store a histogram's zoom.

    Saved rather than broadcast: an operator who leaves the page and comes back
    finds their view where they left it, but a zoom here does not move the plot
    under someone else who has the dashboard open.
    """
    payload = request.get_json(silent=True)
    updated = histogram_config.set_zoom(
        histogram_id, payload if isinstance(payload, dict) else None)
    if updated is None:
        return jsonify({'error': f'No histogram {histogram_id}'}), 404
    return jsonify(updated), 200


@bp.route('/histograms/config/zoom', methods=['DELETE'])
@jwt_required_custom
def clear_dashboard_zoom():
    return jsonify(histogram_config.clear_all_zoom()), 200


@bp.route('/histograms/config/histograms/<histogram_id>/rois', methods=['POST'])
@jwt_required_custom
def add_dashboard_roi(histogram_id):
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({'error': 'Expected an ROI object'}), 400
    roi = histogram_config.add_roi(histogram_id, payload)
    if roi is None:
        return jsonify({'error': f'No histogram {histogram_id}'}), 404
    return jsonify(roi), 201


@bp.route('/histograms/config/histograms/<histogram_id>/rois/<roi_id>', methods=['PUT'])
@jwt_required_custom
def update_dashboard_roi(histogram_id, roi_id):
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({'error': 'Expected an ROI object'}), 400
    roi = histogram_config.update_roi(histogram_id, roi_id, payload)
    if roi is None:
        return jsonify({'error': f'No ROI {roi_id} on histogram {histogram_id}'}), 404
    return jsonify(roi), 200


@bp.route('/histograms/config/histograms/<histogram_id>/rois/<roi_id>', methods=['DELETE'])
@jwt_required_custom
def delete_dashboard_roi(histogram_id, roi_id):
    if not histogram_config.delete_roi(histogram_id, roi_id):
        return jsonify({'error': f'No ROI {roi_id} on histogram {histogram_id}'}), 404
    return jsonify({'message': 'ROI removed'}), 200


@bp.route('/histograms/roi_integrals', methods=['GET'])
@jwt_required_custom
def get_roi_integrals():
    """
    Every configured ROI's integral in one request.

    Replaces one request per ROI per dashboard tick, and — because the spectrum
    is read once per board/channel instead of once per ROI — one spy read per
    channel instead of one per region.

    Pass all=1 to include histograms that are hidden and ROIs that are switched
    off, which is what the run snapshot uses.
    """
    include_all = request.args.get('all') in ('1', 'true', 'yes')
    results = roi_analysis.compute_integrals(
        visible_only=not include_all, enabled_only=not include_all)
    return jsonify({'results': results}), 200


@bp.route('/histograms/run/<int:run_number>/roi_snapshot', methods=['POST'])
@jwt_required_custom
def write_roi_snapshot(run_number):
    """Write a run's roi.json now, rather than waiting for the run to end."""
    path = roi_analysis.write_run_snapshot(run_number)
    if path is None:
        return jsonify({'error': 'Nothing to record, or the run has no data directory'}), 404
    return jsonify({'message': 'ROI snapshot written', 'path': path}), 200

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
    
# Waveform Routes
@bp.route('/waveforms/probe1/<board_id>/<channel>', methods=['GET'])
@jwt_required_custom
def get_probe1(board_id, channel):
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
        waveform = spy_mgr.get_waveform(board_id, channel, boards, "probe1")
        json_data = spy_mgr.convert_histogram_to_json(waveform)
        return json_data if json_data else ""
    except Exception as e:
        return jsonify({'error': f'Failed to get waveform1: {str(e)}'}), 500

@bp.route('/waveforms/probe2/<board_id>/<channel>', methods=['GET'])
@jwt_required_custom
def get_probe2(board_id, channel):
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
        waveform = spy_mgr.get_waveform(board_id, channel, boards, "probe2")
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
        if waveform_type not in ['wave1', 'wave2', 'probe1', 'probe2']:
            return jsonify({'error': 'Invalid waveform type. Use wave1 or wave2.'}), 400
        
        boards = daq_mgr.get_boards()
        waveform = spy_mgr.get_waveform(board_id, channel, boards, waveform_type)
        # If type is probe1, make it green, if probe2 make it red
        if waveform_type == "probe1":
            waveform.SetLineColor(ROOT.kGreen)
        elif waveform_type == "probe2":
            waveform.SetLineColor(ROOT.kRed)
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
        Boolean indicating if waveforms are enabled for every board
    """
    try:
        boards = daq_mgr.get_boards()
        status = spy_mgr.get_waveform_status(boards)
        return jsonify(status)
    except Exception as e:
        return jsonify({'error': f'Failed to get waveform status: {str(e)}'}), 500

def _find_board(board_id):
    """Locate a configured board by id, comparing as strings."""
    for board in daq_mgr.get_boards():
        if str(board['id']) == str(board_id):
            return board
    return None

@bp.route('/waveforms/status_per_board', methods=['GET'])
@jwt_required_custom
def get_waveform_status_per_board():
    """
    Get the waveform activation status of each board individually.

    Returns:
        Mapping of board id to a boolean indicating if its waveforms are enabled
    """
    try:
        boards = daq_mgr.get_boards()
        return jsonify(spy_mgr.get_waveform_status_per_board(boards))
    except Exception as e:
        return jsonify({'error': f'Failed to get per-board waveform status: {str(e)}'}), 500

@bp.route('/waveforms/activate/<board_id>', methods=['POST'])
@jwt_required_custom
def activate_waveforms_board(board_id):
    """
    Activate waveform recording for a single board.

    Args:
        board_id: Id of the board to activate waveforms for

    Returns:
        Success/failure message
    """
    try:
        board = _find_board(board_id)
        if board is None:
            return jsonify({'error': f'Board {board_id} not found'}), 404
        if spy_mgr.set_waveform_for_board(board, True):
            return jsonify({'message': f'Waveforms activated for board {board_id}!'}), 200
        return jsonify({'message': f'Failed to activate waveforms for board {board_id}'}), 500
    except Exception as e:
        return jsonify({'error': f'Failed to activate waveforms: {str(e)}'}), 500

@bp.route('/waveforms/deactivate/<board_id>', methods=['POST'])
@jwt_required_custom
def deactivate_waveforms_board(board_id):
    """
    Deactivate waveform recording for a single board.

    Args:
        board_id: Id of the board to deactivate waveforms for

    Returns:
        Success/failure message
    """
    try:
        board = _find_board(board_id)
        if board is None:
            return jsonify({'error': f'Board {board_id} not found'}), 404
        if spy_mgr.set_waveform_for_board(board, False):
            return jsonify({'message': f'Waveforms deactivated for board {board_id}!'}), 200
        return jsonify({'message': f'Failed to deactivate waveforms for board {board_id}'}), 500
    except Exception as e:
        return jsonify({'error': f'Failed to deactivate waveforms: {str(e)}'}), 500

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
        # caendaq PSD is 2048 x-bins; rebin to a compact 128 x 256 for the browser.
        histo.RebinX(16)
        json_data = spy_mgr.convert_histogram_to_json(histo)
        return json_data if json_data else ""
    except Exception as e:
        return jsonify({'error': f'Failed to get PSD histogram: {str(e)}'}), 500