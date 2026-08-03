"""
Graphite Database Utility Module

This module provides a Python interface for communicating with Graphite,
a real-time graphing system for time-series data. It handles metric retrieval,
data formatting, and error management for the LUNA experiment monitoring system.

Key Features:
- Time-series data retrieval from Graphite
- Multiple data format support (JSON, CSV, etc.)
- Robust error handling and logging
- Connection status monitoring
- Flexible time range queries

Author: Scientific DAQ Team
Purpose: Graphite database interface for LUNA experiment monitoring
"""

import requests
import logging
import threading
import time
from typing import List, Tuple, Optional, Dict, Any
from datetime import datetime

# Configure logging
logger = logging.getLogger(__name__)

# How long to wait for the TCP handshake, as opposed to for the answer. These
# are very different things and the distinction is what keeps a dead Graphite
# from taking WebDAQ with it. A host that is merely SLOW still completes the
# handshake in milliseconds on the local network; a host that is gone (powered
# off, or a firewall dropping SYNs rather than refusing them) never completes it
# at all, and without a separate short deadline every query then blocks for the
# full read timeout. Two seconds is far beyond any healthy LAN handshake.
DEFAULT_CONNECT_TIMEOUT_S = 2.0

# Consecutive failures before the breaker opens. Above one so that a single
# dropped packet or a render hiccup does not blind the dashboard.
DEFAULT_FAILURE_THRESHOLD = 3

# How long the breaker stays open before letting one probe through. Short enough
# that a Graphite coming back is picked up on its own within the minute, long
# enough that a dead host is not retried on every dashboard poll.
DEFAULT_COOLDOWN_S = 60.0


class GraphiteUnavailable(TimeoutError):
    """
    Raised instead of a network call while the breaker is open.

    Subclasses TimeoutError so callers that already treat a timeout as "no data
    this round" keep working unchanged — the difference is that this one is
    raised immediately rather than after a stalled connect.
    """


