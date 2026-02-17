# app/routes/experiment.py
import os
import json
import logging
from datetime import datetime

from flask import Blueprint, request, jsonify
from app import db

from ..models.run_metadata import RunMetadata
from ..utils.jwt_utils import jwt_required_custom, get_current_user
from ..services.daq_manager import get_daq_manager
from ..services.spy_manager import get_spy_manager

logger = logging.getLogger(__name__)

TEST_FLAG = os.getenv('TEST_FLAG', False)

bp = Blueprint('experiment', __name__)

if not TEST_FLAG:
    # Clean up just in case
    os.system("killall RUSpy >/dev/null 2>&1")
    os.system("docker stop xdaq >/dev/null 2>&1")

# Initialize managers
daq_mgr = get_daq_manager(test_flag=TEST_FLAG)
spy_mgr = get_spy_manager(test_flag=TEST_FLAG)


def set_flask_app(app):
    """Store Flask app reference for use in background threads (e.g., auto-restart)."""
    daq_mgr.flask_app = app


def perform_auto_restart(board_id: str, failure_type: str) -> None:
    """
    Perform auto-restart when board failure is detected.
    This function is called from a dedicated restart thread (not the monitoring thread).

    Args:
        board_id: ID of the failed board
        failure_type: Description of the failure type
    """
    logger.info(f"Performing auto-restart due to {failure_type} on board {board_id}")

    # Get the Flask app reference from the daq_manager singleton
    app = daq_mgr.flask_app
    if app is None:
        logger.error("Flask app reference not set on daq_manager - cannot auto-restart")
        return

    # We need to create an app context since this runs in a background thread
    with app.app_context():
        try:
            current_run_number = daq_mgr.get_run_number()
            save_data = daq_mgr.get_save_data()

            # Stop spy server first
            spy_mgr.stop_spy()

            # Stop XDAQ
            daq_mgr.stop_xdaq()

            # Update run metadata with note about auto-stop
            if save_data:
                try:
                    run_metadata = RunMetadata.query.filter_by(run_number=current_run_number).first()
                    if run_metadata:
                        run_metadata.end_time = datetime.now()
                        # Append auto-restart note to existing notes
                        auto_note = f"[AUTO-RESTART] Run stopped due to {failure_type} on board {board_id}"
                        if run_metadata.notes:
                            run_metadata.notes = run_metadata.notes + "\n" + auto_note
                        else:
                            run_metadata.notes = auto_note
                        # Mark run as potentially bad
                        run_metadata.flag = 'bad'

                        # Write metadata.json
                        metadata = {
                            "Start Time": run_metadata.start_time.isoformat() if run_metadata.start_time else None,
                            "Stop Time": run_metadata.end_time.isoformat(),
                            "Terminal Voltage": run_metadata.terminal_voltage,
                            "Probe Voltage": run_metadata.probe_voltage,
                            "Run Type": run_metadata.run_type,
                            "Target Name": run_metadata.target_name,
                            "Accumulated Charge": run_metadata.accumulated_charge,
                            "Auto Restart Note": auto_note
                        }

                        run_dir = f'data/run{current_run_number}/metadata.json'
                        if os.path.exists(os.path.dirname(run_dir)):
                            with open(run_dir, 'w') as f:
                                json.dump(metadata, f, indent=4)

                        db.session.commit()
                        logger.info(f"Updated metadata for run {current_run_number} with auto-restart note")
                except Exception as e:
                    logger.error(f"Error updating run metadata: {e}")

            # Increment run number for next run
            if save_data:
                daq_mgr.increment_run_number()

            # Set not running state
            daq_mgr.set_running_state(False)

            logger.info(f"Run {current_run_number} stopped. Preparing to start new run...")

            # Small delay before starting new run
            import time
            time.sleep(2)

            # Start new run
            new_run_number = daq_mgr.get_run_number()

            # Prepare for run start
            if not daq_mgr.prepare_run_start():
                logger.error("Failed to prepare run start during auto-restart")
                return

            # Configure and start XDAQ
            if not daq_mgr.configure_xdaq_for_run():
                logger.error("Failed to configure XDAQ during auto-restart")
                return

            if not daq_mgr.start_xdaq():
                logger.error("Failed to start XDAQ during auto-restart")
                return

            # Set running state
            daq_mgr.set_running_state(True)

            # Start board monitoring thread
            daq_mgr.start_board_monitoring()

            # Start spy server
            daq_state = daq_mgr.get_state()
            if not spy_mgr.start_spy(daq_state):
                logger.error("Failed to start spy server during auto-restart")
                return

            # Add new run to database
            if save_data:
                try:
                    run_metadata = RunMetadata.query.filter_by(run_number=new_run_number).first()
                    if not run_metadata:
                        run_metadata = RunMetadata(
                            run_number=new_run_number,
                            start_time=datetime.now(),
                            notes=f"[AUTO-RESTART] Automatically started after {failure_type} on board {board_id} in run {current_run_number}"
                        )
                        db.session.add(run_metadata)
                        db.session.commit()
                except Exception as e:
                    logger.error(f"Error creating new run metadata: {e}")

            logger.info(f"Auto-restart complete. New run {new_run_number} started.")

        except Exception as e:
            logger.error(f"Error during auto-restart: {e}")


