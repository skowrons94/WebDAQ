"""
A beam-current "module" whose readings come from a monitored Graphite metric.

Not every setup has a picoammeter on the target. Some read the beam current from
the accelerator itself, which already publishes it to Graphite alongside the
other machine values. This controller makes that number look exactly like a
TetrAMM or an RBD 9103 to the rest of the server: the same readout, the same
per-run ``current.txt``, and — the point of it — the same accumulated charge, so
the analysis normalises to a real integrated charge rather than to nothing.

It presents the interface the ``/current`` routes call on the real controllers,
so nothing downstream needs to know where the number came from.

Units: the metric is whatever the accelerator publishes, so ``scale`` converts
it into the µA everything else here works in (1 for a metric already in µA,
1e-3 for nA, 1e3 for mA).
"""

import logging
import os
import threading
import time
from collections import deque
from datetime import datetime
from typing import Any, Dict, Optional

import numpy as np

from ..services import graphite_reader

logger = logging.getLogger(__name__)

BUFFER_SAMPLES = 100        # what get_data_array() returns, as the real modules do
HISTORY_SAMPLES = 100000    # timestamped history for the rolling/run-start charts


class GraphiteCurrentController:
    """A current source backed by a Graphite metric rather than by hardware."""

    def __init__(self, metric: str = '', scale: float = 1.0,
                 poll_interval_s: float = 1.0):
        self.metric = str(metric or '')
        self.scale = self._sane_scale(scale)
        # Polling faster than the metric is published gains nothing but load;
        # 1 s matches how often the accelerator values are typically archived.
        self.acquisition_interval = max(0.2, float(poll_interval_s or 1.0))

        self.is_acquiring = False
        self._charge_channel = 0

        self._accumulated_charge = 0.0     # µC, since the last reset (this run)
        self._total_accumulated = 0.0      # µC, lifetime
        self._accumulating = False         # True while a run is in progress

        self._buffer = deque([0.0] * BUFFER_SAMPLES, maxlen=BUFFER_SAMPLES)
        self._latest = 0.0
        self._history_times = deque(maxlen=HISTORY_SAMPLES)
        self._history_values = deque(maxlen=HISTORY_SAMPLES)

        # Integration state, keyed on the metric's OWN timestamps rather than on
        # wall-clock: a poll that returns three archived points must contribute
        # the charge of those three points, not of one polling interval.
        #
        # Two cursors, because a rejected reading still has to be remembered:
        # '_last_seen' is the newest timestamp examined, so a bad sample is not
        # re-examined on every poll, while '_last_timestamp'/'_last_value' stay
        # on the last reading good enough to integrate from.
        self._last_seen = 0.0
        self._last_timestamp = 0.0
        self._last_value = 0.0
        self._last_sample_wall = 0.0
        self._primed = False

        self.save_data = False
        self.save_folder = ""
        self.run_start_time: Optional[float] = None

        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()

        logger.info(
            f"Graphite current module configured on '{self.metric or '(unset)'}' "
            f"(x{self.scale} -> µA, every {self.acquisition_interval}s)")

    # ───────────────────────────────────────────────────────────── configuration

    @staticmethod
    def _sane_scale(scale: Any) -> float:
        try:
            value = float(scale)
        except (TypeError, ValueError):
            return 1.0
        # A zero scale would silently report no beam and integrate no charge,
        # which looks like a dead beam rather than a misconfiguration.
        return value if value != 0 and np.isfinite(value) else 1.0

    @staticmethod
    def _is_usable(value: float) -> bool:
        """Whether a reading is a beam current at all.

        A monitored value is not a dedicated picoammeter: it goes NaN when its
        source is down or the archive has a hole, and negative when the readout
        is unplugged or reading its own offset backwards. Neither is a
        measurement of beam, and integrating either corrupts the run's charge —
        a NaN poisons the total irrecoverably, a negative silently eats charge
        that really was delivered. Both are dropped, and the trapezoid simply
        bridges the gap they leave (up to _max_gap).
        """
        try:
            return bool(np.isfinite(value)) and value >= 0
        except (TypeError, ValueError):
            return False

    @property
    def settings(self) -> Dict[str, Any]:
        """Reported by /current/status, in the shape the other modules use."""
        return {
            "metric": self.metric,
            "scale": self.scale,
            "poll_interval_s": self.acquisition_interval,
        }

    def configure(self, metric: Optional[str] = None, scale: Optional[float] = None,
                  poll_interval_s: Optional[float] = None) -> None:
        """Retarget the module. Charge already integrated is kept."""
        with self._lock:
            if metric is not None and str(metric) != self.metric:
                self.metric = str(metric)
                # A different metric is a different signal: integrating across
                # the change with the old timestamp would invent a gap-sized
                # slab of charge at the new value.
                self._primed = False
                self._last_seen = 0.0
                self._history_times.clear()
                self._history_values.clear()
            if scale is not None:
                self.scale = self._sane_scale(scale)
            if poll_interval_s is not None:
                self.acquisition_interval = max(0.2, float(poll_interval_s or 1.0))

    # ─────────────────────────────────────────────────────────────── acquisition

    @property
    def _max_gap(self) -> float:
        """Longest gap still integrated as if the current had held across it.

        Graphite being unreachable for ten minutes must not add ten minutes'
        worth of charge the moment it comes back; past this the gap counts as
        unmeasured and contributes nothing.
        """
        return max(10.0, 5.0 * self.acquisition_interval)

    def _poll_once(self) -> None:
        with self._lock:
            metric, scale = self.metric, self.scale
            interval = self.acquisition_interval
            primed, last_seen = self._primed, self._last_seen

        if not metric:
            return

        # Ask for a window rather than a point so a stalled poll, a slow archive
        # or a metric published in bursts does not drop samples on the floor.
        window = int(max(60.0, 10.0 * interval))
        series = graphite_reader.fetch_series(
            metric, f'-{window}s', 'now', scale=scale)
        if not series:
            return

        fresh = [point for point in series if point[0] > last_seen]
        if not fresh:
            # Still connected — Graphite answered, the metric just has not
            # advanced yet.
            with self._lock:
                self._last_sample_wall = time.time()
            return

        to_log = []
        accepted = False
        with self._lock:
            for timestamp, value in fresh:
                self._last_seen = max(self._last_seen, timestamp)

                if not self._is_usable(value):
                    logger.debug(
                        f"Ignoring unusable reading from '{metric}': {value}")
                    continue

                self._history_times.append(timestamp)
                self._history_values.append(value)
                self._buffer.append(value)
                self._latest = value

                if primed:
                    dt = timestamp - self._last_timestamp
                    if 0 < dt <= self._max_gap:
                        # Trapezoid: a ramping beam is integrated as a ramp
                        # rather than as a staircase. µA × s = µC.
                        delta = 0.5 * (self._last_value + value) * dt
                        self._total_accumulated += delta
                        if self._accumulating:
                            self._accumulated_charge += delta
                else:
                    # The first poll brings back a window of archived points.
                    # They give the plot immediate context, but there is no
                    # measured interval before the first of them to integrate.
                    primed = True

                self._last_timestamp = timestamp
                self._last_value = value
                accepted = True

                if self.save_data and self.run_start_time is not None:
                    to_log.append((timestamp - self.run_start_time, value))

            if accepted:
                # A poll that brought back nothing but NaNs has not established
                # that the metric works, so it must not refresh either the
                # integration cursor or the connected state.
                self._primed = True
                self._last_sample_wall = time.time()
            folder = self.save_folder

        for relative_time, value in to_log:
            self._append_sample(folder, relative_time, value)

    def _append_sample(self, folder: str, relative_time: float, value: float) -> None:
        """One row, in the format the real controllers write."""
        try:
            with open(os.path.join(folder, 'current.txt'), 'a') as f:
                f.write(f'{relative_time:.8e}\t{value:.3e}\t\n')
        except OSError as e:
            logger.error(f"Could not write the current log: {e}")

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self._poll_once()
            except Exception as e:
                logger.error(f"Graphite current poll failed: {e}")
            self._stop.wait(self.acquisition_interval)

    # ───────────────────────────────────────────────────────────────── lifecycle

    def initialize(self) -> None:
        if self._thread is None or not self._thread.is_alive():
            self._stop.clear()
            self._thread = threading.Thread(
                target=self._loop, name="graphite-current", daemon=True)
            self._thread.start()
        self.is_acquiring = True
        logger.info(f"Graphite current acquisition started on '{self.metric}'")

    def stop_acquisition(self) -> None:
        self.is_acquiring = False

    def disconnect(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2)
        self.is_acquiring = False

    def reset(self) -> None:
        self.disconnect()
        with self._lock:
            self._primed = False
        self.initialize()

    def is_connected(self) -> bool:
        """Connected means the metric is actually arriving.

        A reachable Graphite that has not seen this metric for a minute is not
        a working current readout, and reporting it as one would let a run start
        against a dead number.
        """
        if not self.metric:
            return False
        with self._lock:
            last = self._last_sample_wall
            stale_after = max(60.0, 10.0 * self.acquisition_interval)
        return bool(last) and (time.time() - last) <= stale_after

    def port_exists(self) -> bool:
        return bool(self.metric)

    def check_thread(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    # ─────────────────────────────────────────────────────────────────── readout

    def get_data(self) -> float:
        with self._lock:
            return float(self._latest)

    def get_data_array(self) -> np.ndarray:
        with self._lock:
            return np.array(self._buffer, dtype=float)

    def get_history(self, since: float = 0.0, max_points: int = 20000) -> list:
        """Timestamped samples, newest last."""
        with self._lock:
            points = [
                [float(timestamp), float(value)]
                for timestamp, value in zip(self._history_times, self._history_values)
                if timestamp >= float(since)
            ]

        if len(points) > max_points:
            indices = np.linspace(0, len(points) - 1, max_points, dtype=int)
            points = [points[int(index)] for index in indices]
        return points

    # ──────────────────────────────────────────────────────────────────── charge

    def get_accumulated_charge(self) -> float:
        with self._lock:
            return self._accumulated_charge

    def reset_accumulated_charge(self) -> None:
        with self._lock:
            self._accumulated_charge = 0.0

    def set_accumulating(self, accumulating: bool) -> None:
        with self._lock:
            self._accumulating = bool(accumulating)

    def is_accumulating(self) -> bool:
        with self._lock:
            return self._accumulating

    def get_total_accumulated_charge(self) -> float:
        with self._lock:
            return self._total_accumulated

    def set_total_accumulated_charge(self, value: float) -> None:
        with self._lock:
            self._total_accumulated = float(value)

    def get_charge_channel(self) -> int:
        return self._charge_channel

    def set_charge_channel(self, channel: int) -> None:
        # One metric, one channel; accepted so the routes need no special case.
        self._charge_channel = 0

    # ────────────────────────────────────────────────────────────── data logging

    def set_save_data(self, enable_save: bool, save_folder: str = '') -> None:
        """Start or stop writing current.txt, in the single-channel layout."""
        with self._lock:
            if enable_save and save_folder:
                try:
                    os.makedirs(save_folder, exist_ok=True)
                    with open(os.path.join(save_folder, 'current.txt'), 'w') as f:
                        f.write(f'### Start time: '
                                f'{datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")} ###\n')
                        f.write('# Time(s)\tCurrent(uA)\n')
                    self.run_start_time = time.time()
                    self.save_folder = save_folder
                    self.save_data = True
                    logger.info(f"Graphite current logging to {save_folder}current.txt")
                except OSError as e:
                    logger.error(f"Could not start the current log: {e}")
                    self.save_data = False
            else:
                self.save_data = False
                self.save_folder = ""
                self.run_start_time = None

    # ─────────────────────────────────────────────── settings (accepted, inert)
    # There is no device to program. The routes push hardware settings through
    # these; remember nothing and report nothing rather than failing.

    def set_setting(self, setting: str, value: Any) -> None:
        pass

    def get_setting(self, setting: str) -> Any:
        return 0

    def write_settings(self) -> None:
        pass

    def _send_command(self, *args, **kwargs) -> str:
        return "ACK"

    def __getattr__(self, name: str):
        """Accept the remaining hardware setters (set_ip, set_range, …) as no-ops.

        Only reached for attributes not defined above, so it cannot mask a real
        method; it keeps this module from breaking when a route configures the
        device it thinks it has.
        """
        if name.startswith("set_") or name.startswith("get_"):
            def _noop(*args, **kwargs):
                logger.debug(f"Graphite current module: ignoring {name}{args}")
                return 0
            return _noop
        raise AttributeError(name)
