"""
Struck SIS3316 acquisition manager.

The SIS3316 counterpart of :mod:`app.services.caen_acquisition`: it owns one
``sis3316daq.DAQ`` (server/native/sis3316daq, pure Python over UDP) for every
board whose dict carries ``"vendor": "sis3316"``. CaenAcquisition hands those
boards here, so every caller keeps talking to get_caen_acquisition() only.

Unlike caendaq, the DAQ object outlives the run. An SIS3316 with VME FPGA
firmware older than V3316-2008 answers only to UDP port 0xE000, so one socket
per PC can talk to it: the same connection serves the run, the settings page
between runs (on-board histograms, temperature, counters) and the board scan.

Board dict: {id, name: "SIS3316", chan: 16, dpp: "SIS3316", vendor: "sis3316",
link_type: "Ethernet", link_num: "<IP address>", vme: "0"}. Its settings live
in conf/<name>_<id>.json in sis3316daq's settings format (not CAEN registers).
"""

import json
import logging
import os
import threading
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from ..utils.board_files import BOARD_FILE_LOCK, write_json_atomic

logger = logging.getLogger(__name__)

VENDOR = "sis3316"
DEFAULT_HOST = "192.168.1.100"


def is_sis3316(board: Optional[Dict[str, Any]]) -> bool:
    return bool(board) and str(board.get("vendor", "")).lower() == VENDOR


def settings_path(board: Dict[str, Any]) -> str:
    return f"conf/{board.get('name', 'SIS3316')}_{board.get('id')}.json"


def board_host(board: Dict[str, Any]) -> str:
    return str(board.get("link_num") or DEFAULT_HOST).strip()


