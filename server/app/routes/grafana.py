# app/routes/grafana.py
"""
REST endpoints for Grafana's alert rules.

The Alerts page and run control reach Grafana only through these, so the
Grafana address and token are configured once, on the server.
"""

from flask import Blueprint, request, jsonify

from ..utils.jwt_utils import jwt_required_custom
from ..services.grafana_client import get_grafana_client, GrafanaError

bp = Blueprint('grafana', __name__)

grafana_client = get_grafana_client()


def _error(e: GrafanaError):
    return jsonify({'error': str(e)}), e.status


@bp.route('/grafana/settings', methods=['GET'])
@jwt_required_custom
def get_settings():
    """Grafana connection settings; the token is returned masked."""
    return jsonify(grafana_client.get_settings())


@bp.route('/grafana/settings', methods=['POST'])
@jwt_required_custom
def set_settings():
    """Update the connection settings. An empty token keeps the stored one."""
    data = request.get_json() or {}
    grafana_client.set_settings(
        url=data.get('url'),
        api_key=data.get('api_key'),
        clear_api_key=bool(data.get('clear_api_key')),
    )
    return jsonify({'message': 'Grafana settings updated', 'settings': grafana_client.get_settings()})


@bp.route('/grafana/test', methods=['POST'])
@jwt_required_custom
def test_connection():
    """Check Grafana answers and lists alert rules with the configured token."""
    return jsonify(grafana_client.test_connection())


@bp.route('/grafana/alert-rules', methods=['GET'])
@jwt_required_custom
def list_alert_rules():
    try:
        return jsonify(grafana_client.list_alert_rules() or [])
    except GrafanaError as e:
        return _error(e)


@bp.route('/grafana/alert-rules/<uid>', methods=['GET'])
@jwt_required_custom
def get_alert_rule(uid):
    try:
        return jsonify(grafana_client.get_alert_rule(uid))
    except GrafanaError as e:
        return _error(e)


@bp.route('/grafana/alert-rules/<uid>', methods=['PUT'])
@jwt_required_custom
def update_alert_rule(uid):
    rule = request.get_json(silent=True)
    if not isinstance(rule, dict):
        return jsonify({'error': 'Expected the alert rule as a JSON object'}), 400
    try:
        return jsonify(grafana_client.update_alert_rule(uid, rule))
    except GrafanaError as e:
        return _error(e)
