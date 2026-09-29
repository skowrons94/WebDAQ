"""
ZulipNotifier — send alerts to a Zulip stream.

The alternative transport to Telegram: the collaboration's Zulip organisation is
where the shift already talks, so an alert can land in the same place as the
conversation about it. A bot account posts to one stream and topic, which keeps
every alert in a single searchable thread the whole shift can see.

Credentials live in conf/zulip_settings.json (the same arrangement as
conf/telegram_settings.json for the bot token), and the API key is never returned
to the browser. Messages are Zulip markdown.
"""

import base64
import json
import logging
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

_SETTINGS_FILE = 'conf/zulip_settings.json'

# Every call gets a deadline: a Zulip organisation that accepts the connection and
# then stops answering must not hold the alert thread.
_TIMEOUT = 10.0

DEFAULT_TOPIC = 'WebDAQ alerts'


class ZulipNotifier:
    """Zulip transport. Same shape as TelegramNotifier: enabled/settings/send."""

    name = 'zulip'
    label = 'Zulip'

    def __init__(self):
        self.logger = logging.getLogger(__name__ + '.ZulipNotifier')
        self.enabled = False
        self.site = ''          # https://chat.example.org
        self.bot_email = ''     # webdaq-bot@chat.example.org
        self.api_key = ''
        self.stream = ''        # e.g. "LUNA DAQ"
        self.topic = DEFAULT_TOPIC
        self._load()

    # --------------------------------------------------------------- settings
    def _load(self) -> None:
        if os.path.exists(_SETTINGS_FILE):
            try:
                with open(_SETTINGS_FILE, 'r') as f:
                    s = json.load(f)
                self.enabled = bool(s.get('enabled', False))
                self.site = s.get('site', '')
                self.bot_email = s.get('bot_email', '')
                self.api_key = s.get('api_key', '')
                self.stream = s.get('stream', '')
                self.topic = s.get('topic', DEFAULT_TOPIC) or DEFAULT_TOPIC
                self.logger.info(f"Loaded Zulip settings ({self.site})")
                return
            except Exception as e:
                self.logger.error(f"Error loading Zulip settings: {e}")
        self.enabled, self.site, self.bot_email, self.api_key = False, '', '', ''
        self.stream, self.topic = '', DEFAULT_TOPIC

    def _save(self) -> None:
        try:
            os.makedirs(os.path.dirname(_SETTINGS_FILE), exist_ok=True)
            with open(_SETTINGS_FILE, 'w') as f:
                json.dump({'enabled': self.enabled, 'site': self.site,
                           'bot_email': self.bot_email, 'api_key': self.api_key,
                           'stream': self.stream, 'topic': self.topic}, f, indent=4)
        except Exception as e:
            self.logger.error(f"Error saving Zulip settings: {e}")

    @staticmethod
    def _mask(secret: str) -> str:
        """Show that a key is set without echoing it back to the browser."""
        return '*' * len(secret) if secret else ''

    def is_configured(self) -> bool:
        return bool(self.site and self.bot_email and self.api_key and self.stream)

    def get_settings(self) -> Dict[str, Any]:
        return {
            'enabled': self.enabled,
            'site': self.site,
            'bot_email': self.bot_email,
            'api_key': self._mask(self.api_key),
            'stream': self.stream,
            'topic': self.topic,
            'configured': self.is_configured(),
        }

    def set_settings(self, enabled: Optional[bool] = None, site: Optional[str] = None,
                     bot_email: Optional[str] = None, api_key: Optional[str] = None,
                     stream: Optional[str] = None, topic: Optional[str] = None,
                     clear_api_key: bool = False) -> None:
        # Everything is read and converted before anything is stored: a value that
        # failed halfway used to leave the switch on in memory and off in the file.
        new_enabled = self.enabled if enabled is None else bool(enabled)
        new_site = self.site
        if site is not None:
            new_site = str(site).strip().rstrip('/')
            if new_site and not re.match(r'^https?://', new_site):
                new_site = 'https://' + new_site
        new_email = self.bot_email if bot_email is None else str(bot_email).strip()
        # An empty key means "leave it alone": the getter only ever returns a
        # mask, so the settings form cannot round-trip the real one.
        new_key = self.api_key
        if clear_api_key:
            new_key = ''
        elif api_key:
            new_key = str(api_key).strip()
        new_stream = self.stream if stream is None else str(stream).strip()
        new_topic = self.topic
        if topic is not None:
            new_topic = str(topic).strip() or DEFAULT_TOPIC

        self.enabled, self.site, self.bot_email = new_enabled, new_site, new_email
        self.api_key, self.stream, self.topic = new_key, new_stream, new_topic
        self._save()
        self.logger.info(f"Zulip settings updated: enabled={self.enabled}, site={self.site}")

    # --------------------------------------------------------------- delivery
    def format(self, title: str, lines) -> str:
        """Render an alert as Zulip markdown."""
        body = '\n'.join(f'* {line}' for line in lines if line)
        return f"**{title}**\n\n{body}" if body else f"**{title}**"

    def send_message(self, message: str) -> bool:
        """Post to the configured stream/topic. Never raises."""
        if not self.enabled:
            return False
        if not self.is_configured():
            self.logger.warning("Zulip site, bot account, key or stream not configured")
            return False
        data = urllib.parse.urlencode({
            'type': 'stream',
            'to': self.stream,
            'topic': self.topic or DEFAULT_TOPIC,
            'content': message,
        }).encode('utf-8')
        token = base64.b64encode(
            f"{self.bot_email}:{self.api_key}".encode('utf-8')).decode('ascii')
        req = urllib.request.Request(
            f"{self.site}/api/v1/messages", data=data, method='POST',
            headers={'Content-Type': 'application/x-www-form-urlencoded',
                     'Authorization': f'Basic {token}'})
        try:
            with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
                result = json.loads(resp.read().decode('utf-8') or '{}')
            if result.get('result') == 'success':
                return True
            self.logger.error(f"Zulip API error: {result}")
            return False
        except Exception as e:
            self.logger.error(f"Error sending Zulip message: {self._describe(e)}")
            return False

    def _describe(self, error: Exception) -> str:
        if isinstance(error, urllib.error.HTTPError):
            detail = ''
            try:
                detail = json.loads(error.read()).get('msg', '')
            except Exception:
                pass
            if error.code in (401, 403):
                return ('the bot email or API key was rejected'
                        if not detail else f"{detail} (rejected)")
            return f"Zulip answered {error.code}" + (f": {detail}" if detail else "")
        if isinstance(error, urllib.error.URLError):
            return f"{self.site} is unreachable: {error.reason}"
        return str(error)

    def test_connection(self) -> Dict[str, Any]:
        """Post a test message, whatever the enabled flag says."""
        if not self.is_configured():
            return {'success': False,
                    'message': 'Site, bot email, API key or stream not configured'}
        original = self.enabled
        self.enabled = True
        try:
            ok = self.send_message(self.format(
                'WebDAQ test message',
                ['Zulip notifications are working correctly.']))
        finally:
            self.enabled = original
        if ok and not original:
            return {'success': True,
                    'message': f'Test message sent to #{self.stream} > {self.topic} — but '
                               'Zulip is switched off, so no alert will be delivered '
                               'until you enable it above.'}
        if ok:
            return {'success': True,
                    'message': f'Test message sent to #{self.stream} > {self.topic}'}
        return {'success': False,
                'message': 'Failed to send the test message. Check the site, bot '
                           'account, API key and stream (see server.log for the reason).'}


_notifier: Optional[ZulipNotifier] = None


def get_zulip_notifier() -> ZulipNotifier:
    """Get or create the process-wide Zulip notifier."""
    global _notifier
    if _notifier is None:
        _notifier = ZulipNotifier()
    return _notifier
