"""
ElogClient — read and write a PSI ELOG logbook from WebDAQ.

The collaboration keeps its shift log in ELOG, so run control should be able to
show recent entries and submit new ones without leaving the browser.

Authentication uses one shared service account stored in conf/elog_settings.json
(the same arrangement as conf/telegram_settings.json for the bot token).
Attribution is separate: ELOG's ``Author`` attribute is filled from the WebDAQ
user who is posting, so entries still carry a real name.

The ELOG protocol itself is handled by py_elog (PSI's own client), which is
imported lazily so a server without it still starts and reports a clear reason
instead of failing at import time. Everything the rest of the app uses goes
through this class, so replacing py_elog stays a local change.
"""

import os
import json
import time
import logging
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

_SETTINGS_FILE = 'conf/elog_settings.json'

# Reading an entry is one HTTP round trip, and the list view needs many of them.
_CACHE_TTL = 30.0
_CACHE_MAX = 500

# Every ELOG call gets a deadline. Without one, a logbook that accepts the
# connection and then stops answering holds a WebDAQ worker thread until the OS
# gives up — during a run, with the dashboard polling, that is how a server runs
# out of workers.
_TIMEOUT = 10.0

# Attributes ELOG sets itself: they describe the entry rather than being fields
# the operator fills in, so the composer must not offer them as inputs.
_INTERNAL_ATTRIBUTES = {
    '$@MID@$', 'Date', 'When', 'Attachment', 'Encoding', 'Locked by',
    'In reply to', 'Reply to', 'Edit',
}


class ElogError(Exception):
    """An ELOG operation failed for a reason worth showing the operator."""


