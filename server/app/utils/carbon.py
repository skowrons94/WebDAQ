"""
Carbon (Graphite ingest) push, guarded so a dead collector cannot stall a caller.

The picoammeter controllers sample on a fixed cadence and push every sample to
Carbon's plaintext port. That push is fire-and-forget as far as the experiment is
concerned — nothing in the DAQ reads it back, and losing a minute of monitoring
history costs nothing. What it must never do is hold anything up, because the
loops that call it also own the buffers the web layer reads and the charge
integration the run metadata depends on.

Two rules follow, and this module exists to enforce them:

  * one connection per push, not one per metric — Carbon's plaintext protocol
    takes any number of newline-terminated "path value timestamp" lines, so a
    four-channel picoammeter costs one handshake instead of four; and
  * a circuit breaker, so a Carbon that is gone costs one connect per cooldown
    instead of one per sample forever.

The second rule is the one that matters. A host that refuses connections fails
in microseconds; a host that is powered off, or behind a firewall dropping SYNs,
never answers at all, and then every push waits out the connect timeout. At a
0.5s sampling interval that is not a hiccup, it is a permanent stall.

Callers should still push OUTSIDE any lock they hold. This module bounds how
long a push takes; it cannot make a blocked caller safe to block behind.
"""

import logging
import socket
import threading
import time
from typing import Any, Dict, List, Optional, Sequence, Tuple

logger = logging.getLogger(__name__)

# Handshake deadline. The collector is on the local network, so anything beyond
# this is a host that is not coming back within this sample.
DEFAULT_CONNECT_TIMEOUT_S = 1.0

# Consecutive failures before the breaker opens, and how long it then stays open.
DEFAULT_FAILURE_THRESHOLD = 3
DEFAULT_COOLDOWN_S = 60.0


class CarbonPusher:
    """
    Batched, breaker-guarded plaintext push to Carbon.

    Thread-safe: one instance per controller, called from that controller's
    acquisition thread, with state readable from web-request threads.
    """

    def __init__(self, name: str,
                 connect_timeout: float = DEFAULT_CONNECT_TIMEOUT_S,
                 failure_threshold: int = DEFAULT_FAILURE_THRESHOLD,
                 cooldown_s: float = DEFAULT_COOLDOWN_S):
        """
        Args:
            name: what is pushing, used only in log lines (e.g. 'tetramm')
            connect_timeout: seconds to wait for the TCP handshake
            failure_threshold: consecutive failures that open the breaker
            cooldown_s: how long the breaker stays open before trying again
        """
        self.name = name
        self.connect_timeout = float(connect_timeout)
        self.failure_threshold = max(1, int(failure_threshold))
        self.cooldown_s = float(cooldown_s)

        self._lock = threading.Lock()
        self._failures = 0
        self._open_until: Optional[float] = None
        self._last_error: Optional[str] = None
        self._target: Optional[Tuple[str, int]] = None
        self._dropped = 0            # pushes skipped while the breaker was open

        self.logger = logging.getLogger(f"{__name__}.{name}")

    def send(self, host: str, port: int,
             metrics: Sequence[Tuple[str, float]],
             timestamp: float) -> bool:
        """
        Push metrics as one batch. Never raises.

        Args:
            host, port: Carbon plaintext endpoint. Read on every call rather
                than cached, because the operator can repoint it at runtime
                (see routes/current.py); a new target clears the breaker so a
                fix takes effect immediately instead of after a cooldown.
            metrics: (path, value) pairs
            timestamp: unix time to stamp every metric in this batch with

        Returns:
            True if the batch went out, False if it was dropped.
        """
        if not metrics or not host:
            return False

        target = (str(host), int(port))
        if not self._admit(target):
            return False

        payload = ''.join(f"{path} {value} {int(timestamp)}\n"
                          for path, value in metrics)

        try:
            with socket.create_connection(target, timeout=self.connect_timeout) as sock:
                sock.sendall(payload.encode('utf-8'))
        except Exception as e:
            self._failure(e)
            return False

        self._success()
        return True

    # ── Breaker ──────────────────────────────────────────────────────────────

    def _admit(self, target: Tuple[str, int]) -> bool:
        with self._lock:
            if target != self._target:
                # Repointed (or first use): whatever we learned about the old
                # collector says nothing about this one.
                self._target = target
                self._failures = 0
                self._open_until = None
                self._last_error = None
                return True

            if self._open_until is None:
                return True

            if time.monotonic() < self._open_until:
                self._dropped += 1
                return False

            # Cooldown expired: this push is the probe.
            return True

    def _success(self) -> None:
        with self._lock:
            recovered = self._open_until is not None
            dropped = self._dropped
            self._failures = 0
            self._open_until = None
            self._last_error = None
            self._dropped = 0
        if recovered:
            self.logger.warning(
                f"Carbon at {self._fmt_target()} is accepting metrics again "
                f"({dropped} push(es) dropped while it was down)")

    def _failure(self, error: Exception) -> None:
        with self._lock:
            self._failures += 1
            self._last_error = str(error).split('\n')[0][:200]
            newly_open = (self._open_until is None
                          and self._failures >= self.failure_threshold)
            if newly_open:
                self._open_until = time.monotonic() + self.cooldown_s
            elif self._open_until is not None:
                # The probe failed too — wait another cooldown.
                self._open_until = time.monotonic() + self.cooldown_s
            failures = self._failures
        if newly_open:
            # Once per outage. These loops run at 2Hz; a line per failure is
            # how a monitoring outage turns into an unreadable log.
            self.logger.warning(
                f"Carbon at {self._fmt_target()} unreachable after {failures} "
                f"attempts ({self._last_error}). Metrics will be dropped and it "
                f"will be retried every {self.cooldown_s}s. Acquisition and "
                f"charge integration are unaffected.")

    def _fmt_target(self) -> str:
        return "unset" if self._target is None else f"{self._target[0]}:{self._target[1]}"

    def reset(self) -> None:
        """Forget an outage and push again on the next sample."""
        with self._lock:
            self._failures = 0
            self._open_until = None
            self._last_error = None
            self._dropped = 0

    def state(self) -> Dict[str, Any]:
        """Push status, for status endpoints."""
        with self._lock:
            open_for = (None if self._open_until is None
                        else max(0.0, self._open_until - time.monotonic()))
            return {
                'target': self._fmt_target(),
                'available': self._open_until is None,
                'consecutive_failures': self._failures,
                'retry_in_s': None if open_for is None else round(open_for, 1),
                'dropped_since_failure': self._dropped,
                'last_error': self._last_error,
            }
