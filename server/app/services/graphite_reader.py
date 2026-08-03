"""
Read-side access to Graphite, shared by everything that plots history.

Two different Graphite endpoints are in play here and they are easy to confuse:

  * ``conf/current.json``'s ``graphite_host``/``graphite_port`` is the *Carbon*
    plaintext ingest (port 2003) that the picoammeter controllers PUSH their
    samples to. Nothing can be read back from it.
  * ``conf/stats.json``'s ``graphite_host``/``graphite_port`` is the *render API*
    (HTTP) that the Stats page READS from.

History queries are reads, so they belong to the second one. Taking the server
from the same file the Stats page configures means an operator sets it once and
both pages follow, rather than the current plot silently querying port 2003 and
reporting "no data".

The client is rebuilt whenever that file changes, so editing the Graphite server
in the UI takes effect without restarting the server.
"""

import json
import logging
import os
import threading
from typing import Any, Dict, List, Optional

from ..utils.graphite import GraphiteClient

logger = logging.getLogger(__name__)

_CONFIG_PATH = "conf/stats.json"
_DEFAULT_HOST = "localhost"
_DEFAULT_PORT = 80

# Short by GraphiteClient standards: this sits on a dashboard poll path, where a
# slow answer is worse than no answer.
_TIMEOUT_S = 10

_lock = threading.Lock()
_client: Optional[GraphiteClient] = None
_client_mtime: Any = object()   # sentinel: never equal to a real mtime


def _read_config() -> Dict[str, Any]:
    try:
        with open(_CONFIG_PATH) as f:
            config = json.load(f)
        return config if isinstance(config, dict) else {}
    except (OSError, ValueError) as e:
        logger.debug(f"Could not read {_CONFIG_PATH}: {e}")
        return {}


def get_client() -> GraphiteClient:
    """A render-API client, rebuilt when conf/stats.json changes."""
    global _client, _client_mtime

    try:
        mtime = os.path.getmtime(_CONFIG_PATH)
    except OSError:
        mtime = None

    with _lock:
        if _client is None or mtime != _client_mtime:
            config = _read_config()
            host = str(config.get("graphite_host") or _DEFAULT_HOST)
            try:
                port = int(config.get("graphite_port") or _DEFAULT_PORT)
            except (TypeError, ValueError):
                port = _DEFAULT_PORT
            _client = GraphiteClient(host, port, timeout=_TIMEOUT_S)
            _client_mtime = mtime
        return _client


def fetch_series(target: str,
                 from_time: str,
                 until_time: str = 'now',
                 max_points: Optional[int] = None,
                 scale: float = 1.0) -> List[List[float]]:
    """
    ``[[epoch_seconds, value], ...]`` for a metric.

    ``max_points`` is handed to Graphite as ``maxDataPoints``, so the
    consolidation happens on the Graphite side: asking for three days of a
    one-second metric costs the same as asking for three minutes of it.

    Returns an empty list rather than raising when Graphite cannot answer — the
    callers all have another source to fall back to, and a plot that briefly
    stops extending is better than one that errors.
    """
    if not target:
        return []

    try:
        points = get_client().get_data(
            target, from_time, until_time, max_data_points=max_points)
    except Exception as e:
        logger.warning(f"Graphite query for '{target}' failed: {e}")
        return []

    series: List[List[float]] = []
    for moment, value in points:
        if value is None:
            continue
        try:
            series.append([moment.timestamp(), float(value) * scale])
        except (AttributeError, TypeError, ValueError, OverflowError):
            continue
    return series


def is_configured() -> bool:
    """Whether a Graphite server has been configured for reading at all."""
    return bool(_read_config().get("graphite_host"))
