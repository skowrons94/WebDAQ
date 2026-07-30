"""
DAQ Manager Module

This module provides centralized management of the Data Acquisition (DAQ) system state,
including board configurations, run control, and settings persistence. It extracts
the DAQ logic from the experiment routes to improve code organization.

Key Features:
- DAQ state management (running status, run number, save settings)
- Board configuration management (add/remove CAEN boards)
- Settings persistence to JSON files
- caendaq acquisition lifecycle + board-failure monitoring
- Run directory management
- Board information queries for digitizer control

Author: WebDAQ Refactoring
Purpose: Centralized DAQ state management for LUNA experiment
"""

import os
import json
import time
import logging
import threading
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime
from typing import Callable, Dict, List, Optional, Any

from .digitizer_container import DigitizerContainer
from .telegram_notifier import TelegramNotifier
from ..utils.safe_registers import is_online_safe
from ..utils.board_defaults import default_board_config

logger = logging.getLogger(__name__)


class BoardConfigError(ValueError):
    """A board configuration the operator has to fix (not a hardware failure).

    The message is written for the operator and is shown verbatim in the UI.
    """


class DAQManager:
    """
    Centralized manager for DAQ system state and operations.
    
    Handles all aspects of DAQ configuration including board management,
    run control settings, and persistence of state information.
    """
    
    def __init__(self, test_flag: bool = False):
        """
        Initialize DAQ Manager.
        
        Args:
            test_flag: Enable test mode for development
        """
        self.logger = logging.getLogger(__name__ + '.DAQManager')
        self.test_flag = test_flag
        
        # Initialize DAQ state
        self.daq_state = self._load_or_create_state()
        
        # Initialize digitizer container for persistent connections
        self.digitizer_container = DigitizerContainer(test_flag=test_flag)
        
        # Initialize board monitoring
        self.board_status = {}  # Track board failure status: {board_id: {'failed': bool, 'last_value': int}}
        self.monitor_thread = None
        self.monitor_stop_event = threading.Event()

        # Auto-restart on board failure settings
        self.auto_restart_enabled = False
        self.auto_restart_delay = 30  # seconds to wait before restarting
        self.restart_pending = False  # Flag to indicate restart is in progress
        self.last_restart_info = None  # Info about the last auto-restart event
        self.restart_callback = None  # Callback function to trigger restart

        # Flask app reference for background threads that need app context
        self.flask_app = None

        # Called when a run starts or stops, whatever started or stopped it —
        # the charge integration hangs off this so it can never be left running
        # by a client that failed to say "stop".
        self.run_state_listeners: List[Callable[[bool], None]] = []

        # Telegram notification settings (loaded from persistent storage)
        self.telegram = TelegramNotifier()
        
        # Initialize persistent connections for existing boards
        for board in self.daq_state.get('boards', []):
            board_id = str(board['id'])
            if not self.digitizer_container.add_board(board):
                self.logger.warning(f"Failed to create persistent connection for board {board_id}")

        # A board listed in settings.json whose register file is missing leaves
        # every register-driven page (tuner, CAEN dashboard) empty and a run
        # unable to configure. Rebuild what is missing instead of carrying the
        # inconsistency forward.
        self._repair_board_configs()
        
        # Acquisition runs in-process via caen_acquisition (the caendaq module).
        self.logger.info("Acquisition backend: caendaq")

        # Update project files
        self._update_project()
    
    def _ensure_directories(self) -> None:
        """Ensure required directories exist."""
        directories = ['conf', 'calib', 'data']
        for directory in directories:
            if not os.path.exists(directory):
                os.makedirs(directory)
                self.logger.debug(f"Created directory: {directory}")
    
    def _load_or_create_state(self) -> Dict[str, Any]:
        """
        Load DAQ state from file or create default state.
        
        Returns:
            Dictionary containing DAQ state
        """
        self._ensure_directories()
        
        settings_file = 'conf/settings.json'
        if os.path.exists(settings_file):
            try:
                with open(settings_file, 'r') as f:
                    state = json.load(f)
                self.logger.info("Loaded existing DAQ state")
                return state
            except Exception as e:
                self.logger.error(f"Error loading DAQ state: {e}")
        
        # Create default state
        default_state = {
            'running': False,
            'start_time': 0,
            'run': 0,
            'save': False,
            'limit_size': False,
            'file_size_limit': 0,
            'boards': [],
        }

        try:
            with open(settings_file, 'w') as f:
                json.dump(default_state, f, indent=4)
            self.logger.info("Created default DAQ state")
        except Exception as e:
            self.logger.error(f"Error saving default DAQ state: {e}")
        
        return default_state
    
    def _update_project(self) -> None:
        """Persist the DAQ state to conf/settings.json."""
        try:
            with open('conf/settings.json', 'w') as f:
                json.dump(self.daq_state, f, indent=4)
            self.logger.debug("Project configuration updated")
        except Exception as e:
            self.logger.error(f"Error updating project: {e}")
    
    def get_state(self) -> Dict[str, Any]:
        """
        Get current DAQ state.
        
        Returns:
            Complete DAQ state dictionary
        """
        return self.daq_state.copy()
    
    def is_running(self) -> bool:
        """True if a run is active (tracked via set_running_state)."""

        return self.daq_state['running']
    
    def get_run_number(self) -> int:
        """
        Get current run number.
        
        Returns:
            Current run number
        """
        return self.daq_state['run']
    
    def set_run_number(self, run_number: int) -> None:
        """
        Set run number.
        
        Args:
            run_number: New run number
        """
        self.daq_state['run'] = run_number
        self._update_project()
        self.logger.info(f"Run number set to {run_number}")
    
    def get_save_data(self) -> bool:
        """
        Get save data setting.
        
        Returns:
            True if data saving is enabled
        """
        return self.daq_state['save']
    
    def set_save_data(self, save: bool) -> None:
        """
        Set save data setting.
        
        Args:
            save: Enable/disable data saving
        """
        self.daq_state['save'] = save
        self._update_project()
        self.logger.info(f"Save data set to {save}")
    
    def get_limit_data_size(self) -> bool:
        """
        Get limit data size setting.
        
        Returns:
            True if data size limiting is enabled
        """
        return self.daq_state['limit_size']
    
    def set_limit_data_size(self, limit_size: bool) -> None:
        """
        Set limit data size setting.
        
        Args:
            limit_size: Enable/disable data size limiting
        """
        self.daq_state['limit_size'] = limit_size
        self._update_project()
        self.logger.info(f"Limit data size set to {limit_size}")
    
    def get_data_size_limit(self) -> int:
        """
        Get data size limit value.
        
        Returns:
            File size limit in bytes
        """
        return self.daq_state['file_size_limit']
    
    def set_data_size_limit(self, file_size_limit: int) -> None:
        """
        Set data size limit value.
        
        Args:
            file_size_limit: File size limit in bytes
        """
        self.daq_state['file_size_limit'] = file_size_limit
        self._update_project()
        self.logger.info(f"Data size limit set to {file_size_limit}")
    
    def get_start_time(self) -> Optional[str]:
        """
        Get DAQ start time.

        Returns:
            Start time string or None if not running
        """
        return self.daq_state.get('start_time')

    def get_boards(self) -> List[Dict[str, Any]]:
        """
        Get list of configured CAEN boards.
        
        Returns:
            List of board configuration dictionaries
        """
        return self.daq_state['boards'].copy()
    
    @staticmethod
    def _has_registers(config_file: str) -> bool:
        """Whether a board config exists AND actually carries registers.

        Older test-mode runs wrote a placeholder with an empty "registers" block;
        treat those as missing so they get regenerated with real defaults.
        """
        try:
            with open(config_file) as f:
                return bool(json.load(f).get("registers"))
        except Exception:
            return False

    @staticmethod
    def board_config_path(board: Dict[str, Any]) -> str:
        """Where a board's register dump lives."""
        return f"conf/{board.get('name')}_{board.get('id')}.json"

    def _repair_board_configs(self) -> None:
        """
        Rebuild register files that are missing or empty.

        The board list and the register dumps are separate files, so they can
        drift apart — a config deleted by hand, a copied settings.json, an
        interrupted first start. The symptom is a board that looks configured
        while /digitizer/<id>/registers answers "Registers not found", which
        reads as a broken page rather than as missing data. Rebuilding here
        means the server comes up consistent with what it advertises.
        """
        for board in self.daq_state.get('boards', []):
            config_file = self.board_config_path(board)
            if self._has_registers(config_file):
                continue

            board_id = str(board['id'])
            self.logger.warning(f"Board {board_id} has no register configuration at {config_file}")
            try:
                os.makedirs('conf', exist_ok=True)
                if self.test_flag:
                    config = default_board_config(
                        name=board.get('name', 'V1730'),
                        board_id=int(board['id']),
                        dpp=board.get('dpp', 'DPP-PSD'),
                        channels=int(board.get('chan', 16)),
                    )
                    with open(config_file, 'w') as f:
                        json.dump(config, f, indent=4)
                    self.logger.info(
                        f"Rebuilt default {board.get('dpp', 'DPP-PSD')} configuration for mock "
                        f"board {board_id} ({len(config['registers'])} registers)")
                elif self._read_registers_from_board(board, config_file):
                    self.logger.info(f"Re-read register configuration for board {board_id} from the board")
                else:
                    self.logger.error(
                        f"Board {board_id} is configured but its registers could not be read — "
                        "the tuner and the CAEN dashboard will have nothing to show. "
                        "Check the connection, then remove and re-add the board.")
            except Exception as e:
                self.logger.error(f"Could not rebuild configuration for board {board_id}: {e}")

    def _read_registers_from_board(self, board: Dict[str, Any], config_file: str) -> bool:
        """Dump a connected board's registers to its config file. False if unreachable."""
        board_id = str(board['id'])
        dgtz = self.digitizer_container.get_digitizer(board_id)
        if dgtz is None:
            return False
        lock = self.digitizer_container.get_connection_lock(board_id)
        try:
            if lock:
                lock.acquire()
            if not dgtz.get_connected():
                return False
            if board.get('dpp') == 'DPP-PHA':
                dgtz.read_pha(config_file)
            else:
                dgtz.read_psd(config_file)
        except Exception as e:
            self.logger.error(f"Reading registers from board {board_id} failed: {e}")
            return False
        finally:
            if lock:
                lock.release()
        return self._has_registers(config_file)

    def find_board_with_id(self, board_id: Any) -> Optional[Dict[str, Any]]:
        """The already-configured board using this id, or None.

        Compares as strings because ids arrive both as numbers (settings.json)
        and as strings (the REST API).
        """
        for board in self.daq_state['boards']:
            if str(board['id']) == str(board_id):
                return board.copy()
        return None

    def _validate_new_board(self, board_config: Dict[str, Any]) -> None:
        """
        Check a board can be added, and normalise its id.

        Board ids must be unique: the id names the board's configuration file,
        identifies the board inside the unified data file, and selects the master
        of a synchronised chain. Two boards sharing one would overwrite each
        other's configuration and make their data indistinguishable — so this is
        rejected up front, before any file is written or any board is opened.

        Raises:
            BoardConfigError: with a message meant for the operator
        """
        raw_id = board_config.get('id')
        if raw_id is None or str(raw_id).strip() == '':
            raise BoardConfigError("A board ID is required.")

        try:
            board_id = int(str(raw_id).strip())
        except (TypeError, ValueError):
            raise BoardConfigError(f"Board ID must be a whole number (got '{raw_id}').")

        if board_id < 0:
            raise BoardConfigError(f"Board ID must not be negative (got {board_id}).")

        existing = self.find_board_with_id(board_id)
        if existing is not None:
            raise BoardConfigError(
                f"Board ID {board_id} is already used by '{existing.get('name', 'another board')}'. "
                "Two boards cannot share an ID — it names the board's configuration file, "
                "identifies it in the data file, and picks the master of a synchronised chain. "
                "Give this board a different ID, or remove the existing one first."
            )

        # Store the id as a number so sorting and comparisons stay consistent
        # regardless of whether it arrived as "1" or 1.
        board_config['id'] = board_id

    def _insert_board_sorted(self, board_config: Dict[str, Any]) -> None:
        """Insert a board into daq_state['boards'], keeping it sorted by id."""
        board_id = int(board_config['id'])
        insert_index = 0
        for i, existing in enumerate(self.daq_state['boards']):
            if int(existing['id']) > board_id:
                insert_index = i
                break
            insert_index = i + 1
        self.daq_state['boards'].insert(insert_index, board_config)

    def add_board(self, board_config: Dict[str, Any]) -> bool:
        """
        Add a new CAEN board to the configuration.

        Args:
            board_config: Board configuration dictionary

        Returns:
            True if successful, False if the board could not be reached

        Raises:
            BoardConfigError: the configuration itself is invalid (e.g. an ID
                another board already uses). Raised before anything is written
                or opened, so a rejected board leaves no trace.
        """
        self._validate_new_board(board_config)

        try:
            # Test mode: no hardware. Register a mock board with sensible defaults
            # so the whole flow (add board -> start run -> mock data) works. The
            # MockDigitizer answers for any board added here.
            if self.test_flag:
                board_config.setdefault("name", "V1730")   # decodable default (PHA & PSD)
                board_config["chan"] = int(board_config.get("chan", 16))
                os.makedirs("conf", exist_ok=True)
                os.makedirs("calib", exist_ok=True)
                config_file = f"conf/{board_config['name']}_{board_config['id']}.json"
                # With no hardware to read, fabricate the register dump the
                # digitizer would have produced. It is the source of truth for
                # the dashboard and for how the run starts (0x8100), so an empty
                # one leaves the UI blank — regenerate those too.
                if not self._has_registers(config_file):
                    config = default_board_config(
                        name=board_config['name'],
                        board_id=int(board_config['id']),
                        dpp=board_config.get('dpp', 'DPP-PSD'),
                        channels=board_config['chan'],
                    )
                    with open(config_file, 'w') as f:
                        json.dump(config, f, indent=4)
                    self.logger.info(
                        f"Created default {board_config.get('dpp', 'DPP-PSD')} register "
                        f"configuration for mock board at {config_file} "
                        f"({len(config['registers'])} registers)")
                calib_file = f"calib/{board_config['name']}_{board_config['id']}.cal"
                with open(calib_file, 'w') as f:
                    for _ in range(board_config['chan']):
                        f.write("0.0 1.0\n")
                self._insert_board_sorted(board_config)
                self._update_project()
                self.logger.info(f"Added mock board: {board_config['name']} (ID {board_config['id']})")
                return True

            # Create persistent digitizer connection
            if not self.digitizer_container.add_board(board_config):
                self.logger.error(f"Failed to create persistent connection for board {board_config['id']}")
                return False
            
            # Get board information from the persistent connection
            board_id = str(board_config['id'])
            dgtz = self.digitizer_container.get_digitizer(board_id)
            
            if dgtz is None:
                self.logger.error(f"Failed to get digitizer instance for board {board_id}")
                return False
            
            # Get board information
            lock = self.digitizer_container.get_connection_lock(board_id)
            with lock:
                if dgtz.get_connected():
                    board_info = dgtz.get_info()
                    board_config["name"] = board_info["ModelName"]
                    board_config["chan"] = int(board_info["Channels"])
                    
                    # Read and save register configuration
                    config_file = f"conf/{board_config['name']}_{board_config['id']}.json"
                    if board_config["dpp"] == "DPP-PHA":
                        dgtz.read_pha(config_file)
                    elif board_config["dpp"] == "DPP-PSD":
                        dgtz.read_psd(config_file)
                else:
                    self.logger.error(f"Board {board_id} not connected after creation")
                    self.digitizer_container.remove_board(board_id)
                    return False

            # Open the file and search for reg_ef08 to set the "value" to board id
            with open(config_file, 'r') as f:
                config_data = json.load(f)
            if "reg_EF08" in config_data["registers"]:
                config_data["registers"]["reg_EF08"]["value"] = "0x" + str(int(board_config["id"]))
            with open(config_file, 'w') as f:
                json.dump(config_data, f, indent=4)
            
            # Create calibration file
            calib_file = f"calib/{board_config['name']}_{board_config['id']}.cal"
            with open(calib_file, 'w') as f:
                for channel in range(board_config['chan']):
                    f.write("0.0 1.0\n")
            
            # Add board to configuration in sorted order by board_id
            self._insert_board_sorted(board_config)

            # Update project
            self._update_project()
            
            self.logger.info(f"Added board: {board_config['name']} (ID: {board_config['id']})")
            return True
            
        except Exception as e:
            self.logger.error(f"Error adding board: {e}")
            # Clean up persistent connection on error
            board_id = str(board_config.get('id', ''))
            if board_id:
                self.digitizer_container.remove_board(board_id)
            return False
    
    def remove_board(self, board_id: str) -> bool:
        """
        Remove a CAEN board from the configuration.
        
        Args:
            board_id: ID of board to remove
            
        Returns:
            True if successful, False otherwise
        """
        try:
            board_id = str(board_id)  # Ensure it's a string
            
            # Find the board by ID
            board_index = None
            for i, board in enumerate(self.daq_state['boards']):
                if str(board['id']) == board_id:
                    board_index = i
                    break
            
            if board_index is not None:
                board = self.daq_state['boards'][board_index]
                
                # Remove persistent digitizer connection
                self.digitizer_container.remove_board(board_id)
                
                # Remove calibration file
                calib_file = f"calib/{board['name']}_{board['id']}.cal"
                if os.path.exists(calib_file):
                    os.remove(calib_file)
                
                # Remove board from configuration
                removed_board = self.daq_state['boards'].pop(board_index)
                
                # Update project
                self._update_project()
                
                self.logger.info(f"Removed board: {removed_board['name']} (ID: {removed_board['id']})")
                return True
            else:
                self.logger.warning(f"Board with ID {board_id} not found")
                return False
                
        except Exception as e:
            self.logger.error(f"Error removing board: {e}")
            return False
    
    def check_run_directory(self) -> bool:
        """
        Check if current run directory exists.
        
        Returns:
            True if run directory exists
        """
        run_dir = f"data/run{self.daq_state['run']}"
        return os.path.exists(run_dir)
    
    def prepare_run_start(self) -> bool:
        """
        Prepare for run start (create directories, copy configs).
        
        Returns:
            True if preparation successful
        """
        try:
            run_number = self.daq_state['run']
            save = self.daq_state['save']
            
            # Check if directory exists before starting DAQ
            data_dir = "data/"
            if not os.path.exists(data_dir):
                os.makedirs(data_dir)
            
            # If save is enabled, create the run directory
            if save:
                run_dir = f"data/run{run_number}/"
                if not os.path.exists(run_dir):
                    os.makedirs(run_dir)
                
                # Copy JSON configuration files to run directory
                for board in self.daq_state['boards']:
                    conf_file = f"conf/{board['name']}_{board['id']}.json"
                    if os.path.exists(conf_file):
                        os.system(f"cp {conf_file} {run_dir}")
            
            return True
            
        except Exception as e:
            self.logger.error(f"Error preparing run start: {e}")
            return False
    
    def set_running_state(self, running: bool, start_time: Optional[str] = None) -> None:
        """
        Set DAQ running state.
        
        Args:
            running: True if DAQ is running
            start_time: Start time string (auto-generated if None)
        """
        changed = bool(self.daq_state.get('running')) != bool(running)
        self.daq_state['running'] = running

        if running:
            self.board_status = {}   # reset board-failure flags at run start
            if start_time is None:
                # Emit a timezone-aware ISO 8601 timestamp (includes the local
                # UTC offset, e.g. 2026-05-27T14:30:00+02:00). Without the offset
                # the browser parses the string ambiguously and the run timer can
                # start with a wrong, sometimes negative, elapsed value.
                start_time = datetime.now().astimezone().isoformat()
            self.daq_state['start_time'] = start_time
        else:
            self.daq_state['start_time'] = None

        self._update_project()

        if changed:
            self._notify_run_state(bool(running))

    def add_run_state_listener(self, callback: Callable[[bool], None]) -> None:
        """
        Register `callback(running)`, called whenever a run starts or stops.

        Every path that begins or ends a run goes through set_running_state, so
        a listener sees the transition regardless of who caused it — the run
        buttons, an auto-restart, or a shutdown.
        """
        self.run_state_listeners.append(callback)

    def _notify_run_state(self, running: bool) -> None:
        """Tell the listeners the run state changed, without letting one break the rest."""
        for callback in list(self.run_state_listeners):
            try:
                callback(running)
            except Exception as e:
                self.logger.error(f"Run state listener failed: {e}")

    def increment_run_number(self) -> None:
        """Increment run number (typically after successful run)."""
        if self.daq_state['save'] or self.test_flag:
            self.daq_state['run'] += 1
            self._update_project()
            self.logger.info(f"Run number incremented to {self.daq_state['run']}")
    
    def get_file_bandwidth(self) -> float:
        """
        Current file write bandwidth in MB/s, summed across boards, from the
        caendaq statistics.
        """
        try:
            from .caen_acquisition import get_caen_acquisition
            total_bps = sum(b.get('write_rate', 0.0)
                            for b in get_caen_acquisition(self.test_flag).stats())
            return total_bps / (1024.0 * 1024.0)
        except Exception as e:
            self.logger.debug(f"Error getting file bandwidth: {e}")
            return 0.0
    
    def write_board_register(self, board_id: str, address: int, value: int) -> Dict[str, Any]:
        """
        Write a register straight to a board (online tuning).

        Which of the two ways in depends on who holds the board: during a run
        that is caendaq, between runs it is the probe connection. The caller
        does not need to know which.

        Only registers on the safe list are written; anything else is reported
        back unwritten, with the reason, so the change still lives in the
        configuration file and applies at the next start.

        Returns:
            {'written': bool, 'reason': str, 'via': 'run'|'probe'|''}
        """
        board = self.find_board_with_id(board_id)
        if board is None:
            return {'written': False, 'reason': f"No board with id {board_id}.", 'via': ''}

        allowed, reason = is_online_safe(int(address), board.get('dpp', 'DPP-PSD'))
        if not allowed:
            return {'written': False, 'reason': reason, 'via': ''}

        if self.is_running():
            from .caen_acquisition import get_caen_acquisition
            acquisition = get_caen_acquisition(self.test_flag)
            if acquisition.write_register(str(board_id), int(address), int(value)):
                return {'written': True, 'reason': '', 'via': 'run'}
            return {'written': False, 'via': 'run', 'reason': (
                "The running acquisition did not accept the write. The configuration has "
                "been saved and applies at the next run.")}

        if self.digitizer_container.write_register(str(board_id), int(address), int(value)):
            return {'written': True, 'reason': '', 'via': 'probe'}
        return {'written': False, 'via': 'probe', 'reason': (
            "The board did not accept the write — it may be disconnected. The configuration "
            "has been saved and applies at the next run.")}

    def release_digitizers(self) -> None:
        """Close the persistent probe connections so caendaq can open the boards
        for a run. Best-effort; a no-op in test mode / when nothing is connected."""
        for board_id in self.digitizer_container.get_all_board_ids():
            dgtz = self.digitizer_container.get_digitizer(board_id)
            lock = self.digitizer_container.get_connection_lock(board_id)
            if dgtz is None:
                continue
            try:
                if lock:
                    with lock:
                        if dgtz.get_connected():
                            dgtz.close()
                elif dgtz.get_connected():
                    dgtz.close()
            except Exception as e:
                self.logger.warning(f"release_digitizers: board {board_id}: {e}")

    def reacquire_digitizers(self) -> None:
        """Reopen the persistent probe connections after a run (best-effort)."""
        for board_id in self.digitizer_container.get_all_board_ids():
            dgtz = self.digitizer_container.get_digitizer(board_id)
            lock = self.digitizer_container.get_connection_lock(board_id)
            if dgtz is None:
                continue
            try:
                if lock:
                    with lock:
                        if not dgtz.get_connected():
                            dgtz.open()
                elif not dgtz.get_connected():
                    dgtz.open()
            except Exception as e:
                self.logger.warning(f"reacquire_digitizers: board {board_id}: {e}")

    def reset_acquisition(self) -> bool:
        """
        Reset the acquisition: stop board monitoring, tear down the caendaq DAQ,
        return the boards to the probe layer, and clear the running flag. Used by
        the 'Reset acquisition' button to recover from a stuck state.
        """
        try:
            self.stop_board_monitoring()
        except Exception as e:
            self.logger.debug(f"reset: stop monitoring: {e}")
        try:
            from .caen_acquisition import get_caen_acquisition
            get_caen_acquisition(self.test_flag).stop()
        except Exception as e:
            self.logger.warning(f"reset: error stopping acquisition: {e}")
        try:
            self.reacquire_digitizers()
        except Exception as e:
            self.logger.debug(f"reset: reacquire: {e}")
        self.set_running_state(False)
        return True
    
    def get_board_info(self, board_id: str) -> Optional[Dict[str, Any]]:
        """
        Get information for a specific board.
        
        Args:
            board_id: Board ID string
            
        Returns:
            Board configuration dictionary or None if not found
        """
        # Board ids reach us as strings from the URL, but may be stored as ints
        # (boards added through the API keep the string, older/hand-written
        # settings.json files use numbers). Compare as strings so either works.
        for board in self.daq_state['boards']:
            if str(board['id']) == str(board_id):
                return board.copy()
        return None
    
    def get_board_by_index(self, index: int) -> Optional[Dict[str, Any]]:
        """
        Get board information by index.
        
        Args:
            index: Board index in the list
            
        Returns:
            Board configuration dictionary or None if not found
        """
        if 0 <= index < len(self.daq_state['boards']):
            return self.daq_state['boards'][index].copy()
        return None
    
    def _monitor_boards_thread(self) -> None:
        """
        Monitor board health from caendaq's board-FAIL counter (bit 26 of the
        aggregate header) — no board is polled directly, so there is no conflict
        with caendaq owning the digitizers during a run. On the FIRST failure of a
        board it sends a Telegram notification and, if enabled, triggers the
        auto-restart callback (once per board per run).
        """
        self.logger.info("Board monitoring thread started (caendaq board-FAIL)")

        try:
            from .caen_acquisition import get_caen_acquisition
            acq = get_caen_acquisition(self.test_flag)
        except Exception as e:
            self.logger.error(f"Board monitoring: no caendaq acquisition: {e}")
            acq = None

        while not self.monitor_stop_event.is_set():
            try:
                if acq is not None and acq.is_running():
                    for board_id, h in acq.board_health().items():
                        st = self.board_status.setdefault(
                            board_id, {'failed': False, 'failures': 0, 'last_value': 0})
                        failures = int(h.get('failures', 0))
                        st['failures'] = failures
                        st['last_value'] = failures

                        # Act only on the first transition to "failed" for a board.
                        if h.get('failed') and not st['failed']:
                            st['failed'] = True
                            self.logger.warning(
                                f"Board {board_id} FAILED (caendaq FAIL bit; {failures} aggregates)")
                            self.send_board_failure_notification(
                                board_id, self._get_failure_type_string(failures),
                                self.daq_state['run'])
                            if self.auto_restart_enabled and not self.restart_pending:
                                self._handle_auto_restart(board_id, failures)

            except Exception as e:
                self.logger.error(f"Error in board monitoring thread: {e}")

            if self.monitor_stop_event.wait(1.0):
                break

        self.logger.info("Board monitoring thread stopped")

    def _get_failure_type_string(self, failure_value: int) -> str:
        """
        Convert failure register value to human-readable string.

        Args:
            failure_value: The register value indicating the failure type

        Returns:
            Human-readable failure type string
        """
        if failure_value & 0x04:  # Bit 2 indicates PLL Lock Loss
            return "PLL Lock Loss"
        elif failure_value & 0x01:  # Bit 0 indicates Generic Failure
            return "Generic Failure"
        else:
            return f"Board Error (0x{failure_value:X})"

    def _handle_auto_restart(self, board_id: str, failure_value: int) -> None:
        """
        Handle auto-restart when a board failure is detected.
        Waits for the configured delay, then triggers the restart callback.

        Args:
            board_id: ID of the failed board
            failure_value: The register value indicating the failure type
        """
        self.restart_pending = True

        # Determine failure type from the register value
        failure_type = self._get_failure_type_string(failure_value)

        self.logger.warning(f"Auto-restart triggered: Board {board_id} - {failure_type}")
        self.logger.info(f"Waiting {self.auto_restart_delay} seconds before restart...")

        # Store restart info for later use
        self.last_restart_info = {
            'board_id': board_id,
            'failure_type': failure_type,
            'failure_value': failure_value,
            'timestamp': datetime.now().isoformat(),
            'run_number': self.daq_state['run']
        }

        # Wait for the configured delay (checking if we should stop)
        for _ in range(self.auto_restart_delay):
            if self.monitor_stop_event.is_set():
                self.logger.info("Auto-restart cancelled - monitoring stopped")
                self.restart_pending = False
                return
            time.sleep(1)

        # Signal the monitoring thread to stop its loop
        self.monitor_stop_event.set()

        # Run the restart callback in a separate thread so we don't try to
        # join the monitoring thread from within itself
        if self.restart_callback:
            self.logger.info("Triggering restart callback...")
            restart_thread = threading.Thread(
                target=self._execute_restart_callback,
                args=(board_id, failure_type),
                daemon=True
            )
            restart_thread.start()
        else:
            self.logger.warning("No restart callback registered - cannot auto-restart")
            self.restart_pending = False

    def _execute_restart_callback(self, board_id: str, failure_type: str) -> None:
        """
        Execute the restart callback in a separate thread.
        Waits for the monitoring thread to exit first to avoid conflicts.

        Args:
            board_id: ID of the failed board
            failure_type: Description of the failure type
        """
        try:
            # Wait for the monitoring thread to finish exiting
            if self.monitor_thread and self.monitor_thread.is_alive():
                self.monitor_thread.join(timeout=10.0)

            self.restart_callback(board_id, failure_type)
        except Exception as e:
            self.logger.error(f"Error in restart callback: {e}")
        finally:
            self.restart_pending = False
    
    def start_board_monitoring(self) -> None:
        """
        Start the board monitoring thread.
        Should be called when a run starts.
        """
        if self.monitor_thread and self.monitor_thread.is_alive():
            self.logger.warning("Board monitoring thread already running")
            return

        # Reset all board statuses
        for board in self.daq_state['boards']:
            board_id = str(board['id'])
            self.board_status[board_id] = {'failed': False, 'last_value': 0}

        # Reset Telegram notification flag for new run
        self.reset_telegram_notification_flag()

        # Start monitoring thread
        self.monitor_stop_event.clear()
        self.monitor_thread = threading.Thread(target=self._monitor_boards_thread, daemon=True)
        self.monitor_thread.start()
        self.logger.info("Board monitoring started")
    
    def stop_board_monitoring(self) -> None:
        """
        Stop the board monitoring thread.
        Should be called when a run stops.
        """
        if self.monitor_thread and self.monitor_thread.is_alive():
            self.monitor_stop_event.set()
            self.monitor_thread.join(timeout=5.0)
            if self.monitor_thread.is_alive():
                self.logger.warning("Board monitoring thread did not stop gracefully")
            else:
                self.logger.info("Board monitoring stopped")
        else:
            self.logger.info("Board monitoring was not running")
    
    def get_board_status(self) -> Dict[str, Dict[str, Any]]:
        """
        Current per-board status, keyed by board id: {'failed': bool, 'failures': int}.

        During a run this is driven by caendaq's board-FAIL counter (bit 26 of the
        aggregate header). A board that fails even once stays flagged for the rest
        of the run (the flag is reset at run start). No board is polled directly.
        """
        try:
            from .caen_acquisition import get_caen_acquisition
            acq = get_caen_acquisition(self.test_flag)
            if acq.is_running():
                for bid, h in acq.board_health().items():
                    prev = self.board_status.get(bid, {})
                    failures = int(h.get('failures', 0))
                    self.board_status[bid] = {
                        'failed': bool(h.get('failed')) or bool(prev.get('failed')),
                        'failures': failures,
                        'last_value': failures,  # kept for frontend compatibility
                    }
        except Exception as e:
            self.logger.debug(f"get_board_status caendaq merge failed: {e}")
        return self.board_status.copy()

    def get_auto_restart_enabled(self) -> bool:
        """
        Get auto-restart on failure setting.

        Returns:
            True if auto-restart is enabled
        """
        return self.auto_restart_enabled

    def set_auto_restart_enabled(self, enabled: bool) -> None:
        """
        Set auto-restart on failure setting.

        Args:
            enabled: Enable/disable auto-restart on board failure
        """
        self.auto_restart_enabled = enabled
        self.logger.info(f"Auto-restart on failure set to {enabled}")

    def get_auto_restart_delay(self) -> int:
        """
        Get auto-restart delay in seconds.

        Returns:
            Delay in seconds before auto-restart
        """
        return self.auto_restart_delay

    def set_auto_restart_delay(self, delay: int) -> None:
        """
        Set auto-restart delay in seconds.

        Args:
            delay: Delay in seconds before auto-restart (minimum 5 seconds)
        """
        self.auto_restart_delay = max(5, delay)
        self.logger.info(f"Auto-restart delay set to {self.auto_restart_delay} seconds")

    def register_restart_callback(self, callback) -> None:
        """
        Register a callback function to be called when auto-restart is triggered.
        The callback receives (board_id, failure_type) as arguments.

        Args:
            callback: Callable that takes (board_id: str, failure_type: str)
        """
        self.restart_callback = callback
        self.logger.info("Restart callback registered")

    def get_last_restart_info(self) -> Optional[Dict[str, Any]]:
        """
        Get information about the last auto-restart event.

        Returns:
            Dictionary with restart info or None if no restart has occurred
        """
        return self.last_restart_info

    def is_restart_pending(self) -> bool:
        """
        Check if a restart is currently pending (waiting for delay).

        Returns:
            True if restart is pending
        """
        return self.restart_pending

    # ==================== Telegram Notification Methods ====================

    # --- Telegram (delegated to TelegramNotifier) ---
    def get_telegram_settings(self) -> Dict[str, Any]:
        return self.telegram.get_settings()

    def set_telegram_settings(self, enabled: bool = None, bot_token: str = None, chat_id: str = None) -> None:
        self.telegram.set_settings(enabled=enabled, bot_token=bot_token, chat_id=chat_id)

    def test_telegram_connection(self) -> Dict[str, Any]:
        return self.telegram.test_connection()

    def reset_telegram_notification_flag(self) -> None:
        self.telegram.reset_notification_flag()

    def send_board_failure_notification(self, board_id: str, failure_type: str, run_number: int) -> bool:
        return self.telegram.send_board_failure(
            board_id, failure_type, run_number,
            self.auto_restart_enabled, self.auto_restart_delay)

    def _board_held_by_acquisition(self, board_id: str) -> bool:
        """Whether caendaq currently holds this board open for the running acquisition.

        Says nothing about the link being healthy — that is what the 'failed' flag
        from board monitoring is for. It answers only "who owns this board", which
        is what connectivity needs while the probe layer has let go of it.
        """
        try:
            from .caen_acquisition import get_caen_acquisition
            acq = get_caen_acquisition(self.test_flag)
            return acq.is_running() and acq.board_index(str(board_id)) is not None
        except Exception as e:
            self.logger.debug(f"connectivity: no caendaq state for board {board_id}: {e}")
            return False

    def check_board_connectivity(self) -> Dict[str, Dict[str, Any]]:
        """
        Check connectivity status of all configured boards.

        Which layer to ask depends on who owns the boards. Outside a run that is
        the persistent probe connections. During a run it is caendaq: start_run
        calls release_digitizers() to hand the boards over, so the probe layer has
        no connections left and asking it would report every board as
        disconnected mid-run while the acquisition is reading them perfectly well.

        Returns:
            Dictionary mapping board_id to connectivity status:
            {'connected': bool, 'ready': bool, 'failed': bool}
        """
        board_connectivity = {}

        for board in self.daq_state['boards']:
            board_id = str(board['id'])
            connectivity_status = {
                'connected': False,
                'ready': False,
                'failed': self.board_status.get(board_id, {}).get('failed', False)
            }
            
            if self.test_flag:
                # In test mode, simulate connectivity
                connectivity_status['connected'] = True
                connectivity_status['ready'] = not self.is_running()
            elif self.is_running():
                # caendaq owns the boards for the duration of the run.
                connectivity_status['connected'] = self._board_held_by_acquisition(board_id)
                connectivity_status['ready'] = False
            else:
                # Use persistent digitizer connection
                connectivity_status['connected'] = self.digitizer_container.is_connected(board_id)
                connectivity_status['ready'] = connectivity_status['connected'] and not self.is_running()
            
            board_connectivity[board_id] = connectivity_status
        
        return board_connectivity
    
    def refresh_board_connection(self, board_id: str) -> bool:
        """
        Refresh persistent connection for a specific board.
        
        Args:
            board_id: Board ID string
            
        Returns:
            True if successful, False otherwise
        """
        # Find the board configuration
        board_config = None
        for board in self.daq_state['boards']:
            if str(board['id']) == str(board_id):
                board_config = board
                break
        
        if board_config is None:
            self.logger.error(f"Board configuration not found for board {board_id}")
            return False
        
        return self.digitizer_container.refresh_board_connection(board_id, board_config)
    
    def cleanup(self) -> None:
        """
        Clean up resources when shutting down the DAQ manager.
        Closes all persistent digitizer connections and stops monitoring.
        """
        self.logger.info("Cleaning up DAQ manager resources")
        
        # Stop board monitoring thread
        self.stop_board_monitoring()
        
        # Clean up all digitizer connections
        self.digitizer_container.cleanup()
        
        # Clear board status
        self.board_status.clear()
        
        self.logger.info("DAQ manager cleanup completed")
    
    def __del__(self) -> None:
        """Destructor - ensure cleanup is called."""
        try:
            self.cleanup()
        except Exception as e:
            # Use print instead of logger since logger may not be available during destruction
            print(f"Error during DAQ manager cleanup: {e}")


# Global instance - will be initialized by the application
daq_manager = None

def get_daq_manager(test_flag: bool = False) -> DAQManager:
    """
    Get or create the global DAQ manager instance.
    
    Args:
        test_flag: Enable test mode
        
    Returns:
        DAQ manager instance
    """
    global daq_manager
    if daq_manager is None:
        daq_manager = DAQManager(test_flag=test_flag)
    return daq_manager