class GraphiteClient:
    """
    Client for interacting with Graphite time-series database.
    
    Provides methods for retrieving metrics data, checking connectivity,
    and handling various data formats from Graphite render API.
    """
    
    def __init__(self, host: str, port: int = 80, timeout: int = 30,
                 connect_timeout: float = DEFAULT_CONNECT_TIMEOUT_S,
                 failure_threshold: int = DEFAULT_FAILURE_THRESHOLD,
                 cooldown_s: float = DEFAULT_COOLDOWN_S):
        """
        Initialize the GraphiteClient with connection parameters.

        Args:
            host: Hostname or IP address of the Graphite server
            port: Port number of the Graphite server (default: 80)
            timeout: Time to wait for the ANSWER, in seconds (default: 30)
            connect_timeout: Time to wait for the TCP handshake, in seconds
            failure_threshold: Consecutive failures that open the breaker
            cooldown_s: How long the breaker stays open before probing again
        """
        self.host = host
        self.port = port
        self.timeout = timeout
        self.connect_timeout = connect_timeout
        self.base_url = f"http://{host}:{port}"

        # Circuit breaker. Every caller shares one client across waitress worker
        # threads, so this state is shared and needs its own lock.
        self.failure_threshold = max(1, int(failure_threshold))
        self.cooldown_s = float(cooldown_s)
        self._breaker_lock = threading.Lock()
        self._failures = 0
        self._open_until: Optional[float] = None   # monotonic deadline
        self._probing = False                      # a half-open probe is in flight
        self._last_error: Optional[str] = None

        self.logger = logging.getLogger(__name__ + '.GraphiteClient')

        self.logger.info(f"GraphiteClient initialized for {self.base_url}")
        self.logger.debug(
            f"Timeouts: {connect_timeout}s connect / {timeout}s read; "
            f"breaker opens after {self.failure_threshold} failures "
            f"for {self.cooldown_s}s")

    # ── Circuit breaker ──────────────────────────────────────────────────────
    #
    # The point is not to spare Graphite, it is to spare US. A query runs on a
    # waitress worker thread; with the server unreachable every one of them
    # parks in connect() and the request queue grows without bound until the
    # whole DAQ interface is unusable. Failing instantly keeps the workers free.

    @property
    def _timeouts(self):
        """requests' (connect, read) pair."""
        return (self.connect_timeout, self.timeout)

    def _breaker_admit(self) -> bool:
        """
        Decide whether a network call may go ahead.

        Returns True to proceed, and raises GraphiteUnavailable when the breaker
        is open. Exactly one caller is admitted as the half-open probe once the
        cooldown expires; the rest keep failing fast until that probe settles,
        so a dead host costs one handshake per cooldown rather than one per
        thread.
        """
        with self._breaker_lock:
            if self._open_until is None:
                return True

            if time.monotonic() < self._open_until or self._probing:
                raise GraphiteUnavailable(
                    f"Graphite at {self.base_url} is marked unavailable "
                    f"({self._last_error or 'no route'}); not retried until the "
                    f"cooldown expires")

            # Cooldown expired and nobody else is probing: this call becomes it.
            self._probing = True
            self.logger.info(
                f"Probing Graphite at {self.base_url} after {self.cooldown_s}s")
            return True

    def _breaker_success(self) -> None:
        with self._breaker_lock:
            recovered = self._open_until is not None
            self._failures = 0
            self._open_until = None
            self._probing = False
            self._last_error = None
        if recovered:
            self.logger.warning(
                f"Graphite at {self.base_url} is reachable again; resuming queries")

    def _breaker_failure(self, error: Exception) -> None:
        with self._breaker_lock:
            self._failures += 1
            self._last_error = str(error).split('\n')[0][:200]
            was_open = self._open_until is not None
            self._probing = False
            if self._failures >= self.failure_threshold:
                self._open_until = time.monotonic() + self.cooldown_s
                newly_open = not was_open
            else:
                newly_open = False
        if newly_open:
            # Logged once per outage, not once per query: the flood of identical
            # tracebacks is itself part of what makes an outage hard to read.
            self.logger.error(
                f"Graphite at {self.base_url} unreachable after {self._failures} "
                f"attempts ({self._last_error}). Queries will fail immediately "
                f"and it will be probed every {self.cooldown_s}s until it "
                f"answers. WebDAQ acquisition is unaffected.")

    def reset_breaker(self) -> None:
        """
        Forget an outage and query again on the next call.

        Recovery is automatic — the breaker probes on its own every cooldown —
        so this is only for when you have just fixed Graphite and would rather
        not wait for the next probe.
        """
        with self._breaker_lock:
            self._failures = 0
            self._open_until = None
            self._probing = False
            self._last_error = None
        self.logger.info(f"Graphite breaker for {self.base_url} reset by request")

    @property
    def available(self) -> bool:
        """False while the breaker is open, i.e. queries would fail instantly."""
        with self._breaker_lock:
            return self._open_until is None

    def breaker_state(self) -> Dict[str, Any]:
        """Breaker status, for the UI and /stats endpoints."""
        with self._breaker_lock:
            open_for = (None if self._open_until is None
                        else max(0.0, self._open_until - time.monotonic()))
            return {
                'available': self._open_until is None,
                'consecutive_failures': self._failures,
                'retry_in_s': None if open_for is None else round(open_for, 1),
                'last_error': self._last_error,
            }

    def _get(self, url: str, params: Dict[str, Any],
             timeout: Optional[Any] = None) -> requests.Response:
        """A GET guarded by the breaker, with the connect deadline applied."""
        self._breaker_admit()
        try:
            response = requests.get(url, params=params,
                                    timeout=timeout or self._timeouts)
        except (requests.exceptions.ConnectionError,
                requests.exceptions.Timeout) as e:
            # Only transport failures count against the breaker. An HTTP error
            # or unparseable body means Graphite is up and talking, which is a
            # different problem and must not stop us querying it.
            self._breaker_failure(e)
            raise
        self._breaker_success()
        return response


    def get_data(self,
                 target: str,
                 from_time: str,
                 until_time: str = 'now',
                 format: str = 'json',
                 max_data_points: Optional[int] = None) -> List[Tuple[datetime, Optional[float]]]:
        """
        Retrieve time-series data for a given metric from Graphite.

        This method queries the Graphite render API to fetch data points
        for a specified metric over a given time range.

        Args:
            target: Metric name or Graphite function (e.g., 'tetram.ch0', 'ancillary.rates.*')
            from_time: Start time for query (e.g., '-1h', '-1d', '20240101')
            until_time: End time for query (default: 'now')
            format: Response format (default: 'json')
            max_data_points: Cap on the number of points returned. Graphite
                consolidates (averages) to fit, so a three-day window costs no
                more to fetch or to plot than a three-minute one. Omit for the
                metric's native resolution.

        Returns:
            List of tuples containing (timestamp, value) pairs

        Raises:
            requests.RequestException: For HTTP communication errors
            ValueError: For invalid response format
            TimeoutError: For request timeout
        """
        self.logger.debug(f"Querying Graphite: target={target}, from={from_time}, until={until_time}")

        url = f"{self.base_url}/render"
        params = {
            'target': target,
            'from': from_time,
            'until': until_time,
            'format': format
        }
        if max_data_points:
            params['maxDataPoints'] = int(max_data_points)

        try:
            # Make HTTP request to Graphite
            response = self._get(url, params)
            response.raise_for_status()

            self.logger.debug(f"Graphite response status: {response.status_code}")
            
            # Parse JSON response
            data = response.json()
            
            # Validate response structure
            if not data:
                self.logger.warning(f"Empty response from Graphite for target: {target}")
                return []
            
            if not isinstance(data, list) or len(data) == 0:
                self.logger.warning(f"Invalid response format from Graphite for target: {target}")
                return []
            
            first_series = data[0]
            if 'datapoints' not in first_series:
                self.logger.warning(f"No datapoints in Graphite response for target: {target}")
                return []
            
            # Convert datapoints to list of (datetime, value) tuples
            datapoints = first_series['datapoints']
            result = []
            
            for value, timestamp in datapoints:
                # Handle null timestamps (Graphite sometimes returns them)
                if timestamp is not None:
                    try:
                        dt = datetime.fromtimestamp(timestamp)
                        result.append((dt, value))
                    except (ValueError, OSError) as e:
                        self.logger.warning(f"Invalid timestamp {timestamp}: {e}")
                        continue
            
            self.logger.debug(f"Retrieved {len(result)} datapoints for target: {target}")
            return result
            
        except GraphiteUnavailable:
            # Already logged once when the breaker opened; re-raised as-is so
            # the caller can tell "known down" from "just failed".
            raise

        except requests.exceptions.Timeout as e:
            error_msg = f"Timeout querying Graphite for target {target}: {e}"
            self.logger.error(error_msg)
            raise TimeoutError(error_msg)

        except requests.exceptions.ConnectionError as e:
            error_msg = f"Connection error to Graphite server {self.base_url}: {e}"
            self.logger.error(error_msg)
            raise requests.RequestException(error_msg)
            
        except requests.exceptions.HTTPError as e:
            error_msg = f"HTTP error from Graphite server: {e}"
            self.logger.error(error_msg)
            raise requests.RequestException(error_msg)
            
        except requests.RequestException as e:
            error_msg = f"Request error communicating with Graphite: {e}"
            self.logger.error(error_msg)
            raise
            
        except ValueError as e:
            error_msg = f"Error parsing Graphite response for target {target}: {e}"
            self.logger.error(error_msg)
            raise
            
        except Exception as e:
            error_msg = f"Unexpected error querying Graphite for target {target}: {e}"
            self.logger.error(error_msg)
            raise
    
    def get_multiple_targets(self, 
                           targets: List[str], 
                           from_time: str, 
                           until_time: str = 'now') -> Dict[str, List[Tuple[datetime, Optional[float]]]]:
        """
        Retrieve data for multiple targets in a single request.
        
        Args:
            targets: List of metric names or Graphite functions
            from_time: Start time for query
            until_time: End time for query (default: 'now')
            
        Returns:
            Dictionary mapping target names to their data points
        """
        self.logger.debug(f"Querying multiple targets: {len(targets)} metrics")
        
        url = f"{self.base_url}/render"
        params = {
            'format': 'json',
            'from': from_time,
            'until': until_time
        }
        
        # Add all targets as separate parameters
        for target in targets:
            params[f'target'] = target
        
        try:
            response = self._get(url, params)
            response.raise_for_status()

            data = response.json()
            result = {}

            for series in data:
                target_name = series.get('target', 'unknown')
                datapoints = series.get('datapoints', [])
                
                result[target_name] = [
                    (datetime.fromtimestamp(timestamp), value)
                    for value, timestamp in datapoints
                    if timestamp is not None
                ]
            
            self.logger.debug(f"Retrieved data for {len(result)} targets")
            return result
            
        except Exception as e:
            self.logger.error(f"Error querying multiple targets: {e}")
            raise
    
    def check_connection(self) -> bool:
        """
        Check if the Graphite server is accessible.
        
        Returns:
            bool: True if server is accessible, False otherwise
        """
        try:
            # Try a simple query to test connectivity
            # Ask for the top of the metric tree rather than just knocking on the
            # door: a status code below 500 only proves *something* is listening,
            # and a wrong port pointing at some other web service would then show
            # up as "connected" while every metric stayed empty. A JSON list back
            # from /metrics/find means this really is Graphite.
            response = self._get(f"{self.base_url}/metrics/find",
                                 {'query': '*', 'format': 'json'},
                                 timeout=(self.connect_timeout, 5))

            if response.status_code >= 400:
                self.logger.warning(f"Graphite server returned status {response.status_code}")
                return False

            try:
                is_connected = isinstance(response.json(), list)
            except ValueError:
                is_connected = False

            if is_connected:
                self.logger.debug("Graphite server connection test successful")
            else:
                self.logger.warning(
                    f"{self.base_url} answered, but not like a Graphite server")

            return is_connected
            
        except GraphiteUnavailable:
            # Known down, so this is not news and not worth a second line in the
            # log. check_connection is the one caller allowed to ask anyway: it
            # exists to report status, and the breaker's own probe is what will
            # notice the recovery.
            return False

        except requests.exceptions.ConnectionError:
            self.logger.warning(f"Cannot connect to Graphite server at {self.base_url}")
            return False

        except requests.exceptions.Timeout:
            self.logger.warning("Graphite server connection test timed out")
            return False

        except Exception as e:
            self.logger.warning(f"Graphite connection test failed: {e}")
            return False
    
    def find_metrics(self, query: str = '*') -> List[Dict[str, Any]]:
        """
        One level of the metric tree, as [{'path': ..., 'is_leaf': bool}].

        Graphite's /metrics/find answers in two different shapes depending on
        version and format: the treejson style ({'id', 'text', 'leaf'}) and the
        plain style ({'path', 'is_leaf'}). Both are normalised here, because a
        server answering in the other shape looks like an empty tree otherwise.

        Args:
            query: a pattern for ONE level, e.g. '*' or 'accelerator.*'

        Returns:
            Nodes sorted by path. Empty on any error — the browser shows
            "nothing here" rather than failing.
        """
        try:
            response = self._get(f"{self.base_url}/metrics/find",
                                 {'query': query, 'format': 'json'})
            response.raise_for_status()
            data = response.json()
        except Exception as e:
            self.logger.error(f"Error finding metrics for '{query}': {e}")
            return []

        if not isinstance(data, list):
            return []

        nodes = []
        for item in data:
            if not isinstance(item, dict):
                continue
            path = item.get('path') or item.get('id') or item.get('text')
            if not path:
                continue
            if 'is_leaf' in item:
                is_leaf = bool(item['is_leaf'])
            elif 'leaf' in item:
                is_leaf = bool(item['leaf'])
            else:
                # Neither flag: a node that cannot be expanded is a metric.
                is_leaf = not bool(item.get('expandable', 0))
            nodes.append({'path': str(path), 'is_leaf': is_leaf})

        nodes.sort(key=lambda n: n['path'])
        self.logger.debug(f"Found {len(nodes)} nodes for query '{query}'")
        return nodes

    def get_metrics_list(self, query: str = '*') -> List[str]:
        """
        Get list of available metrics matching a pattern.
        
        Args:
            query: Metric pattern to search for (default: '*' for all)
            
        Returns:
            List of metric names
        """
        try:
            url = f"{self.base_url}/metrics/find"
            params = {
                'query': query,
                'format': 'json'
            }
            
            response = self._get(url, params)
            response.raise_for_status()

            data = response.json()

            # Extract metric names from the response
            metrics = []
            for item in data:
                if item.get('leaf', False):  # Only leaf nodes are actual metrics
                    metrics.append(item.get('text', ''))
            
            self.logger.debug(f"Found {len(metrics)} metrics matching pattern: {query}")
            return metrics
            
        except Exception as e:
            self.logger.error(f"Error retrieving metrics list: {e}")
            return []
    
    def get_connection_info(self) -> Dict[str, Any]:
        """
        Get detailed connection information and status.
        
        Returns:
            Dictionary with connection details and status
        """
        info = {
            'host': self.host,
            'port': self.port,
            'base_url': self.base_url,
            'timeout': self.timeout,
            'connect_timeout': self.connect_timeout,
            'connected': False,
            'response_time_ms': None,
            'error': None
        }
        info.update(self.breaker_state())

        try:
            start_time = time.time()

            # Test connection
            info['connected'] = self.check_connection()
            
            # Calculate response time
            response_time = (time.time() - start_time) * 1000
            info['response_time_ms'] = round(response_time, 2)
            
        except Exception as e:
            info['error'] = str(e)
        
        return info
    
    def format_data_for_export(self, 
                             data: List[Tuple[datetime, Optional[float]]], 
                             metric_name: str = 'metric') -> List[Dict[str, Any]]:
        """
        Format data points for export to external systems.
        
        Args:
            data: List of (timestamp, value) tuples
            metric_name: Name of the metric for labeling
            
        Returns:
            List of dictionaries with formatted data
        """
        formatted_data = []
        
        for timestamp, value in data:
            formatted_data.append({
                'metric': metric_name,
                'timestamp': timestamp.isoformat(),
                'value': value,
                'unix_timestamp': int(timestamp.timestamp())
            })
        
        return formatted_data