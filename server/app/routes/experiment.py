# app/routes/experiment.py
import os
import logging
from datetime import datetime

from flask import Blueprint, request, jsonify
from app import db

from ..models.run_metadata import RunMetadata
from ..utils.jwt_utils import jwt_required_custom, get_current_user
from ..services.daq_manager import get_daq_manager, BoardConfigError
from ..services.spy_manager import get_spy_manager
from ..services.caen_acquisition import get_caen_acquisition
from ..services.run_metadata_snapshot import sync_run_metadata_file
# Module-level helpers that read synchronisation straight from the board configs.
from ..services import caen_acquisition

logger = logging.getLogger(__name__)

TEST_FLAG = os.getenv('TEST_FLAG', False)

# The Graphite/Carbon target for the independent rate publisher is read from
# conf/stats.json by caen_acquisition (see _graphite_from_stats).

bp = Blueprint('experiment', __name__)

# Initialize managers (acquisition runs in-process via caendaq)
daq_mgr = get_daq_manager(test_flag=TEST_FLAG)
spy_mgr = get_spy_manager(test_flag=TEST_FLAG)
caen_acq = get_caen_acquisition(test_flag=TEST_FLAG)


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

            # Stop monitoring, spy and acquisition
            daq_mgr.stop_board_monitoring()
            spy_mgr.stop_spy()
            caen_acq.stop()
            daq_mgr.reacquire_digitizers()

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

                        db.session.commit()
                        sync_run_metadata_file(run_metadata)
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

            # Prepare and start the new run via caendaq
            if not daq_mgr.prepare_run_start():
                logger.error("Failed to prepare run start during auto-restart")
                return

            boards = daq_mgr.get_boards()
            save = daq_mgr.get_save_data()
            out_dir = f"data/run{new_run_number}"
            max_bytes = daq_mgr.get_data_size_limit() if daq_mgr.get_limit_data_size() else 0

            daq_mgr.release_digitizers()
            if not caen_acq.configure(boards, new_run_number, out_dir,
                                      max_file_bytes=max_bytes, write=save) \
               or not caen_acq.start():
                logger.error("Failed to start acquisition during auto-restart")
                daq_mgr.reacquire_digitizers()
                return

            # Set running state, enable the spy + board monitoring
            daq_mgr.set_running_state(True)
            spy_mgr.start_spy(daq_mgr.get_state())
            daq_mgr.start_board_monitoring()

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
                    sync_run_metadata_file(run_metadata)
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

    # Prepare for run start (creates the run directory when saving)
    if not daq_mgr.prepare_run_start():
        return jsonify({'message': 'Failed to prepare run start'}), 500

    run = daq_mgr.get_run_number()
    save = daq_mgr.get_save_data()
    out_dir = f"data/run{run}"
    max_bytes = daq_mgr.get_data_size_limit() if daq_mgr.get_limit_data_size() else 0

    # Hand the boards over to caendaq (release the daq_manager's probe
    # connections so caendaq can open the digitizers), then configure + start.
    daq_mgr.release_digitizers()
    if not caen_acq.configure(boards, run, out_dir, max_file_bytes=max_bytes, write=save):
        daq_mgr.reacquire_digitizers()
        return jsonify({'message': 'Failed to configure acquisition'}), 500
    if not caen_acq.start():
        daq_mgr.reacquire_digitizers()
        return jsonify({'message': 'Failed to start acquisition'}), 500

    # Set running state and enable the on-demand spy.
    daq_mgr.set_running_state(True)
    spy_mgr.start_spy(daq_mgr.get_state())
    # Watch caendaq's board-FAIL signal (drives Telegram alerts + auto-restart).
    daq_mgr.start_board_monitoring()

    # Add run to database if saving data
    if daq_mgr.get_save_data():
        run_number = daq_mgr.get_run_number()
        # Hardware + software provenance, captured now that the boards are open
        # and configured, so the record describes the run as it actually ran.
        try:
            boards_snapshot = caen_acq.board_info_all()
            versions_snapshot = caen_acq.software_versions()
        except Exception as e:
            logger.error(f"Could not capture acquisition provenance: {e}", exc_info=True)
            boards_snapshot, versions_snapshot = [], {}
        sync_mode = caen_acq.sync_mode(boards)

        try:
            run_metadata = RunMetadata.query.filter_by(run_number=run_number).first()
            if not run_metadata:
                run_metadata = RunMetadata(
                    run_number=run_number,
                    start_time=datetime.now(),
                    user_id=get_current_user()
                )
                db.session.add(run_metadata)
            else:
                run_metadata.start_time = datetime.now()
                run_metadata.end_time = None
            run_metadata.set_board_info(boards_snapshot)
            run_metadata.set_software_versions(versions_snapshot)
            run_metadata.sync_mode = sync_mode
            db.session.commit()
            sync_run_metadata_file(run_metadata)
        except Exception as e:
            # Non-fatal: the run itself is fine, but say why the record is thin.
            logger.error(f"Could not record run {run_number} metadata: {e}", exc_info=True)

    return jsonify({'message': 'Run started successfully!'}), 200

