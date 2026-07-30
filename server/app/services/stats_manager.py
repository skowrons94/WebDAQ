"""
Stats Manager Module

This module provides centralized management of Graphite statistics collection
for real-time monitoring. It manages Graphite client connections, metric path
configuration, and background data collection threads.

Key Features:
- Single Graphite client for efficient connection management
- Configurable metric paths saved to conf/stats.json
- Background data collection thread similar to current.py
- Real-time data streaming to a per-run stats.csv
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

# Root of the metric tree caendaq publishes rates under. It names the
# EXPERIMENT, not a board — set it to 'ancillary.rates.12c12c' and that campaign
# owns the subtree, with boards below it as bo_<VME board id>. Kept here (and in
# conf/stats.json) so switching experiment is a settings change, not a rebuild.
DEFAULT_GRAPHITE_PREFIX = "ancillary.rates"


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
            "graphite_prefix": DEFAULT_GRAPHITE_PREFIX,
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

    def add_path(self, path: str, alias: Optional[str] = None, unit: Optional[str] = None) -> bool:
        """
        Add a new metric path to the configuration.

        Args:
            path: Graphite metric path (e.g., 'accelerator.terminal_voltage')
            alias: Optional friendly name for the metric
            unit: Optional unit ('kV', 'uA', 'counts/s'), recorded in the run's
                stats file so a column can be read without guessing its scale

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
                "unit": unit or "",
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

    def update_path(self, path: str, alias: Optional[str] = None, enabled: Optional[bool] = None,
                    unit: Optional[str] = None) -> bool:
        """
        Update a metric path configuration.

        Args:
            path: Graphite metric path to update
            alias: New alias (if provided)
            enabled: Enable/disable the path (if provided)
            unit: New unit (if provided; pass '' to clear it)

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
                    if unit is not None:
                        path_entry['unit'] = unit

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

    def get_graphite_prefix(self) -> str:
        """The experiment's metric subtree, e.g. 'ancillary.rates.12c12c'."""
        return str(self.stats_config.get('graphite_prefix') or '') or DEFAULT_GRAPHITE_PREFIX

    def set_graphite_prefix(self, prefix: str) -> str:
        """Set the experiment's metric subtree and persist it.

        Returns the prefix actually stored — the same normalisation caendaq
        applies, so what the operator sees back is what the paths will use.
        Raises ValueError if nothing usable is left after normalising.
        """
        cleaned = self.normalize_prefix(prefix)
        self.stats_config['graphite_prefix'] = cleaned
        self._save_config(self.stats_config)
        self.logger.info(f"Graphite metric prefix set to '{cleaned}'")
        return cleaned

    @staticmethod
    def normalize_prefix(prefix: str) -> str:
        """Normalise a metric prefix the way caendaq's StatsCollector does.

        A prefix is a dotted path, so dots survive; anything else Graphite would
        choke on becomes '_', and leading/trailing dots are trimmed because they
        would produce empty path segments.
        """
        raw = str(prefix or '').strip()
        cleaned = ''.join(
            c if (c.isalnum() and c.isascii()) or c in '.-' else '_' for c in raw
        ).strip('.')
        if not cleaned:
            raise ValueError("The metric prefix must contain at least one usable character.")
        return cleaned

    def get_last_value(self, path: str, from_time: str = '-10s') -> Tuple[Optional[float], Optional[datetime]]:
        """
        Fetch the last non-null value from Graphite for a given path.

        Args:
            path: Graphite metric path
            from_time: Time range to query (default: '-10s')

        Returns:
            Tuple of (value, timestamp) or (None, None) if no data found
        """
        # Graphite occasionally returns empty/null tails (ingestion lag, brief
        # render hiccups). Walk through progressively wider windows so a
        # transient gap doesn't leave the caller with no value.
        windows = [from_time]
        for fallback in ('-1min', '-5min', '-30min'):
            if fallback not in windows:
                windows.append(fallback)

        for window in windows:
            for attempt in range(2):
                try:
                    data = self.graphite_client.get_data(path, window, 'now')
                    for timestamp, value in reversed(data):
                        if value is not None:
                            return (value, timestamp)
                    break  # got a response, just no non-null points — widen window
                except Exception as e:
                    if attempt == 0:
                        self.logger.debug(
                            f"Graphite query failed for {path} (window {window}), retrying: {e}"
                        )
                        continue
                    self.logger.warning(
                        f"Graphite query failed for {path} (window {window}): {e}"
                    )
                    break  # try next window

        return (None, None)

    @staticmethod
    def _format_row(fields: List[str]) -> str:
        """One CSV record. Fields that contain a comma or a quote are quoted."""
        cells = []
        for field in fields:
            if any(ch in field for ch in ',"\n'):
                cells.append('"' + field.replace('"', '""') + '"')
            else:
                cells.append(field)
        return ",".join(cells)

    @staticmethod
    def _column_title(path_entry: Dict[str, Any]) -> str:
        """A column heading: the metric's name, with its unit when it has one."""
        name = path_entry.get('alias') or path_entry['path']
        unit = (path_entry.get('unit') or '').strip()
        return f"{name} [{unit}]" if unit else name

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

        Creates stats.csv with its header and starts background collection thread.

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

                self.stats_file = os.path.join(run_dir, "stats.csv")
                self.current_run_number = run_number
                self.run_start_time = time.time()

                # Freeze the set of columns for the whole run so data rows always
                # line up with the header.
                self.stats_paths = self.get_enabled_paths()
                self.stats_columns = ["Time [s]"] + [
                    self._column_title(p) for p in self.stats_paths
                ]

                # CSV, because this file is read by analysis code far more often
                # than by eye: the metadata stays in '#' comment lines that every
                # CSV reader can skip (pandas: read_csv(..., comment='#')), and
                # the column row carries the operator's own name and unit for
                # each metric, with its Graphite path recorded above so a column
                # can always be traced back to its source.
                start_iso = datetime.fromtimestamp(self.run_start_time).isoformat(timespec='seconds')
                header_lines = [
                    "# LUNA DAQ statistics",
                    f"# Run number: {run_number}",
                    f"# Start time: {start_iso}",
                    "# Format: CSV. The first column is the elapsed acquisition time in seconds;",
                    "# the rest are the metrics below, in this order. Missing samples are 0.",
                    "#",
                ]
                for entry in self.stats_paths:
                    unit = (entry.get('unit') or '').strip() or '-'
                    header_lines.append(
                        f"# Metric: {entry.get('alias') or entry['path']} | unit: {unit} "
                        f"| source: {entry['path']}")
                header_lines.append("#")
                header_lines.append(self._format_row(self.stats_columns))
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
        # Signal the loop BEFORE taking the lock. Stopping a run must not wait
        # for a Graphite query that is still in flight: an unreachable server
        # can hold one for a long time, and the operator pressing Stop cannot be
        # made to wait for it.
        if not self.collecting:
            self.logger.warning("Not currently collecting stats")
            return False
        self.collecting = False

        with self.collection_lock:
            try:
                # Wait for thread to finish (with timeout)
                if self.collection_thread and self.collection_thread.is_alive():
                    self.collection_thread.join(timeout=5)

                self.stats_file = None
                self.current_run_number = None
                self.run_start_time = None
                self.stats_paths = []
                self.stats_columns = []

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

        Periodically fetches latest values from Graphite and writes to stats.csv.
        Similar pattern to current.py's acquisition thread.
        """
        collection_interval = 1.0  # seconds

        while self.collecting:
            try:
                # Read the run's frozen state under the lock, then let it go: the
                # Graphite queries below can take seconds against a sick server,
                # and holding the lock across them would block stop_run().
                with self.collection_lock:
                    stats_file = self.stats_file
                    run_start_time = self.run_start_time
                    path_entries = list(self.stats_paths)

                if not self.collecting or not stats_file or not run_start_time:
                    break

                elapsed_time = time.time() - run_start_time

                # One value per column, in the order frozen at start_run so each
                # lands under its header; missing samples become 0.
                fields = [f"{elapsed_time:.3f}"]
                for path_entry in path_entries:
                    if not self.collecting:
                        break          # Stop was pressed mid-sample: drop this row
                    value, _timestamp = self.get_last_value(path_entry['path'])
                    fields.append(self._format_value(value))

                # A short row would put values under the wrong headings.
                if self.collecting and len(fields) == len(path_entries) + 1:
                    if os.path.exists(os.path.dirname(stats_file)):
                        with open(stats_file, 'a') as f:
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
            "graphite_prefix": self.get_graphite_prefix(),
            "paths_count": len(self.stats_config.get('paths', [])),
            "enabled_paths_count": len(self.get_enabled_paths()),
            "collecting": self.collecting,
            "current_run": self.current_run_number
        }
