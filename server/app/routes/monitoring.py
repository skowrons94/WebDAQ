# app/routes/monitoring.py
"""
Finding the monitoring servers for Settings → Monitoring.

The settings themselves stay where the code that uses them reads them from
(/stats/graphite_config for Graphite, /grafana/settings for Grafana); this only
looks for servers to fill them with. Nothing is saved here: the page fills the
fields and the operator presses Save.
"""

import json
import os

from flask import Blueprint, jsonify

from ..utils.jwt_utils import jwt_required_custom
from ..services import monitoring
from ..services.grafana_client import get_grafana_client

bp = Blueprint('monitoring', __name__)

_CURRENT_FILE = 'conf/current.json'


def _read_json(path):
    if not os.path.exists(path):
        return {}
    try:
        with open(path) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _int_or_none(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


@bp.route('/monitoring/detect', methods=['GET'])
@jwt_required_custom
def detect():
    """
    Probe the hosts WebDAQ knows of for Graphite (web API and Carbon) and Grafana.

    The hosts are the configured Graphite host, the Grafana host, the beam
    current's old Graphite host from conf/current.json, this PC and lunaserver.
    Takes at most a few seconds whatever the network does.
    """
    stats = _read_json(monitoring.STATS_FILE)
    current = _read_json(_CURRENT_FILE)
    grafana_url = get_grafana_client().url or ''

    graphite_host = str(stats.get('graphite_host') or '')
    hosts = [graphite_host, 'localhost', monitoring.host_of_url(grafana_url),
             str(current.get('graphite_host') or ''), *monitoring.DEFAULT_HOSTS]

    result = monitoring.detect(
        hosts,
        graphite_ports=[p for p in [_int_or_none(stats.get('graphite_port'))] if p],
        carbon_ports=[p for p in [_int_or_none(stats.get('carbon_port'))] if p],
        grafana_ports=[p for p in [monitoring.port_of_url(grafana_url)] if p],
        carbon_hosts=[graphite_host],
    )
    return jsonify(result), 200


@bp.route('/monitoring/status', methods=['GET'])
@jwt_required_custom
def status():
    """Whether the configured Graphite (web and Carbon) and Grafana answer."""
    stats = _read_json(monitoring.STATS_FILE)
    return jsonify(monitoring.status(
        str(stats.get('graphite_host') or ''),
        _int_or_none(stats.get('graphite_port')),
        _int_or_none(stats.get('carbon_port')),
        get_grafana_client().url or '',
    )), 200
