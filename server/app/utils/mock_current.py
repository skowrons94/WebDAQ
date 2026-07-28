"""
Simulated beam-current module for test mode.

Stands in for the TetrAMM or the RBD 9103 when ``TEST_FLAG`` is set, so the
current readout, the accumulated charge and the per-run ``current.txt`` all work
without a picoammeter attached — which is what the dashboard's current plot and
the Data dashboard's charge integration need in order to be exercised at all.

It presents the same interface the routes call on the real controllers and
writes exactly the same log format, so nothing downstream can tell the
difference. The signal is deliberately beam-like rather than random: a slow
decay with ripple, drift and the occasional dip, so plots and integrals look
like something an operator would recognise.
"""

import logging
import math
import os
import random
import threading
import time
from datetime import datetime
from typing import Any, Dict, Optional, Union

import numpy as np

logger = logging.getLogger(__name__)

BUFFER_SAMPLES = 100      # what get_data_array() returns, as the real modules do
SAMPLE_INTERVAL_S = 0.1   # 10 Hz, comparable to the hardware's logging rate


class MockCurrentController:
    """A synthetic picoammeter.

    ``single_channel`` selects the RBD 9103 shape (one current, scalars) rather
    than the TetrAMM's four channels (dicts keyed by channel number as strings).
    """

    def __init__(self, channels: int = 4, single_channel: bool = False,
                 base_current_uA: float = 12.0):
        self.channels = 1 if single_channel else channels
        self.single_channel = single_channel
        self.base_current = base_current_uA

        self.is_acquiring = False
        self._connected = False
        self._charge_channel = 0

        self._accumulated_charge = 0.0     # µC, since the last reset (this run)
        self._total_accumulated = 0.0      # µC, lifetime
        self._accumulating = False         # True while a run is in progress

        self._buffers = [[0.0] * BUFFER_SAMPLES for _ in range(self.channels)]
        self._latest = [0.0] * self.channels

        self.save_data = False
        self.save_folder = ""
        self.run_start_time: Optional[float] = None

        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._t0 = time.time()
        self._settings: Dict[str, Any] = {}

        logger.info(
            f"Simulated current module active "
            f"({'RBD 9103, 1 channel' if single_channel else f'TetrAMM, {self.channels} channels'})")

    # ─────────────────────────────────────────────────────── signal generation

    def _sample(self, t: float) -> list:
        """One reading per channel at time t, in µA."""
        # Slow exponential decay of the source, a little drift, mains-ish ripple.
        decay = math.exp(-t / 900.0)
        drift = 1.0 + 0.03 * math.sin(t / 120.0)
        ripple = 0.25 * math.sin(t * 2.0) + 0.10 * math.sin(t * 7.3)
        noise = random.gauss(0.0, 0.05)

        beam = self.base_current * decay * drift + ripple + noise
        # Occasional short dips, as when the beam trips.
        if int(t / 37.0) % 11 == 10 and (t % 37.0) < 2.0:
            beam *= 0.15
        beam = max(beam, 0.0)

        if self.single_channel:
            return [beam]

        # Channel 0 is the beam; 1 and 2 are collimator-like fractions; 3 idles.
        return [
            beam,
            beam * 0.10 + random.gauss(0.0, 0.01),
            beam * 0.02 + random.gauss(0.0, 0.005),
            max(random.gauss(0.001, 0.0005), 0.0),
        ][:self.channels]

    def _loop(self) -> None:
        """Produce samples, accumulate charge and log to file, like the real thing."""
        next_tick = time.time()
        last_time = time.time()

        while not self._stop.is_set():
            now = time.time()
            elapsed = now - self._t0
            values = self._sample(elapsed)
            dt = now - last_time
            last_time = now

            with self._lock:
                self._latest = values
                for c in range(self.channels):
                    self._buffers[c].append(values[c])
                    if len(self._buffers[c]) > BUFFER_SAMPLES:
                        self._buffers[c].pop(0)

                # µA × s = µC, on the channel selected for charge. The lifetime
                # total always integrates; the run figure only during a run,
                # exactly as the real controllers do.
                channel = min(self._charge_channel, self.channels - 1)
                delta = values[channel] * dt
                self._total_accumulated += delta
                if self._accumulating:
                    self._accumulated_charge += delta

                should_save = self.save_data and self.run_start_time is not None
                folder, start = self.save_folder, self.run_start_time

            if should_save:
                self._append_sample(folder, now - start, values)

            next_tick += SAMPLE_INTERVAL_S
            self._stop.wait(max(0.0, next_tick - time.time()))

    def _append_sample(self, folder: str, relative_time: float, values: list) -> None:
        """Append one row in the same format the real controllers write."""
        try:
            with open(os.path.join(folder, 'current.txt'), 'a') as f:
                f.write(f'{relative_time:.8e}\t')
                for value in values:
                    f.write(f'{value:.3e}\t')
                f.write('\n')
        except OSError as e:
            logger.error(f"Could not write the simulated current log: {e}")

    # ───────────────────────────────────────────────────────────── lifecycle

    def initialize(self) -> None:
        self._connected = True
        self._t0 = time.time()
        if self._thread is None or not self._thread.is_alive():
            self._stop.clear()
            self._thread = threading.Thread(target=self._loop, name="mock-current", daemon=True)
            self._thread.start()
        self.is_acquiring = True
        logger.info("Simulated current acquisition started")

    def stop_acquisition(self) -> None:
        self.is_acquiring = False

    def disconnect(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2)
        self.is_acquiring = False
        self._connected = False

    def reset(self) -> None:
        self.disconnect()
        self.initialize()

    def is_connected(self) -> bool:
        return self._connected

    def port_exists(self) -> bool:
        return True

    def check_thread(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    # ──────────────────────────────────────────────────────────────── readout

    def get_data(self) -> Union[float, Dict[str, float]]:
        """Latest reading: a scalar for the RBD shape, a per-channel dict otherwise."""
        with self._lock:
            if self.single_channel:
                return self._latest[0]
            return {str(c): self._latest[c] for c in range(self.channels)}

    def get_data_array(self) -> Union[np.ndarray, Dict[str, np.ndarray]]:
        """The recent sample buffer, in the same shape as the real controllers."""
        with self._lock:
            if self.single_channel:
                return np.array(self._buffers[0])
            return {str(c): np.array(self._buffers[c]) for c in range(self.channels)}

    # ───────────────────────────────────────────────────────────────── charge

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
        self._charge_channel = int(channel)

    # ───────────────────────────────────────────────────────────── data logging

    def set_save_data(self, enable_save: bool, save_folder: str = '') -> None:
        """Start or stop writing current.txt, headers matching the real modules."""
        with self._lock:
            if enable_save and save_folder:
                try:
                    os.makedirs(save_folder, exist_ok=True)
                    with open(os.path.join(save_folder, 'current.txt'), 'w') as f:
                        f.write(f'### Start time: '
                                f'{datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")} ###\n')
                        if self.single_channel:
                            f.write('# Time(s)\tCurrent(uA)\n')
                        else:
                            header = '\t'.join(f'Ch{c}(uA)' for c in range(self.channels))
                            f.write(f'# Time(s)\t{header}\n')
                    self.run_start_time = time.time()
                    self.save_folder = save_folder
                    self.save_data = True
                    logger.info(f"Simulated current logging to {save_folder}current.txt")
                except OSError as e:
                    logger.error(f"Could not start the simulated current log: {e}")
                    self.save_data = False
            else:
                self.save_data = False
                self.save_folder = ""
                self.run_start_time = None

    # ──────────────────────────────────────────────── settings (accepted, inert)
    # The routes push hardware settings through these; there is no device to
    # program, so remember them and report them back unchanged.

    def set_setting(self, setting: str, value: Any) -> None:
        self._settings[str(setting)] = value

    def get_setting(self, setting: str) -> Any:
        return self._settings.get(str(setting), 0)

    def write_settings(self) -> None:
        pass

    def _send_command(self, *args, **kwargs) -> str:
        return "ACK"

    def __getattr__(self, name: str):
        """Accept the remaining hardware setters (set_range, set_bias, …) as no-ops.

        Only reached for attributes not defined above, so it cannot mask a real
        method; it keeps the mock from breaking when a route configures the
        device it thinks it has.
        """
        if name.startswith("set_") or name.startswith("get_"):
            def _noop(*args, **kwargs):
                logger.debug(f"Simulated current module: ignoring {name}{args}")
                return 0
            return _noop
        raise AttributeError(name)
