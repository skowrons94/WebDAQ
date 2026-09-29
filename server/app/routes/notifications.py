# app/routes/notifications.py
"""
REST endpoints for notifications: the transports (Telegram, Zulip) and the alert
rules that decide what is worth a message and who gets it.

The older /experiment/*_telegram_settings routes still work — the frontend moved
here, but a bookmark or a script pointing at them does not have to.
"""

import os

from flask import Blueprint, request, jsonify

from ..utils.jwt_utils import jwt_required_custom
from ..services.daq_manager import get_daq_manager
from ..services.zulip_notifier import get_zulip_notifier
from ..services.alerting import get_alert_manager, AlertConfigError

bp = Blueprint('notifications', __name__)

TEST_FLAG = os.getenv('TEST_FLAG', False)

daq_mgr = get_daq_manager(test_flag=TEST_FLAG)
zulip = get_zulip_notifier()
alerts = get_alert_manager()


def _telegram():
    """The Telegram transport, owned by the DAQ manager."""
    return daq_mgr.telegram


@bp.route('/notifications/transports', methods=['GET'])
@jwt_required_custom
def get_transports():
    """Both transports' settings; the secrets are returned masked."""
    return jsonify({
        'telegram': _telegram().get_settings(),
        'zulip': zulip.get_settings(),
    })


@bp.route('/notifications/transports/telegram', methods=['POST'])
@jwt_required_custom
def set_telegram():
    """Update Telegram. An empty bot token keeps the stored one."""
    data = request.get_json() or {}
    _telegram().set_settings(
        enabled=data.get('enabled'),
        bot_token=data.get('bot_token'),
        chat_id=data.get('chat_id'),
        clear_bot_token=bool(data.get('clear_bot_token')),
    )
    return jsonify({'message': 'Telegram settings updated',
                    'settings': _telegram().get_settings()})


@bp.route('/notifications/transports/zulip', methods=['POST'])
@jwt_required_custom
def set_zulip():
    """Update Zulip. An empty API key keeps the stored one."""
    data = request.get_json() or {}
    zulip.set_settings(
        enabled=data.get('enabled'),
        site=data.get('site'),
        bot_email=data.get('bot_email'),
        api_key=data.get('api_key'),
        stream=data.get('stream'),
        topic=data.get('topic'),
        clear_api_key=bool(data.get('clear_api_key')),
    )
    return jsonify({'message': 'Zulip settings updated', 'settings': zulip.get_settings()})


@bp.route('/notifications/transports/<transport>/test', methods=['POST'])
@jwt_required_custom
def test_transport(transport):
    """Send a test message through one transport."""
    if transport == 'telegram':
        return jsonify(_telegram().test_connection())
    if transport == 'zulip':
        return jsonify(zulip.test_connection())
    return jsonify({'success': False, 'message': f'Unknown transport {transport!r}'}), 400


@bp.route('/notifications/rules', methods=['GET'])
@jwt_required_custom
def get_rules():
    """The alert rules, the types available, and what each rule currently thinks."""
    return jsonify({
        'rules': alerts.get_rules(),
        'types': alerts.get_rule_types(),
        'status': alerts.get_status(),
    })


@bp.route('/notifications/rules', methods=['POST'])
@jwt_required_custom
def add_rule():
    try:
        rule = alerts.add_rule(request.get_json() or {})
    except AlertConfigError as e:
        return jsonify({'error': str(e)}), 400
    return jsonify({'message': 'Alert rule added', 'rule': rule}), 201


@bp.route('/notifications/rules/<rule_id>', methods=['PUT'])
@jwt_required_custom
def update_rule(rule_id):
    try:
        rule = alerts.update_rule(rule_id, request.get_json() or {})
    except AlertConfigError as e:
        return jsonify({'error': str(e)}), 400
    return jsonify({'message': 'Alert rule updated', 'rule': rule})


@bp.route('/notifications/rules/<rule_id>', methods=['DELETE'])
@jwt_required_custom
def delete_rule(rule_id):
    try:
        alerts.delete_rule(rule_id)
    except AlertConfigError as e:
        return jsonify({'error': str(e)}), 404
    return jsonify({'message': 'Alert rule deleted'})


@bp.route('/notifications/settings', methods=['POST'])
@jwt_required_custom
def set_settings():
    """Settings that apply to every rule (currently: announce a recovery)."""
    data = request.get_json() or {}
    if 'notify_recovery' in data:
        alerts.set_notify_recovery(bool(data['notify_recovery']))
    return jsonify({'message': 'Notification settings updated',
                    'status': alerts.get_status()})


@bp.route('/notifications/status', methods=['GET'])
@jwt_required_custom
def get_status():
    """Whether the watcher is running and which rules are currently alerting."""
    return jsonify(alerts.get_status())
