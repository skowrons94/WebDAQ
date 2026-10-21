"""
The counting rates of the whole run, for the Data rates page.

The page used to keep the last 60 samples in the browser: a reload lost them,
and a run of a few hours could not be looked at as a whole. Here the server
samples every board's rates (events, pile-ups, lost, saturations per channel,
and the file write rate) at the statistics cadence for as long as the run
lasts, and keeps them after it stops until the next one starts.

Memory stays bounded whatever the run length: when MAX_POINTS samples are held,
neighbouring pairs are averaged into one and the resolution halves, so a
twelve-hour run is still a few thousand points. Each halving bumps
``generation``, which tells a client following with ``since`` to fetch it all
again. It needs no Graphite: the rates come from the acquisition itself.
"""

import logging
import threading
import time
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

MAX_POINTS = 2000
METRICS = ("event_rate", "pileup_rate", "lost_rate", "satu_rate")


def _board_key(board: Dict[str, Any], channel: Dict[str, Any]) -> str:
    # The channel names its board where it can (CAEN: register id; SIS3316:
    # WebDAQ id), as the Histograms page matches them.
    return str(channel.get("board", board.get("board_id", "")))


class RateHistory:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._acq = None
        self.run_start: Optional[float] = None
        self.generation = 0
        self.step_s = 1.0
        self.points: List[Dict[str, Any]] = []
        self._pending: Optional[Dict[str, Any]] = None   # half of a pair, while decimated
        self._pending_n = 0
        self._stride = 1

    # ── lifecycle ──────────────────────────────────────────────────────────
    def start(self, acq, interval_s: float = 1.0) -> None:
        self.stop()
        with self._lock:
            self._acq = acq
            self.run_start = time.time()
            self.generation += 1
            self.step_s = max(0.2, float(interval_s))
            self.points = []
            self._pending, self._pending_n, self._stride = None, 0, 1
            self._stop.clear()
            self._thread = threading.Thread(target=self._loop, name="rate-history", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        """At run stop: stop sampling, keep the history for viewing."""
        self._stop.set()
        thread = self._thread
        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=3)
        self._thread = None

    def _loop(self) -> None:
        while not self._stop.wait(self._interval()):
            try:
                self.sample()
            except Exception as e:
                logger.debug(f"rate history sample failed: {e}")

    def _interval(self) -> float:
        acq = self._acq
        try:
            ms = acq.stats_interval() if acq is not None else None
        except Exception:
            ms = None
        return max(0.2, (ms or 1000) / 1000.0)

    # ── sampling ───────────────────────────────────────────────────────────
    def sample(self) -> None:
        acq = self._acq
        if acq is None or self.run_start is None:
            return
        boards = acq.stats() or []
        if not boards:
            return
        point: Dict[str, Any] = {"t": round(time.time() - self.run_start, 3), "b": {}}
        for board in boards:
            for ch in board.get("channels", []):
                key = _board_key(board, ch)
                entry = point["b"].setdefault(key, {"w": 0.0, "ch": {}})
                entry["ch"][str(ch.get("channel"))] = [float(ch.get(m) or 0.0) for m in METRICS]
            key = str(board.get("board_id", ""))
            point["b"].setdefault(key, {"w": 0.0, "ch": {}})["w"] = float(board.get("write_rate") or 0.0)
        with self._lock:
            self._add(point)

    def _add(self, point: Dict[str, Any]) -> None:
        # Past MAX_POINTS each stored point stands for `_stride` samples.
        if self._stride > 1:
            self._pending = point if self._pending is None else _average(self._pending, point, self._pending_n)
            self._pending_n += 1
            if self._pending_n < self._stride:
                return
            point, self._pending, self._pending_n = self._pending, None, 0
        self.points.append(point)
        if len(self.points) >= MAX_POINTS:
            self.points = [_average(self.points[i], self.points[i + 1], 1)
                           for i in range(0, len(self.points) - 1, 2)]
            self._stride *= 2
            self.step_s *= 2
            self.generation += 1

    # ── reading ────────────────────────────────────────────────────────────
    def snapshot(self, since: Optional[float] = None, generation: Optional[int] = None) -> Dict[str, Any]:
        with self._lock:
            same = generation is not None and int(generation) == self.generation
            points = [p for p in self.points if since is None or not same or p["t"] > since]
            return {
                "run_start": self.run_start,
                "generation": self.generation,
                "step_s": self.step_s,
                "metrics": list(METRICS),
                "incremental": same and since is not None,
                "running": self._thread is not None and self._thread.is_alive(),
                "points": points,
            }


def _average(a: Dict[str, Any], b: Dict[str, Any], weight_a: int) -> Dict[str, Any]:
    """The mean of `a` (itself the mean of `weight_a` samples) and `b`."""
    wa, wb = float(weight_a), 1.0
    total = wa + wb
    out: Dict[str, Any] = {"t": round((a["t"] * wa + b["t"] * wb) / total, 3), "b": {}}
    for key in set(a["b"]) | set(b["b"]):
        ea, eb = a["b"].get(key, {"w": 0.0, "ch": {}}), b["b"].get(key, {"w": 0.0, "ch": {}})
        entry = {"w": (ea["w"] * wa + eb["w"] * wb) / total, "ch": {}}
        for ch in set(ea["ch"]) | set(eb["ch"]):
            va = ea["ch"].get(ch, [0.0] * len(METRICS))
            vb = eb["ch"].get(ch, [0.0] * len(METRICS))
            entry["ch"][ch] = [(x * wa + y * wb) / total for x, y in zip(va, vb)]
        out["b"][key] = entry
    return out


_history = RateHistory()


def get_rate_history() -> RateHistory:
    return _history
