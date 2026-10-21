"""
A simulated SIS3316 for running without hardware (WebDAQ's TEST_FLAG mode).

It implements the part of the Sis3316 interface that the DAQ uses and produces
records in the real memory format, so decoding, spectra and file writing run
the same code paths as with a board. Every enabled channel sees a pulser-like
signal: a fixed amplitude per channel with a little noise, at ~100 Hz.
"""

import time
from typing import Any, Dict, List

import numpy as np

from . import registers as R
from .settings import apply_defaults, channel_settings


class MockSis3316:
    def __init__(self, host: str = "mock", *args, **kwargs):
        self.host = host
        self.info: Dict[str, Any] = {}
        self.settings: Dict[str, Any] = {}
        self.sample_clock_mhz = 250.0
        self.bank2_armed = False
        self._armed = False
        self._t0 = time.monotonic()
        self._bank_start = time.monotonic()
        self._prev_bank: Dict[int, np.ndarray] = {}
        self._hist = np.zeros((R.N_CHANNELS, R.HISTOGRAM_BINS), np.uint32)
        self._stats = np.zeros((R.N_CHANNELS, 6), np.uint64)
        self._rng = np.random.default_rng(1234)
        self.link = type("Link", (), {"timeouts": 0, "bytes_read": 0, "packet_id_mode": False,
                                      "is_open": True})()

    def open(self) -> Dict[str, Any]:
        self.info = {
            "model": "SIS3316", "module_id": "0x3316", "vme_fpga_firmware": "0x2004",
            "udp_protocol": "mock", "hardware_version": 2, "serial": 0,
            "mac": "00:00:56:31:60:00", "adc_fpga_firmware": ["0x02500004"] * 4,
            "adc_type": "250MHz-14bit", "adc_bits": 14, "channels": 16,
            "temperature_c": 40.0, "mock": True,
        }
        return self.info

    def close(self) -> None:
        self._armed = False

    def temperature(self) -> float:
        return 40.0

    def initialize(self, settings: Dict[str, Any]) -> None:
        self.configure(settings)

    def configure(self, settings: Dict[str, Any]) -> None:
        self.settings = apply_defaults(settings)
        self.sample_clock_mhz = float(self.settings["board"]["sample_clock_mhz"])

    def clear_energy_histograms(self, channels) -> None:
        for ch in channels:
            self._hist[ch] = 0

    def clear_timestamp(self) -> None:
        self._t0 = time.monotonic()
        self._stats[:] = 0

    def arm(self, bank2: bool = False) -> None:
        self.bank2_armed = bank2
        self._armed = True
        self._bank_start = time.monotonic()

    def disarm(self) -> None:
        self._armed = False

    def acquisition_status(self) -> int:
        return (1 << 16) if self._armed else 0

    def swap(self) -> bool:
        read_bank2 = self.bank2_armed
        self._prev_bank = self._generate(time.monotonic() - self._bank_start)
        self.arm(not self.bank2_armed)
        return read_bank2

    def previous_bank_addresses(self, bank2: bool, timeout_s: float = 0.2) -> List[int]:
        return [int(self._prev_bank.get(ch, np.zeros(0)).size) for ch in range(R.N_CHANNELS)]

    def read_bank(self, channel: int, bank2: bool, nwords: int) -> np.ndarray:
        return self._prev_bank.get(channel, np.zeros(0, np.uint32))[:nwords]

    def energy_histogram(self, channel: int, nbins: int = R.HISTOGRAM_BINS) -> np.ndarray:
        return self._hist[channel, :max(2, min(R.HISTOGRAM_BINS, int(nbins)))].copy()

    def statistic_counters(self) -> np.ndarray:
        return self._stats.copy()

    def adc_status(self) -> List[int]:
        return [0x130118] * 4

    # ── synthetic data ─────────────────────────────────────────────────────
    def _generate(self, seconds: float) -> Dict[int, np.ndarray]:
        out: Dict[int, np.ndarray] = {}
        b = self.settings.get("board", {})
        raw = int(b.get("raw_samples", 0)) & 0xFFFE
        pre = int(b.get("pre_trigger_delay", 100))
        clock_hz = self.sample_clock_mhz * 1e6
        now_ts = int((time.monotonic() - self._t0) * clock_hz)
        for ch in range(R.N_CHANNELS):
            cs = channel_settings(self.settings, ch)
            if not cs["enabled"]:
                continue
            n = int(self._rng.poisson(100.0 * seconds))
            if n == 0:
                continue
            amp = 300.0 + 50.0 * ch
            p = int(cs["energy_peaking"])
            energies = (amp + self._rng.normal(0, 1.5, n)) * p
            ts = np.sort(now_ts - self._rng.integers(0, max(1, int(seconds * clock_hz)), n))
            hdr = 2 + 2
            rec = np.zeros((n, hdr + 1 + raw // 2), np.uint32)
            rec[:, 0] = ((ts >> 32).astype(np.uint32) << 16) | (ch << 4) | 0x8
            rec[:, 1] = (ts & 0xFFFFFFFF).astype(np.uint32)
            rec[:, 2] = 0
            rec[:, 3] = energies.astype(np.int64).astype(np.uint32)
            rec[:, 4] = 0xE0000000 | (raw // 2)
            if raw:
                t = np.arange(raw)
                pulse = np.where(t >= pre, amp * np.exp(-(t - pre) / 30000.0), 0.0)
                wave = (8192 + pulse + self._rng.normal(0, 2, (n, raw))).clip(0, 16383).astype(np.uint16)
                rec[:, 5:] = wave.view(np.uint32).reshape(n, raw // 2)
            out[ch] = rec.ravel()
            div = max(1, int(cs["histogram_divider"]))
            if b.get("onboard_histograms", True):
                idx = np.clip(energies.astype(np.int64) // div, 0, R.HISTOGRAM_BINS - 1)
                np.add.at(self._hist[ch], idx, 1)
            self._stats[ch, 0] += n
            self._stats[ch, 1] += n
        return out
