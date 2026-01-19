"""
Resolution Tuner Service Module

This module provides automated resolution tuning for CAEN digitizer boards by:
- Running DAQ cycles without saving data
- Varying board parameters systematically
- Fitting histograms with Gaussian functions to measure sigma (resolution)
- Adaptively optimizing parameters to find the best resolution
- Persisting tuning history

"""

import os
import json
import time
import pickle
import logging
import threading
import shutil
from datetime import datetime
from typing import Dict, List, Optional, Any

import numpy as np
from scipy.optimize import curve_fit

logger = logging.getLogger(__name__)

# Tunable parameters for DPP-PHA boards (parameter_name: base_register_address)
# Channel offset is 0x100 per channel
TUNABLE_PARAMETERS = {
    "Trapezoid Rise Time": 0x105C,
    "Trapezoid Flat Top": 0x1060,
    "Peaking Time": 0x1064,
    "Decay Time": 0x1068,
    "Input Rise Time": 0x1058,
    "Trigger Hold Off": 0x1070,
    "Peak Hold Time": 0x1078,
}


def gaussian(x, amplitude, mean, sigma, baseline):
    """Gaussian function with constant baseline for fitting."""
    return amplitude * np.exp(-((x - mean) ** 2) / (2 * sigma ** 2)) + baseline


