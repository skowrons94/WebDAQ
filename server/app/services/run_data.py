"""
Read-side access to completed runs.

Everything a finished run left on disk lives under ``data/run<N>/``:

    run_<N>_0000.caendat    the raw CAEN data (one unified file per board set)
    <board>_<id>.json       the register dump each board ran with
    current.txt             the beam current logged during the run
    metadata.json           the run record written at stop

This module turns that directory into something the Data dashboard can show:
the file inventory, the current as a time series, the integrated charge, and
the RUReader conversion to ROOT. It only reads (and writes ROOT output); the
acquisition path is untouched.
"""

import logging
import os
import shutil
import subprocess
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

DATA_DIR = "data"
CURRENT_FILE = "current.txt"
METADATA_FILE = "metadata.json"

# The converter installed by install.sh. Overridable for unusual setups.
RUREADER_BIN = os.getenv("RUREADER_BIN", "RUReader")

# Optional environment prefix (e.g. a conda env) whose bin/ is prepended to the
# converter's PATH. Needed when RUReader was built against a ROOT living in a
# different environment from the one the server runs in — see _annotate_log.
RUREADER_ENV_PREFIX = os.getenv("RUREADER_ENV_PREFIX", "")

# ROOT's interpreter probes the compiler it was built with to find the C++
# standard headers. When that compiler is not on PATH it prints this and carries
# on; RUReader only uses compiled ROOT I/O, so the conversion still completes.
_CLING_SIGNATURE = "cannot extract standard library include paths"


def run_dir(run_number: int) -> str:
    return os.path.join(DATA_DIR, f"run{int(run_number)}")


def run_exists(run_number: int) -> bool:
    return os.path.isdir(run_dir(run_number))


# ─────────────────────────────────────────────────────────── file inventory

def _size(path: str) -> int:
    try:
        return os.path.getsize(path)
    except OSError:
        return 0


def list_files(run_number: int) -> Dict[str, Any]:
    """What the run directory holds, split by role."""
    directory = run_dir(run_number)
    out: Dict[str, Any] = {
        "data": [], "board_config": [], "root": [], "current": None,
        "metadata": None, "total_bytes": 0,
    }
    if not os.path.isdir(directory):
        return out

    for name in sorted(os.listdir(directory)):
        path = os.path.join(directory, name)
        if not os.path.isfile(path):
            continue
        size = _size(path)
        out["total_bytes"] += size
        entry = {"name": name, "bytes": size}
        if name.endswith(".caendat"):
            out["data"].append(entry)
        elif name.endswith(".root"):
            out["root"].append(entry)
        elif name == CURRENT_FILE:
            out["current"] = entry
        elif name == METADATA_FILE:
            out["metadata"] = entry
        elif name.endswith(".json"):
            out["board_config"].append(entry)
    return out


# ───────────────────────────────────────────────────────────── current data

def _parse_header(line: str) -> List[str]:
    """Column names from the '# Time(s)\tCh0(uA)...' header line."""
    return [c.strip() for c in line.lstrip("#").strip().split("\t") if c.strip()]


