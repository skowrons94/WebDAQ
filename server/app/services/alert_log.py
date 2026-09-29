"""
AlertLog — what happened while nobody was looking.

A Telegram message is gone once it is read, and a shift that comes in at 08:00
has no way to ask "what did the DAQ do at 03:00?". So every alert and every
recovery is also written here, with the time, what it was about, and whether it
actually reached anybody. The log survives a server restart, which is exactly the
case you want it for: the restart is often part of the story.

Kept deliberately small and boring: one JSON file, capped at the most recent
events, written under a lock. Nothing here may raise into the caller — a failure
to *record* an alert must never stop the alert being sent.
"""

import json
import logging
import os
import threading
import time
import uuid
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_LOG_FILE = 'conf/alert_log.json'

# Enough for a long weekend of a noisy chain, small enough to read and to write
# in one go. Older events fall off the end.
MAX_EVENTS = 500


class AlertLog:
    def __init__(self, path: str = _LOG_FILE, max_events: int = MAX_EVENTS):
        self.logger = logging.getLogger(__name__ + '.AlertLog')
        self.path = path
        self.max_events = max_events
        self._lock = threading.Lock()
        self.events: List[Dict[str, Any]] = []
        self._load()

    # ------------------------------------------------------------------ storage
    def _load(self) -> None:
        if not os.path.exists(self.path):
            return
        try:
            with open(self.path, 'r') as f:
                stored = json.load(f)
            events = stored.get('events', []) if isinstance(stored, dict) else stored
            self.events = [e for e in events if isinstance(e, dict)][-self.max_events:]
            self.logger.info(f"Loaded {len(self.events)} logged alert(s)")
        except Exception as e:
            # A corrupt log is not worth losing the session over.
            self.logger.error(f"Error loading the alert log: {e}")
            self.events = []

    def _save(self) -> None:
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            tmp = f"{self.path}.tmp"
            with open(tmp, 'w') as f:
                json.dump({'events': self.events}, f, indent=2)
            os.replace(tmp, self.path)      # never leave a half-written log
        except Exception as e:
            self.logger.error(f"Error saving the alert log: {e}")

    # ------------------------------------------------------------------- record
    def record(self, kind: str, title: str, lines: Optional[List[str]] = None,
               rule_id: str = '', rule_type: str = '', subject: str = '',
               run_number: Optional[int] = None,
               deliveries: Optional[Dict[str, bool]] = None,
               at: Optional[float] = None) -> Dict[str, Any]:
        """Append one event. `kind` is 'alert', 'recovery' or 'info'."""
        event = {
            'id': uuid.uuid4().hex[:12],
            'at': float(at if at is not None else time.time()),
            'kind': kind,
            'title': title,
            'lines': list(lines or []),
            'rule_id': rule_id,
            'rule_type': rule_type,
            'subject': subject,
            'run_number': run_number,
            'deliveries': dict(deliveries or {}),
            # Whether anybody has seen it in the browser. Delivery to Telegram or
            # Zulip is a separate question, kept per transport above.
            'seen': False,
        }
        try:
            with self._lock:
                self.events.append(event)
                if len(self.events) > self.max_events:
                    del self.events[:len(self.events) - self.max_events]
                self._save()
        except Exception as e:
            self.logger.error(f"Could not record '{title}': {e}")
        return event

    # -------------------------------------------------------------------- reads
    def list_events(self, limit: int = 100, kind: str = '',
                    unseen_only: bool = False) -> List[Dict[str, Any]]:
        """Most recent first."""
        with self._lock:
            events = list(reversed(self.events))
        if kind:
            events = [e for e in events if e.get('kind') == kind]
        if unseen_only:
            events = [e for e in events if not e.get('seen')]
        return [dict(e) for e in events[:max(1, min(limit, self.max_events))]]

    def unseen_count(self) -> int:
        with self._lock:
            return sum(1 for e in self.events if not e.get('seen'))

    def summary(self) -> Dict[str, Any]:
        """What the bell in the header needs: how many, and the latest."""
        with self._lock:
            unseen = [e for e in self.events if not e.get('seen')]
            latest = self.events[-1] if self.events else None
        return {
            'unseen': len(unseen),
            'total': len(self.events),
            'latest': dict(latest) if latest else None,
            # Something that has not been delivered anywhere is worth showing
            # differently from something that reached the shift's phones.
            'undelivered': sum(1 for e in unseen
                               if not any((e.get('deliveries') or {}).values())),
        }

    # ------------------------------------------------------------------- writes
    def mark_seen(self, ids: Optional[List[str]] = None) -> int:
        """Mark these events seen, or all of them when ids is None.

        An empty list marks nothing: it means "none of them" to every caller, and
        reading it as "all" would quietly clear a shift's unread markers.
        """
        wanted = None if ids is None else {str(i) for i in ids}
        if wanted is not None and not wanted:
            return 0
        changed = 0
        with self._lock:
            for event in self.events:
                if (wanted is None or event['id'] in wanted) and not event.get('seen'):
                    event['seen'] = True
                    changed += 1
            if changed:
                self._save()
        return changed

    def clear(self) -> int:
        with self._lock:
            removed = len(self.events)
            self.events = []
            self._save()
        return removed


_log: Optional[AlertLog] = None


def get_alert_log() -> AlertLog:
    """Get or create the process-wide alert log."""
    global _log
    if _log is None:
        _log = AlertLog()
    return _log
