"""
Stats Manager Module

This module provides centralized management of Graphite statistics collection
for real-time monitoring. It manages Graphite client connections, metric path
configuration, and background data collection threads.

Key Features:
- Single Graphite client for efficient connection management
- Configurable metric paths saved to conf/stats.json
- Background data collection thread similar to current.py
- Real-time data streaming to stats.txt files
- Last non-null value fetching from Graphite
- Thread-safe operations

Author: WebDAQ Team
Purpose: Centralized statistics collection from Graphite
"""

import os
import json
import logging
import time
import threading
from typing import Dict, List, Optional, Any, Tuple
from datetime import datetime

from ..utils.graphite import GraphiteClient

logger = logging.getLogger(__name__)


class StatsManager:
    """
    Centralized manager for Graphite statistics collection.

    Manages metric paths, Graphite client connections, and background
    data collection threads for real-time statistics monitoring.
    """

    def __init__(self, graphite_host: str = 'lunaserver', graphite_port: int = 80):
        """
        Initialize Stats Manager.

        Args:
            graphite_host: Graphite server hostname (default: 'lunaserver')
            graphite_port: Graphite server port (default: 80)
        """
        self.logger = logging.getLogger(__name__ + '.StatsManager')

        # Initialize Graphite client
        self.graphite_client = GraphiteClient(graphite_host, graphite_port)
        self.logger.info(f"Stats manager initialized with Graphite at {graphite_host}:{graphite_port}")

        # Load configuration
        self.config_path = "conf/stats.json"
        self.stats_config = self._load_config()

        # Thread management
        self.collection_thread = None
        self.collecting = False
        self.current_run_number = None
        self.run_start_time = None
        self.stats_file = None
        # Column layout frozen at start_run so the data rows always line up with
        # the header even if paths are added/removed mid-run.
        self.stats_paths: List[Dict[str, Any]] = []
        self.stats_columns: List[str] = []
        self.stats_col_widths: List[int] = []
        self.collection_lock = threading.Lock()

    def _load_config(self) -> Dict[str, Any]:
        """
        Load stats configuration from conf/stats.json.

        Creates default config if file doesn't exist.

        Returns:
            Dictionary with configuration including paths list
        """
        os.makedirs("conf", exist_ok=True)

        if os.path.exists(self.config_path):
            try:
                with open(self.config_path, 'r') as f:
                    config = json.load(f)
                # Update graphite client settings if they exist in config
                if 'graphite_host' in config:
                    self.graphite_client.host = config['graphite_host']
                if 'graphite_port' in config:
                    self.graphite_client.port = config['graphite_port']
                if 'graphite_host' in config or 'graphite_port' in config:
                    self.graphite_client.base_url = f"http://{self.graphite_client.host}:{self.graphite_client.port}"
                self.logger.info(f"Loaded stats config with {len(config.get('paths', []))} paths")
                return config
            except Exception as e:
                self.logger.error(f"Error loading stats config: {e}")

        # Create default config
        default_config = {
            "graphite_host": self.graphite_client.host,
            "graphite_port": self.graphite_client.port,
            "paths": []
        }

        self._save_config(default_config)
        return default_config

    def _save_config(self, config: Dict[str, Any]) -> bool:
        """
        Save stats configuration to conf/stats.json.

        Args:
            config: Configuration dictionary to save

        Returns:
            True if save successful, False otherwise
        """
        try:
            os.makedirs("conf", exist_ok=True)
            with open(self.config_path, 'w') as f:
                json.dump(config, f, indent=2)
            self.logger.info("Stats config saved successfully")
            return True
        except Exception as e:
            self.logger.error(f"Error saving stats config: {e}")
            return False

    def add_path(self, path: str, alias: Optional[str] = None) -> bool:
        """
        Add a new metric path to the configuration.

        Args:
            path: Graphite metric path (e.g., 'accelerator.terminal_voltage')
            alias: Optional friendly name for the metric

        Returns:
            True if added successfully, False otherwise
        """
        try:
            # Check if path already exists
            existing_paths = [p['path'] for p in self.stats_config.get('paths', [])]
            if path in existing_paths:
                self.logger.warning(f"Path already exists: {path}")
                return False

            # Add new path
            new_path_entry = {
                "path": path,
                "alias": alias or path,
                "enabled": True
            }

            if 'paths' not in self.stats_config:
                self.stats_config['paths'] = []

            self.stats_config['paths'].append(new_path_entry)
            self._save_config(self.stats_config)

            self.logger.info(f"Added path: {path} (alias: {alias or path})")
            return True

        except Exception as e:
            self.logger.error(f"Error adding path: {e}")
            return False

    def remove_path(self, path: str) -> bool:
        """
        Remove a metric path from the configuration.

        Args:
            path: Graphite metric path to remove

        Returns:
            True if removed successfully, False otherwise
        """
        try:
            if 'paths' not in self.stats_config:
                return False

            initial_count = len(self.stats_config['paths'])
            self.stats_config['paths'] = [
                p for p in self.stats_config['paths']
                if p['path'] != path
            ]

            if len(self.stats_config['paths']) < initial_count:
                self._save_config(self.stats_config)
                self.logger.info(f"Removed path: {path}")
                return True
            else:
                self.logger.warning(f"Path not found: {path}")
                return False

        except Exception as e:
            self.logger.error(f"Error removing path: {e}")
            return False

    def update_path(self, path: str, alias: Optional[str] = None, enabled: Optional[bool] = None) -> bool:
        """
        Update a metric path configuration.

        Args:
            path: Graphite metric path to update
            alias: New alias (if provided)
            enabled: Enable/disable the path (if provided)

        Returns:
            True if updated successfully, False otherwise
        """
        try:
            if 'paths' not in self.stats_config:
                return False

            for path_entry in self.stats_config['paths']:
                if path_entry['path'] == path:
                    if alias is not None:
                        path_entry['alias'] = alias
                    if enabled is not None:
                        path_entry['enabled'] = enabled

                    self._save_config(self.stats_config)
                    self.logger.info(f"Updated path: {path}")
                    return True

            self.logger.warning(f"Path not found: {path}")
            return False

        except Exception as e:
            self.logger.error(f"Error updating path: {e}")
            return False

    def get_paths(self) -> List[Dict[str, Any]]:
        """
        Get all configured metric paths.

        Returns:
            List of path configuration dictionaries
        """
        return self.stats_config.get('paths', [])

    def get_enabled_paths(self) -> List[Dict[str, Any]]:
        """
        Get all enabled metric paths.

        Returns:
            List of enabled path configuration dictionaries
        """
        return [p for p in self.stats_config.get('paths', []) if p.get('enabled', True)]

    def get_last_value(self, path: str, from_time: str = '-10s') -> Tuple[Optional[float], Optional[datetime]]:
        """
        Fetch the last non-null value from Graphite for a given path.

        Args:
            path: Graphite metric path
            from_time: Time range to query (default: '-10s')

        Returns:
            Tuple of (value, timestamp) or (None, None) if no data found
        """
        try:
            data = self.graphite_client.get_data(path, from_time, 'now')

            # Find last non-null value
            for timestamp, value in reversed(data):
                if value is not None:
                    return (value, timestamp)

            return (None, None)

        except Exception as e:
            self.logger.error(f"Error fetching last value for {path}: {e}")
            return (None, None)

    def _format_row(self, fields: List[str]) -> str:
        """Right-justify each field to its column width for aligned output."""
        return "".join(
            field.rjust(width)
            for field, width in zip(fields, self.stats_col_widths)
        )

    @staticmethod
    def _format_value(value: Any) -> str:
        """Format a metric value; missing/invalid samples become '0'."""
        if value is None:
            return "0"
        try:
            return f"{float(value):.6g}"
        except (TypeError, ValueError):
            return "0"

    def start_run(self, run_number: int) -> bool:
        """
        Start statistics collection for a new run.

        Creates stats.txt file with headers and starts background collection thread.

        Args:
            run_number: Run number for data organization

        Returns:
            True if start successful, False otherwise
        """
        with self.collection_lock:
            try:
                if self.collecting:
                    self.logger.warning("Already collecting stats")
                    return False

                # Create run directory
                run_dir = f"./data/run{run_number}"
                os.makedirs(run_dir, exist_ok=True)

                self.stats_file = os.path.join(run_dir, "stats.txt")
                self.current_run_number = run_number
                self.run_start_time = time.time()

                # Freeze the set of columns for the whole run so data rows always
                # line up with the header.
                self.stats_paths = self.get_enabled_paths()
                self.stats_columns = ["Time_s"] + [
                    p.get('alias') or p['path'] for p in self.stats_paths
                ]
                # Each column is right-justified to a fixed width; the +3 keeps a
                # visible gap between columns.
                self.stats_col_widths = [max(len(c) + 3, 16) for c in self.stats_columns]

                # Write a human-readable header: metadata as comments, then an
                # aligned column-name row matching the data rows below.
                start_iso = datetime.fromtimestamp(self.run_start_time).isoformat(timespec='seconds')
                header_lines = [
                    "# LUNA DAQ statistics",
                    f"# Run number: {run_number}",
                    f"# Start time: {start_iso}",
                    "# Columns: elapsed acquisition time (s) followed by one column per Graphite metric.",
                    "# Missing samples are recorded as 0.",
                    "#",
                    self._format_row(self.stats_columns),
                ]
                with open(self.stats_file, 'w') as f:
                    f.write("\n".join(header_lines) + "\n")

                # Start collection thread
                self.collecting = True
                self.collection_thread = threading.Thread(
                    target=self._collection_loop,
                    daemon=True
                )
                self.collection_thread.start()

                self.logger.info(f"Stats collection started for run {run_number}")
                return True

            except Exception as e:
                self.logger.error(f"Error starting stats run: {e}")
                return False

    def stop_run(self) -> bool:
        """
        Stop statistics collection for current run.

        Returns:
            True if stop successful, False otherwise
        """
        with self.collection_lock:
            try:
                if not self.collecting:
                    self.logger.warning("Not currently collecting stats")
                    return False

                self.collecting = False

                # Wait for thread to finish (with timeout)
                if self.collection_thread and self.collection_thread.is_alive():
                    self.collection_thread.join(timeout=5)

                self.stats_file = None
                self.current_run_number = None
                self.run_start_time = None
                self.stats_paths = []
                self.stats_columns = []
                self.stats_col_widths = []

                self.logger.info("Stats collection stopped")
                return True

            except Exception as e:
                self.logger.error(f"Error stopping stats run: {e}")
                return False

    def is_collecting(self) -> bool:
        """
        Check if stats collection is currently running.

        Returns:
            True if collecting, False otherwise
        """
        return self.collecting

    def _collection_loop(self):
        """
        Background thread loop for collecting statistics.

        Periodically fetches latest values from Graphite and writes to stats.txt.
        Similar pattern to current.py's acquisition thread.
        """
        collection_interval = 1.0  # seconds

        while self.collecting:
            try:
                with self.collection_lock:
                    if not self.collecting or not self.stats_file or not self.run_start_time:
                        break

                    # Calculate elapsed time
                    elapsed_time = time.time() - self.run_start_time

                    # Collect data using the columns frozen at start_run so each
                    # value lands under its header; missing samples become 0.
                    fields = [f"{elapsed_time:.3f}"]
                    for path_entry in self.stats_paths:
                        value, _timestamp = self.get_last_value(path_entry['path'])
                        fields.append(self._format_value(value))

                    # Write to file
                    if self.stats_file and os.path.exists(os.path.dirname(self.stats_file)):
                        with open(self.stats_file, 'a') as f:
                            f.write(self._format_row(fields) + "\n")

                # Sleep before next collection
                time.sleep(collection_interval)

            except Exception as e:
                self.logger.error(f"Error in collection loop: {e}")
                time.sleep(collection_interval)

    def get_config_info(self) -> Dict[str, Any]:
        """
        Get current configuration information.

        Returns:
            Dictionary with config details
        """
        return {
            "graphite_host": self.graphite_client.host,
            "graphite_port": self.graphite_client.port,
            "paths_count": len(self.stats_config.get('paths', [])),
            "enabled_paths_count": len(self.get_enabled_paths()),
            "collecting": self.collecting,
            "current_run": self.current_run_number
        }
