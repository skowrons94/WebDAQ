"""
CAEN acquisition manager.

Owns a single in-process ``caendaq.DAQ`` instance (the pybind11 module built from
the CaenDAQ repo) that reads the boards, writes ``.caendat`` files and decodes
events into online spectra — the in-process CAEN acquisition backend.

Board configs come from the daq_manager state (the same list the UI edits): each
board dict carries ``id``, ``name``, ``chan``, ``dpp``, ``link_type``,
``link_num`` and ``vme``. The per-board register configuration is the existing
``conf/<name>_<id>.json`` dump, which CaenDigitizer applies directly.
"""

import json
import os
import logging
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# CAEN connection-type codes understood by caendaq/CaenDigitizer.
_CONN_TYPE = {"USB": 0, "Optical": 1, "A4818": 5}

_STATS_FILE = "conf/stats.json"
_DEFAULT_CARBON_PORT = 2003   # Graphite/Carbon plaintext ingestion port
_DEFAULT_GRAPHITE_PREFIX = "ancillary.rates"


def _graphite_from_stats() -> Tuple[str, int, str]:
    """Read the Graphite target from conf/stats.json.

    Returns (host, carbon_port, prefix). Host '' or 'localhost' with nothing
    listening just means best-effort/no push. The 'graphite_port' there is the
    HTTP render port; Carbon uses 'carbon_port' (default 2003).

    'graphite_prefix' is the root of the metric tree and belongs to the
    EXPERIMENT, not to a board: set it to e.g. 'ancillary.rates.12c12c' and that
    campaign owns the subtree, with boards below it as bo_<VME board id>. Each
    experiment gets its own, so two campaigns never write into one series.
    """
    try:
        with open(_STATS_FILE) as f:
            cfg = json.load(f)
        host = str(cfg.get("graphite_host", "") or "")
        port = int(cfg.get("carbon_port", _DEFAULT_CARBON_PORT))
        prefix = str(cfg.get("graphite_prefix", "") or "") or _DEFAULT_GRAPHITE_PREFIX
        return host, port, prefix
    except Exception:
        return "", _DEFAULT_CARBON_PORT, _DEFAULT_GRAPHITE_PREFIX


def _sampling_from_stats() -> Tuple[int, int]:
    """Read the rate sampling cadence from conf/stats.json.

    Returns (interval_ms, first_interval_ms). One caendaq tick samples,
    differences and pushes, so interval_ms is simultaneously the refresh rate,
    the averaging window and the Graphite resolution. first_interval_ms only
    paces the opening tick, so a long window still shows numbers seconds after
    Start instead of leaving the page blank.
    """
    from .stats_manager import (DEFAULT_STATS_INTERVAL_MS,
                                DEFAULT_STATS_FIRST_INTERVAL_MS,
                                MIN_STATS_INTERVAL_MS, MAX_STATS_INTERVAL_MS)

    def _clamp(value: Any, fallback: int) -> int:
        try:
            return max(MIN_STATS_INTERVAL_MS, min(MAX_STATS_INTERVAL_MS, int(value)))
        except (TypeError, ValueError):
            return fallback

    try:
        with open(_STATS_FILE) as f:
            cfg = json.load(f)
        return (_clamp(cfg.get("stats_interval_ms"), DEFAULT_STATS_INTERVAL_MS),
                _clamp(cfg.get("stats_first_interval_ms"), DEFAULT_STATS_FIRST_INTERVAL_MS))
    except Exception:
        return DEFAULT_STATS_INTERVAL_MS, DEFAULT_STATS_FIRST_INTERVAL_MS


# Keywords that newer caendaq builds accept and older ones do not, newest first.
# WebDAQ and caendaq are updated independently — caendaq is a submodule compiled
# into the env — so a server that knows about a keyword the installed module does
# not must degrade, never fail the run.
_OPTIONAL_DAQ_KWARGS = ("stats_first_interval_ms", "stats_interval_ms", "graphite_prefix")


