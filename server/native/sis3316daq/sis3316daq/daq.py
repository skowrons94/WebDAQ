"""
Acquisition engine for one or more SIS3316 boards, the Python counterpart of
caendaq.DAQ.

Per board a reader thread runs the double-bank readout:

    arm bank 1 -> wait (readout interval, or earlier when a channel reaches
    the bank address threshold) -> swap to the other bank -> read every
    enabled channel's previous bank -> decode -> spectra + HDF5 -> repeat

A stats thread turns event counts into rates every stats interval and pushes
them to Graphite with the same metric names caendaq uses:

    <prefix>.bo_<board id>.writeRate
    <prefix>.bo_<board id>.ch_<ch>.{totalRate,pileRate,lostRate,satuRate}

A board that stops answering is marked failed (board_failures counts the
episodes) and the reader keeps trying to re-initialise it.
"""

import logging
import socket
import threading
import time
from typing import Any, Dict, List, Optional

import numpy as np

from . import registers as R
from .board import ACQ_ADDRESS_THRESHOLD, Sis3316
from .events import decode_bank
from .mock import MockSis3316
from .settings import apply_defaults, channel_settings, validate
from .transport import Sis3316Error
from .writer import Hdf5RunWriter

logger = logging.getLogger(__name__)

_FAILED_AFTER = 5            # consecutive failed cycles before a board counts as failed
_RETRY_INTERVAL_S = 2.0      # re-initialisation attempts of a failed board


class _Board:
    def __init__(self, name: str, board_id: int, host: str, settings: Dict[str, Any],
                 port: int, local_ip: str, mock: bool):
        self.name = name
        self.board_id = int(board_id)
        self.host = host
        self.settings = validate(settings)
        self.mock = mock
        self.dev = MockSis3316(host) if mock else Sis3316(host, port, local_ip=local_ip)
        self.info: Dict[str, Any] = {}
        self.lock = threading.RLock()
        self.thread: Optional[threading.Thread] = None
        self.pending_settings: Optional[Dict[str, Any]] = None
        self.reset_spectra()
        self.events = np.zeros(R.N_CHANNELS, np.int64)       # cumulative per channel
        self.pileups = np.zeros(R.N_CHANNELS, np.int64)
        self.deadtime = np.zeros(R.N_CHANNELS, np.int64)
        self.last_stat = None
        # Statistic counters at the run start: V3316-2004 does not clear them
        # with the Timestamp-Clear, so counts are reported relative to this.
        self.stat_baseline = None
        # diagnostics, the shape WebDAQ's board_diagnostics() expects
        self.buffers_read = 0
        self.bytes_read = 0
        self.comm_errors = 0
        self.events_decoded = 0
        self.board_failures = 0
        self.failed = False
        self.consecutive_errors = 0
        self.last_error = ""

    def reset_spectra(self) -> None:
        bins = int(self.settings["board"]["spectrum_bins"])
        self.spectra = np.zeros((R.N_CHANNELS, bins), np.uint32)
        self.waveforms: List[Optional[np.ndarray]] = [None] * R.N_CHANNELS
        self.maws: List[Optional[np.ndarray]] = [None] * R.N_CHANNELS

    def enabled_channels(self) -> List[int]:
        return [ch for ch in range(R.N_CHANNELS)
                if channel_settings(self.settings, ch)["enabled"]]


