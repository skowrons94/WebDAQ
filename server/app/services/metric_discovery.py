"""
Which Graphite metrics are alive, for the Stats page's "Add metric".

Picking from the whole tree means opening branches until something looks
right, and half of what is there stopped being written years ago. This walks
the tree once, asks Graphite for the last hour of every metric found (a few
dozen per request), and keeps those that have a value in it, with the latest
value and when it came. The DAQ's own counting rates are left out — they are
on the Data rates page — and so are the series of the current modules.

The walk is bounded (depth and number of metrics) and its result is cached for
a minute, so opening the dialog twice does not walk the tree twice.
"""

import logging
import threading
import time
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

MAX_DEPTH = 7
MAX_METRICS = 3000
BATCH = 40
CACHE_S = 60.0

_lock = threading.Lock()
_cache: Dict[str, Any] = {"at": 0.0, "key": None, "result": None}


# Graphite's and statsd's reports on themselves: never what an operator wants
# to watch next to the beam.
SELF_METRICS = ["carbon.", "statsd.", "stats.statsd.", "stats_counts.statsd."]


def _ours(prefixes: List[str]) -> List[str]:
    """Branches not worth offering: the DAQ's counting rates, the current
    modules' series, and Graphite's own bookkeeping."""
    out = [p.strip(".") + "." for p in prefixes if p]
    out += ["rbd9103.", "tetram."] + SELF_METRICS
    return out


def _walk(client, skip: List[str]) -> List[str]:
    leaves: List[str] = []
    level = [""]
    for _ in range(MAX_DEPTH):
        nxt = []
        for branch in level:
            for node in client.find_metrics(f"{branch}.*" if branch else "*"):
                path = node["path"]
                if any((path + ".").startswith(s) for s in skip):
                    continue
                (leaves if node["is_leaf"] else nxt).append(path)
                if len(leaves) >= MAX_METRICS:
                    return leaves
        if not nxt:
            break
        level = nxt
    return leaves


def recent_metrics(client, daq_prefixes: List[str], window: str = "-1h",
                   refresh: bool = False) -> Dict[str, Any]:
    key = (getattr(client, "base_url", ""), tuple(daq_prefixes), window)
    with _lock:
        if (not refresh and _cache["key"] == key and _cache["result"] is not None
                and time.time() - _cache["at"] < CACHE_S):
            return _cache["result"]

    skip = _ours(daq_prefixes)
    leaves = _walk(client, skip)
    alive: List[Dict[str, Any]] = []
    for i in range(0, len(leaves), BATCH):
        batch = leaves[i:i + BATCH]
        try:
            data = client.get_multiple_targets(batch, window)
        except Exception as e:
            logger.debug(f"recent metrics: render failed for {len(batch)} targets: {e}")
            continue
        for path, points in data.items():
            values = [(t, v) for t, v in points if v is not None]
            if not values:
                continue
            t, v = values[-1]
            alive.append({
                "path": path,
                "value": v,
                "timestamp": t.isoformat(),
                "trend": [v for _, v in values[-60:]],
            })
    alive.sort(key=lambda m: m["path"])
    result = {"metrics": alive, "scanned": len(leaves), "truncated": len(leaves) >= MAX_METRICS,
              "window": window}
    with _lock:
        _cache.update(at=time.time(), key=key, result=result)
    return result
