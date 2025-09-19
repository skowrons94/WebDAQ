"""
TetrAMM Controller Utility Module

This module provides a Python interface for communicating with TetrAMM
(4-channel picoammeter) devices for precise current measurements in 
scientific applications. It handles TCP/IP communication, data acquisition,
Graphite integration, and file-based data logging.

Key Features:
- TCP/IP communication with TetrAMM devices
- Continuous current measurement acquisition
- Real-time data streaming to Graphite database
- File-based data logging during experiments
- Configurable measurement parameters
- Thread-safe data access and buffering
- Comprehensive error handling and logging

Author: Scientific DAQ Team
Purpose: Current measurement interface for LUNA experiment
"""

import socket
import threading
import time
import json
import os
import logging
from datetime import datetime
from typing import Dict, Any, Union

import numpy as np

# Configure logging
logger = logging.getLogger(__name__)


class TetrAMMController:
    """
    Controller class for TetrAMM 4-channel picoammeter devices.
    
    Manages TCP/IP communication, data acquisition, and integration with
    monitoring systems for precise current measurements in scientific experiments.
    """
    
    def __init__(self, 
                 ip: str = '169.254.145.10', 
                 port: int = 10001, 
                 graphite_host: str = '172.18.9.54', 
                 graphite_port: int = 2003):
        """
        Initialize TetrAMM controller with network parameters.
        
        Args:
            ip: IP address of the TetrAMM device
            port: TCP port for TetrAMM communication (default: 10001)
            graphite_host: Graphite server hostname for metrics
            graphite_port: Graphite server port for metrics (default: 2003)
        """
        self.logger = logging.getLogger(__name__ + '.TetrAMMController')
        
        # Network configuration
        self.ip = ip
        self.port = port
        self.graphite_host = graphite_host
        self.graphite_port = graphite_port
        
        # Connection management
        self.socket = None
        self.connection_timeout = 2.0
        
        # Data acquisition threading
        self.acquisition_thread = None
        self.is_acquiring = False
        self.acquisition_interval = 0.5  # seconds between measurements
        
        # Data logging
        self.save_data = False
        self.save_folder = ''
        self.run_start_time = 0
        
        # Data buffering (circular buffers for 100k samples)
        self.buffer_size = 100000
        self.buffer_lock = threading.Lock()
        self.times = np.zeros(self.buffer_size)
        self.values = {
            "0": np.zeros(self.buffer_size),
            "1": np.zeros(self.buffer_size), 
            "2": np.zeros(self.buffer_size),
            "3": np.zeros(self.buffer_size)
        }
        
        # Charge accumulation tracking
        self.accumulated_charge = 0.0  # Reset to 0 when run starts, only increases when saving data
        self.total_accumulated_charge = 0.0  # Always increases
        self.previous_time = 0.0
        
        # Device settings
        self.settings = {}
        self.load_settings()
        
        self.logger.info(f"TetrAMM controller initialized for device at {ip}:{port}")
    
    def set_ip(self, ip: str) -> None:
        """
        Update the IP address of the TetrAMM device.
        
        Args:
            ip: New IP address
        """
        old_ip = self.ip
        self.ip = ip
        self.logger.info(f"TetrAMM IP address changed from {old_ip} to {ip}")
    
    def set_port(self, port: int) -> None:
        """
        Update the TCP port for TetrAMM communication.
        
        Args:
            port: New port number
        """
        old_port = self.port
        self.port = port
        self.logger.info(f"TetrAMM port changed from {old_port} to {port}")
    
    def is_connected(self) -> bool:
        """
        Check if the TetrAMM is connected and acquiring data.
        
        Returns:
            bool: True if socket is connected and acquiring data, False otherwise
        """
        if not self.socket or not self.is_acquiring:
            return False
        
        try:
            # Check socket status by attempting to get socket error state
            error = self.socket.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
            if error != 0:
                # Socket has an error, mark as disconnected
                self.logger.warning(f"Socket error detected: {error}")
                self._handle_disconnection()
                return False
            
            # Additional check: try to peek at socket data without consuming it
            # This will raise an exception if connection is broken
            self.socket.settimeout(0.1)  # Very short timeout
            try:
                data = self.socket.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT)
                # If we get here, connection is alive (even if no data)
                return True
            except socket.timeout:
                # Timeout is fine, means no data but connection is alive
                return True
            except (ConnectionResetError, BrokenPipeError, OSError):
                # Connection is broken
                self.logger.warning("Connection broken detected in is_connected check")
                self._handle_disconnection()
                return False
            finally:
                # Restore original timeout
                self.socket.settimeout(self.connection_timeout)
                
        except Exception as e:
            self.logger.warning(f"Error checking connection status: {e}")
            self._handle_disconnection()
            return False
    
    def _handle_disconnection(self) -> None:
        """
        Handle disconnection by cleaning up socket and stopping acquisition.
        """
        try:
            self.is_acquiring = False
            if self.socket:
                try:
                    self.socket.close()
                except:
                    pass
                self.socket = None
            self.logger.info("TetrAMM disconnection handled")
        except Exception as e:
            self.logger.error(f"Error handling disconnection: {e}")
    
    def load_settings(self) -> None:
        """
        Load TetrAMM configuration settings from file or create defaults.
        """
        settings_file = 'conf/tetram.json'
        
        try:
            # Ensure conf directory exists
            os.makedirs('conf', exist_ok=True)
            
            if os.path.exists(settings_file):
                with open(settings_file, 'r') as f:
                    self.settings = json.load(f)
                self.logger.info("TetrAMM settings loaded from configuration file")
            else:
                # Create default settings
                self.settings = {
                    'CHN': "4",        # Number of channels (1-4)
                    'RNG': "AUTO",     # Range setting (AUTO, 20nA, 200nA, etc.)
                    'ASCII': "ON",     # ASCII output format
                    'NRSAMP': "10000", # Number of samples per measurement
                    'TRG': "OFF",      # Trigger mode
                    'NAQ': "1"         # Number of acquisitions
                }
                self.write_settings()
                self.logger.info("Default TetrAMM settings created")
                
        except Exception as e:
            self.logger.error(f"Failed to load TetrAMM settings: {e}")
            # Use minimal defaults
            self.settings = {'CHN': "4", 'RNG': "AUTO", 'ASCII': "ON"}
    
    def write_settings(self) -> None:
        """
        Save current TetrAMM settings to configuration file.
        """
        try:
            os.makedirs('conf', exist_ok=True)
            with open('conf/tetram.json', 'w') as f:
                json.dump(self.settings, f, indent=2)
            self.logger.debug("TetrAMM settings saved to configuration file")
            
        except Exception as e:
            self.logger.error(f"Failed to save TetrAMM settings: {e}")
    
    def connect(self) -> None:
        """
        Establish TCP connection to the TetrAMM device.
        """
        try:
            self.logger.info(f"Connecting to TetrAMM at {self.ip}:{self.port}")
            
            self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.socket.settimeout(self.connection_timeout)
            self.socket.connect((self.ip, int(self.port)))
            
            self.logger.info("Successfully connected to TetrAMM device")
            
        except socket.timeout as e:
            error_msg = f"Connection to TetrAMM timed out: {e}"
            self.logger.error(error_msg)
            if self.socket:
                self.socket.close()
                self.socket = None
            
        except (ConnectionError, OSError) as e:
            error_msg = f"Failed to connect to TetrAMM: {e}"
            self.logger.error(error_msg)
            if self.socket:
                self.socket.close()
                self.socket = None
            
        except Exception as e:
            error_msg = f"Unexpected error connecting to TetrAMM: {e}"
            self.logger.error(error_msg)
            if self.socket:
                self.socket.close()
                self.socket = None
    
    def disconnect(self) -> None:
        """
        Disconnect from the TetrAMM device and stop data acquisition.
        """
        try:
            if self.is_acquiring:
                self.stop_acquisition()
            
            if self.socket:
                self.socket.close()
                self.socket = None
                self.logger.info("Disconnected from TetrAMM device")
                
        except Exception as e:
            self.logger.warning(f"Error during TetrAMM disconnection: {e}")
    
    def _send_command(self, command: str) -> bytes:
        """
        Send a command to the TetrAMM device and receive response.
        
        Args:
            command: Command string to send
            
        Returns:
            bytes: Response from the device
            
        """
        if not self.socket:
            raise ConnectionError("TetrAMM device not connected")
        
        try:
            # Send command with carriage return terminator
            command_bytes = f'{command}\r'.encode('utf-8')
            self.socket.send(command_bytes)
            
            # Receive response
            response = self.socket.recv(1024)
            
            self.logger.debug(f"TetrAMM command: {command} -> {response.decode().strip()}")
            return response
            
        except socket.timeout as e:
            self.logger.warning(f"TetrAMM command timeout: {command}")
            
        except (ConnectionResetError, BrokenPipeError, OSError) as e:
            self.logger.error(f"TetrAMM connection lost during command '{command}': {e}")
            # Mark device as disconnected
            if self.socket:
                try:
                    self.socket.close()
                except:
                    pass
                self.socket = None
            self.is_acquiring = False
            
        except Exception as e:
            self.logger.error(f"Error sending TetrAMM command '{command}': {e}")
    
    def set_setting(self, setting: str, value: str) -> Union[str, int]:
        """
        Set a configuration parameter on the TetrAMM device.
        
        Args:
            setting: Parameter name (e.g., 'CHN', 'RNG', 'NRSAMP')
            value: Parameter value as string
            
        Returns:
            str: Device response, or -1 if invalid setting
        """
        if setting not in self.settings:
            self.logger.warning(f"Unknown TetrAMM setting: {setting}")
            return -1
        
        try:
            # Update local settings
            old_value = self.settings[setting]
            self.settings[setting] = value
            self.write_settings()
            
            # Send command to device
            response = self._send_command(f'{setting}:{value}')
            response_str = response.decode().split()[0]
            
            self.logger.info(f"TetrAMM setting updated: {setting} = {value} (was {old_value})")
            return response_str
            
        except Exception as e:
            self.logger.error(f"Failed to set TetrAMM setting {setting}={value}: {e}")
            # Revert local setting on failure
            self.settings[setting] = old_value
            self.write_settings()
    
    def get_setting(self, setting: str) -> str:
        """
        Get current value of a configuration parameter from the device.
        
        Args:
            setting: Parameter name to query
            
        Returns:
            str: Current parameter value
        """
        try:
            # Temporarily stop acquisition for setting query
            was_acquiring = self.is_acquiring
            if was_acquiring:
                self.stop_acquisition()
            
            # Query device
            response = self._send_command(f'{setting}:?')
            response_str = response.decode()
            
            # Parse response (format: "SETTING:VALUE\r\n")
            value = response_str.split(':')[1].rstrip('\r\n')
            
            # Restart acquisition if it was running
            if was_acquiring:
                self.start_acquisition()
            
            self.logger.debug(f"TetrAMM setting query: {setting} = {value}")
            return value
            
        except Exception as e:
            self.logger.error(f"Failed to get TetrAMM setting {setting}: {e}")
            # Restart acquisition on error if it was running
            if was_acquiring:
                try:
                    self.start_acquisition()
                except:
                    pass
            return ""
    
    def initialize(self) -> None:
        """
        Initialize TetrAMM device with current settings and start acquisition.
        """
        try:
            self.logger.info("Initializing TetrAMM device")
            
            # Connect to device
            self.connect()
            
            # Apply all settings
            for setting, value in self.settings.items():
                try:
                    self.set_setting(setting, value)
                except Exception as e:
                    self.logger.warning(f"Failed to apply setting {setting}={value}: {e}")
            
            # Start data acquisition
            self.start_acquisition()
            
            self.logger.info("TetrAMM device initialized successfully")
            
        except Exception as e:
            self.logger.error(f"Failed to initialize TetrAMM device: {e}")
    
    def start_acquisition(self) -> None:
        """
        Start continuous data acquisition in a separate thread.
        """
        if not self.is_acquiring:
            self.logger.info("Starting TetrAMM data acquisition")
            
            self.is_acquiring = True
            self.acquisition_thread = threading.Thread(
                target=self._acquisition_loop,
                daemon=True,
                name="TetrAMM-Acquisition"
            )
            self.acquisition_thread.start()
            
            self.logger.info("TetrAMM data acquisition started")
    
    def stop_acquisition(self) -> None:
        """
        Stop continuous data acquisition and clean up.
        """
        if self.is_acquiring:
            self.logger.info("Stopping TetrAMM data acquisition")
            
            self.is_acquiring = False
            
            # Wait for acquisition thread to finish
            if self.acquisition_thread and self.acquisition_thread.is_alive():
                self.acquisition_thread.join(timeout=5)
                        
            # Clear any remaining data in socket buffer
            try:
                if self.socket:
                    self.socket.settimeout(0.1)
                    for _ in range(10):
                        data = self.socket.recv(1024)
                        if b'ACK\r\n' in data:
                            break

            except (socket.timeout, socket.error):
                pass
            finally:
                if self.socket:
                    self.socket.settimeout(self.connection_timeout)
            
            self.logger.info("TetrAMM data acquisition stopped")
    
    def _acquisition_loop(self) -> None:
        """
        Main data acquisition loop running in separate thread.
        """
        self.logger.debug("TetrAMM acquisition loop started")
        
        while self.is_acquiring:
            try:
                self._acquire_measurement()
                time.sleep(self.acquisition_interval)
                
            except socket.timeout:
                self.logger.warning("TetrAMM acquisition timeout - device may be unreachable")
                # Try to send ACQ:OFF, but if it fails, disconnect
                try:
                    self._send_command('ACQ:OFF')
                except:
                    self.logger.warning("Failed to send ACQ:OFF, disconnecting TetrAMM")
                    self.is_acquiring = False
                    if self.socket:
                        try:
                            self.socket.close()
                        except:
                            pass
                        self.socket = None
                    break
                
            except (ConnectionResetError, BrokenPipeError, OSError) as e:
                self.logger.error(f"TetrAMM connection lost in acquisition loop: {e}")
                self.is_acquiring = False
                if self.socket:
                    try:
                        self.socket.close()
                    except:
                        pass
                    self.socket = None
                break
                
            except Exception as e:
                self.logger.error(f"Error in TetrAMM acquisition loop: {e}")
                time.sleep(self.acquisition_interval)
        
        self.logger.debug("TetrAMM acquisition loop stopped")
    
    def _acquire_measurement(self) -> None:
        """
        Acquire a single measurement from all active channels.
        """
        try:
            # Request measurement from device
            data = self._send_command('ACQ:ON')
            data_str = data.decode().split()
            
            # Skip if device returns ACK (no new data)
            if data_str[0] == 'ACK':
                return
            
            # Parse measurement data
            timestamp = datetime.now().timestamp()
            num_channels = int(self.settings.get('CHN', 4))
            
            # Update data buffers with thread safety
            with self.buffer_lock:
                # Shift time buffer and add new timestamp
                self.times = np.roll(self.times, -1)
                self.times[-1] = timestamp
                
                # Process each channel's data
                for i in range(min(num_channels, len(data_str))):
                    channel_key = str(i)
                    if channel_key in self.values:
                        # Shift channel buffer and add new value (convert to microamps)
                        self.values[channel_key] = np.roll(self.values[channel_key], -1)
                        raw_value = float(data_str[i])
                        current_ua = raw_value * 1e6  # Convert to microamps
                        self.values[channel_key][-1] = current_ua
                        
                        # Send to Graphite monitoring system
                        self._send_metric_to_graphite(f"tetram.ch{i}", current_ua, timestamp)
                
                # Save to file if data logging is enabled
                if self.save_data:
                    self._log_measurement_to_file(timestamp, num_channels)
                self.update_accumulated_charge()
            
        except Exception as e:
            self.logger.warning(f"Error acquiring TetrAMM measurement: {e}")
    
    def _send_metric_to_graphite(self, metric_path: str, value: float, timestamp: float) -> None:
        """
        Send a metric to Graphite monitoring system.
        
        Args:
            metric_path: Metric path (e.g., "tetram.ch0")
            value: Metric value
            timestamp: Unix timestamp
        """
        try:
            # Create socket connection to Graphite
            with socket.create_connection((self.graphite_host, self.graphite_port), timeout=1) as sock:
                # Format message: metric_path value timestamp
                message = f"{metric_path} {value} {int(timestamp)}\n"
                sock.sendall(message.encode('utf-8'))
                
        except Exception as e:
            # Don't log every Graphite error to avoid spam
            if hasattr(self, '_last_graphite_error_time'):
                if time.time() - self._last_graphite_error_time > 60:  # Log once per minute
                    self.logger.warning(f"Failed to send metric to Graphite: {e}")
                    self._last_graphite_error_time = time.time()
            else:
                self.logger.warning(f"Failed to send metric to Graphite: {e}")
                self._last_graphite_error_time = time.time()
    
    def _log_measurement_to_file(self, timestamp: float, num_channels: int) -> None:
        """
        Log current measurement to data file.
        
        Args:
            timestamp: Measurement timestamp
            num_channels: Number of active channels
        """
        try:
            log_file = os.path.join(self.save_folder, 'current.txt')
            relative_time = timestamp - self.run_start_time
            
            with open(log_file, 'a') as f:
                # Write time since run start
                f.write(f'{relative_time:.8e}\t')
                
                # Write current values for each channel
                for i in range(num_channels):
                    channel_key = str(i)
                    if channel_key in self.values:
                        current_value = self.values[channel_key][-1]
                        f.write(f'{current_value:.3e}\t')
                
                f.write('\n')
                
        except Exception as e:
            self.logger.error(f"Failed to log measurement to file: {e}")
    
    def set_save_data(self, enable_save: bool, save_folder: str = '') -> None:
        """
        Configure data logging to file.
        
        Args:
            enable_save: Whether to enable data logging
            save_folder: Directory to save data files
        """
        with self.buffer_lock:
            if enable_save and save_folder:
                try:
                    # Ensure save directory exists
                    os.makedirs(save_folder, exist_ok=True)
                    
                    # Initialize data file with header
                    log_file = os.path.join(save_folder, 'current.txt')
                    with open(log_file, 'w') as f:
                        start_time_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")
                        f.write(f'### Start time: {start_time_str} ###\n')
                        f.write('# Time(s)\tCh0(uA)\tCh1(uA)\tCh2(uA)\tCh3(uA)\n')
                    
                    self.run_start_time = datetime.now().timestamp()
                    self.save_folder = save_folder
                    self.save_data = True
                    
                    self.logger.info(f"TetrAMM data logging enabled: {save_folder}")
                    
                except Exception as e:
                    self.logger.error(f"Failed to enable data logging: {e}")
                    self.save_data = False

            else:
                self.save_data = False
                self.save_folder = ''
                self.logger.info("TetrAMM data logging disabled")
    
    def get_data_array(self) -> Dict[str, np.ndarray]:
        """
        Get recent measurement data arrays for plotting.
        
        Returns:
            dict: Dictionary with channel data arrays (last 100 points)
        """
        with self.buffer_lock:
            return {
                "0": self.values["0"][-101:-1].copy(),
                "1": self.values["1"][-101:-1].copy(),
                "2": self.values["2"][-101:-1].copy(),
                "3": self.values["3"][-101:-1].copy()
            }
    
    def get_data(self) -> Dict[str, float]:
        """
        Get the most recent measurement from all channels.
        
        Returns:
            dict: Dictionary with current values for each channel
        """
        with self.buffer_lock:
            return {
                "0": float(self.values["0"][-1]),
                "1": float(self.values["1"][-1]),
                "2": float(self.values["2"][-1]),
                "3": float(self.values["3"][-1])
            }
    
    def reset(self) -> None:
        """
        Reset the TetrAMM connection and reinitialize.
        """
        self.logger.info("Resetting TetrAMM controller")
        
        try:
            # Stop acquisition and disconnect
            if self.is_acquiring:
                self.stop_acquisition()
                time.sleep(0.5)
            
            self.disconnect()
            time.sleep(0.5)
            
            # Reinitialize
            self.initialize()
            
            self.logger.info("TetrAMM controller reset successfully")
            
        except Exception as e:
            self.logger.error(f"Failed to reset TetrAMM controller: {e}")

    
    def check_thread(self) -> bool:
        """
        Check if the acquisition thread is running.
        
        Returns:
            bool: True if acquisition thread is alive, False otherwise
        """
        if self.acquisition_thread:
            return self.acquisition_thread.is_alive()
        return False
    
    def update_accumulated_charge(self) -> float:
        """
        Update accumulated charge based on current measurement and time.
        
        Returns:
            float: Current accumulated charge for this run
        """
        current_data = float(self.values["0"][-1])  # Channel 0 current in microamps
        current_time = datetime.now().timestamp()
            
        # Handle very small currents as zero
        if current_data < 1e-9:
            current_data = 0
            
        # Initialize previous_time if this is the first call
        if self.previous_time == 0:
            self.previous_time = current_time
            
        # Calculate charge increment (current * time in microamp-seconds)
        time_diff = current_time - self.previous_time
        charge_increment = current_data * time_diff
            
        # Always update total accumulated charge
        self.total_accumulated_charge += charge_increment
            
        # Only update accumulated charge if data is being saved
        if self.save_data:
            self.accumulated_charge += charge_increment
            
        self.previous_time = current_time
    
    def reset_accumulated_charge(self) -> None:
        """
        Reset accumulated charge to 0 (called when starting a new run).
        """
        with self.buffer_lock:
            self.accumulated_charge = 0.0
            self.previous_time = datetime.now().timestamp()
    
    def get_accumulated_charge(self) -> float:
        """
        Get current accumulated charge for this run.
        
        Returns:
            float: Accumulated charge in microamp-seconds
        """
        return self.accumulated_charge
    
    def get_total_accumulated_charge(self) -> float:
        """
        Get total accumulated charge across all time.
        
        Returns:
            float: Total accumulated charge in microamp-seconds
        """
        return self.total_accumulated_charge
    
    def set_total_accumulated_charge(self, value: float) -> None:
        """
        Set the total accumulated charge (for loading from config).
        
        Args:
            value: Total accumulated charge value
        """
        self.total_accumulated_charge = value

    def get_status(self) -> Dict[str, Any]:
        """
        Get comprehensive status information.
        
        Returns:
            dict: Status information including connection, settings, and data
        """
        with self.buffer_lock:
            latest_data = self.get_data()
        
        return {
            'ip': self.ip,
            'port': self.port,
            'connected': self.is_connected(),
            'acquiring': self.is_acquiring,
            'thread_alive': self.check_thread(),
            'save_data': self.save_data,
            'save_folder': self.save_folder,
            'settings': self.settings.copy(),
            'latest_measurements': latest_data,
            'buffer_size': self.buffer_size,
            'acquisition_interval': self.acquisition_interval,
            'accumulated_charge': self.accumulated_charge,
            'total_accumulated_charge': self.total_accumulated_charge
        }


# Maintain backward compatibility with original class name
tetram_controller = TetrAMMController