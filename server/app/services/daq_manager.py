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
        
        # Initialize board monitoring
        self.board_status = {}  # Track board failure status: {board_id: {'failed': bool, 'last_value': int}}
        self.monitor_thread = None
        self.monitor_stop_event = threading.Event()
        
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
            # Convert link type to numeric value
            link_type_map = {"USB": 0, "Optical": 1, "A4818": 2}
            link_type = link_type_map.get(board_config["link_type"], 0)
            
            # Create digitizer instance and connect
            dgtz = digitizer(
                link_type, 
                int(board_config["link_num"]), 
                int(board_config["id"]), 
                int(board_config["vme"], 16)
            )
            dgtz.open()
            
            if not dgtz.get_connected():
                self.logger.error(f"Failed to connect to board {board_config['id']}")
                return False
            
            # Get board information
            board_info = dgtz.get_info()
            board_config["name"] = board_info["ModelName"]
            board_config["chan"] = int(board_info["Channels"])
            
            # Add board to configuration
            self.daq_state['boards'].append(board_config)
            
            # Read and save register configuration
            config_file = f"conf/{board_config['name']}_{board_config['id']}.json"
            if board_config["dpp"] == "DPP-PHA":
                dgtz.read_pha(config_file)
            elif board_config["dpp"] == "DPP-PSD":
                dgtz.read_psd(config_file)

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
                for i in range(board_config['chan']):
                    f.write("0.0 1.0\n")
            
            # Close connection
            dgtz.close()
            
            # Update project
            self._update_project()
            
            self.logger.info(f"Added board: {board_config['name']} (ID: {board_config['id']})")
            return True
            
        except Exception as e:
            self.logger.error(f"Error adding board: {e}")
            return False
    
    def remove_board(self, board_index: int) -> bool:
        """
        Remove a CAEN board from the configuration.
        
        Args:
            board_index: Index of board to remove
            
        Returns:
            True if successful, False otherwise
        """
        try:
            if 0 <= board_index < len(self.daq_state['boards']):
                board = self.daq_state['boards'][board_index]
                
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
                self.logger.warning(f"Invalid board index: {board_index}")
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
        Thread function to monitor board status by reading address 0x8178.
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
                    
                    try:
                        # Create digitizer connection
                        link_type_map = {"USB": 0, "Optical": 1, "A4818": 2}
                        link_type = link_type_map.get(board["link_type"], 0)
                        
                        dgtz = digitizer(
                            link_type, 
                            int(board["link_num"]), 
                            int(board["id"]), 
                            int(board["vme"], 16)
                        )
                        
                        # If already have a non-zero last value, skip further checks
                        if( self.board_status[board_id]['last_value'] != 0):
                            continue
                        
                        # Open connection and read address 0x8178
                        dgtz.open()
                        if dgtz.get_connected():
                            value = dgtz.read_register(0x8178)
                            self.board_status[board_id]['last_value'] = value
                            
                            # Check if value is non-zero (indicates failure)
                            if value != 0:
                                self.board_status[board_id]['failed'] = True
                                self.logger.warning(f"Board {board_id} failed - address 0x8178 = 0x{value:X}")
                            
                            dgtz.close()
                        else:
                            self.logger.warning(f"Could not connect to board {board_id} for monitoring")
                            
                    except Exception as e:
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