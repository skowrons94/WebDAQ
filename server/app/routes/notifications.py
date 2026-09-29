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
from ..services.alert_log import get_alert_log
from ..services import recovery

bp = Blueprint('notifications', __name__)

TEST_FLAG = os.getenv('TEST_FLAG', False)

daq_mgr = get_daq_manager(test_flag=TEST_FLAG)
zulip = get_zulip_notifier()
alerts = get_alert_manager()


def alert_log():
    """The process-wide alert log, looked up per request rather than held: the
    log is also reached from the alerting service and from recovery, and binding
    one instance here would mean two objects writing the same file."""
    return get_alert_log()


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


def _rule_body():
    """The request body as a rule object, or (None, error response)."""
    body = request.get_json(silent=True)
    if body is None:
        body = {}
    if not isinstance(body, dict):
        return None, (jsonify({'error': 'Expected the rule as a JSON object'}), 400)
    if 'params' in body and body['params'] is not None \
            and not isinstance(body['params'], dict):
        return None, (jsonify({'error': "'params' has to be a JSON object"}), 400)
    if 'transports' in body and body['transports'] is not None \
            and not isinstance(body['transports'], (list, str)):
        return None, (jsonify({'error': "'transports' has to be a list"}), 400)
    return body, None


@bp.route('/notifications/rules', methods=['POST'])
@jwt_required_custom
def add_rule():
    body, error = _rule_body()
    if error:
        return error
    try:
        rule = alerts.add_rule(body)
    except AlertConfigError as e:
        return jsonify({'error': str(e)}), 400
    return jsonify({'message': 'Alert rule added', 'rule': rule}), 201


@bp.route('/notifications/rules/<rule_id>', methods=['PUT'])
@jwt_required_custom
def update_rule(rule_id):
    body, error = _rule_body()
    if error:
        return error
    try:
        rule = alerts.update_rule(rule_id, body)
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


# ── What happened while nobody was looking ───────────────────────────────────

@bp.route('/notifications/events', methods=['GET'])
@jwt_required_custom
def get_events():
    """The alert history, newest first, with how many nobody has looked at yet."""
    try:
        limit = int(request.args.get('limit', 100))
    except (TypeError, ValueError):
        return jsonify({'error': 'limit has to be a number'}), 400
    kind = request.args.get('kind', '')
    unseen_only = request.args.get('unseen') in ('1', 'true', 'yes')
    return jsonify({
        'events': alert_log().list_events(limit=limit, kind=kind, unseen_only=unseen_only),
        'summary': alert_log().summary(),
    })


@bp.route('/notifications/events/summary', methods=['GET'])
@jwt_required_custom
def get_events_summary():
    """Just the counts — what the bell in the header polls."""
    return jsonify(alert_log().summary())


@bp.route('/notifications/events/seen', methods=['POST'])
@jwt_required_custom
def mark_events_seen():
    """Mark events as seen; no ids means all of them."""
    data = request.get_json(silent=True) or {}
    ids = data.get('ids')
    if ids is not None:
        if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
            return jsonify({'error': 'ids has to be a list of event ids'}), 400
    return jsonify({'marked': alert_log().mark_seen(ids), 'summary': alert_log().summary()})


@bp.route('/notifications/events', methods=['DELETE'])
@jwt_required_custom
def clear_events():
    return jsonify({'removed': alert_log().clear()})


# ── Recovery: the fix offered next to the problem ────────────────────────────

@bp.route('/recovery/actions', methods=['GET'])
@jwt_required_custom
def get_recovery_actions():
    """Each recovery action, and whether its subsystem currently looks healthy."""
    return jsonify({'actions': recovery.actions()})


@bp.route('/recovery/actions/<name>', methods=['POST'])
@jwt_required_custom
def run_recovery_action(name):
    """Run one recovery action. Nothing here runs by itself."""
    result = recovery.run_action(name)
    return jsonify(result), 200 if result.get('success') else 400


@bp.route('/notifications/watcher', methods=['POST'])
@jwt_required_custom
def set_watcher():
    """Start or stop the alert watcher.

    It is normally started by main.py, but a backend launched another way (a bare
    `flask run`, a WSGI server) would leave the rules configured and never
    evaluated. The settings page shows whether it is watching, so it also has to
    offer the way to start it rather than leaving the operator stuck.
    """
    data = request.get_json(silent=True) or {}
    action = str(data.get('action', 'start')).lower()
    if action not in ('start', 'stop'):
        return jsonify({'error': "action has to be 'start' or 'stop'"}), 400
    if action == 'start':
        alerts.start()
    else:
        alerts.stop()
    return jsonify({'message': f'Alert watcher {action}ed', 'status': alerts.get_status()})