# Register the restart callback with the DAQ manager
daq_mgr.register_restart_callback(perform_auto_restart)

@bp.route("/experiment/start_run", methods=['POST'])
@jwt_required_custom
def start_run():
    # Check if DAQ is already running
    if daq_mgr.is_running():
        return jsonify({'message': 'DAQ is already running!'}), 404
    
    # Check if there are boards configured
    boards = daq_mgr.get_boards()
    if len(boards) == 0:
        return jsonify({'message': 'No CAEN boards found!'}), 404

    # Prepare for run start
    if not daq_mgr.prepare_run_start():
        return jsonify({'message': 'Failed to prepare run start'}), 500

    # Configure and start XDAQ
    if not daq_mgr.configure_xdaq_for_run():
        return jsonify({'message': 'Failed to configure XDAQ'}), 500
    
    if not daq_mgr.start_xdaq():
        return jsonify({'message': 'Failed to start XDAQ'}), 500

    # Set running state
    daq_mgr.set_running_state(True)

    # Start board monitoring thread
    daq_mgr.start_board_monitoring()

    # Start spy server
    daq_state = daq_mgr.get_state()
    if not spy_mgr.start_spy(daq_state):
        return jsonify({'message': 'Failed to start spy server'}), 500
    
    # Add run to database if saving data
    if daq_mgr.get_save_data():
        run_number = daq_mgr.get_run_number()
        try:
            run_metadata = RunMetadata.query.filter_by(run_number=run_number).first()
            if not run_metadata:
                run_metadata = RunMetadata(
                    run_number=run_number, 
                    start_time=datetime.now(), 
                    user_id=get_current_user()
                )
                db.session.add(run_metadata)
                db.session.commit()
            else:
                run_metadata.start_time = datetime.now()
                run_metadata.end_time = None
                db.session.commit()
        except Exception:
            pass  # Non-critical error

    return jsonify({'message': 'Run started successfully!'}), 200

@bp.route("/experiment/stop_run", methods=['POST'])
@jwt_required_custom
def stop_run():
    if not daq_mgr.is_running():
        return jsonify({'message': 'Run stopped successfully!'}), 200

    # Stop spy server first
    spy_mgr.stop_spy()
    
    # Stop board monitoring thread
    daq_mgr.stop_board_monitoring()
    
    # Stop XDAQ
    daq_mgr.stop_xdaq()

    # Update run metadata in database
    if daq_mgr.get_save_data():
        run_number = daq_mgr.get_run_number()
        try:
            run_metadata = RunMetadata.query.filter_by(run_number=run_number).first()
            if run_metadata:
                run_metadata.end_time = datetime.now()
                
                metadata = {
                    "Start Time": run_metadata.start_time.isoformat(),
                    "Stop Time": run_metadata.end_time.isoformat(),
                    "Terminal Voltage": run_metadata.terminal_voltage,
                    "Probe Voltage": run_metadata.probe_voltage,
                    "Run Type": run_metadata.run_type,
                    "Target Name": run_metadata.target_name,
                    "Accumulated Charge": run_metadata.accumulated_charge
                }
                
                with open(f'data/run{run_number}/metadata.json', 'w') as f:
                    json.dump(metadata, f, indent=4)

                db.session.commit()
        except Exception:
            pass

    # Increment run number if we saved data
    if daq_mgr.get_save_data():
        daq_mgr.increment_run_number()

    # Set not running state
    daq_mgr.set_running_state(False)

    return jsonify({'message': 'Run stopped successfully!'}), 200