def _construct_daq(module: Any, out_dir: str, logger: logging.Logger, **kwargs: Any) -> Any:
    """Build caendaq.DAQ, dropping keywords the installed module does not know.

    pybind11 reports an unknown keyword as TypeError, so each rejection retires
    the newest optional keyword and retries. Without this, updating WebDAQ
    without rebuilding caendaq makes configure() fail and no run can start at
    all — a much worse outcome than losing one setting.
    """
    attempt = dict(kwargs)
    while True:
        try:
            return module.DAQ(out_dir, **attempt)
        except TypeError:
            stale = next((k for k in _OPTIONAL_DAQ_KWARGS if k in attempt), None)
            if stale is None:
                raise           # a real signature problem, not version skew
            attempt.pop(stale)
            logger.warning(
                f"Installed caendaq does not accept '{stale}' — ignoring it and "
                "retrying. Rebuild/reinstall the caendaq module to get this "
                "setting (see server/native/README.md).")


def _webdaq_version() -> str:
    """WebDAQ's own version: the git describe of this checkout, or 'unknown'.
    Recorded in run metadata so a dataset can be traced back to the exact code."""
    import subprocess
    repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    try:
        out = subprocess.run(["git", "-C", repo, "describe", "--always", "--dirty", "--tags"],
                             capture_output=True, text=True, timeout=5)
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except Exception:
        pass
    return "unknown"


# Acquisition Control (0x8100) bits[1:0] — Start/Stop Mode Selection.
# UM5678 rev.3 p.43 (DPP-PHA) / UM4380 rev.6 p.43 (DPP-PSD).
START_MODE_SW          = 0   # run starts/stops on software command (bit[2])
START_MODE_SIN_GPI     = 1   # armed; runs while S-IN/GPI is asserted
START_MODE_FIRST_TRIG  = 2   # armed; starts on the first TRG-IN rising edge
START_MODE_LVDS        = 3   # armed; driven by the LVDS RUN signal (VME only)

START_MODE_NAMES = {
    START_MODE_SW:         "SW controlled",
    START_MODE_SIN_GPI:    "S-IN/GPI controlled",
    START_MODE_FIRST_TRIG: "First trigger controlled",
    START_MODE_LVDS:       "LVDS controlled",
}


def _read_register(board: Dict[str, Any], reg_key: str) -> Optional[int]:
    """One register's value from the board's conf/<name>_<id>.json, or None."""
    try:
        fn = f"conf/{board['name']}_{board['id']}.json"
        if not os.path.exists(fn):
            return None
        with open(fn) as f:
            data = json.load(f)
        reg = data.get("registers", {}).get(reg_key)
        if not reg:
            return None
        return int(reg["value"], 16)
    except Exception:
        return None


def acquisition_control_of(board: Dict[str, Any]) -> int:
    """The board's whole Acquisition Control register (0x8100), or 0.

    Carries both halves of multi-board synchronisation: the start mode in
    bits[1:0] and the PLL reference clock source in bit[6]."""
    value = _read_register(board, "reg_8100")
    return 0 if value is None else value


def front_panel_io_of(board: Dict[str, Any]) -> int:
    """Front Panel I/O Control (0x811C), or 0.

    Bits[17:16] decide what TRG-OUT/GPO carries — it must be 'Trigger' (00) for
    a first-trigger chain to propagate at all."""
    value = _read_register(board, "reg_811C")
    return 0 if value is None else value


def trg_out_mask_of(board: Dict[str, Any]) -> int:
    """Front Panel TRG-OUT (GPO) Enable Mask (0x8110), or 0.

    Bit[31] lets the SOFTWARE trigger reach TRG-OUT (needed on the master, which
    starts the chain with SendSWTrigger) and bit[30] lets the EXTERNAL trigger on
    TRG-IN reach it (needed on every board that must forward the start onwards).
    Both default to 1 on the hardware."""
    value = _read_register(board, "reg_8110")
    return 0 if value is None else value


def start_mode_of(board: Dict[str, Any]) -> int:
    """The board's configured Start/Stop Mode (0x8100 bits[1:0]).

    This is the single source of truth for synchronisation: it is what the CAEN
    dashboard edits, what caendaq reads to decide arm-vs-start, and what ends up
    in the run metadata. Defaults to SW controlled when unreadable."""
    return acquisition_control_of(board) & 0x3


def is_synchronised(board: Dict[str, Any]) -> bool:
    """Whether the board waits for an external start (i.e. is part of a chain)."""
    return start_mode_of(board) != START_MODE_SW


def _waveforms_enabled(board: Dict[str, Any]) -> bool:
    """Whether waveform recording is on for a board (bit 16 of register 0x8000 in
    its conf/<name>_<id>.json), matching spy_manager.get_waveform_status_for_board."""
    try:
        fn = f"conf/{board['name']}_{board['id']}.json"
        if not os.path.exists(fn):
            return False
        with open(fn) as f:
            data = json.load(f)
        reg = data.get("registers", {}).get("reg_8000")
        if not reg:
            return False
        return (int(reg["value"], 16) & (1 << 16)) != 0
    except Exception:
        return False