class TuningSession:
    """Represents a single tuning session."""

    def __init__(self, board_id: str, channel: int, parameter_name: str,
                 param_min: float, param_max: float, num_steps: int,
                 run_duration: int, fit_range_min: int, fit_range_max: int):
        self.session_id = f"session_{int(time.time())}_{board_id}_{channel}"
        self.board_id = board_id
        self.channel = channel
        self.parameter_name = parameter_name
        self.param_min = param_min
        self.param_max = param_max
        self.num_steps = num_steps
        self.run_duration = run_duration
        self.fit_range_min = fit_range_min
        self.fit_range_max = fit_range_max
        self.points: List[Dict[str, Any]] = []
        self.best_point: Optional[Dict[str, Any]] = None
        self.status = "running"  # running, completed, stopped, error
        self.start_time = time.time()
        self.end_time: Optional[float] = None
        self.error_message: Optional[str] = None
        self.current_step = 0
        self.total_steps = num_steps
        self.config_backup_path: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert session to dictionary for serialization."""
        return {
            "session_id": self.session_id,
            "board_id": self.board_id,
            "channel": self.channel,
            "parameter_name": self.parameter_name,
            "param_min": self.param_min,
            "param_max": self.param_max,
            "num_steps": self.num_steps,
            "run_duration": self.run_duration,
            "fit_range_min": self.fit_range_min,
            "fit_range_max": self.fit_range_max,
            "points": self.points,
            "best_point": self.best_point,
            "status": self.status,
            "start_time": self.start_time,
            "end_time": self.end_time,
            "error_message": self.error_message,
            "current_step": self.current_step,
            "total_steps": self.total_steps,
            "config_backup_path": self.config_backup_path,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "TuningSession":
        """Create session from dictionary."""
        session = cls(
            board_id=data["board_id"],
            channel=data["channel"],
            parameter_name=data["parameter_name"],
            param_min=data["param_min"],
            param_max=data["param_max"],
            num_steps=data["num_steps"],
            run_duration=data["run_duration"],
            fit_range_min=data["fit_range_min"],
            fit_range_max=data["fit_range_max"],
        )
        session.session_id = data["session_id"]
        session.points = data.get("points", [])
        session.best_point = data.get("best_point")
        session.status = data.get("status", "completed")
        session.start_time = data.get("start_time", time.time())
        session.end_time = data.get("end_time")
        session.error_message = data.get("error_message")
        session.current_step = data.get("current_step", 0)
        session.total_steps = data.get("total_steps", data["num_steps"])
        session.config_backup_path = data.get("config_backup_path")
        return session


class ResolutionTuner:
    """
    Automated resolution tuning service for CAEN DPP-PHA digitizer boards.

    This service optimizes board parameters by:
    1. Running short DAQ acquisitions without saving data
    2. Fitting the resulting histograms with Gaussian functions
    3. Recording the sigma (resolution) for each parameter value
    4. Adaptively refining the search around the best point
    """

    def __init__(self, daq_manager, spy_manager, test_flag: bool = False):
        """
        Initialize the Resolution Tuner.

        Args:
            daq_manager: DAQ manager instance for run control
            spy_manager: Spy manager instance for histogram access
            test_flag: Enable test mode for development
        """
        self.logger = logging.getLogger(__name__ + '.ResolutionTuner')
        self.daq_manager = daq_manager
        self.spy_manager = spy_manager
        self.test_flag = test_flag

        # Tuning state
        self.current_session: Optional[TuningSession] = None
        self.tuning_thread: Optional[threading.Thread] = None
        self.stop_event = threading.Event()
        self.lock = threading.Lock()

        # History persistence
        self.history_file = "conf/tuning.pkl"
        self.backup_dir = "conf/tuning_backups"
        self.history: Dict[str, TuningSession] = self._load_history()

        # Ensure backup directory exists
        os.makedirs(self.backup_dir, exist_ok=True)

        self.logger.info("Resolution Tuner initialized")

    def _load_history(self) -> Dict[str, TuningSession]:
        """Load tuning history from pickle file."""
        if os.path.exists(self.history_file):
            try:
                with open(self.history_file, 'rb') as f:
                    data = pickle.load(f)
                    # Convert dicts back to TuningSession objects
                    history = {}
                    for session_id, session_data in data.items():
                        if isinstance(session_data, dict):
                            history[session_id] = TuningSession.from_dict(session_data)
                        else:
                            history[session_id] = session_data
                    self.logger.info(f"Loaded {len(history)} tuning sessions from history")
                    return history
            except Exception as e:
                self.logger.error(f"Error loading tuning history: {e}")
        return {}

    def _save_history(self) -> None:
        """Save tuning history to pickle file."""
        try:
            os.makedirs(os.path.dirname(self.history_file), exist_ok=True)
            # Convert sessions to dicts for serialization
            data = {sid: session.to_dict() for sid, session in self.history.items()}
            with open(self.history_file, 'wb') as f:
                pickle.dump(data, f)
            self.logger.debug("Tuning history saved")
        except Exception as e:
            self.logger.error(f"Error saving tuning history: {e}")

    def _backup_config(self, board_name: str, board_id: str) -> Optional[str]:
        """
        Create a timestamped backup of the board configuration.

        Args:
            board_name: Name of the board
            board_id: Board ID

        Returns:
            Path to backup file or None if failed
        """
        try:
            config_file = f"conf/{board_name}_{board_id}.json"
            if not os.path.exists(config_file):
                self.logger.warning(f"Config file not found: {config_file}")
                return None

            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            backup_file = f"{self.backup_dir}/{board_name}_{board_id}_{timestamp}.json"

            shutil.copy2(config_file, backup_file)
            self.logger.info(f"Config backup created: {backup_file}")
            return backup_file
        except Exception as e:
            self.logger.error(f"Error creating config backup: {e}")
            return None

    def _get_board_config_file(self, board_id: str) -> Optional[str]:
        """Get the configuration file path for a board."""
        boards = self.daq_manager.get_boards()
        for board in boards:
            if str(board['id']) == str(board_id):
                return f"conf/{board['name']}_{board['id']}.json"
        return None

    def _get_register_key(self, parameter_name: str, channel: int) -> str:
        """Get the register key for a parameter and channel."""
        base_address = TUNABLE_PARAMETERS.get(parameter_name)
        if base_address is None:
            raise ValueError(f"Unknown parameter: {parameter_name}")

        # Calculate channel-specific address
        address = base_address + (channel * 0x100)
        return f"reg_{address:04X}"

    def _set_parameter_value(self, board_id: str, parameter_name: str,
                              channel: int, value: int) -> bool:
        """
        Set a parameter value in the board configuration JSON.

        Args:
            board_id: Board ID
            parameter_name: Name of the parameter to set
            channel: Channel number
            value: Value to set

        Returns:
            True if successful
        """
        try:
            config_file = self._get_board_config_file(board_id)
            if not config_file or not os.path.exists(config_file):
                self.logger.error(f"Config file not found for board {board_id}")
                return False

            with open(config_file, 'r') as f:
                config = json.load(f)

            reg_key = self._get_register_key(parameter_name, channel)

            if reg_key in config.get("registers", {}):
                config["registers"][reg_key]["value"] = f"0x{value:X}"

                with open(config_file, 'w') as f:
                    json.dump(config, f, indent=4)

                self.logger.debug(f"Set {parameter_name} to {value} for board {board_id} channel {channel}")
                return True
            else:
                self.logger.warning(f"Register {reg_key} not found in config")
                return False

        except Exception as e:
            self.logger.error(f"Error setting parameter value: {e}")
            return False

    def _get_parameter_value(self, board_id: str, parameter_name: str,
                              channel: int) -> Optional[int]:
        """Get the current value of a parameter from the board configuration."""
        try:
            config_file = self._get_board_config_file(board_id)
            if not config_file or not os.path.exists(config_file):
                return None

            with open(config_file, 'r') as f:
                config = json.load(f)

            reg_key = self._get_register_key(parameter_name, channel)

            if reg_key in config.get("registers", {}):
                value_str = config["registers"][reg_key]["value"]
                return int(value_str, 16)
            return None

        except Exception as e:
            self.logger.error(f"Error getting parameter value: {e}")
            return None

    def _fit_gaussian(self, histogram) -> Dict[str, Any]:
        """
        Fit a Gaussian function to the histogram data.

        Args:
            histogram: ROOT histogram object

        Returns:
            Dictionary with fit results: sigma, sigma_error, mean, amplitude, chi_squared
        """
        try:
            if histogram is None:
                return {"error": "No histogram data"}

            # Get histogram data
            n_bins = histogram.GetNbinsX()
            x_data = np.array([histogram.GetBinCenter(i) for i in range(1, n_bins + 1)])
            y_data = np.array([histogram.GetBinContent(i) for i in range(1, n_bins + 1)])

            # Get fit range from current session
            if self.current_session:
                fit_min = self.current_session.fit_range_min
                fit_max = self.current_session.fit_range_max
            else:
                # Default to full range
                fit_min = x_data.min()
                fit_max = x_data.max()

            # Mask data to fit range
            mask = (x_data >= fit_min) & (x_data <= fit_max)
            x_fit = x_data[mask]
            y_fit = y_data[mask]

            if len(x_fit) < 4:
                return {"error": "Not enough data points in fit range"}

            # Initial parameter estimation
            idx_max = np.argmax(y_fit)
            amplitude_init = y_fit[idx_max]
            mean_init = x_fit[idx_max]
            sigma_init = (fit_max - fit_min) / 6
            baseline_init = np.min(y_fit)

            # Bounds for fitting
            bounds = (
                [0, fit_min, 0.1, 0],  # Lower bounds
                [amplitude_init * 10, fit_max, (fit_max - fit_min) / 2, amplitude_init]  # Upper bounds
            )

            # Perform fit
            popt, pcov = curve_fit(
                gaussian, x_fit, y_fit,
                p0=[amplitude_init, mean_init, sigma_init, baseline_init],
                bounds=bounds,
                maxfev=10000
            )

            amplitude, mean, sigma, baseline = popt
            perr = np.sqrt(np.diag(pcov))

            # Calculate chi-squared
            y_pred = gaussian(x_fit, *popt)
            residuals = y_fit - y_pred
            chi_squared = np.sum(residuals**2 / np.maximum(y_pred, 1))
            reduced_chi_squared = chi_squared / max(len(x_fit) - 4, 1)

            # Calculate integral
            integral = np.sum(y_fit)

            return {
                "sigma": abs(sigma),
                "sigma_error": perr[2] if len(perr) > 2 else 0,
                "mean": mean,
                "amplitude": amplitude,
                "baseline": baseline,
                "chi_squared": reduced_chi_squared,
                "integral": integral,
                "fit_success": True,
            }

        except Exception as e:
            self.logger.error(f"Gaussian fit failed: {e}")
            return {"error": str(e), "fit_success": False}

    def _generate_parameter_values(self, param_min: float, param_max: float,
                                     num_steps: int) -> List[int]:
        """Generate parameter values for tuning sweep."""
        values = np.linspace(param_min, param_max, num_steps)
        return [int(v) for v in values]

    def _generate_adaptive_values(self, best_value: int, param_min: float,
                                   param_max: float, tested_values: List[int],
                                   num_new_points: int = 5) -> List[int]:
        """
        Generate new parameter values focused around the best point.

        Progressive refinement: shrink range by 50% around best point.
        """
        # Calculate new range (50% of original, centered on best)
        original_range = param_max - param_min
        new_range = original_range * 0.5
        new_min = max(param_min, best_value - new_range / 2)
        new_max = min(param_max, best_value + new_range / 2)

        # Generate new values
        new_values = np.linspace(new_min, new_max, num_new_points + 2)
        new_values = [int(v) for v in new_values]

        # Filter out already-tested values (within tolerance)
        tolerance = max(1, int((param_max - param_min) / 100))
        filtered_values = []
        for v in new_values:
            is_tested = any(abs(v - tested) <= tolerance for tested in tested_values)
            if not is_tested:
                filtered_values.append(v)

        return filtered_values

    def _tuning_loop(self) -> None:
        """Main tuning loop - runs in separate thread."""
        session = self.current_session
        if not session:
            return

        try:
            # Get board info
            boards = self.daq_manager.get_boards()
            board_info = None
            for board in boards:
                if str(board['id']) == session.board_id:
                    board_info = board
                    break

            if not board_info:
                session.status = "error"
                session.error_message = f"Board {session.board_id} not found"
                self._save_history()
                return

            # Create config backup
            session.config_backup_path = self._backup_config(
                board_info['name'], board_info['id']
            )

            # Store original save data setting
            original_save = self.daq_manager.get_save_data()

            # Generate initial parameter values
            param_values = self._generate_parameter_values(
                session.param_min, session.param_max, session.num_steps
            )
            session.total_steps = len(param_values)

            tested_values = []

            # Initial sweep
            for i, param_value in enumerate(param_values):
                if self.stop_event.is_set():
                    session.status = "stopped"
                    break

                session.current_step = i + 1
                self.logger.info(f"Tuning step {i + 1}/{session.total_steps}: "
                               f"{session.parameter_name} = {param_value}")

                # Set parameter value
                if not self._set_parameter_value(
                    session.board_id, session.parameter_name,
                    session.channel, param_value
                ):
                    self.logger.warning(f"Failed to set parameter value {param_value}")
                    continue

                # Disable save data for tuning runs
                self.daq_manager.set_save_data(False)

                # Start DAQ run
                if not self.test_flag:
                    self.daq_manager.prepare_run_start()
                    self.daq_manager.configure_xdaq_for_run()
                    self.daq_manager.start_xdaq()
                    self.daq_manager.set_running_state(True)

                    # Start spy server
                    self.spy_manager.start_spy(self.daq_manager.get_state())

                # Wait for run duration
                for _ in range(session.run_duration):
                    if self.stop_event.is_set():
                        break
                    time.sleep(1)

                if self.stop_event.is_set():
                    # Stop run and exit
                    if not self.test_flag:
                        self.daq_manager.stop_xdaq()
                        self.spy_manager.stop_spy()
                        self.daq_manager.set_running_state(False)
                    session.status = "stopped"
                    break

                # Get histogram and fit
                histogram = self.spy_manager.get_histogram(
                    session.board_id, session.channel, boards
                )
                fit_result = self._fit_gaussian(histogram)

                # Stop DAQ run
                if not self.test_flag:
                    self.daq_manager.stop_xdaq()
                    self.spy_manager.stop_spy()
                    self.daq_manager.set_running_state(False)

                # Record point
                point = {
                    "parameter_value": param_value,
                    "sigma": fit_result.get("sigma", float('inf')),
                    "sigma_error": fit_result.get("sigma_error", 0),
                    "mean": fit_result.get("mean", 0),
                    "chi_squared": fit_result.get("chi_squared", float('inf')),
                    "integral": fit_result.get("integral", 0),
                    "timestamp": time.time(),
                    "fit_success": fit_result.get("fit_success", False),
                    "error": fit_result.get("error"),
                }
                session.points.append(point)
                tested_values.append(param_value)

                # Update best point
                if point["fit_success"] and point["sigma"] > 0:
                    if (session.best_point is None or
                        point["sigma"] < session.best_point.get("sigma", float('inf'))):
                        session.best_point = point.copy()

                # Save progress
                self.history[session.session_id] = session
                self._save_history()

                # Short pause between runs
                time.sleep(2)

            # Adaptive refinement phase
            if not self.stop_event.is_set() and session.best_point:
                # Generate refined values around best point
                refined_values = self._generate_adaptive_values(
                    session.best_point["parameter_value"],
                    session.param_min, session.param_max,
                    tested_values, num_new_points=5
                )

                if refined_values:
                    session.total_steps += len(refined_values)

                    for param_value in refined_values:
                        if self.stop_event.is_set():
                            break

                        session.current_step += 1
                        self.logger.info(f"Adaptive tuning: {session.parameter_name} = {param_value}")

                        # Same process as initial sweep
                        if not self._set_parameter_value(
                            session.board_id, session.parameter_name,
                            session.channel, param_value
                        ):
                            continue

                        self.daq_manager.set_save_data(False)

                        if not self.test_flag:
                            self.daq_manager.prepare_run_start()
                            self.daq_manager.configure_xdaq_for_run()
                            self.daq_manager.start_xdaq()
                            self.daq_manager.set_running_state(True)
                            self.spy_manager.start_spy(self.daq_manager.get_state())

                        for _ in range(session.run_duration):
                            if self.stop_event.is_set():
                                break
                            time.sleep(1)

                        if self.stop_event.is_set():
                            if not self.test_flag:
                                self.daq_manager.stop_xdaq()
                                self.spy_manager.stop_spy()
                                self.daq_manager.set_running_state(False)
                            break

                        histogram = self.spy_manager.get_histogram(
                            session.board_id, session.channel, boards
                        )
                        fit_result = self._fit_gaussian(histogram)

                        if not self.test_flag:
                            self.daq_manager.stop_xdaq()
                            self.spy_manager.stop_spy()
                            self.daq_manager.set_running_state(False)

                        point = {
                            "parameter_value": param_value,
                            "sigma": fit_result.get("sigma", float('inf')),
                            "sigma_error": fit_result.get("sigma_error", 0),
                            "mean": fit_result.get("mean", 0),
                            "chi_squared": fit_result.get("chi_squared", float('inf')),
                            "integral": fit_result.get("integral", 0),
                            "timestamp": time.time(),
                            "fit_success": fit_result.get("fit_success", False),
                            "error": fit_result.get("error"),
                        }
                        session.points.append(point)
                        tested_values.append(param_value)

                        if point["fit_success"] and point["sigma"] > 0:
                            if point["sigma"] < session.best_point.get("sigma", float('inf')):
                                session.best_point = point.copy()

                        self.history[session.session_id] = session
                        self._save_history()

                        time.sleep(2)

            # Set best parameter value if found
            if session.best_point and not self.stop_event.is_set():
                self._set_parameter_value(
                    session.board_id, session.parameter_name,
                    session.channel, session.best_point["parameter_value"]
                )
                self.logger.info(f"Best parameter value set: "
                               f"{session.parameter_name} = {session.best_point['parameter_value']} "
                               f"(sigma = {session.best_point['sigma']:.2f})")

            # Restore original save data setting
            self.daq_manager.set_save_data(original_save)

            if session.status == "running":
                session.status = "completed"
            session.end_time = time.time()

        except Exception as e:
            self.logger.error(f"Tuning loop error: {e}")
            session.status = "error"
            session.error_message = str(e)
            session.end_time = time.time()

            # Try to stop DAQ if running
            try:
                if not self.test_flag:
                    self.daq_manager.stop_xdaq()
                    self.spy_manager.stop_spy()
                    self.daq_manager.set_running_state(False)
            except:
                pass

        finally:
            # Save final state
            self.history[session.session_id] = session
            self._save_history()
            self.logger.info(f"Tuning session {session.session_id} ended with status: {session.status}")

    def start_tuning(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """
        Start a new tuning session.

        Args:
            config: Tuning configuration with:
                - board_id: Board ID string
                - channel: Channel number
                - parameter_name: Name of parameter to tune
                - param_min: Minimum parameter value
                - param_max: Maximum parameter value
                - num_steps: Number of steps in sweep
                - run_duration: Duration of each run in seconds
                - fit_range_min: Minimum of fit range
                - fit_range_max: Maximum of fit range

        Returns:
            Dict with session_id or error
        """
        with self.lock:
            if self.current_session and self.current_session.status == "running":
                return {"error": "A tuning session is already running"}

            # Validate board is DPP-PHA
            boards = self.daq_manager.get_boards()
            board_info = None
            for board in boards:
                if str(board['id']) == str(config['board_id']):
                    board_info = board
                    break

            if not board_info:
                return {"error": f"Board {config['board_id']} not found"}

            if board_info.get('dpp') != 'DPP-PHA':
                return {"error": "Resolution tuning only supports DPP-PHA boards"}

            # Validate parameter name
            if config['parameter_name'] not in TUNABLE_PARAMETERS:
                return {"error": f"Unknown parameter: {config['parameter_name']}"}

            # Validate run duration
            run_duration = max(30, int(config.get('run_duration', 30)))

            # Create new session
            self.current_session = TuningSession(
                board_id=str(config['board_id']),
                channel=int(config['channel']),
                parameter_name=config['parameter_name'],
                param_min=float(config['param_min']),
                param_max=float(config['param_max']),
                num_steps=int(config['num_steps']),
                run_duration=run_duration,
                fit_range_min=int(config['fit_range_min']),
                fit_range_max=int(config['fit_range_max']),
            )

            # Add to history
            self.history[self.current_session.session_id] = self.current_session

            # Start tuning thread
            self.stop_event.clear()
            self.tuning_thread = threading.Thread(
                target=self._tuning_loop,
                daemon=True
            )
            self.tuning_thread.start()

            self.logger.info(f"Tuning session started: {self.current_session.session_id}")
            return {"session_id": self.current_session.session_id}

    def stop_tuning(self) -> Dict[str, Any]:
        """Stop the current tuning session."""
        with self.lock:
            if not self.current_session or self.current_session.status != "running":
                return {"error": "No tuning session is running"}

            self.stop_event.set()

            # Wait for thread to finish (with timeout)
            if self.tuning_thread and self.tuning_thread.is_alive():
                self.tuning_thread.join(timeout=30)

            return {"message": "Tuning stopped", "session_id": self.current_session.session_id}

    def get_status(self) -> Dict[str, Any]:
        """Get current tuning status."""
        with self.lock:
            if not self.current_session:
                return {"status": "idle", "session": None}

            return {
                "status": self.current_session.status,
                "session": self.current_session.to_dict(),
            }

    def get_current_data(self) -> Dict[str, Any]:
        """Get data from current tuning session."""
        with self.lock:
            if not self.current_session:
                return {"points": [], "best_point": None}

            return {
                "points": self.current_session.points,
                "best_point": self.current_session.best_point,
                "current_step": self.current_session.current_step,
                "total_steps": self.current_session.total_steps,
            }

    def get_history(self, board_id: Optional[str] = None,
                    limit: int = 50) -> List[Dict[str, Any]]:
        """
        Get tuning history.

        Args:
            board_id: Filter by board ID (optional)
            limit: Maximum number of sessions to return

        Returns:
            List of session dictionaries
        """
        sessions = list(self.history.values())

        # Filter by board_id if specified
        if board_id:
            sessions = [s for s in sessions if s.board_id == board_id]

        # Sort by start time (most recent first)
        sessions.sort(key=lambda s: s.start_time, reverse=True)

        # Limit results
        sessions = sessions[:limit]

        return [s.to_dict() for s in sessions]

    def reset_history(self) -> Dict[str, Any]:
        """Clear all tuning history."""
        with self.lock:
            if self.current_session and self.current_session.status == "running":
                return {"error": "Cannot reset history while tuning is running"}

            self.history.clear()
            self.current_session = None

            # Delete history file
            if os.path.exists(self.history_file):
                os.remove(self.history_file)

            return {"message": "Tuning history cleared"}

    def get_tunable_parameters(self) -> List[Dict[str, str]]:
        """Get list of tunable parameters."""
        return [
            {"name": name, "address": f"0x{addr:04X}"}
            for name, addr in TUNABLE_PARAMETERS.items()
        ]


# Global instance
resolution_tuner: Optional[ResolutionTuner] = None


def get_resolution_tuner(daq_manager, spy_manager, test_flag: bool = False) -> ResolutionTuner:
    """
    Get or create the global resolution tuner instance.

    Args:
        daq_manager: DAQ manager instance
        spy_manager: Spy manager instance
        test_flag: Enable test mode

    Returns:
        Resolution tuner instance
    """
    global resolution_tuner
    if resolution_tuner is None:
        resolution_tuner = ResolutionTuner(daq_manager, spy_manager, test_flag=test_flag)
    return resolution_tuner