def read_current(run_number: int, max_points: int = 2000) -> Dict[str, Any]:
    """
    The beam current logged during a run, ready to plot.

    Handles both writers: the TetrAMM logs four channels, the RBD 9103 one, and
    both start the file with a '### Start time ... ###' line followed by a '#'
    header naming the columns. Column names are taken from that header rather
    than assumed, so either module renders correctly.

    Long runs are downsampled to ``max_points`` by striding, since a plot cannot
    show more than a few thousand points anyway. ``integration`` is always
    computed on the FULL series, never the downsampled one.
    """
    path = os.path.join(run_dir(run_number), CURRENT_FILE)
    result: Dict[str, Any] = {
        "available": False, "start_time": None, "columns": [], "samples": [],
        "n_samples": 0, "downsampled": False, "integration": None,
    }
    if not os.path.isfile(path):
        return result

    columns: List[str] = []
    times: List[float] = []
    values: List[List[float]] = []

    try:
        with open(path, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                if line.startswith("###"):
                    # '### Start time: 2026-07-27 15:23:28.761641 ###'
                    if "Start time:" in line:
                        result["start_time"] = line.split("Start time:")[1].strip(" #").strip()
                    continue
                if line.startswith("#"):
                    columns = _parse_header(line)
                    continue
                parts = line.split()
                if len(parts) < 2:
                    continue
                try:
                    row = [float(p) for p in parts]
                except ValueError:
                    continue           # a partially written last line
                times.append(row[0])
                values.append(row[1:])
    except OSError as e:
        logger.error(f"Could not read {path}: {e}")
        return result

    if not times:
        return result

    n_channels = min(len(v) for v in values)
    # Fall back to generic names if the header was missing or short.
    if len(columns) != n_channels + 1:
        columns = ["Time(s)"] + [f"Ch{i}(uA)" for i in range(n_channels)]

    result["available"] = True
    result["columns"] = columns
    result["n_samples"] = len(times)
    result["integration"] = integrate_current(times, values, columns[1:])

    step = max(1, len(times) // max_points)
    result["downsampled"] = step > 1
    result["samples"] = [
        [times[i]] + list(values[i][:n_channels]) for i in range(0, len(times), step)
    ]
    return result


def integrate_current(
    times: List[float], values: List[List[float]], channel_names: List[str],
) -> Dict[str, Any]:
    """
    Integrated charge per channel, by the trapezoidal rule.

    Current is logged in µA against time in seconds, so the integral is in µC;
    nC and mC are offered too so the number is readable at any beam intensity.
    Also reports mean current and the elapsed time actually covered.
    """
    if len(times) < 2:
        return {"channels": [], "duration_s": 0.0, "note": "not enough samples to integrate"}

    n_channels = min(len(v) for v in values)
    charges = [0.0] * n_channels

    for i in range(1, len(times)):
        dt = times[i] - times[i - 1]
        # Guard against a clock jump or a duplicated timestamp.
        if dt <= 0:
            continue
        for c in range(n_channels):
            charges[c] += 0.5 * (values[i][c] + values[i - 1][c]) * dt

    duration = times[-1] - times[0]
    channels = []
    for c in range(n_channels):
        name = channel_names[c] if c < len(channel_names) else f"Ch{c}(uA)"
        channels.append({
            "name": name,
            "charge_uC": charges[c],
            "charge_nC": charges[c] * 1e3,
            "charge_mC": charges[c] * 1e-3,
            "mean_current_uA": (charges[c] / duration) if duration > 0 else 0.0,
        })

    return {"channels": channels, "duration_s": duration, "method": "trapezoidal"}


# ─────────────────────────────────────────────────────── RUReader conversion

def _converter_env() -> Optional[Dict[str, str]]:
    """Environment for the converter, or None to inherit the server's.

    RUReader must find the ROOT it was linked against. When that ROOT lives in a
    different environment from the one running the server, point at it with
    RUREADER_ENV_PREFIX and its bin/ goes to the front of PATH.
    """
    if not RUREADER_ENV_PREFIX:
        return None
    bin_dir = os.path.join(RUREADER_ENV_PREFIX, "bin")
    if not os.path.isdir(bin_dir):
        logger.warning(f"RUREADER_ENV_PREFIX={RUREADER_ENV_PREFIX} has no bin/ — ignoring")
        return None
    env = os.environ.copy()
    env["PATH"] = bin_dir + os.pathsep + env.get("PATH", "")
    return env


def _annotate_log(lines: List[str], produced_output: bool) -> List[str]:
    """Explain converter output that looks alarming but is not.

    The cling message is the common one: ROOT prints a multi-line ERROR when it
    cannot locate the C++ standard headers, which happens whenever the compiler
    ROOT was built with is absent from the environment. RUReader does not use
    the interpreter, so the ROOT file is written correctly regardless — but an
    operator reading "ERROR" at the end of a log has no way to know that.
    """
    if not any(_CLING_SIGNATURE in line for line in lines):
        return lines

    if produced_output:
        note = (
            "NOTE: the 'cling ... cannot extract standard library include paths' error "
            "above is harmless — the ROOT file was written correctly. It means RUReader "
            "was built against a ROOT installation whose compiler is not on PATH here "
            "(typically RUReader built in one conda environment, server running in "
            "another). To silence it, rebuild RUReader in the environment the server "
            "runs in with ./install.sh, or set RUREADER_ENV_PREFIX to the environment "
            "that provides its ROOT.")
    else:
        note = (
            "NOTE: ROOT could not locate the C++ standard headers (the 'cling' error "
            "above). RUReader was built against a ROOT whose compiler is not on PATH "
            "here. Rebuild RUReader in the environment the server runs in with "
            "./install.sh, or set RUREADER_ENV_PREFIX to the environment providing "
            "its ROOT.")
    return [note] + lines


class ConversionManager:
    """
    Runs RUReader in the background, one conversion per run at a time.

    Conversions take minutes on a large run, so the request only starts the job
    and the dashboard polls ``status``. Output goes to ``run<N>.root`` inside the
    run directory, next to the data it was made from.
    """

    def __init__(self) -> None:
        self._jobs: Dict[int, Dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._capabilities: Optional[Dict[str, bool]] = None

    def available(self) -> Optional[str]:
        """Path to the RUReader binary, or None when it is not installed."""
        return shutil.which(RUREADER_BIN)

    def capabilities(self) -> Dict[str, bool]:
        """
        Which optional flags the *installed* binary understands.

        The binary on PATH is not necessarily built from the pinned submodule —
        an older RUReader has no --ts-unit or --compression, and passing them
        makes it exit with "Unknown option" instead of converting. So ask it
        once (via --help) and only send flags it advertises.
        """
        if self._capabilities is not None:
            return self._capabilities

        caps = {"ts_unit": False, "compression": False, "ignore_fail": False,
                "header_boards": False}
        binary = self.available()
        if binary:
            help_text = ""
            for flag in ("--help", "-h"):
                try:
                    proc = subprocess.run([binary, flag], capture_output=True,
                                          text=True, timeout=15)
                    help_text = (proc.stdout or "") + (proc.stderr or "")
                    if help_text.strip():
                        break
                except Exception as e:      # binary missing, not executable, hangs
                    logger.warning(f"Could not query {binary} {flag}: {e}")
            caps["ts_unit"] = "--ts-unit" in help_text
            caps["compression"] = "--compression" in help_text
            caps["ignore_fail"] = "--ignore-fail" in help_text
            # Newer builds read the board list from the .caendat header and only
            # accept -d as an override; older ones REQUIRE it and abort with
            # "No digitizer specified" without it.
            caps["header_boards"] = "Override the board type" in help_text
            if not any(caps.values()):
                logger.warning(
                    f"{binary} advertised no known options — treating it as a "
                    "minimal build and passing only -i/-o.")

        self._capabilities = caps
        return caps

    def status(self, run_number: int) -> Dict[str, Any]:
        run_number = int(run_number)
        with self._lock:
            job = self._jobs.get(run_number)
            state = dict(job) if job else {"state": "idle"}
        # An earlier conversion (or one from a previous server run) shows up as
        # a .root file even with no job in memory.
        outputs = [f["name"] for f in list_files(run_number)["root"]]
        state["outputs"] = outputs
        state["converted"] = bool(outputs)
        state["binary"] = self.available()
        # Lets the UI offer only the options this build actually accepts.
        state["capabilities"] = self.capabilities()
        return state

    def start(self, run_number: int, options: Optional[Dict[str, Any]] = None) -> Tuple[bool, str]:
        """Kick off a conversion. Returns (started, message)."""
        run_number = int(run_number)
        options = options or {}

        binary = self.available()
        if not binary:
            return False, (
                f"'{RUREADER_BIN}' is not installed. Build it with ./install.sh, "
                "or set RUREADER_BIN to its path.")
        if not run_exists(run_number):
            return False, f"Run {run_number} has no data directory."
        if not list_files(run_number)["data"]:
            return False, f"Run {run_number} contains no .caendat files to convert."

        with self._lock:
            job = self._jobs.get(run_number)
            if job and job.get("state") == "running":
                return False, f"Run {run_number} is already being converted."
            self._jobs[run_number] = {
                "state": "running", "started_at": time.time(),
                "output": None, "log": [], "returncode": None,
            }

        thread = threading.Thread(
            target=self._convert, args=(run_number, binary, options),
            name=f"rureader-run{run_number}", daemon=True)
        thread.start()
        return True, f"Converting run {run_number}…"

    def _convert(self, run_number: int, binary: str, options: Dict[str, Any]) -> None:
        directory = run_dir(run_number)
        output = os.path.join(directory, f"run{run_number}.root")
        # RUReader accepts a directory and converts every .caendat inside it in
        # name order, which is how a run split across files keeps its time order.
        cmd = [binary, "-i", directory, "-o", output]

        # Only send options this build understands (see capabilities()).
        caps = self.capabilities()
        skipped = []

        ts_unit = options.get("ts_unit")
        if ts_unit in ("ps", "ns", "us", "ms", "s", "raw"):
            if caps["ts_unit"]:
                cmd += ["-t", str(ts_unit)]
            else:
                skipped.append(f"timestamp unit '{ts_unit}'")

        if options.get("compression") is not None:
            if caps["compression"]:
                cmd += ["-c", str(int(options["compression"]))]
            else:
                skipped.append("ROOT compression level")

        # An older RUReader cannot read the board list from the file header and
        # aborts with "No digitizer specified" unless told explicitly. We know
        # the boards from the run's own record, so supply them.
        if not caps["header_boards"]:
            boards = options.get("boards") or []
            for board in boards:
                cmd += ["-d", str(board["name"]), str(board["id"])]
            if not boards:
                skipped.append(
                    "board list (this RUReader cannot read it from the file header, "
                    "and the run has no board record to supply it from)")

        # A board-failure flag makes RUReader stop and ask; the dashboard has no
        # console to answer on, so always pass through and report it in the log.
        if caps["ignore_fail"]:
            cmd.append("--ignore-fail")

        logger.info(f"Run {run_number}: {' '.join(cmd)}")
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=3 * 3600,
                                  env=_converter_env())
            log = (proc.stdout or "") + (proc.stderr or "")
            # Keep the tail: enough to diagnose, small enough to ship as JSON.
            lines = [l for l in log.splitlines() if l.strip()][-60:]
            lines = _annotate_log(lines, produced_output=os.path.isfile(output))
            if skipped:
                lines.insert(0, (
                    "NOTE: the installed RUReader does not support "
                    + ", ".join(skipped)
                    + " — converted without it. Rebuild it with ./install.sh to "
                      "get the version pinned by this repository."))
            ok = proc.returncode == 0 and os.path.isfile(output)
            with self._lock:
                self._jobs[run_number] = {
                    "state": "done" if ok else "failed",
                    "started_at": self._jobs[run_number].get("started_at"),
                    "finished_at": time.time(),
                    "output": os.path.basename(output) if ok else None,
                    "returncode": proc.returncode,
                    "log": lines,
                }
            logger.info(f"Run {run_number}: conversion {'succeeded' if ok else 'failed'}")
        except subprocess.TimeoutExpired:
            self._fail(run_number, ["Conversion timed out after 3 hours."])
        except Exception as e:
            self._fail(run_number, [f"Conversion failed: {e}"])

    def _fail(self, run_number: int, log: List[str]) -> None:
        logger.error(f"Run {run_number}: {log[0] if log else 'conversion failed'}")
        with self._lock:
            self._jobs[run_number] = {
                "state": "failed", "finished_at": time.time(),
                "output": None, "returncode": None, "log": log,
            }


_conversion_manager: Optional[ConversionManager] = None


def get_conversion_manager() -> ConversionManager:
    global _conversion_manager
    if _conversion_manager is None:
        _conversion_manager = ConversionManager()
    return _conversion_manager