class Sis3316Acquisition:
    def __init__(self, test_flag: bool = False):
        self.test_flag = bool(test_flag)
        self._lock = threading.RLock()
        self._daq = None
        self._boards: List[Dict[str, Any]] = []     # in DAQ order (== local index)
        self._key: Tuple = ()
        self._running = False
        self._import_error = ""
        try:
            import sis3316daq
            self._mod = sis3316daq
        except Exception as e:
            self._mod = None
            self._import_error = f"{type(e).__name__}: {e}"
            logger.error(f"sis3316daq could not be imported ({self._import_error}); "
                         "install it with: pip install -e server/native/sis3316daq")

    # ── settings files ─────────────────────────────────────────────────────
    def load_settings(self, board: Dict[str, Any]) -> Dict[str, Any]:
        path = settings_path(board)
        try:
            with open(path) as f:
                data = json.load(f)
        except (OSError, ValueError):
            data = {}
        if self._mod is None:
            return data
        return self._mod.apply_defaults(data)

    def save_settings(self, board: Dict[str, Any], settings: Dict[str, Any]) -> Dict[str, Any]:
        """Validate (raises ValueError) and store a board's settings."""
        if self._mod is None:
            raise RuntimeError(f"sis3316daq is not available: {self._import_error}")
        clean = self._mod.validate(settings)
        os.makedirs("conf", exist_ok=True)
        with BOARD_FILE_LOCK:
            write_json_atomic(settings_path(board), clean)
        return clean

    def ensure_settings_file(self, board: Dict[str, Any]) -> None:
        if not os.path.exists(settings_path(board)) and self._mod is not None:
            self.save_settings(board, self._mod.default_settings())

    # ── board set ──────────────────────────────────────────────────────────
    def is_available(self) -> bool:
        return self._mod is not None

    def is_running(self) -> bool:
        return self._running

    def _sync(self, boards: List[Dict[str, Any]]) -> None:
        """(Re)build the DAQ when the SIS3316 board set changed. Stopped only."""
        if self._mod is None:
            raise RuntimeError(f"sis3316daq is not available: {self._import_error}")
        boards = sorted([b for b in boards if is_sis3316(b)], key=lambda b: int(b["id"]))
        key = tuple((int(b["id"]), board_host(b), str(b.get("name"))) for b in boards)
        if key == self._key and self._daq is not None:
            self._boards = boards
            return
        if self._running:
            raise RuntimeError("the SIS3316 board set cannot change while a run is running")
        if self._daq is not None:
            self._daq.close()
        daq = self._mod.DAQ(out_dir="data", run=0, write=False)
        for b in boards:
            daq.add_board(str(b.get("name", "SIS3316")), int(b["id"]), board_host(b),
                          self.load_settings(b), mock=self.test_flag)
        self._daq = daq
        self._boards = boards
        self._key = key

    def local_index(self, board_id: Any) -> Optional[int]:
        for i, b in enumerate(self._boards):
            if str(b["id"]) == str(board_id):
                return i
        return None

    def forget(self, board_id: Any) -> None:
        """Drop a removed board (closes its socket when it was the last one)."""
        with self._lock:
            if self._running:
                return
            rest = [b for b in self._boards if str(b["id"]) != str(board_id)]
            if len(rest) != len(self._boards):
                self._key = ()
                if rest:
                    self._sync(rest)
                elif self._daq is not None:
                    self._daq.close()
                    self._daq = None
                    self._boards = []

    def _index_for(self, board: Dict[str, Any], boards: Optional[List[Dict[str, Any]]]) -> int:
        with self._lock:
            if not self._running:
                self._sync((boards or []) + ([] if any(str(b["id"]) == str(board["id"])
                                                       for b in (boards or [])) else [board]))
            idx = self.local_index(board["id"])
            if idx is None:
                raise RuntimeError(f"SIS3316 {board['id']} is not part of the running acquisition")
            return idx

    # ── idle / any-time access ─────────────────────────────────────────────
    def identify(self, board: Dict[str, Any], boards: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
        """Open the board if needed and return its identity and temperature."""
        idx = self._index_for(board, boards)
        self._daq.connect(idx)
        return self._daq.board_info(idx)

    def onboard_histogram(self, board, channel: int, nbins: int, boards=None):
        idx = self._index_for(board, boards)
        return self._daq.onboard_histogram(idx, int(channel), int(nbins))

    def clear_onboard_histograms(self, board, channels=None, boards=None) -> None:
        idx = self._index_for(board, boards)
        self._daq.clear_onboard_histograms(idx, channels)

    def statistic_counters(self, board, boards=None):
        idx = self._index_for(board, boards)
        return self._daq.statistic_counters(idx)

    def apply_settings(self, board: Dict[str, Any], settings: Dict[str, Any],
                       boards=None) -> Dict[str, Any]:
        """Validate, save and hand new settings to the DAQ. While running they
        take effect at the next bank swap; settings that would change the run
        file's layout raise ValueError instead."""
        if self._mod is None:
            raise RuntimeError(f"sis3316daq is not available: {self._import_error}")
        clean = self._mod.validate(settings)
        with self._lock:
            idx = self._index_for(board, boards)
            self._daq.update_settings(idx, clean)
        self.save_settings(board, clean)
        if self._running:
            self._log_settings_change(board, clean)
        return clean

    SETTINGS_HISTORY_FILE = "settings_history.jsonl"

    def _log_settings_change(self, board: Dict[str, Any], settings: Dict[str, Any]) -> None:
        """Settings changed during a saved run go into its directory, with
        their time: the copy taken at the start no longer describes all of
        the data (register_history.jsonl does the same for CAEN boards)."""
        out_dir, write = getattr(self._daq, "out_dir", ""), getattr(self._daq, "write", False)
        if not write or not out_dir or not os.path.isdir(out_dir):
            return
        entry = {"time": datetime.now().isoformat(timespec="seconds"),
                 "board": str(board.get("id")), "board_name": str(board.get("name")),
                 "settings": settings}
        try:
            with open(os.path.join(out_dir, self.SETTINGS_HISTORY_FILE), "a") as f:
                f.write(json.dumps(entry) + "\n")
        except OSError as e:
            logger.warning(f"Could not log the SIS3316 settings change in {out_dir}: {e}")

    # ── run control (called by CaenAcquisition) ────────────────────────────
    def configure(self, boards: List[Dict[str, Any]], run: int, out_dir: str,
                  max_file_bytes: int = 0, write: bool = True,
                  graphite: Tuple[str, int, str] = ("", 2003, ""),
                  stats_interval_ms: int = 1000, software: str = "") -> bool:
        try:
            with self._lock:
                self._sync(boards)
                d = self._daq
                d.out_dir = out_dir
                d.run = int(run)
                d.write = bool(write)
                d.max_file_bytes = int(max_file_bytes or 0)
                d.stats_interval_ms = max(100, int(stats_interval_ms))
                d.software = software
                d.set_graphite(*graphite)
                for i, b in enumerate(self._boards):
                    d.update_settings(i, self.load_settings(b))
            return True
        except Exception as e:
            logger.error(f"SIS3316 configure failed: {e}")
            return False

    def start(self) -> bool:
        try:
            with self._lock:
                self._daq.start()
                self._running = True
            return True
        except Exception as e:
            logger.error(f"SIS3316 start failed: {e}")
            try:
                self._daq.stop()
            except Exception:
                pass
            return False

    def stop(self) -> bool:
        with self._lock:
            self._running = False
            if self._daq is not None:
                try:
                    self._daq.stop()
                except Exception as e:
                    logger.error(f"SIS3316 stop failed: {e}")
                    return False
        return True

    def set_graphite(self, host: str, port: int, prefix: str) -> None:
        if self._daq is not None:
            self._daq.set_graphite(host, port, prefix)

    def set_stats_interval(self, interval_ms: int) -> None:
        if self._daq is not None:
            self._daq.stats_interval_ms = max(100, int(interval_ms))

    # ── monitoring ─────────────────────────────────────────────────────────
    def stats(self) -> List[Dict[str, Any]]:
        if self._daq is None or not self._running:
            return []
        return self._daq.stats()

    def diagnostics(self) -> Dict[str, Dict[str, Any]]:
        if self._daq is None or not self._running:
            return {}
        return {str(k): v for k, v in self._daq.diagnostics().items()}

    def health(self) -> Dict[str, Dict[str, Any]]:
        return {bid: {"failed": bool(d["failed"]), "failures": int(d["board_failures"])}
                for bid, d in self.diagnostics().items()}

    def board_info(self, board_id: Any) -> Optional[Dict[str, Any]]:
        idx = self.local_index(board_id)
        if idx is None or self._daq is None:
            return None
        try:
            info = self._daq.board_info(idx)
        except Exception as e:
            logger.debug(f"SIS3316 board_info({board_id}) failed: {e}")
            return None
        info["vendor"] = VENDOR
        info["board_id"] = str(board_id)
        info["settings"] = self._daq.boards[idx].settings
        return info

    def software_version(self) -> Optional[str]:
        return getattr(self._mod, "__version__", None) if self._mod is not None else None

    # Live arrays for the spy, by local index
    def array(self, idx: int, kind: str, channel: int, wave_kind: str = "any"):
        if self._daq is None:
            return None
        if kind == "energy":
            return self._daq.energy(idx, channel)
        if kind == "waveform":
            return self._daq.waveform(idx, channel, wave_kind)
        if kind == "maw":
            return self._daq.maw(idx, channel)
        if kind == "interval" and hasattr(self._daq, "interval"):
            return self._daq.interval(idx, channel)
        return None


_instance: Optional[Sis3316Acquisition] = None
_instance_lock = threading.Lock()


def get_sis3316_acquisition(test_flag: bool = False) -> Sis3316Acquisition:
    global _instance
    with _instance_lock:
        if _instance is None:
            _instance = Sis3316Acquisition(test_flag=test_flag)
        return _instance