@bp.route("/experiment/add_note", methods=['POST'])
@jwt_required_custom
def add_note():
    data = request.get_json()
    run_number = data['run_number']
    note = data['note']
    
    run_metadata = RunMetadata.query.filter_by(run_number=run_number).first()
    if run_metadata:
        run_metadata.notes = note
        db.session.commit()
        return jsonify({'message': 'Note added successfully'}), 200
    return jsonify({'message': 'Run not found'}), 404

@bp.route("/experiment/add_run_metadata", methods=['POST'])
@jwt_required_custom
def add_run_metadata():
    data = request.get_json()
    run_number = data['run_number']
    target_name = data['target_name']
    terminal_voltage = data['terminal_voltage']
    probe_voltage = data['probe_voltage']
    run_type = data['run_type']
    
    run_metadata = RunMetadata.query.filter_by(run_number=run_number).first()
    if run_metadata:
        run_metadata.target_name = target_name
        run_metadata.terminal_voltage = terminal_voltage
        run_metadata.probe_voltage = probe_voltage
        run_metadata.run_type = run_type
        db.session.commit()
        return jsonify({'message': 'Run metadata added successfully'}), 200
    return jsonify({'message': 'Run not found'}), 404

@bp.route("/experiment/get_run_metadata/<run_number>", methods=['GET'])
@jwt_required_custom
def get_run_metadata(run_number):
    run_metadata = RunMetadata.query.filter_by(run_number=run_number).first()
    if run_metadata:
        return jsonify({
            'run_number': run_metadata.run_number,
            'start_time': run_metadata.start_time,
            'end_time': run_metadata.end_time,
            'notes': run_metadata.notes,
            'target_name': run_metadata.target_name,
            'terminal_voltage': run_metadata.terminal_voltage,
            'probe_voltage': run_metadata.probe_voltage,
            'run_type': run_metadata.run_type,
            'accumulated_charge': run_metadata.accumulated_charge,
            'user_id': run_metadata.user_id,
            'flag': run_metadata.flag
        }), 200
    return jsonify({'message': 'Run not found'}), 404

@bp.route("/experiment/get_run_metadata", methods=['GET'])
@jwt_required_custom
def get_all_run_metadata():
    run_metadata = RunMetadata.query.all()
    # order by run number reversed
    run_metadata = sorted(run_metadata, key=lambda x: x.run_number, reverse=True)
    if run_metadata:
        metadata = []
        for run in run_metadata:
            metadata.append({
                'run_number': run.run_number,
                'start_time': run.start_time,
                'end_time': run.end_time,
                'notes': run.notes,
                'target_name': run.target_name,
                'terminal_voltage': run.terminal_voltage,
                'probe_voltage': run.probe_voltage,
                'run_type': run.run_type,
                'accumulated_charge': run.accumulated_charge,
                'user_id': run.user_id,
                'flag': run.flag
            })
        return jsonify(metadata), 200
    return jsonify({'message': 'No runs found'}), 404

# Route for adding CAEN boards
@bp.route("/experiment/add_board", methods=['POST'])
@jwt_required_custom
def add_caen():
    board_config = request.get_json()
    
    if daq_mgr.add_board(board_config):
        return jsonify(daq_mgr.get_boards()), 200
    else:
        return jsonify({'message': 'Failed to connect to the board!'}), 404

# Route for removing a CAEN board
@bp.route("/experiment/remove_board", methods=['POST'])
@jwt_required_custom
def remove_caen():
    board_id = str(request.get_json()["id"])
    
    if daq_mgr.remove_board(board_id):
        return jsonify(daq_mgr.get_boards()), 200
    else:
        return jsonify({'message': 'Failed to remove board'}), 404

# Route to update save data
@bp.route("/experiment/set_save_data", methods=['POST'])
@jwt_required_custom
def update_save_data():
    save = request.get_json()["value"]
    daq_mgr.set_save_data(save)
    return jsonify(daq_mgr.get_save_data())

# Route to update limit size
@bp.route("/experiment/set_limit_data_size", methods=['POST'])
@jwt_required_custom
def update_limit_size():
    limit_size = request.get_json()["value"]
    daq_mgr.set_limit_data_size(limit_size)
    return jsonify(daq_mgr.get_limit_data_size())

