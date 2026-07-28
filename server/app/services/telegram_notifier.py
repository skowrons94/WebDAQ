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

_SETTINGS_FILE = 'conf/telegram_settings.json'


class TelegramNotifier:
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

    def get_settings(self) -> Dict[str, Any]:
        return {
            'enabled': self.enabled,
            'bot_token': self._mask_token(self.bot_token),
            'chat_id': self.chat_id,
            'configured': bool(self.bot_token and self.chat_id),
        }

    def set_settings(self, enabled: bool = None, bot_token: str = None, chat_id: str = None) -> None:
        if enabled is not None:
            self.enabled = enabled
        if bot_token is not None:
            self.bot_token = bot_token
        if chat_id is not None:
            self.chat_id = chat_id
        self._save()
        self.logger.info(f"Telegram settings updated: enabled={self.enabled}")

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
        ok = self.send_message(
            "🔬 <b>WebDAQ Test Message</b>\n\nTelegram notifications are working correctly!")
        self.enabled = original
        return ({'success': True, 'message': 'Test message sent successfully'} if ok else
                {'success': False, 'message': 'Failed to send test message. Check bot token and chat ID.'})

    def reset_notification_flag(self) -> None:
        self.notification_sent = False

    def send_board_failure(self, board_id: str, failure_type: str, run_number: int,
                           auto_restart_enabled: bool, auto_restart_delay: int) -> bool:
        """Send a board-failure alert (once per run)."""
        if self.notification_sent:
            return False
        message = (
            f"⚠️ <b>LUNA DAQ Board Failure Alert</b>\n\n"
            f"<b>Run Number:</b> {run_number}\n"
            f"<b>Board ID:</b> {board_id}\n"
            f"<b>Failure Type:</b> {failure_type}\n"
            f"<b>Time:</b> {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n"
        )
        if auto_restart_enabled:
            message += f"🔄 Auto-restart is enabled. Run will restart in {auto_restart_delay} seconds."
        else:
            message += "⏹️ Auto-restart is disabled. Manual intervention required."
        if self.send_message(message):
            self.notification_sent = True
            return True
        return False
