"""
The monitoring servers, Graphite and Grafana, as one setting.

Everything that talks to Graphite takes the server from ``conf/stats.json``:
the Stats page and the monitored values read from its web (render) port, and
the DAQ rates *and the beam current* are written to its Carbon port. There used
to be a second Graphite address in ``conf/current.json`` for the beam current
alone; two addresses for one server meant two places to forget when it moved,
and the picoammeter kept writing to a Graphite nobody was reading. That old
address is left in the file (see ``legacy_current_target``) but no longer used.

This module also finds the servers: ``detect`` knocks on the usual ports of
the hosts WebDAQ already knows about and reports what really answers, so an
operator can pick a server instead of guessing its port.
"""

import json
import logging
import os
import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor, wait
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import urlparse

import requests

from ..utils.graphite import answers_like_graphite

logger = logging.getLogger(__name__)

STATS_FILE = "conf/stats.json"
DEFAULT_CARBON_PORT = 2003

# Where Graphite's web API usually listens: 80 behind Apache/nginx, 8080 for the
# graphite-project Docker image (and scripts/monitoring.sh), 8000/8081 for a
# bare graphite-web, 2080 for the old graphite-statsd image.
GRAPHITE_WEB_PORTS = (80, 8080, 8000, 8081, 2080)
# Grafana's default is 3000, which on the DAQ PC is taken by WebDAQ itself, so
# a local Grafana sits on the next ports (scripts/monitoring.sh uses 3001).
GRAFANA_PORTS = (3000, 3001, 3002, 3030)
# Hosts worth trying even when nothing names them: this PC and the lab server.
DEFAULT_HOSTS = ("localhost", "lunaserver")

# Per probe. These are hosts on the local network: anything slower than this is
# not a server an operator wants the DAQ to depend on.
PROBE_TIMEOUT_S = 1.0
# For the whole detection, name lookups included. A host whose name never
# resolves (a DNS server that does not answer) must not hold up the others.
DETECT_DEADLINE_S = 4.0
_RESOLVE_DEADLINE_S = 1.5


# ── The one Graphite address ──────────────────────────────────────────────────

_cache_lock = threading.Lock()
_cache: Dict[str, Any] = {"mtime": object(), "target": ("", DEFAULT_CARBON_PORT)}


def _read_json(path: str) -> Dict[str, Any]:
    try:
        with open(path) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def carbon_target() -> Tuple[str, int]:
    """
    (host, Carbon port) that metrics are pushed to, from conf/stats.json.

    Called on every picoammeter sample, so the file is read again only when it
    changes: a new server saved in Settings → Monitoring takes effect at the
    next sample, with no restart and nothing to notify.
    """
    try:
        mtime = os.path.getmtime(STATS_FILE)
    except OSError:
        mtime = None
    with _cache_lock:
        if mtime != _cache["mtime"]:
            config = _read_json(STATS_FILE)
            host = str(config.get("graphite_host") or "")
            try:
                port = int(config.get("carbon_port") or DEFAULT_CARBON_PORT)
            except (TypeError, ValueError):
                port = DEFAULT_CARBON_PORT
            _cache["target"] = (host, port)
            _cache["mtime"] = mtime
        return _cache["target"]


