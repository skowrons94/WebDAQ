"""
TelegramNotifier — Telegram notification settings + delivery.

Loads/saves conf/telegram_settings.json and sends messages (board-failure alerts,
test messages) via the Telegram Bot API. Extracted from daq_manager.py; DAQManager
holds one instance and delegates its telegram methods to it.
"""

import os
import json
import logging
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime
from typing import Any, Dict

logger = logging.getLogger(__name__)


def _escape(text: str) -> str:
    """Telegram parses the message as HTML, so a stray '<' would break it."""
    return (str(text).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))

_SETTINGS_FILE = 'conf/telegram_settings.json'


class TelegramNotifier:
    name = 'telegram'
    label = 'Telegram'

    def __init__(self):
        self.logger = logging.getLogger(__name__ + '.TelegramNotifier')
        self.enabled = False
        self.bot_token = ''
        self.chat_id = ''
        self.notification_sent = False   # one board-failure alert per run
        self._load()

    # --------------------------------------------------------------- settings
    def _load(self) -> None:
        if os.path.exists(_SETTINGS_FILE):
            try:
                with open(_SETTINGS_FILE, 'r') as f:
                    s = json.load(f)
                self.enabled = s.get('enabled', False)
                self.bot_token = s.get('bot_token', '')
                self.chat_id = s.get('chat_id', '')
                self.logger.info("Loaded Telegram settings")
                return
            except Exception as e:
                self.logger.error(f"Error loading Telegram settings: {e}")
        self.enabled, self.bot_token, self.chat_id = False, '', ''
        self._save()

    def _save(self) -> None:
        try:
            os.makedirs(os.path.dirname(_SETTINGS_FILE), exist_ok=True)
            with open(_SETTINGS_FILE, 'w') as f:
                json.dump({'enabled': self.enabled, 'bot_token': self.bot_token,
                           'chat_id': self.chat_id}, f, indent=4)
        except Exception as e:
            self.logger.error(f"Error saving Telegram settings: {e}")

    @staticmethod
    def _mask_token(token: str) -> str:
        if not token or len(token) < 20:
            return '*' * len(token) if token else ''
        return token[:10] + '*' * (len(token) - 15) + token[-5:]

    def is_configured(self) -> bool:
        return bool(self.bot_token and self.chat_id)

    def get_settings(self) -> Dict[str, Any]:
        return {
            'enabled': self.enabled,
            'bot_token': self._mask_token(self.bot_token),
            'chat_id': self.chat_id,
            'configured': self.is_configured(),
        }

    def set_settings(self, enabled: bool = None, bot_token: str = None,
                     chat_id: str = None, clear_bot_token: bool = False) -> None:
        # Everything is read and converted before anything is stored: a value that
        # failed halfway used to leave the switch on in memory and off in the file.
        new_enabled = self.enabled if enabled is None else bool(enabled)
        new_token = self.bot_token
        if clear_bot_token:
            new_token = ''
        elif bot_token:
            # A chat id or token can arrive as a number from a script.
            new_token = str(bot_token).strip()
        new_chat = self.chat_id if chat_id is None else str(chat_id).strip()

        self.enabled, self.bot_token, self.chat_id = new_enabled, new_token, new_chat
        self._save()
        self.logger.info(f"Telegram settings updated: enabled={self.enabled}")

    def format(self, title: str, lines) -> str:
        """Render an alert as the HTML subset Telegram accepts."""
        body = '\n'.join(_escape(line) for line in lines if line)
        head = f"<b>{_escape(title)}</b>"
        return f"{head}\n\n{body}" if body else head

    # --------------------------------------------------------------- delivery
    def send_message(self, message: str) -> bool:
        if not self.enabled:
            return False
        if not self.bot_token or not self.chat_id:
            self.logger.warning("Telegram bot token or chat ID not configured")
            return False
        try:
            url = f"https://api.telegram.org/bot{self.bot_token}/sendMessage"
            data = urllib.parse.urlencode(
                {'chat_id': self.chat_id, 'text': message, 'parse_mode': 'HTML'}).encode('utf-8')
            req = urllib.request.Request(url, data=data, method='POST')
            req.add_header('Content-Type', 'application/x-www-form-urlencoded')
            with urllib.request.urlopen(req, timeout=10) as resp:
                result = json.loads(resp.read().decode('utf-8'))
                if result.get('ok'):
                    return True
                self.logger.error(f"Telegram API error: {result}")
                return False
        except Exception as e:
            self.logger.error(f"Error sending Telegram message: {e}")
            return False

    def test_connection(self) -> Dict[str, Any]:
        if not self.bot_token or not self.chat_id:
            return {'success': False, 'message': 'Bot token or chat ID not configured'}
        original = self.enabled
        self.enabled = True
        try:
            ok = self.send_message(
                "🔬 <b>WebDAQ Test Message</b>\n\n"
                "Telegram notifications are working correctly!")
        finally:
            self.enabled = original
        if not ok:
            return {'success': False,
                    'message': 'Failed to send test message. Check bot token and chat ID.'}
        if not original:
            # It went out because the test forces it. Saying only "sent" would let
            # someone finish the setup with the switch off and no alerts at all.
            return {'success': True,
                    'message': 'Test message sent — but Telegram is switched off, so no '
                               'alert will be delivered until you enable it above.'}
        return {'success': True, 'message': 'Test message sent successfully'}

    def reset_notification_flag(self) -> None:
        """Kept for the DAQ manager's run-start call; de-duplication now belongs
        to the alert rules, which know about boards, runs and destinations."""
        self.notification_sent = False