class ElogClient:
    def __init__(self):
        self.logger = logging.getLogger(__name__ + '.ElogClient')
        self.enabled = False
        self.url = ''
        self.user = ''
        self.password = ''
        self.default_attributes: Dict[str, str] = {}

        self._lock = threading.Lock()
        self._cache: Dict[int, Tuple[float, Dict[str, Any]]] = {}
        self._logbook = None          # cached py_elog Logbook
        self._logbook_key = None      # settings the cached Logbook was built from
        self._load()

    # ── settings ─────────────────────────────────────────────────────────────

    def _load(self) -> None:
        if os.path.exists(_SETTINGS_FILE):
            try:
                with open(_SETTINGS_FILE, 'r') as f:
                    s = json.load(f)
                self.enabled = s.get('enabled', False)
                self.url = s.get('url', '')
                self.user = s.get('user', '')
                self.password = s.get('password', '')
                self.default_attributes = s.get('default_attributes', {}) or {}
                self.logger.info("Loaded ELOG settings")
                return
            except Exception as e:
                self.logger.error(f"Error loading ELOG settings: {e}")
        self.enabled, self.url, self.user, self.password = False, '', '', ''
        self.default_attributes = {}

    def _save(self) -> None:
        try:
            os.makedirs(os.path.dirname(_SETTINGS_FILE), exist_ok=True)
            with open(_SETTINGS_FILE, 'w') as f:
                json.dump({'enabled': self.enabled, 'url': self.url, 'user': self.user,
                           'password': self.password,
                           'default_attributes': self.default_attributes}, f, indent=4)
        except Exception as e:
            self.logger.error(f"Error saving ELOG settings: {e}")

    @staticmethod
    def _mask(secret: str) -> str:
        """Show that a password is set without echoing it back to the browser."""
        return '*' * len(secret) if secret else ''

    def get_settings(self) -> Dict[str, Any]:
        return {
            'enabled': self.enabled,
            'url': self.url,
            'user': self.user,
            'password': self._mask(self.password),
            'default_attributes': dict(self.default_attributes),
            'configured': bool(self.url),
            'available': py_elog_available(),
        }

    def set_settings(self, enabled: Optional[bool] = None, url: Optional[str] = None,
                     user: Optional[str] = None, password: Optional[str] = None,
                     default_attributes: Optional[Dict[str, str]] = None) -> None:
        if enabled is not None:
            self.enabled = bool(enabled)
        if url is not None:
            self.url = url.strip()
        if user is not None:
            self.user = user.strip()
        # An empty password means "leave it alone": the getter only ever returns
        # a mask, so the settings form cannot round-trip the real one.
        if password:
            self.password = password
        if default_attributes is not None:
            self.default_attributes = {str(k): str(v) for k, v in default_attributes.items() if str(k).strip()}
        with self._lock:
            self._logbook = None
            self._cache.clear()
        self._save()
        self.logger.info(f"ELOG settings updated: enabled={self.enabled}, url={self.url}")

    # ── connection ───────────────────────────────────────────────────────────

    def _get_logbook(self):
        """The py_elog Logbook for the configured logbook, built on first use."""
        if not self.url:
            raise ElogError("No ELOG logbook is configured. Set its URL in Settings → ELOG.")

        try:
            import elog as py_elog
        except ImportError:
            # py_elog is not published on PyPI — it comes from PSI's conda
            # channel (or from its git repository).
            raise ElogError(
                "The py_elog package is not installed on the server. Install it with "
                "'conda install -c paulscherrerinstitute elog' and restart the server.")

        key = (self.url, self.user, self.password)
        with self._lock:
            if self._logbook is not None and self._logbook_key == key:
                return self._logbook

        try:
            logbook = py_elog.open(self.url, user=self.user or None, password=self.password or None)
        except Exception as e:
            raise ElogError(f"Could not open the ELOG logbook: {self._describe(e)}")

        with self._lock:
            self._logbook = logbook
            self._logbook_key = key
        return logbook

    @staticmethod
    def _describe(error: Exception) -> str:
        """A message an operator can act on, out of py_elog's exception types."""
        name = type(error).__name__
        text = str(error).strip() or name
        if 'Authentication' in name or 'invalid user' in text.lower():
            return f"{text} — check the ELOG user and password."
        if 'Timeout' in name:
            return f"{text} — the ELOG server did not answer in time."
        return text

    def test_connection(self) -> Dict[str, Any]:
        if not self.url:
            return {'success': False, 'message': 'No ELOG URL configured.'}
        try:
            logbook = self._get_logbook()
            last = logbook.get_last_message_id(timeout=_TIMEOUT)
        except ElogError as e:
            return {'success': False, 'message': str(e)}
        except Exception as e:
            return {'success': False, 'message': self._describe(e)}
        if last is None:
            return {'success': True, 'message': 'Connected — the logbook is empty.'}
        return {'success': True, 'message': f'Connected — the last entry is #{last}.'}

    # ── reading ──────────────────────────────────────────────────────────────

    def _cached_entry(self, msg_id: int) -> Optional[Dict[str, Any]]:
        with self._lock:
            hit = self._cache.get(msg_id)
        if hit and (time.time() - hit[0]) < _CACHE_TTL:
            return hit[1]
        return None

    def _store_entry(self, entry: Dict[str, Any]) -> None:
        with self._lock:
            if len(self._cache) >= _CACHE_MAX:
                oldest = sorted(self._cache.items(), key=lambda kv: kv[1][0])[:_CACHE_MAX // 4]
                for key, _ in oldest:
                    self._cache.pop(key, None)
            self._cache[entry['id']] = (time.time(), entry)

    def read_entry(self, msg_id: int, use_cache: bool = True) -> Dict[str, Any]:
        """One entry: text, attributes and attachment URLs."""
        msg_id = int(msg_id)
        if use_cache:
            cached = self._cached_entry(msg_id)
            if cached is not None:
                return cached

        logbook = self._get_logbook()
        try:
            message, attributes, attachments = logbook.read(msg_id, timeout=_TIMEOUT)
        except Exception as e:
            raise ElogError(f"Could not read entry #{msg_id}: {self._describe(e)}")

        attributes = dict(attributes or {})
        entry = {
            'id': msg_id,
            'text': message or '',
            'attributes': attributes,
            'attachments': list(attachments or []),
            'author': attributes.get('Author', ''),
            'subject': attributes.get('Subject', ''),
            'type': attributes.get('Type', ''),
            'date': attributes.get('Date', ''),
            'when': attributes.get('When', ''),
            'encoding': attributes.get('Encoding', ''),
            'in_reply_to': attributes.get('In reply to', ''),
            'reply_to': attributes.get('Reply to', ''),
        }
        self._store_entry(entry)
        return entry

    def list_entries(self, limit: int = 20, offset: int = 0) -> Dict[str, Any]:
        """
        The most recent entries, newest first.

        ELOG has no bulk read, so each entry is a request of its own — they run
        a few at a time and are cached briefly to keep the list view responsive.
        """
        logbook = self._get_logbook()
        try:
            ids = [int(i) for i in (logbook.get_message_ids(timeout=_TIMEOUT) or [])]
        except Exception as e:
            raise ElogError(f"Could not list the logbook: {self._describe(e)}")

        ids.sort(reverse=True)
        page = ids[offset:offset + limit]
        return {
            'entries': self._read_many(page),
            'total': len(ids),
            'offset': offset,
            'limit': limit,
            'has_more': offset + limit < len(ids),
        }

    def search_entries(self, term: str, limit: int = 20) -> Dict[str, Any]:
        """Entries matching a text search, newest first."""
        logbook = self._get_logbook()
        try:
            results = logbook.search(term, n_results=max(limit, 1), timeout=_TIMEOUT)
        except TypeError:
            # Older py_elog releases take neither n_results nor timeout.
            try:
                results = logbook.search(term)
            except Exception as e:
                raise ElogError(f"Search failed: {self._describe(e)}")
        except Exception as e:
            raise ElogError(f"Search failed: {self._describe(e)}")

        # Depending on the version, search returns ids or whole entries.
        ids: List[int] = []
        for result in results or []:
            if isinstance(result, dict):
                raw = result.get('$@MID@$') or result.get('id')
            else:
                raw = result
            try:
                ids.append(int(raw))
            except (TypeError, ValueError):
                continue

        ids.sort(reverse=True)
        return {'entries': self._read_many(ids[:limit]), 'total': len(ids),
                'offset': 0, 'limit': limit, 'has_more': False}

    def _read_many(self, ids: List[int]) -> List[Dict[str, Any]]:
        """Read entries concurrently, keeping the order of `ids`."""
        if not ids:
            return []

        def read(msg_id: int) -> Optional[Dict[str, Any]]:
            try:
                return self.read_entry(msg_id)
            except Exception as e:
                # One unreadable entry (deleted mid-listing, say) must not empty
                # the whole page.
                self.logger.warning(f"Skipping ELOG entry {msg_id}: {e}")
                return None

        with ThreadPoolExecutor(max_workers=4) as pool:
            entries = list(pool.map(read, ids))
        return [entry for entry in entries if entry is not None]

    def attribute_names(self, sample: int = 5) -> List[str]:
        """
        The attribute fields this logbook uses.

        ELOG exposes no configuration API, so the fields are learned from recent
        entries; the composer offers them and the operator can still add more.
        """
        names: List[str] = []
        try:
            recent = self.list_entries(limit=sample).get('entries', [])
        except ElogError:
            return names
        for entry in recent:
            for name in entry.get('attributes', {}):
                if name not in _INTERNAL_ATTRIBUTES and name not in names:
                    names.append(name)
        return names

    # ── writing ──────────────────────────────────────────────────────────────

    def post_entry(self, text: str, attributes: Dict[str, str], reply_to: Optional[int] = None,
                   attachments: Optional[List[Any]] = None, encoding: str = 'plain') -> int:
        """
        Submit an entry (or a reply to one) and return its message id.

        Args:
            text: the entry body
            attributes: ELOG attributes; the defaults from settings fill any gaps
            reply_to: parent message id, to thread the entry under it
            attachments: werkzeug FileStorage objects from the upload form
        """
        if not self.enabled:
            raise ElogError("ELOG posting is switched off in Settings → ELOG.")

        logbook = self._get_logbook()

        merged = dict(self.default_attributes)
        merged.update({k: v for k, v in (attributes or {}).items() if v not in (None, '')})

        temp_dir: Optional[tempfile.TemporaryDirectory] = None
        paths: List[str] = []
        if attachments:
            temp_dir = tempfile.TemporaryDirectory(prefix='webdaq-elog-')
            for upload in attachments:
                name = os.path.basename(getattr(upload, 'filename', '') or 'attachment')
                path = os.path.join(temp_dir.name, name)
                upload.save(path)
                paths.append(path)

        try:
            msg_id = logbook.post(
                text or '',
                msg_id=int(reply_to) if reply_to else None,
                reply=bool(reply_to),
                attributes=merged,
                attachments=paths or None,
                encoding=encoding,
                # Uploads take longer than a read, so this one gets more room.
                timeout=_TIMEOUT * 3,
            )
        except Exception as e:
            raise ElogError(f"ELOG rejected the entry: {self._describe(e)}")
        finally:
            if temp_dir is not None:
                temp_dir.cleanup()

        with self._lock:
            self._cache.clear()   # the listing and the parent thread both changed
        return int(msg_id)

    # ── attachments ──────────────────────────────────────────────────────────

    def download_attachment(self, url: str) -> bytes:
        """
        Fetch an attachment on the browser's behalf (it has no ELOG session).

        Only the configured ELOG host is allowed: this endpoint would otherwise
        be an open proxy for anything the server can reach.
        """
        if not url:
            raise ElogError("No attachment URL given.")
        if urlsplit(url).netloc.lower() != urlsplit(self.url).netloc.lower():
            raise ElogError("That attachment does not belong to the configured ELOG server.")

        logbook = self._get_logbook()
        try:
            return logbook.download_attachment(url, timeout=_TIMEOUT)
        except Exception as e:
            raise ElogError(f"Could not download the attachment: {self._describe(e)}")


def py_elog_available() -> bool:
    """Whether the py_elog package can be imported on this server."""
    try:
        import elog  # noqa: F401
        return True
    except ImportError:
        return False


_client: Optional[ElogClient] = None


def get_elog_client() -> ElogClient:
    """Get or create the process-wide ELOG client."""
    global _client
    if _client is None:
        _client = ElogClient()
    return _client