def legacy_current_target(current_settings: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    The beam current's own Graphite address from conf/current.json, if it
    names a different server from the one setting.

    It is reported, not used: an address that differs is either the server the
    operator meant all along (and the Monitoring setting should be changed to
    it) or a stale one. Either way they should hear about it rather than have
    it vanish.
    """
    host = str(current_settings.get("graphite_host") or "").strip()
    if not host:
        return None
    try:
        port = int(current_settings.get("graphite_port") or DEFAULT_CARBON_PORT)
    except (TypeError, ValueError):
        port = DEFAULT_CARBON_PORT
    if (host, port) == carbon_target():
        return None
    return {"host": host, "port": port}


_legacy_warned = False


def warn_legacy_current_target(current_settings: Dict[str, Any]) -> None:
    """Log, once per process, that the beam current's old address is ignored."""
    global _legacy_warned
    legacy = legacy_current_target(current_settings)
    if legacy is None or _legacy_warned:
        return
    _legacy_warned = True
    host, port = carbon_target()
    logger.warning(
        f"conf/current.json sends the beam current to Graphite at "
        f"{legacy['host']}:{legacy['port']}, but the beam current now goes to the "
        f"one Graphite server in Settings → Monitoring ({host or 'not set'}:{port}). "
        f"The old address is kept in conf/current.json and not used.")


# ── Detection ────────────────────────────────────────────────────────────────

def _resolve(host: str) -> Optional[str]:
    """An address to connect to, IPv4 first (Docker publishes ports there)."""
    for family in (socket.AF_INET, socket.AF_INET6):
        try:
            info = socket.getaddrinfo(host, None, family, socket.SOCK_STREAM)
        except (socket.gaierror, UnicodeError, OSError):
            continue
        if info:
            return info[0][4][0]
    return None


def _http_base(address: str, port: int) -> str:
    return f"http://[{address}]:{port}" if ":" in address else f"http://{address}:{port}"


def _probe_graphite(address: str, port: int, timeout: float = PROBE_TIMEOUT_S) -> bool:
    try:
        response = requests.get(f"{_http_base(address, port)}/metrics/find",
                                params={"query": "*", "format": "json"},
                                timeout=(timeout, timeout))
    except requests.RequestException:
        return False
    return answers_like_graphite(response)


def _probe_carbon(address: str, port: int, timeout: float = PROBE_TIMEOUT_S) -> bool:
    # Carbon's plaintext port says nothing back, so an open port is all there
    # is to see. Nothing is sent: a stray line would become a metric.
    try:
        with socket.create_connection((address, port), timeout=timeout):
            return True
    except OSError:
        return False


def _probe_grafana(address: str, port: int, timeout: float = PROBE_TIMEOUT_S) -> Optional[Dict[str, Any]]:
    # /api/health is Grafana's, needs no login, and answers with a JSON object
    # carrying "database". Asking for exactly that keeps WebDAQ's own frontend,
    # which also listens on 3000 here, from being taken for a Grafana.
    try:
        response = requests.get(f"{_http_base(address, port)}/api/health",
                                timeout=(timeout, timeout))
        body = response.json()
    except (requests.RequestException, ValueError):
        return None
    if not isinstance(body, dict) or "database" not in body:
        return None
    return {"version": str(body.get("version") or ""), "database": str(body.get("database") or "")}


def _unique(items: Iterable[Any]) -> List[Any]:
    seen, out = set(), []
    for item in items:
        if item in (None, "") or item in seen:
            continue
        seen.add(item)
        out.append(item)
    return out


def host_of_url(url: str) -> str:
    """'http://lunaserver:3000' → 'lunaserver' ('' when it has none)."""
    if not url:
        return ""
    try:
        return urlparse(url if "://" in url else f"http://{url}").hostname or ""
    except ValueError:
        return ""


def port_of_url(url: str) -> Optional[int]:
    try:
        parsed = urlparse(url if "://" in url else f"http://{url}")
        return parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError:
        return None


def detect(hosts: Iterable[str],
           graphite_ports: Iterable[int] = (),
           carbon_ports: Iterable[int] = (),
           grafana_ports: Iterable[int] = (),
           carbon_hosts: Iterable[str] = ()) -> Dict[str, Any]:
    """
    Look for Graphite and Grafana servers.

    Args:
        hosts: where to look, in order of preference (the configured ones first)
        graphite_ports, grafana_ports: ports tried on top of the usual ones
            (the configured ones, so a server on an odd port is still found)
        carbon_ports: Carbon ports tried besides 2003
        carbon_hosts: hosts whose Carbon is reported even without a Graphite web
            API answering there (the configured one: rates may be written to a
            Carbon whose web side runs elsewhere)

    Every probe runs in its own thread with a 1 s timeout, and the whole thing
    gives up after DETECT_DEADLINE_S, so a host that drops packets costs one
    timeout, not one per port.

    Returns {"graphite": [{host, web_port, carbon_port}], "grafana": [{url, version,
    database}], "hosts": [...], "unresolved": [...], "elapsed_s": float}. A
    Graphite whose Carbon port is closed comes back with carbon_port None.
    """
    started = time.monotonic()
    hosts = _unique(str(h).strip() for h in hosts)
    web_ports = _unique(list(graphite_ports) + list(GRAPHITE_WEB_PORTS))
    carbon_list = _unique(list(carbon_ports) + [DEFAULT_CARBON_PORT])
    grafana_list = _unique(list(grafana_ports) + list(GRAFANA_PORTS))
    carbon_hosts = set(_unique(str(h).strip() for h in carbon_hosts))

    pool = ThreadPoolExecutor(max_workers=64, thread_name_prefix="monitoring-detect")
    try:
        resolving = {host: pool.submit(_resolve, host) for host in hosts}
        wait(resolving.values(), timeout=_RESOLVE_DEADLINE_S)
        addresses: Dict[str, str] = {}
        for host, future in resolving.items():
            address = future.result() if future.done() else None
            if address:
                addresses[host] = address
        unresolved = [h for h in hosts if h not in addresses]

        # Two names for one machine ('localhost' and its own host name) would
        # report each server twice; the first, preferred name keeps it.
        by_address: Dict[str, str] = {}
        for host in hosts:
            if host in addresses:
                by_address.setdefault(addresses[host], host)

        jobs = {}
        for address, host in by_address.items():
            for port in web_ports:
                jobs[pool.submit(_probe_graphite, address, port)] = ("graphite", host, port)
            for port in carbon_list:
                jobs[pool.submit(_probe_carbon, address, port)] = ("carbon", host, port)
            for port in grafana_list:
                jobs[pool.submit(_probe_grafana, address, port)] = ("grafana", host, port)
        remaining = max(0.1, DETECT_DEADLINE_S - (time.monotonic() - started))
        wait(jobs.keys(), timeout=remaining)

        found: Dict[str, Dict[Tuple[str, int], Any]] = {"graphite": {}, "carbon": {}, "grafana": {}}
        for future, (kind, host, port) in jobs.items():
            if not future.done() or future.exception() is not None:
                continue
            result = future.result()
            if result:
                found[kind][(host, port)] = result
    finally:
        # Probes past the deadline are abandoned, not waited for: they end on
        # their own timeouts and their answers are no longer wanted.
        pool.shutdown(wait=False, cancel_futures=True)

    graphite: List[Dict[str, Any]] = []
    for host in by_address.values():
        carbon = next((p for p in carbon_list if (host, p) in found["carbon"]), None)
        web = [p for p in web_ports if (host, p) in found["graphite"]]
        for port in web:
            graphite.append({"host": host, "web_port": port, "carbon_port": carbon})
        if not web and carbon is not None and host in carbon_hosts:
            graphite.append({"host": host, "web_port": None, "carbon_port": carbon})

    grafana: List[Dict[str, Any]] = []
    for host in by_address.values():
        for port in grafana_list:
            health = found["grafana"].get((host, port))
            if health:
                grafana.append({"url": f"http://{host}:{port}", **health})

    return {
        "graphite": graphite,
        "grafana": grafana,
        "hosts": hosts,
        "unresolved": unresolved,
        "elapsed_s": round(time.monotonic() - started, 2),
    }


# ── Status of the configured servers ─────────────────────────────────────────

# Longer than a detection probe: this is the server the operator chose, and a
# slow answer from it is still an answer.
STATUS_TIMEOUT_S = 2.0
STATUS_DEADLINE_S = 4.0   # the whole status check, name lookups included


def status(graphite_host: str, web_port: Optional[int], carbon_port: Optional[int],
           grafana_url: str, grafana_token: str = "") -> Dict[str, Any]:
    """
    Whether each configured server answers: Graphite's web API, its Carbon
    port, and Grafana. Checked together, so the page waits for the slowest
    one rather than for all three in a row.

    For Grafana, /api/health answers without a login, so "reachable" alone
    said nothing about whether the Alerts page can work: the alert-rule list
    is asked for too, with the token, and its HTTP status is reported as
    `rules_status` (401/403: a token is missing or refused).
    """
    carbon_port = carbon_port or DEFAULT_CARBON_PORT
    grafana_url = (grafana_url or "").rstrip("/")

    def graphite_ok() -> bool:
        return bool(graphite_host and web_port) and _probe_graphite_at(
            graphite_host, int(web_port))

    def carbon_ok() -> bool:
        address = _resolve(graphite_host) if graphite_host else None
        return bool(address) and _probe_carbon(address, int(carbon_port), STATUS_TIMEOUT_S)

    def grafana_health() -> Optional[Dict[str, Any]]:
        if not grafana_url:
            return None
        try:
            response = requests.get(f"{grafana_url}/api/health",
                                    timeout=(STATUS_TIMEOUT_S, STATUS_TIMEOUT_S))
            body = response.json()
        except (requests.RequestException, ValueError):
            return None
        if not isinstance(body, dict) or "database" not in body:
            return None
        rules_status: Optional[int] = None
        headers = {"Accept": "application/json"}
        if grafana_token:
            headers["Authorization"] = f"Bearer {grafana_token}"
        try:
            rules_status = requests.get(f"{grafana_url}/api/v1/provisioning/alert-rules",
                                        headers=headers,
                                        timeout=(STATUS_TIMEOUT_S, STATUS_TIMEOUT_S)).status_code
        except requests.RequestException:
            pass
        return {"version": str(body.get("version") or ""), "rules_status": rules_status}

    # A name lookup has no timeout of its own: a broken DNS must not hold the
    # page, so whatever has not answered by the deadline counts as down.
    pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="monitoring-status")
    futures = (pool.submit(graphite_ok), pool.submit(carbon_ok), pool.submit(grafana_health))
    deadline = time.monotonic() + STATUS_DEADLINE_S

    def outcome(future, failed):
        try:
            return future.result(timeout=max(0.0, deadline - time.monotonic()))
        except Exception:
            return failed

    graphite_up, carbon_up, grafana = (outcome(futures[0], False), outcome(futures[1], False),
                                       outcome(futures[2], None))
    pool.shutdown(wait=False, cancel_futures=True)

    return {
        "graphite": {"reachable": graphite_up, "host": graphite_host, "port": web_port},
        "carbon": {"reachable": carbon_up, "host": graphite_host, "port": carbon_port},
        "grafana": {"reachable": grafana is not None, "url": grafana_url,
                    "version": (grafana or {}).get("version", ""),
                    "rules_status": (grafana or {}).get("rules_status"),
                    "has_token": bool(grafana_token)},
    }



def _probe_graphite_at(host: str, port: int) -> bool:
    try:
        response = requests.get(f"http://{host}:{port}/metrics/find",
                                params={"query": "*", "format": "json"},
                                timeout=(STATUS_TIMEOUT_S, STATUS_TIMEOUT_S))
    except requests.RequestException:
        return False
    return answers_like_graphite(response)
