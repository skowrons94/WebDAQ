"""
CAEN acquisition manager.

Owns a single in-process ``caendaq.DAQ`` instance (the pybind11 module built from
the CaenDAQ repo) that reads the boards, writes ``.caendat`` files and decodes
events into online spectra — the in-process CAEN acquisition backend.

Board configs come from the daq_manager state (the same list the UI edits): each
board dict carries ``id``, ``name``, ``chan``, ``dpp``, ``link_type``,
``link_num`` and ``vme``. The per-board register configuration is the existing
``conf/<name>_<id>.json`` dump, which CaenDigitizer applies directly.

Boards with ``"vendor": "sis3316"`` (Struck SIS3316, Ethernet) are not CAEN
boards: configure() hands them to :mod:`app.services.sis3316_acquisition`, and
every method here merges the two backends, so callers need not know which
board is which. Board indices (board_index()) stay global over all boards.
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


# Board Configuration (0x8000) bits UM5678/UM4380 mark "must be 1" on the x725 /
# x730 DPP-PHA and DPP-PSD firmware: [18] time stamp recording, [19] energy
# (charge) recording. Without them the board sends the waveform alone, every
# "energy" is a stray sample and no hit has a time. The settings page does not
# offer them, so a dump read from a board in that state is the only way in.
_MUST_BE_ONE_8000 = (1 << 18) | (1 << 19)


def ensure_recording_bits(board: Dict[str, Any], logger: logging.Logger) -> bool:
    """Switch time stamp and energy recording back on in the board's register
    dump if they are off. Returns True when the file was changed."""
    name = str(board.get("name", ""))
    if "725" not in name and "730" not in name:
        return False
    if str(board.get("dpp", "")) not in ("DPP-PHA", "DPP-PSD"):
        return False
    fn = f"conf/{board['name']}_{board['id']}.json"
    try:
        with open(fn) as f:
            data = json.load(f)
        reg = data.get("registers", {}).get("reg_8000")
        if not reg:
            return False
        value = int(reg["value"], 16)
        if value & _MUST_BE_ONE_8000 == _MUST_BE_ONE_8000:
            return False
        fixed = value | _MUST_BE_ONE_8000
        reg["value"] = f"0x{fixed:X}"
        tmp = fn + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f, indent=4)
        os.replace(tmp, fn)
        logger.warning(
            f"Board {board['id']} ({name}): Board Configuration 0x8000 was 0x{value:X}, "
            f"with time stamp and/or energy recording (bits 18/19, which the CAEN "
            f"manual says must be 1) off — the board would send waveforms only. "
            f"Set to 0x{fixed:X} in {fn}.")
        return True
    except Exception as e:
        logger.debug(f"ensure_recording_bits({fn}): {e}")
        return False


# A channel needs this many events before its energies are judged.
ENERGY_CHECK_MIN_EVENTS = 100


def energy_warning(events: int, spectrum, psd: bool = False) -> Optional[str]:
    """Why a channel's energies are unusable, or None.

    The online spectrum has no bin for energy 0 (a 0 is not filled), so the
    events missing from it are the ones the board gave energy 0; the last bin
    is the top of the 15-bit (PHA) or 16-bit (PSD charge) scale.
    """
    if events < ENERGY_CHECK_MIN_EVENTS:
        return None
    # A channel that never had a non-zero energy has no spectrum at all.
    empty = spectrum is None or len(spectrum) == 0
    filled = 0 if empty else int(spectrum.sum())
    zero = max(0, events - filled) / events
    top = 0.0 if empty else int(spectrum[-1]) / events
    what = "charge" if psd else "energy"
    if zero >= 0.5:
        fix = ("check the gates and the charge sensitivity" if psd else
               "the trapezoid output is out of range: check Trapezoid Rescaling "
               "(DPP Algorithm Control bits 5:0) and Fine Gain, and the decay time")
        return f"{zero:.0%} of the events have {what} 0 — {fix}."
    if top >= 0.5:
        fix = ("lower the charge sensitivity" if psd else
               "raise Trapezoid Rescaling or lower Fine Gain")
        return f"{top:.0%} of the events are at the top of the {what} scale — {fix}."
    return None


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

    @property
    def _caen_boards(self) -> List[Dict[str, Any]]:
        """The CAEN boards of the run, in caendaq index order."""
        from .sis3316_acquisition import is_sis3316
        return [b for b in self._boards if not is_sis3316(b)]

    @property
    def _sis_boards(self) -> List[Dict[str, Any]]:
        """The SIS3316 boards of the run (handled by sis3316_acquisition)."""
        from .sis3316_acquisition import is_sis3316
        return [b for b in self._boards if is_sis3316(b)]

    def get_daq(self):
        """The live-data source for the spy: caendaq's DAQ, or, when the run
        includes SIS3316 boards, a view that routes each global board index to
        the right backend."""
        if self._sis_boards:
            return _MixedDaq(self)
        return self.daq

    def _sis(self):
        from .sis3316_acquisition import get_sis3316_acquisition
        return get_sis3316_acquisition(self.test_flag)

    def caen_index(self, board_id: str) -> Optional[int]:
        """caendaq's own index of a CAEN board in this run, or None."""
        for i, b in enumerate(self._caen_boards):
            if str(b["id"]) == str(board_id):
                return i
        return None

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
        from .sis3316_acquisition import is_sis3316
        caen_boards = [b for b in boards if not is_sis3316(b)]
        sis_boards = [b for b in boards if is_sis3316(b)]
        self.daq = None
        self._boards = []
        if sis_boards:
            graphite = _graphite_from_stats()
            interval_ms, _ = _sampling_from_stats()
            if not self._sis().configure(sis_boards, run=int(run), out_dir=out_dir,
                                         max_file_bytes=int(max_file_bytes), write=bool(write),
                                         graphite=graphite, stats_interval_ms=interval_ms,
                                         software=_webdaq_version()):
                return False
        if not caen_boards:
            self._boards = list(boards)
            self.logger.info(f"Acquisition configured with {len(sis_boards)} SIS3316 board(s), run {run}")
            return True
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
            # daq_state keeps boards sorted by id, so add order == board index.
            for board in caen_boards:
                ensure_recording_bits(board, self.logger)
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
            self._boards = list(boards)
            self.logger.info(f"Acquisition configured with {len(self._boards)} board(s), run {run}")
            return True
        except Exception as e:
            self.logger.error(f"Error configuring acquisition: {e}")
            self.daq = None
            return False

    def start(self) -> bool:
        if self.daq is None and not self._sis_boards:
            self.logger.error("start() called before configure()")
            return False
        try:
            # SIS3316 boards first: they start sampling at once, while caendaq
            # may still wait for a synchronised CAEN chain's start signal.
            if self._sis_boards and not self._sis().start():
                self.logger.error("SIS3316 acquisition failed to start")
                return False
            if self.daq is not None and not self.daq.start():
                self.logger.error("caendaq DAQ failed to start")
                if self._sis_boards:
                    self._sis().stop()
                return False
            self._running = True
            self.logger.info("Acquisition started")
            self._start_coincidences()
            self._start_rate_history()
            return True
        except Exception as e:
            self.logger.error(f"Error starting acquisition: {e}")
            return False

    def stop(self) -> bool:
        self._running = False
        try:
            if self.daq is not None:
                self.daq.stop()
            if self._sis_boards:
                self._sis().stop()
            self.logger.info("Acquisition stopped")
            self._finish_coincidences()
            try:
                from .rate_history import get_rate_history
                get_rate_history().stop()
            except Exception:
                pass
            return True
        except Exception as e:
            self.logger.error(f"Error stopping acquisition: {e}")
            return False

    # ----------------------------------------------------------- coincidences
    def _start_rate_history(self) -> None:
        try:
            from .rate_history import get_rate_history
            get_rate_history().start(self, (self.stats_interval() or 1000) / 1000.0)
        except Exception as e:
            self.logger.error(f"The run's rate history could not start: {e}")

    def _start_coincidences(self) -> None:
        # Never allowed to fail a run: coincidences are a view on the data.
        try:
            from .coincidences import get_coincidence_builder
            get_coincidence_builder().start(self)
        except Exception as e:
            self.logger.error(f"Online coincidences could not start: {e}")

    def _finish_coincidences(self) -> None:
        try:
            from .coincidences import get_coincidence_builder
            get_coincidence_builder().finish()
        except Exception as e:
            self.logger.error(f"Online coincidences did not finish cleanly: {e}")

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
        index = self.caen_index(board_id)
        if index is None:
            self.logger.error(f"write_register: CAEN board {board_id} is not part of this run")
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
        index = self.caen_index(board_id)
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
        if not self._running:
            return []
        out: List[Dict[str, Any]] = []
        try:
            if self.daq is not None:
                boards = self.daq.stats()
                for index, board in enumerate(boards):
                    self._add_energy_warnings(index, board)
                out.extend(boards)
        except Exception as e:
            self.logger.debug(f"stats() failed: {e}")
        if self._sis_boards:
            try:
                out.extend(self._sis().stats())
            except Exception as e:
                self.logger.debug(f"SIS3316 stats() failed: {e}")
        return out

    def _add_energy_warnings(self, index: int, board: Dict[str, Any]) -> None:
        """Flag channels whose energies are not usable, in their stats entry.

        Judged on the data, not on the registers: whatever combination of
        trapezoid rescaling, fine gain or gates causes it, a channel whose
        events come out with energy 0, or pinned at the top of the scale, has
        a spectrum that means nothing. The counts are over the whole run.
        """
        cfg = self._caen_boards[index] if index < len(self._caen_boards) else {}
        psd = str(cfg.get("dpp", "")).upper().endswith("PSD")
        for ch in board.get("channels", []):
            try:
                n = int(self.daq.channel_events(index, int(ch["channel"])))
                spectrum = (self.daq.qlong if psd else self.daq.energy)(index, int(ch["channel"]))
            except Exception:
                continue
            warning = energy_warning(n, spectrum, psd)
            if warning:
                ch["energy_warning"] = warning

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
        if self._sis_boards and prefix:
            self._sis().set_graphite(str(host), int(port), str(prefix))

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
        if self._sis_boards:
            self._sis().set_stats_interval(int(interval_ms))
            if self.daq is None:
                return int(interval_ms) if self._running else None
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
        sis_version = self._sis().software_version() if self._sis_boards else None
        if sis_version:
            info["sis3316daq"] = sis_version
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
        if any(str(b["id"]) == str(board_id) for b in self._sis_boards):
            return self._sis().board_info(board_id)
        idx = self.caen_index(board_id)
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
        if self.daq is None and not self._sis_boards:
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
        from .sis3316_acquisition import is_sis3316
        candidates = boards if boards is not None else self._boards
        candidates = [b for b in candidates if not is_sis3316(b)]
        return "daisy-chain" if any(is_synchronised(b) for b in candidates) else "independent"

    # Per-board readout counters caendaq keeps for the run, in the order the
    # Board Health page shows them. A build without one of these (the module is
    # versioned separately from the server) simply reports None for it.
    _DIAGNOSTIC_COUNTERS = (
        "buffers_read",       # data blocks read from the board
        "bytes_read",         # bytes read from the board
        "bytes_written",      # bytes accepted by the write queue
        "blocks_dropped",     # blocks the write queue refused (full) — lost data
        "comm_errors",        # CAEN read errors
        "events_decoded",     # events decoded out of those buffers
        "decode_dropped",     # blocks the online decoder skipped while behind (file has them)
        "incomplete_events",  # events sent without a time stamp or energy (0x8000 bits 18/19 off)
        "board_failures",     # aggregates carrying the board's FAIL flag
    )

    def board_diagnostics(self) -> Dict[str, Dict[str, Any]]:
        """Every readout counter caendaq keeps for each board this run, keyed by
        WebDAQ board id, for the Board Health page and the stall watch:

            {board_id: {'buffers_read': int|None, ..., 'failed': bool}}

        All counters are cumulative for the run (a fresh caendaq.DAQ is built at
        every start) and empty outside a run. A counter missing from the installed
        caendaq build reads None rather than failing the whole request.
        """
        if not self._running:
            return {}
        out: Dict[str, Dict[str, Any]] = {}
        if self._sis_boards:
            out.update(self._sis().diagnostics())
        if self.daq is None:
            return out
        for i, b in enumerate(self._caen_boards):
            counters: Dict[str, Any] = {}
            for name in self._DIAGNOSTIC_COUNTERS:
                reader = getattr(self.daq, name, None)
                if reader is None:
                    counters[name] = None
                    continue
                try:
                    counters[name] = int(reader(i))
                except Exception as e:
                    self.logger.debug(f"board_diagnostics {name} board {i}: {e}")
                    counters[name] = None
            counters["failed"] = bool(counters.get("board_failures") or 0)
            out[str(b["id"])] = counters
        return out

    def board_fail_meaning(self) -> str:
        """caendaq's own explanation of the board-FAIL flag, for the UI to show
        next to a failure. Empty when the module cannot tell us."""
        try:
            return str(self._caendaq.board_fail_meaning())
        except Exception:
            return ""

    def board_health(self) -> Dict[str, Dict[str, Any]]:
        """Per-board failure status during a run, keyed by WebDAQ board id:
        {board_id: {'failed': bool, 'failures': int}}. Empty if no run is active.
        The counters reset at the start of each run. See caendaq.board_fail_meaning()."""
        if not self._running:
            return {}
        out: Dict[str, Dict[str, Any]] = {}
        if self._sis_boards:
            out.update(self._sis().health())
        if self.daq is None:
            return out
        for i, b in enumerate(self._caen_boards):
            try:
                n = int(self.daq.board_failures(i))
                out[str(b["id"])] = {"failed": n > 0, "failures": n}
            except Exception as e:
                self.logger.debug(f"board_health board {i}: {e}")
        return out