# Route to update file size limit
@bp.route("/experiment/set_data_size_limit", methods=['POST'])
@jwt_required_custom
def update_file_size_limit():
    file_size_limit = request.get_json()["value"]
    daq_mgr.set_data_size_limit(file_size_limit)
    return jsonify(daq_mgr.get_data_size_limit())

# Route to get the save data
@bp.route("/experiment/get_save_data", methods=['GET'])
@jwt_required_custom
def get_save_data():
    return jsonify(daq_mgr.get_save_data())

# Route to get the limit size
@bp.route("/experiment/get_limit_data_size", methods=['GET'])
@jwt_required_custom
def get_limit_size():
    return jsonify(daq_mgr.get_limit_data_size())

# Route to get the file size limit
@bp.route("/experiment/get_data_size_limit", methods=['GET'])
@jwt_required_custom
def get_file_size_limit():
    return jsonify(daq_mgr.get_data_size_limit())

# Route for sending CAEN board
@bp.route("/experiment/get_board_configuration", methods=['GET'])
@jwt_required_custom
def get_board_configuration():
    return jsonify(daq_mgr.get_boards())

# Get run number from the database
@bp.route("/experiment/get_run_number", methods=['GET'])
@jwt_required_custom
def get_run_number():
    return jsonify(daq_mgr.get_run_number())

# Set run number in the database
@bp.route("/experiment/set_run_number", methods=['POST'])
@jwt_required_custom
def set_run_number():
    run_number = request.get_json()["value"]
    daq_mgr.set_run_number(run_number)
    return jsonify(daq_mgr.get_run_number())

# Check run directory
@bp.route("/experiment/check_run_directory", methods=['GET'])
@jwt_required_custom
def check_run_directory():
    return jsonify(daq_mgr.check_run_directory())

# Get run status
@bp.route("/experiment/get_run_status", methods=['GET'])
@jwt_required_custom
def get_run_status():
    return jsonify(daq_mgr.is_running())

@bp.route("/experiment/get_start_time", methods=['GET'])
@jwt_required_custom
def get_start_time():
    return jsonify(daq_mgr.get_start_time())

@bp.route('/experiment/xdaq/file_bandwidth', methods=['GET'])
@jwt_required_custom
def get_file_bandwidth():
    return jsonify(daq_mgr.get_file_bandwidth())

@bp.route('/experiment/xdaq/output_bandwidth', methods=['GET'])
@jwt_required_custom
def get_output_bandwidth():
    return jsonify(daq_mgr.get_output_bandwidth())

@bp.route('/experiment/xdaq/reset', methods=['POST'])
@jwt_required_custom
def reset():
    try:
        spy_mgr.stop_spy()
    except Exception:
        pass
    
    if daq_mgr.reset_xdaq():
        return jsonify(0)
    else:
        return jsonify(-1)
    
# Route for updating run flag
@bp.route("/experiment/update_run_flag", methods=['POST'])
@jwt_required_custom
def update_run_flag():
    data = request.get_json()
    run_number = data.get('run_number')
    flag = data.get('flag')
    
    if not run_number or not flag:
        return jsonify({'message': 'Missing run_number or flag'}), 400
    
    if flag not in ['good', 'unknown', 'bad']:
        return jsonify({'message': 'Invalid flag value. Must be good, unknown, or bad'}), 400
    
    run = RunMetadata.query.filter_by(run_number=run_number).first()
    if not run:
        return jsonify({'message': 'Run not found'}), 404
    
    run.flag = flag
    db.session.commit()

    print(f"Run {run_number} flag updated to {flag}")
    print(db)
    
    return jsonify({'message': 'Flag updated successfully', 'flag': flag}), 200

# Route for updating run notes
@bp.route("/experiment/update_run_notes", methods=['POST'])
@jwt_required_custom
def update_run_notes():
    data = request.get_json()
    run_number = data.get('run_number')
    notes = data.get('notes', '')
    
    if not run_number:
        return jsonify({'message': 'Missing run_number'}), 400
    
    run = RunMetadata.query.filter_by(run_number=run_number).first()
    if not run:
        return jsonify({'message': 'Run not found'}), 404
    
    run.notes = notes
    db.session.commit()
    
    return jsonify({'message': 'Notes updated successfully', 'notes': notes}), 200

# Route to get board status information
@bp.route("/experiment/get_board_status", methods=['GET'])
@jwt_required_custom
def get_board_status():
    """
    Get current status of all boards from the monitoring thread.
    Returns status information including whether boards have failed.
    """
    board_status = daq_mgr.get_board_status()
    return jsonify(board_status), 200