class DAQ:
    def __init__(self, out_dir: str = ".", run: int = 0, write: bool = True,
                 max_file_bytes: int = 0, stats_interval_ms: int = 1000,
                 graphite_host: str = "", graphite_port: int = 2003,
                 graphite_prefix: str = "ancillary.rates", software: str = ""):
        self.out_dir = out_dir
        self.run = int(run)
        self.write = bool(write)
        self.max_file_bytes = int(max_file_bytes or 0)
        self.stats_interval_ms = max(100, int(stats_interval_ms))
        self.graphite = (graphite_host, int(graphite_port), graphite_prefix)
        self.software = software
        self.boards: List[_Board] = []
        self.writer: Optional[Hdf5RunWriter] = None
        self._running = threading.Event()
        self._stats_thread: Optional[threading.Thread] = None
        self._rates: List[Dict[str, Any]] = []
        self._rates_lock = threading.Lock()
        self._last_bytes_written = 0

    # ── setup ──────────────────────────────────────────────────────────────
    def add_board(self, name: str, board_id: int, host: str, settings: Dict[str, Any],
                  port: int = 0xE000, local_ip: str = "", mock: bool = False) -> int:
        if self._running.is_set():
            raise RuntimeError("cannot add a board while running")
        self.boards.append(_Board(name, board_id, host, settings, port, local_ip, mock))
        return len(self.boards) - 1

    def connect(self, idx: int) -> Dict[str, Any]:
        """Open (if needed) and identify a board; usable while stopped."""
        b = self.boards[idx]
        with b.lock:
            if not b.info:
                b.info = b.dev.open()
            return dict(b.info)

    def set_graphite(self, host: str, port: int, prefix: str) -> None:
        self.graphite = (host, int(port), prefix)

    # ── run control ────────────────────────────────────────────────────────
    def start(self) -> bool:
        if self._running.is_set():
            return True
        if self.write:
            self.writer = Hdf5RunWriter(self.out_dir, self.run, self.max_file_bytes,
                                        software=self.software)
        for b in self.boards:
            self._start_board(b)
            if self.writer is not None:
                self.writer.add_board(
                    b.board_id, b.name, b.info, b.settings, b.dev.sample_clock_mhz,
                    b.settings["board"]["raw_samples"],
                    b.settings["board"]["maw_test_buffer_length"])
        self._running.set()
        for b in self.boards:
            b.thread = threading.Thread(target=self._reader, args=(b,), daemon=True,
                                        name=f"SIS3316-{b.board_id}")
            b.thread.start()
        self._stats_thread = threading.Thread(target=self._stats_loop, daemon=True,
                                              name="SIS3316-stats")
        self._stats_thread.start()
        return True

    def _start_board(self, b: _Board) -> None:
        with b.lock:
            if not b.info:
                b.info = b.dev.open()
            b.dev.initialize(b.settings)
            if b.settings["board"]["onboard_histograms"]:
                b.dev.clear_energy_histograms(b.enabled_channels())
            b.reset_spectra()
            b.events[:] = 0
            b.pileups[:] = 0
            b.deadtime[:] = 0
            b.last_stat = None
            b.dev.clear_timestamp()
            b.stat_baseline = b.dev.statistic_counters()
            b.dev.arm(bank2=False)
            b.failed = False
            b.consecutive_errors = 0

    def stop(self) -> bool:
        if not self._running.is_set():
            return True
        self._running.clear()
        for b in self.boards:
            if b.thread is not None:
                b.thread.join(timeout=10)
                b.thread = None
        if self._stats_thread is not None:
            self._stats_thread.join(timeout=5)
            self._stats_thread = None
        if self.writer is not None:
            self.writer.close()
        return True

    def is_running(self) -> bool:
        return self._running.is_set()

    def close(self) -> None:
        self.stop()
        for b in self.boards:
            with b.lock:
                try:
                    b.dev.close()
                except Exception:
                    pass
                b.info = {}

    # ── readout ────────────────────────────────────────────────────────────
    def _reader(self, b: _Board) -> None:
        next_swap = time.monotonic()
        while True:
            running = self._running.is_set()
            try:
                if b.failed:
                    if not running:
                        break
                    self._recover(b)
                    next_swap = time.monotonic()
                    continue
                interval = b.settings["board"]["readout_interval_ms"] / 1000.0
                # Wait for the interval, swapping early on the address threshold
                while running and time.monotonic() < next_swap + interval:
                    time.sleep(0.02)
                    if self._running.is_set():
                        with b.lock:
                            if b.dev.acquisition_status() & ACQ_ADDRESS_THRESHOLD:
                                break
                    else:
                        running = False
                next_swap = time.monotonic()
                self._cycle(b, final=not running)
                b.consecutive_errors = 0
                if not running:
                    break
            except Sis3316Error as e:
                b.comm_errors += 1
                b.consecutive_errors += 1
                b.last_error = str(e)
                logger.warning(f"SIS3316 {b.board_id}: readout error: {e}")
                if b.consecutive_errors >= _FAILED_AFTER and not b.failed:
                    b.failed = True
                    b.board_failures += 1
                    logger.error(f"SIS3316 {b.board_id}: board failed ({e})")
                if not running:
                    break
                time.sleep(0.1)
        with b.lock:
            try:
                b.dev.disarm()
            except Sis3316Error:
                pass

    def _recover(self, b: _Board) -> None:
        time.sleep(_RETRY_INTERVAL_S)
        if not self._running.is_set():
            return
        with b.lock:
            try:
                try:
                    b.dev.close()
                except Exception:
                    pass
                b.info = b.dev.open()
                b.dev.initialize(b.settings)
                b.dev.arm(bank2=False)
                b.failed = False
                b.consecutive_errors = 0
                logger.info(f"SIS3316 {b.board_id}: recovered")
            except Exception as e:
                b.last_error = str(e)

    def _cycle(self, b: _Board, final: bool = False) -> None:
        with b.lock:
            read_bank2 = b.dev.swap()
            if final:
                b.dev.disarm()
            nwords = b.dev.previous_bank_addresses(read_bank2)
            stat = b.dev.statistic_counters()
            banks = {}
            for ch in b.enabled_channels():
                if nwords[ch]:
                    banks[ch] = b.dev.read_bank(ch, read_bank2, nwords[ch])
                    b.bytes_read += 4 * nwords[ch]
            b.buffers_read += 1
            if b.pending_settings is not None and not final:
                self._apply_pending(b)
        if b.last_stat is not None:
            b.deadtime += ((stat[:, 2].astype(np.int64) - b.last_stat[:, 2].astype(np.int64))
                           % (1 << 32))
        b.last_stat = stat
        maw_len = b.settings["board"]["maw_test_buffer_length"]
        for ch, words in banks.items():
            fields, waves, maws = decode_bank(words, maw_len)
            n = fields["timestamp"].size
            if n == 0:
                continue
            b.events_decoded += n
            b.events[ch] += n
            b.pileups[ch] += int(fields["pileup"].sum())
            cs = channel_settings(b.settings, ch)
            div = max(1, int(cs["histogram_divider"]))
            e = fields["energy_max"]
            idx = e[e >= 0] // div
            idx = idx[idx < b.spectra.shape[1]]
            b.spectra[ch] += np.bincount(idx, minlength=b.spectra.shape[1]).astype(np.uint32)
            if waves is not None:
                b.waveforms[ch] = waves[-1].copy()
            if maws is not None:
                b.maws[ch] = maws[-1].copy()
            if self.writer is not None:
                self.writer.append(b.board_id, ch, fields, waves, maws)
        if self.writer is not None:
            self.writer.flush()

    def _apply_pending(self, b: _Board) -> None:
        """Reconfigure between two banks (lock held). Re-arming restarts the
        bank armed at the swap, so the events of the few milliseconds between
        the swap and the reconfiguration are lost."""
        s = b.pending_settings
        b.pending_settings = None
        old_bins = b.spectra.shape[1]
        b.dev.disarm()
        b.dev.configure(s)
        b.settings = s
        b.dev.arm(bank2=b.dev.bank2_armed)
        if int(s["board"]["spectrum_bins"]) != old_bins:
            b.reset_spectra()

    def update_settings(self, idx: int, settings: Dict[str, Any]) -> Dict[str, Any]:
        """Validate and apply new settings. While running they take effect at
        the next bank swap (raw length and MAW length are fixed for a run,
        since the run file's waveform arrays have a fixed width)."""
        b = self.boards[idx]
        s = validate(settings)
        if self._running.is_set():
            for key in ("raw_samples", "maw_test_buffer_length", "sample_clock_mhz"):
                if s["board"][key] != b.settings["board"][key]:
                    raise ValueError(f"'{key}' cannot change while a run is running")
            with b.lock:
                b.pending_settings = s
        else:
            with b.lock:
                b.settings = s
                b.reset_spectra()
        return s

    # ── statistics ─────────────────────────────────────────────────────────
    def _stats_loop(self) -> None:
        prev = {b.board_id: (b.events.copy(), b.pileups.copy(), b.deadtime.copy()) for b in self.boards}
        prev_t = time.monotonic()
        while self._running.is_set():
            time.sleep(self.stats_interval_ms / 1000.0)
            now = time.monotonic()
            dt = max(1e-3, now - prev_t)
            rates = []
            written = self.writer.bytes_written if self.writer is not None else 0
            write_rate = (written - self._last_bytes_written) / dt
            self._last_bytes_written = written
            for b in self.boards:
                pe, pp, pd = prev[b.board_id]
                ev, pu, dead = b.events.copy(), b.pileups.copy(), b.deadtime.copy()
                chans = []
                for ch in range(R.N_CHANNELS):
                    chans.append({
                        "board": b.board_id, "channel": ch,
                        "event_rate": float(ev[ch] - pe[ch]) / dt,
                        "pileup_rate": float(pu[ch] - pp[ch]) / dt,
                        "lost_rate": float(dead[ch] - pd[ch]) / dt,
                        "satu_rate": 0.0,
                    })
                prev[b.board_id] = (ev, pu, dead)
                rates.append({
                    "name": b.name, "board_id": b.board_id,
                    "write_rate": write_rate / max(1, len(self.boards)),
                    "board_failures": b.board_failures, "failed": b.failed,
                    "channels": chans,
                })
            prev_t = now
            with self._rates_lock:
                self._rates = rates
            self._push_graphite(rates)

    def _push_graphite(self, rates: List[Dict[str, Any]]) -> None:
        host, port, prefix = self.graphite
        if not host:
            return
        epoch = int(time.time())
        lines = []
        for b in rates:
            bo = f"{prefix}.bo_{b['board_id']}"
            lines.append(f"{bo}.writeRate {b['write_rate']:.3f} {epoch}")
            for c in b["channels"]:
                base = f"{bo}.ch_{c['channel']}."
                lines.append(f"{base}totalRate {c['event_rate']:.3f} {epoch}")
                lines.append(f"{base}pileRate {c['pileup_rate']:.3f} {epoch}")
                lines.append(f"{base}lostRate {c['lost_rate']:.3f} {epoch}")
                lines.append(f"{base}satuRate {c['satu_rate']:.3f} {epoch}")
        try:
            with socket.create_connection((host, port), timeout=0.5) as s:
                s.sendall(("\n".join(lines) + "\n").encode())
        except OSError:
            pass                     # best effort, like caendaq's Graphite sink

    def stats(self) -> List[Dict[str, Any]]:
        with self._rates_lock:
            if self._rates:
                return [dict(r) for r in self._rates]
        return [{"name": b.name, "board_id": b.board_id, "write_rate": 0.0,
                 "board_failures": b.board_failures, "failed": b.failed,
                 "channels": [{"board": b.board_id, "channel": ch, "event_rate": 0.0,
                               "pileup_rate": 0.0, "lost_rate": 0.0, "satu_rate": 0.0}
                              for ch in range(R.N_CHANNELS)]} for b in self.boards]

    def diagnostics(self) -> Dict[int, Dict[str, Any]]:
        out = {}
        for b in self.boards:
            out[b.board_id] = {
                "buffers_read": b.buffers_read,
                "bytes_read": b.bytes_read,
                "bytes_written": self.writer.bytes_written if self.writer is not None else 0,
                "blocks_dropped": 0,
                "comm_errors": b.comm_errors,
                "events_decoded": b.events_decoded,
                "board_failures": b.board_failures,
                "failed": b.failed,
                "last_error": b.last_error,
            }
        return out

    # ── live data ──────────────────────────────────────────────────────────
    def energy(self, idx: int, ch: int) -> np.ndarray:
        return self.boards[idx].spectra[ch].copy()

    def waveform(self, idx: int, ch: int) -> np.ndarray:
        w = self.boards[idx].waveforms[ch]
        return np.zeros(0, np.uint16) if w is None else w.copy()

    def maw(self, idx: int, ch: int) -> np.ndarray:
        m = self.boards[idx].maws[ch]
        return np.zeros(0, np.int32) if m is None else m.copy()

    def onboard_histogram(self, idx: int, ch: int, nbins: int = R.HISTOGRAM_BINS) -> np.ndarray:
        b = self.boards[idx]
        with b.lock:
            if not b.info:
                b.info = b.dev.open()
            return b.dev.energy_histogram(ch, nbins).copy()

    def clear_onboard_histograms(self, idx: int, channels=None) -> None:
        """Zero on-board histograms. While running this happens between banks."""
        b = self.boards[idx]
        chans = list(range(R.N_CHANNELS)) if channels is None else list(channels)
        with b.lock:
            if not b.info:
                b.info = b.dev.open()
            running = self._running.is_set()
            if running:
                b.dev.disarm()
            b.dev.clear_energy_histograms(chans)
            if running:
                b.dev.arm(bank2=b.dev.bank2_armed)

    def statistic_counters(self, idx: int) -> np.ndarray:
        """(16, 6) trigger statistic counts since the last run start."""
        b = self.boards[idx]
        with b.lock:
            if not b.info:
                b.info = b.dev.open()
            now = b.dev.statistic_counters().astype(np.int64)
        if b.stat_baseline is None:
            return now
        return (now - b.stat_baseline.astype(np.int64)) % (1 << 32)

    def board_info(self, idx: int) -> Dict[str, Any]:
        b = self.boards[idx]
        info = dict(b.info)
        try:
            with b.lock:
                if info:
                    info["temperature_c"] = b.dev.temperature()
        except Sis3316Error:
            pass
        info.update({"name": b.name, "board_id": b.board_id, "host": b.host,
                     "sample_clock_mhz": b.dev.sample_clock_mhz, "failed": b.failed})
        return info
