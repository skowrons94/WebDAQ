"""
DAQ Manager Module

This module provides centralized management of the Data Acquisition (DAQ) system state,
including board configurations, run control, and settings persistence. It extracts
the DAQ logic from the experiment routes to improve code organization.

Key Features:
- DAQ state management (running status, run number, save settings)
- Board configuration management (add/remove CAEN boards)
- Settings persistence to JSON files
- XDAQ topology configuration
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
from datetime import datetime
from typing import Dict, List, Optional, Any

from ..utils import xdaq
from ..utils.dgtz import digitizer

logger = logging.getLogger(__name__)

class DigitizerContainer:
    """
    Container class to manage persistent digitizer connections.
    Maintains open digitizer connections to avoid frequent open/close operations.
    """
    
    def __init__(self, test_flag: bool = False):
        """
        Initialize the digitizer container.
        
        Args:
            test_flag: Enable test mode for development
        """
        self.logger = logging.getLogger(__name__ + '.DigitizerContainer')
        self.test_flag = test_flag
        self.digitizers = {}  # {board_id: digitizer_instance}
        self.connection_locks = {}  # {board_id: threading.Lock}
    
    def _create_digitizer(self, board_config: Dict[str, Any]) -> Optional[digitizer]:
        """
        Create and open a digitizer connection with retry logic.
        
        Args:
            board_config: Board configuration dictionary
            
        Returns:
            Digitizer instance or None if failed
        """
        if self.test_flag:
            return None
        
        link_type_map = {"USB": 0, "Optical": 1, "A4818": 2}
        link_type = link_type_map.get(board_config["link_type"], 0)
        
        dgtz = digitizer(
            link_type, 
            int(board_config["link_num"]), 
            int(board_config["id"]), 
            int(board_config["vme"], 16)
        )
        
        # Try to open connection with up to 3 attempts
        for attempt in range(3):
            try:
                dgtz.open()
                if dgtz.get_connected():
                    self.logger.info(f"Successfully connected to board {board_config['id']} on attempt {attempt + 1}")
                    return dgtz
                else:
                    self.logger.warning(f"Failed to connect to board {board_config['id']} on attempt {attempt + 1}")
            except Exception as e:
                self.logger.error(f"Exception connecting to board {board_config['id']} on attempt {attempt + 1}: {e}")
            
            # Wait 1 second before retry (except on the last attempt)
            if attempt < 2:
                time.sleep(1.0)
        
        # All attempts failed
        self.logger.error(f"Failed to connect to board {board_config['id']} after 3 attempts")
        return None
    
    def add_board(self, board_config: Dict[str, Any]) -> bool:
        """
        Add a board and create persistent digitizer connection.
        
        Args:
            board_config: Board configuration dictionary
            
        Returns:
            True if successful, False otherwise
        """
        board_id = str(board_config['id'])
        
        # Create lock for this board
        self.connection_locks[board_id] = threading.Lock()
        
        # Create and store digitizer connection
        dgtz = self._create_digitizer(board_config)
        if dgtz is not None:
            self.digitizers[board_id] = dgtz
            self.logger.info(f"Added persistent connection for board {board_id}")
            return True
        else:
            # Clean up lock if connection failed
            self.connection_locks.pop(board_id, None)
            return False
    
    def remove_board(self, board_id: str) -> None:
        """
        Remove a board and close its digitizer connection.
        
        Args:
            board_id: Board ID string
        """
        board_id = str(board_id)
        
        # Close and remove digitizer connection
        if board_id in self.digitizers:
            try:
                self.digitizers[board_id].close()
                self.logger.info(f"Closed connection for board {board_id}")
            except Exception as e:
                self.logger.error(f"Error closing connection for board {board_id}: {e}")
            
            del self.digitizers[board_id]
        
        # Remove lock
        self.connection_locks.pop(board_id, None)
    
    def get_digitizer(self, board_id: str) -> Optional[digitizer]:
        """
        Get digitizer instance for a board.
        
        Args:
            board_id: Board ID string
            
        Returns:
            Digitizer instance or None if not found
        """
        return self.digitizers.get(str(board_id))
    
    def get_connection_lock(self, board_id: str) -> Optional[threading.Lock]:
        """
        Get connection lock for a board.
        
        Args:
            board_id: Board ID string
            
        Returns:
            Lock instance or None if not found
        """
        return self.connection_locks.get(str(board_id))
    
    def is_connected(self, board_id: str) -> bool:
        """
        Check if board is connected.
        
        Args:
            board_id: Board ID string
            
        Returns:
            True if connected, False otherwise
        """
        if self.test_flag:
            return True
        
        dgtz = self.get_digitizer(board_id)
        if dgtz is None:
            return False
        
        try:
            return dgtz.get_connected()
        except Exception as e:
            self.logger.error(f"Error checking connection for board {board_id}: {e}")
            return False
    
    def read_register(self, board_id: str, address: int) -> Optional[int]:
        """
        Read register from a board using persistent connection.
        
        Args:
            board_id: Board ID string
            address: Register address
            
        Returns:
            Register value or None if failed
        """
        if self.test_flag:
            return 0
        
        dgtz = self.get_digitizer(board_id)
        if dgtz is None:
            return None
        
        lock = self.get_connection_lock(board_id)
        if lock is None:
            return None
        
        try:
            with lock:
                if dgtz.get_connected():
                    return dgtz.read_register(address)
                else:
                    self.logger.warning(f"Board {board_id} not connected for register read")
                    return None
        except Exception as e:
            self.logger.error(f"Error reading register 0x{address:X} from board {board_id}: {e}")
            return None
    
    def refresh_board_connection(self, board_id: str, board_config: Dict[str, Any]) -> bool:
        """
        Refresh connection for a specific board (close and reopen).
        
        Args:
            board_id: Board ID string
            board_config: Board configuration dictionary
            
        Returns:
            True if successful, False otherwise
        """
        self.remove_board(board_id)
        return self.add_board(board_config)
    
    def get_all_board_ids(self) -> List[str]:
        """
        Get list of all board IDs with persistent connections.
        
        Returns:
            List of board ID strings
        """
        return list(self.digitizers.keys())
    
    def cleanup(self) -> None:
        """Close all digitizer connections."""
        for board_id, dgtz in self.digitizers.items():
            try:
                dgtz.close()
                self.logger.info(f"Closed connection for board {board_id}")
            except Exception as e:
                self.logger.error(f"Error closing connection for board {board_id}: {e}")
        
        self.digitizers.clear()
        self.connection_locks.clear()

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
        
        # Initialize persistent connections for existing boards
        for board in self.daq_state.get('boards', []):
            board_id = str(board['id'])
            if not self.digitizer_container.add_board(board):
                self.logger.warning(f"Failed to create persistent connection for board {board_id}")
        
        # Initialize XDAQ topology if not in test mode
        if not self.test_flag:
            self.topology = xdaq.topology("conf/topology.xml")
            self.topology.load_topology()
            self.topology.display()
            
            # Initialize container
            directory = os.path.realpath("./")
            self.container = xdaq.container(directory)
            self.container.initialize()
            self.logger.info("XDAQ container initialized")
            
            # Configure and enable PT
            self.topology.configure_pt()
            self.logger.info("PT configured")
            self.topology.enable_pt()
            self.logger.info("PT enabled")
        else:
            self.topology = None
            self.container = None
            self.logger.info("Running in test mode - XDAQ disabled")
        
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
            'boards': []
        }
        
        try:
            with open(settings_file, 'w') as f:
                json.dump(default_state, f, indent=4)
            self.logger.info("Created default DAQ state")
        except Exception as e:
            self.logger.error(f"Error saving default DAQ state: {e}")
        
        return default_state
    
    def _update_project(self) -> None:
        """Update project configuration files."""
        try:
            # Save DAQ state to JSON
            with open('conf/settings.json', 'w') as f:
                json.dump(self.daq_state, f, indent=4)
            
            # Update XDAQ configuration if not in test mode
            if not self.test_flag and self.topology:
                self.topology.write_ruconf(self.daq_state)
            
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
        """
        Check if DAQ is currently running.
        
        Returns:
            True if DAQ is running, False otherwise
        """
        if not self.test_flag and self.topology:
            try:
                status = self.topology.get_daq_status()
                self.daq_state['running'] = (status == "Running")
            except Exception as e:
                self.logger.warning(f"Error checking DAQ status: {e}")
                self.daq_state['running'] = False
        
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
    
    def add_board(self, board_config: Dict[str, Any]) -> bool:
        """
        Add a new CAEN board to the configuration.
        
        Args:
            board_config: Board configuration dictionary
            
        Returns:
            True if successful, False otherwise
        """
        try:
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
            board_id = int(board_config['id'])
            insert_index = 0
            for i, existing_board in enumerate(self.daq_state['boards']):
                if int(existing_board['id']) > board_id:
                    insert_index = i
                    break
                insert_index = i + 1
            
            self.daq_state['boards'].insert(insert_index, board_config)
            
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
    
    def configure_xdaq_for_run(self) -> bool:
        """
        Configure XDAQ for the current run.
        
        Returns:
            True if configuration successful
        """
        if self.test_flag or not self.topology:
            return True
        
        try:
            run_number = self.daq_state['run']
            save = self.daq_state['save']
            limit_size = self.daq_state['limit_size']
            file_size_limit = self.daq_state['file_size_limit']
            
            # Configure XDAQ
            self.topology.set_cycle_counter(0)
            
            if limit_size:
                self.topology.set_file_size_limit(file_size_limit)
            else:
                self.topology.set_file_size_limit(0)
            
            self.topology.set_run_number(run_number)
            self.topology.set_enable_files(save)
            self.topology.set_file_paths(f"/home/xdaq/project/data/run{run_number}/")
            
            self.topology.configure()
            
            return True
            
        except Exception as e:
            self.logger.error(f"Error configuring XDAQ: {e}")
            return False
    
    def start_xdaq(self) -> bool:
        """
        Start XDAQ data acquisition.
        
        Returns:
            True if start successful
        """
        if self.test_flag or not self.topology:
            return True
        
        try:
            self.topology.start()
            return True
        except Exception as e:
            self.logger.error(f"Error starting XDAQ: {e}")
            return False
    
    def stop_xdaq(self) -> bool:
        """
        Stop XDAQ data acquisition.
        
        Returns:
            True if stop successful
        """
        if self.test_flag or not self.topology:
            return True
        
        try:
            self.topology.halt()
            return True
        except Exception as e:
            self.logger.error(f"Error stopping XDAQ: {e}")
            return False
    
    def set_running_state(self, running: bool, start_time: Optional[str] = None) -> None:
        """
        Set DAQ running state.
        
        Args:
            running: True if DAQ is running
            start_time: Start time string (auto-generated if None)
        """
        self.daq_state['running'] = running
        
        if running:
            if start_time is None:
                start_time = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            self.daq_state['start_time'] = start_time
        else:
            self.daq_state['start_time'] = None
        
        self._update_project()
    
    def increment_run_number(self) -> None:
        """Increment run number (typically after successful run)."""
        if self.daq_state['save'] or self.test_flag:
            self.daq_state['run'] += 1
            self._update_project()
            self.logger.info(f"Run number incremented to {self.daq_state['run']}")
    
    def get_file_bandwidth(self) -> float:
        """
        Get current file bandwidth from XDAQ.
        
        Returns:
            File bandwidth in MB/s
        """
        if not self.daq_state['running'] or self.test_flag or not self.topology:
            return 0.0
        
        try:
            actors = self.topology.get_all_actors()
            total_bandwidth = 0.0
            for actor in actors:
                for a in actor:
                    total_bandwidth += float(a.get_file_bandwith())
            return total_bandwidth
        except Exception as e:
            self.logger.error(f"Error getting file bandwidth: {e}")
            return 0.0
    
    def get_output_bandwidth(self) -> float:
        """
        Get current output bandwidth from XDAQ.
        
        Returns:
            Output bandwidth in MB/s
        """
        if not self.daq_state['running'] or self.test_flag or not self.topology:
            return 0.0
        
        try:
            actors = self.topology.get_all_actors()
            total_bandwidth = 0.0
            for actor in actors:
                for a in actor:
                    total_bandwidth += float(a.get_output_bandwith())
            return total_bandwidth
        except Exception as e:
            self.logger.error(f"Error getting output bandwidth: {e}")
            return 0.0
    
    def reset_xdaq(self) -> bool:
        """
        Reset XDAQ system.
        
        Returns:
            True if reset successful
        """
        if self.test_flag:
            return True
        
        try:
            # Reinitialize topology
            self.topology = xdaq.topology("conf/topology.xml")
            self.topology.load_topology()
            self.topology.display()
            
            # Reset container
            self.container.reset()
            self.logger.info("XDAQ container reset")
            
            # Reconfigure and enable PT
            self.topology.configure_pt()
            self.logger.info("PT reconfigured")
            self.topology.enable_pt()
            self.logger.info("PT re-enabled")
            
            return True
            
        except Exception as e:
            self.logger.error(f"Error resetting XDAQ: {e}")
            return False
    
    def get_board_info(self, board_id: str) -> Optional[Dict[str, Any]]:
        """
        Get information for a specific board.
        
        Args:
            board_id: Board ID string
            
        Returns:
            Board configuration dictionary or None if not found
        """
        for board in self.daq_state['boards']:
            if board['id'] == board_id:
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
        Thread function to monitor board status by reading address 0x8178 using persistent connections.
        Runs every second and checks for non-zero values which indicate board failure.
        """
        self.logger.info("Board monitoring thread started")
        
        while not self.monitor_stop_event.is_set():
            try:
                for board in self.daq_state['boards']:
                    board_id = str(board['id'])
                    
                    # Initialize board status if not exists
                    if board_id not in self.board_status:
                        self.board_status[board_id] = {'failed': False, 'last_value': 0}
                    
                    # Skip if already failed (once failed, stays failed)
                    if self.board_status[board_id]['failed']:
                        continue
                    
                    # If already have a non-zero last value, skip further checks
                    if self.board_status[board_id]['last_value'] != 0:
                        continue
                    
                    try:
                        # Read register 0x8178 using persistent connection
                        value = self.digitizer_container.read_register(board_id, 0x8178)
                        
                        if value is not None:
                            self.board_status[board_id]['last_value'] = value
                            
                            # Check if value is non-zero (indicates failure)
                            if value != 0:
                                self.board_status[board_id]['failed'] = True
                                self.logger.warning(f"Board {board_id} failed - address 0x8178 = 0x{value:X}")
                        else:
                            # Try refreshing the connection once
                            self.refresh_board_connection(board_id)
                            self.logger.warning(f"Could not read register from board {board_id} for monitoring")
                            
                    except Exception as e:
                        # Try refreshing the connection once
                        self.refresh_board_connection(board_id)
                        self.logger.error(f"Error monitoring board {board_id}: {e}")
                
                # Sleep for 1 second or until stop event is set
                if not self.monitor_stop_event.wait(1.0):
                    continue
                else:
                    break
                    
            except Exception as e:
                self.logger.error(f"Error in board monitoring thread: {e}")
                if not self.monitor_stop_event.wait(1.0):
                    continue
                else:
                    break
        
        self.logger.info("Board monitoring thread stopped")
    
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
        Get current status of all boards.
        
        Returns:
            Dictionary mapping board_id to status info: {'failed': bool, 'last_value': int}
        """
        return self.board_status.copy()

    def check_board_connectivity(self) -> Dict[str, Dict[str, Any]]:
        """
        Check connectivity status of all configured boards using persistent connections.
        
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