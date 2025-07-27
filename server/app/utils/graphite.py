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
from typing import List, Tuple, Optional, Dict, Any
from datetime import datetime

# Configure logging
logger = logging.getLogger(__name__)

class GraphiteClient:
    """
    Client for interacting with Graphite time-series database.
    
    Provides methods for retrieving metrics data, checking connectivity,
    and handling various data formats from Graphite render API.
    """
    
    def __init__(self, host: str, port: int = 80, timeout: int = 30):
        """
        Initialize the GraphiteClient with connection parameters.
        
        Args:
            host: Hostname or IP address of the Graphite server
            port: Port number of the Graphite server (default: 80)
            timeout: Request timeout in seconds (default: 30)
        """
        self.host = host
        self.port = port
        self.timeout = timeout
        self.base_url = f"http://{host}:{port}"
        
        self.logger = logging.getLogger(__name__ + '.GraphiteClient')
        
        self.logger.info(f"GraphiteClient initialized for {self.base_url}")
        self.logger.debug(f"Request timeout set to {timeout} seconds")
    
    def get_data(self, 
                 target: str, 
                 from_time: str, 
                 until_time: str = 'now', 
                 format: str = 'json') -> List[Tuple[datetime, Optional[float]]]:
        """
        Retrieve time-series data for a given metric from Graphite.
        
        This method queries the Graphite render API to fetch data points
        for a specified metric over a given time range.
        
        Args:
            target: Metric name or Graphite function (e.g., 'tetram.ch0', 'xdaq.*.rate')
            from_time: Start time for query (e.g., '-1h', '-1d', '20240101')
            until_time: End time for query (default: 'now')
            format: Response format (default: 'json')
            
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
        
        try:
            # Make HTTP request to Graphite
            response = requests.get(url, params=params, timeout=self.timeout)
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
            response = requests.get(url, params=params, timeout=self.timeout)
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
            url = f"{self.base_url}/render"
            params = {
                'target': 'test.connection',
                'from': '-1min',
                'format': 'json'
            }
            
            response = requests.get(url, params=params, timeout=5)
            
            # Accept any response that's not a connection error
            # Even a 404 or empty response means the server is reachable
            is_connected = response.status_code < 500
            
            if is_connected:
                self.logger.debug("Graphite server connection test successful")
            else:
                self.logger.warning(f"Graphite server returned status {response.status_code}")
            
            return is_connected
            
        except requests.exceptions.ConnectionError:
            self.logger.warning(f"Cannot connect to Graphite server at {self.base_url}")
            return False
            
        except requests.exceptions.Timeout:
            self.logger.warning("Graphite server connection test timed out")
            return False
            
        except Exception as e:
            self.logger.warning(f"Graphite connection test failed: {e}")
            return False
    
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
            
            response = requests.get(url, params=params, timeout=self.timeout)
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
            'connected': False,
            'response_time_ms': None,
            'error': None
        }
        
        try:
            import time
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