@bp.route("/experiment/stop_run", methods=['POST'])
@jwt_required_custom
def stop_run():
    if not caen_acq.is_running() and not daq_mgr.is_running():
        return jsonify({'message': 'Run stopped successfully!'}), 200

    # Stop monitoring + spy, then the acquisition, then return the boards to the
    # daq_manager's probe connections.
    daq_mgr.stop_board_monitoring()
    spy_mgr.stop_spy()
    caen_acq.stop()
    # Retries inside: the boards were closed by caendaq a moment ago and a CAEN
    # link is not always ready to be reopened that fast. Say which ones stayed
    # shut — they are the boards that will read "Disconnected" on the dashboard,
    # and "Reset acquisition" is what reopens them.
    reacquired = daq_mgr.reacquire_digitizers()
    still_closed = [bid for bid, ok in reacquired.items() if not ok]
    if still_closed:
        logger.warning(
            f"Run stopped, but board(s) {', '.join(still_closed)} did not reopen. "
            "They will show as disconnected until 'Reset acquisition' is used.")

    # Update run metadata in database
    if daq_mgr.get_save_data():
        run_number = daq_mgr.get_run_number()
        try:
            run_metadata = RunMetadata.query.filter_by(run_number=run_number).first()
            if run_metadata:
                run_metadata.end_time = datetime.now()
                db.session.commit()
                sync_run_metadata_file(run_metadata)
        except Exception as e:
            # Never fail the stop over metadata, but do not lose the reason
            # either — a silent pass here once hid a missing DB migration.
            logger.error(f"Failed to write run {run_number} metadata: {e}", exc_info=True)

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
        sync_run_metadata_file(run_metadata)
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
        sync_run_metadata_file(run_metadata)
        return jsonify({'message': 'Run metadata added successfully'}), 200
    return jsonify({'message': 'Run not found'}), 404

@bp.route("/experiment/get_run_metadata/<run_number>", methods=['GET'])
@jwt_required_custom
def get_run_metadata(run_number):
    run_metadata = RunMetadata.query.filter_by(run_number=run_number).first()
    if run_metadata:
        return jsonify({
            'run_number': run_metadata.run_number,
            # Serialize as a timezone-less ISO string. The stored value is local
            # wall-clock time (datetime.now()); Flask's default encoder would
            # otherwise tag it as GMT, making the browser shift it by the local
            # UTC offset. ISO without a zone is parsed as local time client-side.
            'start_time': run_metadata.start_time.isoformat() if run_metadata.start_time else None,
            'end_time': run_metadata.end_time.isoformat() if run_metadata.end_time else None,
            'notes': run_metadata.notes,
            'target_name': run_metadata.target_name,
            'terminal_voltage': run_metadata.terminal_voltage,
            'probe_voltage': run_metadata.probe_voltage,
            'run_type': run_metadata.run_type,
            'accumulated_charge': run_metadata.accumulated_charge,
            'user_id': run_metadata.user_id,
            'flag': run_metadata.flag,
            # Acquisition provenance captured at run start (empty for older runs).
            'board_info': run_metadata.get_board_info(),
            'software_versions': run_metadata.get_software_versions(),
            'sync_mode': run_metadata.sync_mode
        }), 200
    return jsonify({'message': 'Run not found'}), 404

