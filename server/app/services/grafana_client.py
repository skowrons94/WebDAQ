"""
GrafanaClient — reach Grafana's alert rules from WebDAQ.

The Alerts page lists Grafana's alert rules, silences and activates them, and
edits their thresholds; run control activates the auto-managed ones when a run
starts and silences them when it stops. All of that goes through here, so the
Grafana address and service-account token live on the server, in
conf/grafana_settings.json (the same arrangement as conf/elog_settings.json),
and the token never reaches the browser.

Only the alert-rule part of Grafana's API is exposed: the token may carry far
more rights than the Alerts page needs.
"""

import os
import re
import json
import logging
import urllib.error
import urllib.request
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger(__name__)

_SETTINGS_FILE = 'conf/grafana_settings.json'

# Where Grafana ran before this was configurable.
DEFAULT_URL = 'http://lunaserver:3000'

_ALERT_RULES = '/api/v1/provisioning/alert-rules'

# Every call gets a deadline, so a Grafana that stops answering cannot hold a
# WebDAQ worker thread.
_TIMEOUT = 10.0

# Rule UIDs are Grafana's own short identifiers; anything else is refused rather
# than spliced into a URL.
_UID = re.compile(r'^[A-Za-z0-9_-]{1,40}$')


class GrafanaError(Exception):
    """A Grafana request failed. status is the HTTP status to report."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


class GrafanaClient:
    def __init__(self):
        self.logger = logging.getLogger(__name__ + '.GrafanaClient')
        self.url = DEFAULT_URL
        self.api_key = ''
        self._load()

    # ── settings ─────────────────────────────────────────────────────────────

    def _load(self) -> None:
        if os.path.exists(_SETTINGS_FILE):
            try:
                with open(_SETTINGS_FILE, 'r') as f:
                    s = json.load(f)
                self.url = s.get('url', DEFAULT_URL) or DEFAULT_URL
                self.api_key = s.get('api_key', '')
                self.logger.info(f"Loaded Grafana settings ({self.url})")
                return
            except Exception as e:
                self.logger.error(f"Error loading Grafana settings: {e}")
        self.url, self.api_key = DEFAULT_URL, ''

    def _save(self) -> None:
        try:
            os.makedirs(os.path.dirname(_SETTINGS_FILE), exist_ok=True)
            with open(_SETTINGS_FILE, 'w') as f:
                json.dump({'url': self.url, 'api_key': self.api_key}, f, indent=4)
        except Exception as e:
            self.logger.error(f"Error saving Grafana settings: {e}")

    @staticmethod
    def _mask(secret: str) -> str:
        """Show that a token is set without echoing it back to the browser."""
        return '*' * len(secret) if secret else ''

    def get_settings(self) -> Dict[str, Any]:
        return {
            'url': self.url,
            'api_key': self._mask(self.api_key),
            'configured': bool(self.url),
        }

    def set_settings(self, url: Optional[str] = None, api_key: Optional[str] = None,
                     clear_api_key: bool = False) -> None:
        if url is not None:
            url = url.strip().rstrip('/')
            if url and not re.match(r'^https?://', url):
                url = 'http://' + url
            self.url = url
        # An empty token means "leave it alone": the getter only ever returns a
        # mask, so the settings form cannot round-trip the real one.
        if clear_api_key:
            self.api_key = ''
        elif api_key:
            self.api_key = api_key.strip()
        self._save()
        self.logger.info(f"Grafana settings updated: url={self.url}")

    # ── requests ─────────────────────────────────────────────────────────────

    def _request(self, method: str, path: str, body: Any = None) -> Any:
        if not self.url:
            raise GrafanaError('No Grafana URL configured. Set it in Settings → Grafana.', 503)

        headers = {'Content-Type': 'application/json', 'Accept': 'application/json'}
        if self.api_key:
            headers['Authorization'] = f'Bearer {self.api_key}'
        data = None
        if body is not None:
            data = json.dumps(body).encode('utf-8')
            # Keep rules editable in Grafana's UI after WebDAQ has changed them.
            headers['X-Disable-Provenance'] = 'true'

        req = urllib.request.Request(self.url + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as e:
            # Grafana's 401/403 must not reach the browser as such: the frontend
            # reads a 401 (or 422) as its own session expiring and logs out.
            status = e.code if e.code in (400, 404, 409) else 502
            raise GrafanaError(self._describe_http_error(e), status)
        except urllib.error.URLError as e:
            raise GrafanaError(f'Grafana at {self.url} is unreachable: {e.reason}')
        except Exception as e:  # timeouts, malformed URLs
            raise GrafanaError(f'Grafana at {self.url} is unreachable: {e}')

        try:
            return json.loads(raw) if raw else None
        except ValueError:
            raise GrafanaError(f'{self.url} did not answer like Grafana (not JSON).')

    def _describe_http_error(self, e: urllib.error.HTTPError) -> str:
        detail = ''
        try:
            detail = json.loads(e.read()).get('message', '')
        except Exception:
            pass
        if e.code in (401, 403):
            hint = ('the service-account token was rejected' if self.api_key
                    else 'Grafana requires a service-account token')
            return f'Grafana refused the request ({e.code}): {hint}.'
        return f'Grafana answered {e.code}' + (f': {detail}' if detail else '.')

    @staticmethod
    def _check_uid(uid: str) -> None:
        if not _UID.match(uid or ''):
            raise GrafanaError(f'Invalid alert rule UID: {uid!r}', 400)

    def list_alert_rules(self) -> Any:
        return self._request('GET', _ALERT_RULES)

    def get_alert_rule(self, uid: str) -> Any:
        self._check_uid(uid)
        return self._request('GET', f'{_ALERT_RULES}/{uid}')

    def update_alert_rule(self, uid: str, rule: Dict[str, Any]) -> Any:
        self._check_uid(uid)
        return self._request('PUT', f'{_ALERT_RULES}/{uid}', rule)

    def test_connection(self) -> Dict[str, Any]:
        try:
            rules = self.list_alert_rules()
        except GrafanaError as e:
            return {'success': False, 'message': str(e)}
        count = len(rules) if isinstance(rules, list) else 0
        return {'success': True, 'message': f'Connected — {count} alert rule(s) found.'}


_client: Optional[GrafanaClient] = None


def get_grafana_client() -> GrafanaClient:
    """Get or create the process-wide Grafana client."""
    global _client
    if _client is None:
        _client = GrafanaClient()
    return _client