# Route to refresh all board connections
@bp.route("/experiment/refresh_board_connections", methods=['POST'])
@jwt_required_custom
def refresh_board_connections():
    """
    Refresh all persistent digitizer connections.
    Useful when boards are not responding properly.
    """
    try:
        # Check if DAQ is running - don't refresh during acquisition
        if daq_mgr.is_running():
            return jsonify({'message': 'Cannot refresh board connections while DAQ is running'}), 400
        
        boards = daq_mgr.get_boards()
        if not boards:
            return jsonify({'message': 'No boards configured'}), 404
        
        refreshed_count = 0
        failed_boards = []
        
        # Refresh each board connection
        for board in boards:
            board_id = str(board['id'])
            if daq_mgr.refresh_board_connection(board_id):
                refreshed_count += 1
            else:
                failed_boards.append(board_id)
        
        if failed_boards:
            message = f'Refreshed {refreshed_count}/{len(boards)} board connections. Failed boards: {", ".join(failed_boards)}'
            return jsonify({'message': message, 'refreshed': refreshed_count, 'failed': failed_boards}), 207
        else:
            message = f'Successfully refreshed all {refreshed_count} board connections'
            return jsonify({'message': message, 'refreshed': refreshed_count}), 200
            
    except Exception as e:
        return jsonify({'message': f'Error refreshing board connections: {str(e)}'}), 500


# Auto-restart on board failure routes

@bp.route("/experiment/get_auto_restart", methods=['GET'])
@jwt_required_custom
def get_auto_restart():
    """
    Get auto-restart on board failure setting.
    Returns whether auto-restart is enabled and the delay before restart.
    """
    return jsonify({
        'enabled': daq_mgr.get_auto_restart_enabled(),
        'delay': daq_mgr.get_auto_restart_delay(),
        'pending': daq_mgr.is_restart_pending(),
        'last_restart_info': daq_mgr.get_last_restart_info()
    }), 200


@bp.route("/experiment/set_auto_restart", methods=['POST'])
@jwt_required_custom
def set_auto_restart():
    """
    Set auto-restart on board failure setting.
    Request body: { "enabled": bool, "delay": int (optional, default 30 seconds) }
    """
    data = request.get_json()
    enabled = data.get('enabled', False)
    delay = data.get('delay', 30)

    daq_mgr.set_auto_restart_enabled(enabled)
    if delay:
        daq_mgr.set_auto_restart_delay(delay)

    return jsonify({
        'message': f'Auto-restart {"enabled" if enabled else "disabled"}',
        'enabled': daq_mgr.get_auto_restart_enabled(),
        'delay': daq_mgr.get_auto_restart_delay()
    }), 200


@bp.route("/experiment/get_restart_status", methods=['GET'])
@jwt_required_custom
def get_restart_status():
    """
    Get current restart status.
    Returns whether a restart is pending and info about the last restart.
    """
    return jsonify({
        'pending': daq_mgr.is_restart_pending(),
        'last_restart_info': daq_mgr.get_last_restart_info()
    }), 200


# Telegram notification routes

@bp.route("/experiment/get_telegram_settings", methods=['GET'])
@jwt_required_custom
def get_telegram_settings():
    """
    Get current Telegram notification settings.
    Returns enabled status, masked bot token, and chat ID.
    """
    settings = daq_mgr.get_telegram_settings()
    return jsonify(settings), 200


@bp.route("/experiment/set_telegram_settings", methods=['POST'])
@jwt_required_custom
def set_telegram_settings():
    """
    Update Telegram notification settings.
    Request body: { "enabled": bool, "bot_token": string, "chat_id": string }
    All fields are optional - only provided fields will be updated.
    """
    data = request.get_json()
    enabled = data.get('enabled')
    bot_token = data.get('bot_token')
    chat_id = data.get('chat_id')

    daq_mgr.set_telegram_settings(enabled=enabled, bot_token=bot_token, chat_id=chat_id)

    return jsonify({
        'message': 'Telegram settings updated',
        'settings': daq_mgr.get_telegram_settings()
    }), 200


@bp.route("/experiment/test_telegram", methods=['POST'])
@jwt_required_custom
def test_telegram():
    """
    Send a test message to verify Telegram configuration.
    """
    result = daq_mgr.test_telegram_connection()
    status_code = 200 if result['success'] else 400
    return jsonify(result), status_code