@bp.route("/experiment/get_run_metadata", methods=['GET'])
@jwt_required_custom
def get_all_run_metadata():
    run_metadata = RunMetadata.query.all()
    # order by run number reversed
    run_metadata = sorted(run_metadata, key=lambda x: x.run_number, reverse=True)
    # An empty database (no runs yet) is a valid state, not an error: return an
    # empty list with 200 so the client can just show "no previous runs".
    metadata = []
    for run in run_metadata:
        metadata.append({
            'run_number': run.run_number,
            # ISO without timezone so the browser reads it as local wall-clock
            # time (see get_run_metadata above for the rationale).
            'start_time': run.start_time.isoformat() if run.start_time else None,
            'end_time': run.end_time.isoformat() if run.end_time else None,
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

# Route for adding CAEN boards
@bp.route("/experiment/add_board", methods=['POST'])
@jwt_required_custom
def add_caen():
    board_config = request.get_json()

    try:
        added = daq_mgr.add_board(board_config)
    except BoardConfigError as e:
        # The configuration is wrong (e.g. a duplicate board ID) — tell the
        # operator exactly what to fix rather than reporting a connection error.
        return jsonify({'message': str(e)}), 409

    if added:
        return jsonify(daq_mgr.get_boards()), 200
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

# ── Multi-board synchronisation ──────────────────────────────────────────────
# The boards can be started as a daisy chain so they share one time origin: the
# first board (lowest id) is the master and is started LAST by software, after
# every other board has been armed to wait for its RUN signal on S-IN/GPI.

@bp.route("/experiment/get_sync_settings", methods=['GET'])
@jwt_required_custom
def get_sync_settings():
    boards = daq_mgr.get_boards()

    chain = []
    synced = []
    for board in boards:
        acq = caen_acquisition.acquisition_control_of(board)
        fpio = caen_acquisition.front_panel_io_of(board)
        trg_out = caen_acquisition.trg_out_mask_of(board)
        mode = acq & 0x3
        entry = {
            'board_id': board['id'],
            'name': board['name'],
            'start_mode': mode,
            'start_mode_name': caen_acquisition.START_MODE_NAMES.get(mode, 'unknown'),
            'synchronised': mode != caen_acquisition.START_MODE_SW,
            # PLL reference clock (0x8100 bit[6]): 0 = internal 50 MHz oscillator,
            # 1 = external CLK-IN. Boards sharing a clock stay phase-aligned for
            # the whole run, which synchronising the START alone does not give.
            'clock_source': (acq >> 6) & 0x1,
            'acquisition_control': acq,
            # ── What actually reaches the cable ──
            # 0x811C[17:16]: 0 = Trigger (per 0x8110), 1 = motherboard probe,
            # 2 = channel probe, 3 = S-IN/GPI propagation. Must be 0 to chain.
            'trg_out_mode': (fpio >> 16) & 0x3,
            'front_panel_io_control': fpio,
            # 0x8110[31] software trigger -> TRG-OUT (the master needs this, or
            # its SendSWTrigger never leaves the board).
            'sw_trigger_to_trg_out': (trg_out >> 31) & 0x1,
            # 0x8110[30] external TRG-IN -> TRG-OUT (a board needs this to pass
            # the start on to the next one in the chain).
            'ext_trigger_to_trg_out': (trg_out >> 30) & 0x1,
            'trg_out_mask': trg_out,
            'role': 'independent',   # replaced below for the chained boards
        }
        chain.append(entry)
        if entry['synchronised']:
            synced.append(entry)

    # The master fires the software trigger that starts the chain: board register
    # id 0 by CAEN convention, else the first synchronised board. Mirrors
    # Daq::masterIndex() on the caendaq side.
    if synced:
        master = next((e for e in synced if str(e['board_id']) == '0'), synced[0])
        for entry in synced:
            entry['role'] = 'master' if entry is master else 'slave'

    # A chain can be perfectly armed and still never start, because the start
    # pulse never reaches the cable. Check the propagation path explicitly
    # rather than leaving the operator to discover it from an empty run.
    for i, entry in enumerate(synced):
        problems = []
        if entry['trg_out_mode'] != 0:
            problems.append(
                "TRG-OUT is not set to carry the trigger, so nothing reaches the next board")
        if entry['role'] == 'master' and not entry['sw_trigger_to_trg_out']:
            problems.append(
                "the software trigger is not routed to TRG-OUT, so the chain will never start")
        # Every board except the last one has to pass the start along.
        if i < len(synced) - 1 and not entry['ext_trigger_to_trg_out']:
            problems.append(
                "TRG-IN is not routed to TRG-OUT, so boards after this one will not start")
        entry['problems'] = problems

    return jsonify({
        'mode': 'daisy-chain' if synced else 'independent',
        'chain': chain,
        'synchronised_count': len(synced),
        # A single board has nothing to chain to.
        'applicable': len(boards) > 1,
        # The register the dashboard edits to change any of this.
        'register': 'reg_8100',
    })


@bp.route("/experiment/board_info", methods=['GET'])
@jwt_required_custom
def get_live_board_info():
    """Full CAEN board identity + acquisition registers for the current run.

    Only populated while a run is configured (that is when the digitizers are
    open); otherwise `boards` is empty and only the software versions are known."""
    return jsonify({
        'boards': caen_acq.board_info_all(),
        'software': caen_acq.software_versions(),
        'sync_mode': caen_acq.sync_mode(daq_mgr.get_boards()),
        'running': caen_acq.is_running(),
    })


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

@bp.route('/experiment/file_bandwidth', methods=['GET'])
@jwt_required_custom
def get_file_bandwidth():
    return jsonify(daq_mgr.get_file_bandwidth())

@bp.route('/experiment/stats', methods=['GET'])
@jwt_required_custom
def get_stats():
    """Live per-board / per-channel rates (event/pileup/lost/satu per second and
    file write rate) from the caendaq statistics collector."""
    return jsonify(caen_acq.stats()), 200

@bp.route('/experiment/reset', methods=['POST'])
@jwt_required_custom
def reset():
    try:
        spy_mgr.stop_spy()
    except Exception:
        pass

    if daq_mgr.reset_acquisition():
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
    sync_run_metadata_file(run)

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
    sync_run_metadata_file(run)
    
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
