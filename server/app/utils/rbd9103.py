"""
RBD 9103 Picoammeter Controller Utility Module

This module provides a Python interface for communicating with RBD 9103
picoammeter devices for precise current measurements in scientific applications.
It handles serial communication, data acquisition, Graphite integration, and
file-based data logging.

Key Features:
- Serial communication with RBD 9103 devices
- Support for both standard speed (57600 baud) and high speed (230400 baud) modes
- Continuous current measurement acquisition
- Real-time data streaming to Graphite database
- File-based data logging during experiments
- Configurable measurement parameters (range, filter, bias, input mode)
- Thread-safe data access and buffering
- Comprehensive error handling and logging

Author: Scientific DAQ Team
Purpose: Current measurement interface for LUNA experiment
"""

import serial
import threading
import time
import json
import os
import logging
from datetime import datetime
from typing import Dict, Any, Optional, Union
import socket

import numpy as np

# Configure logging
logger = logging.getLogger(__name__)


class RBD9103Controller:
    """
    Controller class for RBD 9103 picoammeter devices.

    Manages serial communication, data acquisition, and integration with
    monitoring systems for precise current measurements in scientific experiments.
    """

    def __init__(self,
                 port: str = '/dev/ttyUSB0',
                 baudrate: int = 57600,
                 high_speed: bool = False,
                 graphite_host: str = '172.18.9.54',
                 graphite_port: int = 2003):
        """
        Initialize RBD 9103 controller with serial parameters.

        Args:
            port: Serial port device path
            baudrate: Serial communication speed (57600 for standard, 230400 for high speed)
            high_speed: Whether to use high-speed mode (10 samples per message)
            graphite_host: Graphite server hostname for metrics
            graphite_port: Graphite server port for metrics (default: 2003)
        """
        self.logger = logging.getLogger(__name__ + '.RBD9103Controller')

        # Serial configuration
        self.port_name = port
        self.baudrate = baudrate if not high_speed else 230400
        self.high_speed = high_speed
        self.serial_port: Optional[serial.Serial] = None
        self.connection_timeout = 1.0

        # Graphite configuration
        self.graphite_host = graphite_host
        self.graphite_port = graphite_port

        # Data acquisition threading
        self.acquisition_thread = None
        self.is_acquiring = False
        self.acquisition_interval = 0.1 if high_speed else 0.5  # seconds between measurements

        # Data logging
        self.save_data = False
        self.save_folder = ''
        self.run_start_time = 0

        # Data buffering (circular buffers for 100k samples)
        self.buffer_size = 100000
        self.buffer_lock = threading.Lock()
        self.times = np.zeros(self.buffer_size)
        self.values = np.zeros(self.buffer_size)  # Single channel for RBD 9103
        self.current_value = 0.0
        self.current_range = "AUTO"
        self.current_stability = "S"

        # Charge accumulation tracking
        self.accumulated_charge = 0.0
        self.total_accumulated_charge = 0.0
        self.previous_time = 0.0

        # Device settings
        self.settings = {}
        self.load_settings()

        self.logger.info(f"RBD 9103 controller initialized for device at {port}")

    def set_port(self, port: str) -> None:
        """
        Update the serial port device path.

        Args:
            port: New serial port path
        """
        old_port = self.port_name
        self.port_name = port
        self.logger.info(f"RBD 9103 port changed from {old_port} to {port}")

    def set_baudrate(self, baudrate: int) -> None:
        """
        Update the serial baudrate.

        Args:
            baudrate: New baudrate (typically 57600 or 230400)
        """
        old_baudrate = self.baudrate
        self.baudrate = baudrate
        self.logger.info(f"RBD 9103 baudrate changed from {old_baudrate} to {baudrate}")

    def set_high_speed(self, enable: bool) -> None:
        """
        Enable or disable high-speed mode.

        Args:
            enable: True for high-speed mode (230400 baud), False for standard (57600 baud)
        """
        self.high_speed = enable
        self.baudrate = 230400 if enable else 57600
        self.acquisition_interval = 0.1 if enable else 0.5
        self.logger.info(f"RBD 9103 high-speed mode {'enabled' if enable else 'disabled'}")

    def is_connected(self) -> bool:
        """
        Check if the RBD 9103 is connected and acquiring data.

        Returns:
            bool: True if serial port is open and acquiring data, False otherwise
        """
        if not self.serial_port or not self.is_acquiring:
            return False

        try:
            return self.serial_port.is_open
        except Exception as e:
            self.logger.warning(f"Error checking connection status: {e}")
            return False

    def load_settings(self) -> None:
        """
        Load RBD 9103 configuration settings from file or create defaults.
        """
        settings_file = 'conf/rbd9103.json'

        try:
            os.makedirs('conf', exist_ok=True)

            if os.path.exists(settings_file):
                with open(settings_file, 'r') as f:
                    self.settings = json.load(f)
                self.logger.info("RBD 9103 settings loaded from configuration file")
            else:
                # Create default settings based on RBD 9103 commands
                self.settings = {
                    'range': 'R0',           # R0=Auto range
                    'filter': 'F032',        # Filter setting (32 samples)
                    'input_mode': 'G0',      # G0=Normal input
                    'bias': 'B0',            # B0=Bias off
                    'sample_rate': 'I1000',  # Standard speed: I1000 = 1 Hz, High speed: i0100 = 10 Hz
                    'high_speed': False      # Standard speed mode by default
                }
                self.write_settings()
                self.logger.info("Default RBD 9103 settings created")

        except Exception as e:
            self.logger.error(f"Failed to load RBD 9103 settings: {e}")
            self.settings = {'range': 'R0', 'filter': 'F032', 'input_mode': 'G0', 'bias': 'B0'}

    def write_settings(self) -> None:
        """
        Save current RBD 9103 settings to configuration file.
        """
        try:
            os.makedirs('conf', exist_ok=True)
            with open('conf/rbd9103.json', 'w') as f:
                json.dump(self.settings, f, indent=2)
            self.logger.debug("RBD 9103 settings saved to configuration file")

        except Exception as e:
            self.logger.error(f"Failed to save RBD 9103 settings: {e}")

    def _create_message(self, command: str) -> bytes:
        """
        Convert command string to bytes for RBD 9103 protocol.
        All messages must start with '&' and end with newline.

        Args:
            command: Command string (e.g., 'R0', 'F032', 'I1000')

        Returns:
            bytes: Formatted message for serial transmission
        """
        return bytes(f'&{command}\n', 'utf-8')

    def connect(self) -> None:
        """
        Establish serial connection to the RBD 9103 device.
        """
        try:
            self.logger.info(f"Connecting to RBD 9103 at {self.port_name} ({self.baudrate} baud)")

            self.serial_port = serial.Serial(
                port=self.port_name,
                baudrate=self.baudrate,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                xonxoff=False,
                timeout=self.connection_timeout
            )

            self.logger.info("Successfully connected to RBD 9103 device")

        except serial.SerialException as e:
            error_msg = f"Failed to connect to RBD 9103: {e}"
            self.logger.error(error_msg)
            if self.serial_port:
                try:
                    self.serial_port.close()
                except:
                    pass
                self.serial_port = None
            raise

        except Exception as e:
            error_msg = f"Unexpected error connecting to RBD 9103: {e}"
            self.logger.error(error_msg)
            if self.serial_port:
                try:
                    self.serial_port.close()
                except:
                    pass
                self.serial_port = None
            raise

    def disconnect(self) -> None:
        """
        Disconnect from the RBD 9103 device and stop data acquisition.
        """
        try:
            if self.is_acquiring:
                self.stop_acquisition()

            if self.serial_port and self.serial_port.is_open:
                self.serial_port.close()
                self.serial_port = None
                self.logger.info("Disconnected from RBD 9103 device")

        except Exception as e:
            self.logger.warning(f"Error during RBD 9103 disconnection: {e}")

    def _send_command(self, command: str) -> bool:
        """
        Send a command to the RBD 9103 device.

        Args:
            command: Command string to send

        Returns:
            bool: True if command sent successfully, False otherwise
        """
        if not self.serial_port or not self.serial_port.is_open:
            self.logger.error("RBD 9103 device not connected")
            return False

        try:
            message = self._create_message(command)
            self.serial_port.write(message)
            self.logger.debug(f"RBD 9103 command sent: {command}")
            return True

        except serial.SerialException as e:
            self.logger.error(f"RBD 9103 serial error during command '{command}': {e}")
            return False

        except Exception as e:
            self.logger.error(f"Error sending RBD 9103 command '{command}': {e}")
            return False

    def set_range(self, range_code: str) -> bool:
        """
        Set the measurement range.

        Args:
            range_code: Range code (e.g., 'R0' for auto, 'R1' for 20nA, etc.)

        Returns:
            bool: True if successful
        """
        if self._send_command(range_code):
            self.settings['range'] = range_code
            self.write_settings()
            self.logger.info(f"RBD 9103 range set to {range_code}")
            return True
        return False

    def set_filter(self, filter_code: str) -> bool:
        """
        Set the measurement filter.

        Args:
            filter_code: Filter code (e.g., 'F032' for 32 samples averaging)

        Returns:
            bool: True if successful
        """
        if self._send_command(filter_code):
            self.settings['filter'] = filter_code
            self.write_settings()
            self.logger.info(f"RBD 9103 filter set to {filter_code}")
            return True
        return False

    def set_input_mode(self, mode_code: str) -> bool:
        """
        Set the input mode.

        Args:
            mode_code: Input mode code (e.g., 'G0' for normal input)

        Returns:
            bool: True if successful
        """
        if self._send_command(mode_code):
            self.settings['input_mode'] = mode_code
            self.write_settings()
            self.logger.info(f"RBD 9103 input mode set to {mode_code}")
            return True
        return False

    def set_bias(self, bias_code: str) -> bool:
        """
        Set the bias voltage.

        Args:
            bias_code: Bias code (e.g., 'B0' for bias off)

        Returns:
            bool: True if successful
        """
        if self._send_command(bias_code):
            self.settings['bias'] = bias_code
            self.write_settings()
            self.logger.info(f"RBD 9103 bias set to {bias_code}")
            return True
        return False

    def initialize(self) -> None:
        """
        Initialize RBD 9103 device with current settings and start acquisition.
        """
        try:
            self.logger.info("Initializing RBD 9103 device")

            # Connect to device
            self.connect()

            # Only proceed if connection was successful
            if not self.serial_port or not self.serial_port.is_open:
                self.logger.warning("RBD 9103 connection failed, skipping initialization")
                return

            # Apply device settings
            self.set_range(self.settings.get('range', 'R0'))
            self.set_filter(self.settings.get('filter', 'F032'))
            self.set_input_mode(self.settings.get('input_mode', 'G0'))
            self.set_bias(self.settings.get('bias', 'B0'))

            # Start sampling
            sample_rate = self.settings.get('sample_rate', 'I1000')
            self._send_command(sample_rate)

            # Start data acquisition thread only if connected
            if self.serial_port and self.serial_port.is_open:
                self.start_acquisition()
                self.logger.info("RBD 9103 device initialized successfully")
            else:
                self.logger.warning("RBD 9103 device not connected, acquisition not started")

        except Exception as e:
            self.logger.error(f"Failed to initialize RBD 9103 device: {e}")
            # Ensure we don't leave the device in a broken state
            self.is_acquiring = False
            if self.serial_port and self.serial_port.is_open:
                try:
                    self.serial_port.close()
                except:
                    pass

    def start_acquisition(self) -> None:
        """
        Start continuous data acquisition in a separate thread.
        """
        if not self.is_acquiring:
            self.logger.info("Starting RBD 9103 data acquisition")

            self.is_acquiring = True
            self.acquisition_thread = threading.Thread(
                target=self._acquisition_loop,
                daemon=True,
                name="RBD9103-Acquisition"
            )
            self.acquisition_thread.start()

            self.logger.info("RBD 9103 data acquisition started")

    def stop_acquisition(self) -> None:
        """
        Stop continuous data acquisition and clean up.
        """
        if self.is_acquiring:
            self.logger.info("Stopping RBD 9103 data acquisition")

            # Stop sampling on device
            if self.serial_port and self.serial_port.is_open:
                stop_cmd = 'i0000' if self.high_speed else 'I0000'
                self._send_command(stop_cmd)

            self.is_acquiring = False

            # Wait for acquisition thread to finish
            if self.acquisition_thread and self.acquisition_thread.is_alive():
                self.acquisition_thread.join(timeout=5)

            self.logger.info("RBD 9103 data acquisition stopped")

    def _parse_standard_speed_sample(self, msg: str):
        """
        Parse standard speed sample message from format like:
            S=,Range=002nA,+0.0072,nA

        Returns:
            (stability, range, value_in_amps) or None if invalid
        """
        try:
            msg = msg.strip()
            parts = [p.strip() for p in msg.split(',') if p.strip()]
            if len(parts) < 4:
                return None

            # Stability can be blank or something like 'S=S' or 'S=U'
            stability_part = parts[0]
            stability = stability_part.replace('S=', '').strip() or None

            # Range (e.g., "Range=002nA")
            range_part = parts[1]
            if not range_part.startswith("Range="):
                return None
            range_str = range_part.replace("Range=", "").strip()

            # Value and unit
            value_str = parts[2]
            unit_str = parts[3]

            # Parse numeric value
            value_num = float(value_str)

            # Determine multiplier
            unit_prefix = unit_str[0] if len(unit_str) > 1 else ''
            multiplier = {
                '': 1.0,
                'm': 1e-3,
                'u': 1e-6,
                'µ': 1e-6,
                'n': 1e-9,
            }.get(unit_prefix, 1.0)

            value_amps = value_num * multiplier
            return (stability, range_str, value_amps)

        except Exception as e:
            self.logger.warning(f"Error parsing standard speed sample: {e}, msg: {msg}")
            return None

    def _parse_high_speed_sample(self, msg: str) -> list:
        """
        Parse high-speed sample message (10 samples per message).
        Format: &s,stability,range,val1,val2,...,val10,unit

        Args:
            msg: Message string from device

        Returns:
            list: List of (stability, range, value_amps) tuples
        """
        results = []

        if '&s' not in msg:
            return results

        try:
            msg = msg.strip('&\r\n\0')
            parts = msg.split(',')

            if len(parts) >= 4:
                stability = parts[1]
                range_str = parts[2]
                unit = parts[-1]  # Last element is unit

                # Parse all value elements (skip first 3 and last 1)
                for i in range(3, len(parts) - 1):
                    try:
                        value_num = float(parts[i])

                        # Convert to amps based on unit
                        if 'nA' in unit:
                            value_amps = value_num * 1e-9
                        elif 'uA' in unit or 'µA' in unit:
                            value_amps = value_num * 1e-6
                        elif 'mA' in unit:
                            value_amps = value_num * 1e-3
                        else:
                            value_amps = value_num

                        results.append((stability, range_str, value_amps))
                    except ValueError:
                        continue

        except Exception as e:
            self.logger.warning(f"Error parsing high-speed sample: {e}, msg: {msg}")

        return results

    def _acquisition_loop(self) -> None:
        """
        Main data acquisition loop running in separate thread.
        """
        self.logger.debug("RBD 9103 acquisition loop started")

        while self.is_acquiring:
            try:
                if self.serial_port and self.serial_port.is_open:
                    # Read line from serial port
                    line = self.serial_port.readline().decode('utf-8', errors='ignore').rstrip()

                    if line:
                        self.logger.debug(f"RBD 9103 received: {line}")

                        # Parse based on speed mode
                        if self.high_speed:
                            samples = self._parse_high_speed_sample(line)
                            for sample in samples:
                                self._process_sample(*sample)
                        else:
                            sample = self._parse_standard_speed_sample(line)
                            if sample:
                                self._process_sample(*sample)

                time.sleep(0.01)  # Small delay to prevent busy-waiting

            except serial.SerialException as e:
                self.logger.error(f"RBD 9103 serial error in acquisition loop: {e}")
                self.is_acquiring = False
                break

            except Exception as e:
                self.logger.error(f"Error in RBD 9103 acquisition loop: {e}")
                time.sleep(self.acquisition_interval)

        self.logger.debug("RBD 9103 acquisition loop stopped")

    def _process_sample(self, stability: str, range_str: str, value_amps: float) -> None:
        """
        Process a single sample and update buffers.

        Args:
            stability: Stability indicator ('S' or 'U')
            range_str: Current range setting
            value_amps: Current value in amperes
        """
        try:
            timestamp = datetime.now().timestamp()
            current_ua = value_amps * 1e6  # Convert to microamps

            # Update data buffers with thread safety
            with self.buffer_lock:
                # Shift buffers and add new data
                self.times = np.roll(self.times, -1)
                self.times[-1] = timestamp

                self.values = np.roll(self.values, -1)
                self.values[-1] = current_ua

                self.current_value = current_ua
                self.current_range = range_str
                self.current_stability = stability

                # Send to Graphite monitoring system
                self._send_metric_to_graphite("rbd9103.current", current_ua, timestamp)

                # Save to file if data logging is enabled
                if self.save_data:
                    self._log_measurement_to_file(timestamp, current_ua)

                # Update accumulated charge
                self.update_accumulated_charge()

        except Exception as e:
            self.logger.warning(f"Error processing RBD 9103 sample: {e}")

    def _send_metric_to_graphite(self, metric_path: str, value: float, timestamp: float) -> None:
        """
        Send a metric to Graphite monitoring system.

        Args:
            metric_path: Metric path (e.g., "rbd9103.current")
            value: Metric value
            timestamp: Unix timestamp
        """
        try:
            with socket.create_connection((self.graphite_host, self.graphite_port), timeout=1) as sock:
                message = f"{metric_path} {value} {int(timestamp)}\n"
                sock.sendall(message.encode('utf-8'))

        except Exception as e:
            # Don't log every Graphite error to avoid spam
            if not hasattr(self, '_last_graphite_error_time') or \
               (time.time() - self._last_graphite_error_time > 60):
                self.logger.warning(f"Failed to send metric to Graphite: {e}")
                self._last_graphite_error_time = time.time()

    def _log_measurement_to_file(self, timestamp: float, current_ua: float) -> None:
        """
        Log current measurement to data file.

        Args:
            timestamp: Measurement timestamp
            current_ua: Current value in microamps
        """
        try:
            log_file = os.path.join(self.save_folder, 'current.txt')
            relative_time = timestamp - self.run_start_time

            with open(log_file, 'a') as f:
                f.write(f'{relative_time:.8e}\t{current_ua:.3e}\n')

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
                    os.makedirs(save_folder, exist_ok=True)

                    log_file = os.path.join(save_folder, 'current.txt')
                    with open(log_file, 'w') as f:
                        start_time_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")
                        f.write(f'### Start time: {start_time_str} ###\n')
                        f.write('# Time(s)\tCurrent(uA)\n')

                    self.run_start_time = datetime.now().timestamp()
                    self.save_folder = save_folder
                    self.save_data = True

                    self.logger.info(f"RBD 9103 data logging enabled: {save_folder}")

                except Exception as e:
                    self.logger.error(f"Failed to enable data logging: {e}")
                    self.save_data = False
            else:
                self.save_data = False
                self.save_folder = ''
                self.logger.info("RBD 9103 data logging disabled")

    def get_data_array(self) -> np.ndarray:
        """
        Get recent measurement data array for plotting.

        Returns:
            np.ndarray: Array of last 100 current measurements
        """
        with self.buffer_lock:
            return self.values[-101:-1].copy()

    def get_data(self) -> float:
        """
        Get the most recent current measurement.

        Returns:
            float: Current value in microamps
        """
        with self.buffer_lock:
            return float(self.current_value)

    def get_status(self) -> Dict[str, Any]:
        """
        Get comprehensive status information.

        Returns:
            dict: Status information including connection, settings, and data
        """
        with self.buffer_lock:
            latest_data = self.current_value

        return {
            'port': self.port_name,
            'baudrate': self.baudrate,
            'high_speed': self.high_speed,
            'connected': self.is_connected(),
            'acquiring': self.is_acquiring,
            'thread_alive': self.check_thread(),
            'save_data': self.save_data,
            'save_folder': self.save_folder,
            'settings': self.settings.copy(),
            'latest_measurement': latest_data,
            'current_range': self.current_range,
            'current_stability': self.current_stability,
            'buffer_size': self.buffer_size,
            'acquisition_interval': self.acquisition_interval,
            'accumulated_charge': self.accumulated_charge,
            'total_accumulated_charge': self.total_accumulated_charge
        }

    def reset(self) -> None:
        """
        Reset the RBD 9103 connection and reinitialize.
        """
        self.logger.info("Resetting RBD 9103 controller")

        try:
            if self.is_acquiring:
                self.stop_acquisition()
                time.sleep(0.5)

            self.disconnect()
            time.sleep(0.5)

            self.initialize()

            self.logger.info("RBD 9103 controller reset successfully")

        except Exception as e:
            self.logger.error(f"Failed to reset RBD 9103 controller: {e}")

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
        current_data = float(self.current_value)
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
        return self.accumulated_charge

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


# Create a default instance for backward compatibility
rbd9103_controller = RBD9103Controller()