class _MixedDaq:
    """Spy view over a run that mixes caendaq and SIS3316 boards: the spy asks
    by global board index, this answers from the backend that holds the board.
    SIS3316 boards have energy spectra and waveforms only (no PSD)."""

    def __init__(self, acq: "CaenAcquisition"):
        self._acq = acq

    def _route(self, board_index: int):
        board = self._acq._boards[board_index]
        sis = self._acq._sis()
        idx = sis.local_index(board["id"])
        if idx is not None and any(str(b["id"]) == str(board["id"]) for b in self._acq._sis_boards):
            return "sis", sis, idx
        return "caen", self._acq.daq, self._acq.caen_index(str(board["id"]))

    def _get(self, kind: str, board_index: int, channel: int):
        backend, obj, idx = self._route(board_index)
        if obj is None or idx is None:
            return None
        if backend == "sis":
            return obj.array(idx, "waveform" if kind == "waveform" else kind, channel)
        return getattr(obj, kind)(idx, channel)

    def energy(self, b, ch):
        return self._get("energy", b, ch)

    def waveform(self, b, ch):
        return self._get("waveform", b, ch)

    def waveform_of(self, b, ch, kind):
        backend, obj, idx = self._route(b)
        if obj is None or idx is None:
            return None
        if backend == "sis":
            return obj.array(idx, "waveform", ch, kind)
        if not hasattr(obj, "waveform_of"):
            raise NotImplementedError("the installed caendaq has no waveform_of")
        return obj.waveform_of(idx, ch, kind)

    def qshort(self, b, ch):
        return self._get("qshort", b, ch)

    def qlong(self, b, ch):
        return self._get("qlong", b, ch)

    def psd(self, b, ch):
        return self._get("psd", b, ch)

    def interval(self, b, ch):
        return self._get("interval", b, ch)

    def channel_events(self, b, ch):
        backend, obj, idx = self._route(b)
        if backend == "sis" or obj is None or idx is None:
            return 0          # the SIS3316 spectra keep no zero-energy events apart
        return obj.channel_events(idx, ch)


# Global instance --------------------------------------------------------------
_caen_acquisition: Optional[CaenAcquisition] = None


def get_caen_acquisition(test_flag: bool = False) -> CaenAcquisition:
    global _caen_acquisition
    if _caen_acquisition is None:
        _caen_acquisition = CaenAcquisition(test_flag=test_flag)
    return _caen_acquisition