class CaenAcquisition:
    """Thin manager around a single caendaq.DAQ instance."""

    def __init__(self, test_flag: bool = False):
        self.logger = logging.getLogger(__name__ + ".CaenAcquisition")
        self.test_flag = bool(test_flag)
        self.daq = None                       # caendaq.DAQ instance while a run is active
        self._boards: List[Dict[str, Any]] = []  # board dicts, in add order (== board index)
        self._running = False

        self._import_error = ""
        try:
            import caendaq  # the pybind11 module
            self._caendaq = caendaq
            self.logger.info(f"caendaq module loaded from {getattr(caendaq, '__file__', '?')}")
        except Exception as e:  # ImportError, or a failed dlopen of libCAENDigitizer
            import sys
            self._caendaq = None
            self._import_error = f"{type(e).__name__}: {e}"
            self.logger.error(
                f"caendaq module could not be imported ({self._import_error}). "
                f"Python: {sys.executable}. Build/install it into this environment "
                f"(see server/native/README.md) — until then, start a run fails.")

    # ------------------------------------------------------------------ status
    def is_available(self) -> bool:
        return self._caendaq is not None

    def is_running(self) -> bool:
        return self._running

    def get_daq(self):
        return self.daq

    def get_boards(self) -> List[Dict[str, Any]]:
        """Boards in add order — index i here is board index i in caendaq."""
        return self._boards

    # --------------------------------------------------------------- lifecycle
    def configure(self, boards: List[Dict[str, Any]], run: int, out_dir: str,
                  max_file_bytes: int = 0, write: bool = True, write_header: bool = True,
                  decode: bool = True) -> bool:
        """Build a fresh DAQ and register every board. Call before start().

        write=False runs decode-only (no .caendat files) — for tuning / save-off.
        The Graphite target is taken from conf/stats.json (see _graphite_from_stats).
        Mock boards emit waveforms when the board's config has them enabled.

        Synchronisation is NOT set here. It comes from each board's own
        Acquisition Control register (0x8100) in conf/<name>_<id>.json, as
        programmed from the CAEN dashboard: a board whose start mode is not
        "SW controlled" gets armed instead of started, and caendaq fires the
        software trigger on the master once every board is armed.
        """
        if self._caendaq is None:
            self.logger.error(
                "caendaq module not available — cannot configure acquisition. "
                f"Import failed with: {self._import_error or 'unknown'}. "
                "Build + install it into the env running the server "
                "(cmake -DCAENDAQ_BUILD_PYTHON=ON ...; see server/native/README.md).")
            return False
        try:
            graphite_host, graphite_port, graphite_prefix = _graphite_from_stats()
            stats_interval_ms, stats_first_ms = _sampling_from_stats()
            self.daq = _construct_daq(self._caendaq, out_dir, self.logger,
                                      run=int(run),
                                      max_file_bytes=int(max_file_bytes),
                                      write_header=bool(write_header),
                                      graphite_host=graphite_host,
                                      graphite_port=graphite_port,
                                      graphite_prefix=graphite_prefix,
                                      stats_interval_ms=stats_interval_ms,
                                      stats_first_interval_ms=stats_first_ms)
            self._boards = []
            # daq_state keeps boards sorted by id, so add order == board index.
            for board in boards:
                conn = _CONN_TYPE.get(board.get("link_type", "USB"), 0)
                config = f"conf/{board['name']}_{board['id']}.json"
                idx = self.daq.add_board(
                    name=str(board["name"]),
                    conn_type=conn,
                    link=int(board.get("link_num", 0)),
                    node=0,
                    base=int(str(board.get("vme", "0")), 16),
                    config=config,
                    mock=self.test_flag,   # hardware-free source in test mode
                    decode=decode,
                    write=bool(write),
                    mock_waveforms=_waveforms_enabled(board),  # mock mirrors the real board
                    mock_dpp=str(board.get("dpp", "DPP-PSD")),  # mock emulates the board's firmware
                    mock_start_mode=start_mode_of(board),  # mock reproduces the configured chain
                )
                if idx < 0:
                    self.logger.error(f"Failed to add board {board.get('id')} to caendaq")
                    return False
                self._boards.append(board)
            self.logger.info(f"Acquisition configured with {len(self._boards)} board(s), run {run}")
            return True
        except Exception as e:
            self.logger.error(f"Error configuring acquisition: {e}")
            self.daq = None
            return False

    def start(self) -> bool:
        if self.daq is None:
            self.logger.error("start() called before configure()")
            return False
        try:
            if not self.daq.start():
                self.logger.error("caendaq DAQ failed to start")
                return False
            self._running = True
            self.logger.info("Acquisition started")
            return True
        except Exception as e:
            self.logger.error(f"Error starting acquisition: {e}")
            return False

    def stop(self) -> bool:
        self._running = False
        try:
            if self.daq is not None:
                self.daq.stop()
            self.logger.info("Acquisition stopped")
            return True
        except Exception as e:
            self.logger.error(f"Error stopping acquisition: {e}")
            return False

    # ------------------------------------------------------------- monitoring
    def board_index(self, board_id: str) -> Optional[int]:
        """caendaq board index for a WebDAQ board id, or None."""
        for i, b in enumerate(self._boards):
            if str(b["id"]) == str(board_id):
                return i
        return None

    # ---------------------------------------------------------- online tuning
    def write_register(self, board_id: str, address: int, value: int) -> bool:
        """
        Write a register on a board of the *running* acquisition.

        During a run caendaq owns the board handles, so this is the only way to
        reach a register — it serialises the access against the board's reader
        thread. Whether a given register may be moved mid-run is decided by the
        caller (see app.utils.safe_registers).
        """
        if self.daq is None or not self._running:
            return False
        index = self.board_index(board_id)
        if index is None:
            self.logger.error(f"write_register: board {board_id} is not part of this run")
            return False
        try:
            return bool(self.daq.write_register(index, int(address), int(value)))
        except AttributeError:
            # caendaq predates the register API — rebuild it (pip install
            # server/native/caendaq) to tune online.
            self.logger.error("The installed caendaq has no write_register(); rebuild it "
                              "from server/native/caendaq to write registers during a run.")
            return False
        except Exception as e:
            self.logger.error(f"write_register failed for board {board_id}: {e}")
            return False

    def read_register(self, board_id: str, address: int) -> Optional[int]:
        """Read a register back from the running acquisition, or None."""
        if self.daq is None or not self._running:
            return None
        index = self.board_index(board_id)
        if index is None:
            return None
        try:
            return self.daq.read_register(index, int(address))
        except Exception as e:
            self.logger.debug(f"read_register failed for board {board_id}: {e}")
            return None

    def stats(self) -> List[Dict[str, Any]]:
        """Latest per-board/per-channel rates (event/pileup/lost/satu per second
        + file write rate, plus 'failed'/'board_failures'). Empty when no run is
        active (so the UI shows nothing between runs)."""
        if self.daq is None or not self._running:
            return []
        try:
            return self.daq.stats()
        except Exception as e:
            self.logger.debug(f"stats() failed: {e}")
            return []

    def set_graphite(self, host: str = "", port: Optional[int] = None,
                     prefix: Optional[str] = None) -> None:
        """Update the running DAQ's Graphite/Carbon target and metric prefix (call
        when the stats config changes). Reads conf/stats.json for anything not
        given. A live run picks the new prefix up on its next stats interval —
        the series simply continues under the new path."""
        if host == "" and port is None and prefix is None:
            host, port, prefix = _graphite_from_stats()
        else:
            if port is None:
                port = _DEFAULT_CARBON_PORT
            if prefix is None:
                prefix = ""      # empty = leave the collector's prefix alone
        if self.daq is not None:
            try:
                self.daq.set_graphite(str(host), int(port), str(prefix))
            except Exception as e:
                self.logger.warning(f"set_graphite failed: {e}")

    def set_stats_interval(self, interval_ms: Optional[int] = None) -> Optional[int]:
        """Change the rate sampling cadence of a live run, in ms.

        Reads conf/stats.json when called with nothing, so the persisted setting
        and the running collector stay in step. caendaq applies it to the tick
        already in flight, so shortening the interval speeds the rate page up
        immediately rather than after the current long window expires.

        Returns the interval actually applied, or None when no run is active —
        the persisted value is still used by the next run either way.
        """
        if interval_ms is None:
            interval_ms, _ = _sampling_from_stats()
        if self.daq is None:
            return None
        if not hasattr(self.daq, "set_stats_interval"):
            self.logger.warning(
                "Installed caendaq has no set_stats_interval() — the setting is "
                "saved and will apply to the next run once caendaq is rebuilt.")
            return None
        try:
            self.daq.set_stats_interval(int(interval_ms))
            return int(self.daq.stats_interval())
        except Exception as e:
            self.logger.warning(f"set_stats_interval failed: {e}")
            return None

    def stats_interval(self) -> Optional[int]:
        """The live run's sampling cadence in ms, or None when no run is active."""
        if self.daq is None or not hasattr(self.daq, "stats_interval"):
            return None
        try:
            return int(self.daq.stats_interval())
        except Exception:
            return None

    # ------------------------------------------------------- provenance / FAIR
    def software_versions(self) -> Dict[str, Any]:
        """Versions of everything in the acquisition chain, for run metadata.

        Recorded with each run so the data stays interpretable: which build of
        the acquisition backend produced it, and whether it was real hardware or
        the mock source."""
        import platform
        import sys

        info: Dict[str, Any] = {
            "webdaq": _webdaq_version(),
            "python": sys.version.split()[0],
            "platform": platform.platform(),
            "caendaq": None,
            "caendaq_has_caen": None,
            "acquisition_mode": "mock" if self.test_flag else "hardware",
        }
        if self._caendaq is not None:
            info["caendaq"] = getattr(self._caendaq, "__version__", "unknown")
            # Older builds of the module predate this attribute.
            info["caendaq_has_caen"] = bool(getattr(self._caendaq, "HAS_CAEN", False))
        else:
            info["caendaq_import_error"] = self._import_error
        return info

    def board_info(self, board_id: str) -> Optional[Dict[str, Any]]:
        """Everything the CAEN API reports for one board, keyed by WebDAQ id.

        Includes model/serial/firmware/licence and the acquisition registers as
        read back from the hardware after configuration. Only available while a
        run is configured (the digitizers are open); None otherwise."""
        idx = self.board_index(board_id)
        if idx is None or self.daq is None:
            return None
        try:
            info = dict(self.daq.board_info(idx))
            info["board_id"] = str(board_id)
            info["board_index"] = idx
            return info
        except Exception as e:
            self.logger.debug(f"board_info({board_id}) failed: {e}")
            return None

    def board_info_all(self) -> List[Dict[str, Any]]:
        """board_info() for every board, in acquisition (chain) order. Empty when
        no run is configured."""
        if self.daq is None:
            return []
        out: List[Dict[str, Any]] = []
        for b in self._boards:
            info = self.board_info(str(b["id"]))
            if info is not None:
                # Carry the WebDAQ-side identity too, so the record is complete
                # even for fields the CAEN API does not expose.
                info["configured_name"] = b.get("name")
                info["configured_dpp"] = b.get("dpp")
                info["link_type"] = b.get("link_type")
                out.append(info)
        return out

    def sync_mode(self, boards: Optional[List[Dict[str, Any]]] = None) -> str:
        """'daisy-chain' when any board is configured to wait for an external
        start, else 'independent'. Derived from the boards' own registers, so it
        cannot drift out of step with what the hardware is actually doing."""
        candidates = boards if boards is not None else self._boards
        return "daisy-chain" if any(is_synchronised(b) for b in candidates) else "independent"

    def board_health(self) -> Dict[str, Dict[str, Any]]:
        """Per-board failure status during a run, keyed by WebDAQ board id:
        {board_id: {'failed': bool, 'failures': int}}. Empty if no run is active.
        The counters reset at the start of each run. See caendaq.board_fail_meaning()."""
        if self.daq is None or not self._running:
            return {}
        out: Dict[str, Dict[str, Any]] = {}
        for i, b in enumerate(self._boards):
            try:
                n = int(self.daq.board_failures(i))
                out[str(b["id"])] = {"failed": n > 0, "failures": n}
            except Exception as e:
                self.logger.debug(f"board_health board {i}: {e}")
        return out


# Global instance --------------------------------------------------------------
_caen_acquisition: Optional[CaenAcquisition] = None


def get_caen_acquisition(test_flag: bool = False) -> CaenAcquisition:
    global _caen_acquisition
    if _caen_acquisition is None:
        _caen_acquisition = CaenAcquisition(test_flag=test_flag)
    return _caen_acquisition
