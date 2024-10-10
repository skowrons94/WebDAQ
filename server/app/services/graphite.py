import requests
from typing import List, Tuple, Optional
from datetime import datetime

class GraphiteClient:
    def __init__(self, host: str, port: int = 80):
        """
        Initialize the GraphiteClient.

        Args:
            host (str): The hostname or IP address of the Graphite server.
            port (int): The port number of the Graphite server (default is 80).
        """
        self.base_url = f"http://{host}:{port}"

    def get_data(self, 
                 target: str, 
                 from_time: str, 
                 until_time: str = 'now', 
                 format: str = 'json') -> List[Tuple[datetime, Optional[float]]]:
        """
        Retrieve data for a given time series from Graphite.

        Args:
            target (str): The name of the metric or a Graphite function.
            from_time (str): The start time for the query (e.g., '-1h', '-1d', '20210101').
            until_time (str): The end time for the query (default is 'now').
            format (str): The format of the returned data (default is 'json').

        Returns:
            List[Tuple[datetime, Optional[float]]]: A list of tuples containing timestamps and values.

        Raises:
            requests.RequestException: If there's an error in the HTTP request.
            ValueError: If the response from Graphite is not in the expected format.
        """
        url = f"{self.base_url}/render"
        params = {
            'target': target,
            'from': from_time,
            'until': until_time,
            'format': format
        }
        try:
            response = requests.get(url, params=params)
            response.raise_for_status()  # Raises an HTTPError for bad responses

            data = response.json()
            if not data or 'datapoints' not in data[0]:
                raise ValueError("Unexpected response format from Graphite")

            # Convert the datapoints to a list of (datetime, value) tuples
            return [
                (datetime.fromtimestamp(timestamp), value)
                for value, timestamp in data[0]['datapoints']
            ]

        except requests.RequestException as e:
            print(f"Error communicating with Graphite: {e}")
            raise

        except ValueError as e:
            print(f"Error parsing Graphite response: {e}")
            raise

        except Exception as e:
            print(f"Unexpected error: {e}")
            raise