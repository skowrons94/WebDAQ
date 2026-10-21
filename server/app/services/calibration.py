"""
Energy calibration: E = offset + slope × channel, per board channel.

The coefficients live in ``calib/<name>_<id>.cal``, one "offset slope" line per
channel — the file the histograms have always been calibrated from and that
every run copies into its directory. This module adds what the Histograms page
needs to make a calibration there instead of typing numbers on another page:

* fitting a peak in the raw spectrum (a Gaussian on a straight background);
* the calibration through two or more (channel, energy) points, with the
  residuals, or through one point and zero;
* saving it, together with the points it came from (``calib/<name>_<id>.points.json``)
  so the next calibration can start from them;
* keeping the channel's ROIs and saved zoom on the same peaks: they are stored
  in axis units, which a new calibration changes;
* a log of every change made during a run, in that run's directory
  (``calib_history.jsonl``), since the copy taken at the start of the run no
  longer tells the whole story.
"""

import json
import logging
import os
import threading
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

logger = logging.getLogger(__name__)

CALIB_DIR = "calib"
HISTORY_FILE = "calib_history.jsonl"
_lock = threading.Lock()

# Lines worth having at hand for an energy calibration (keV): natural
# background and the usual sources. Values from NNDC/ENSDF.
REFERENCE_LINES: List[Dict[str, Any]] = [
    {"name": "e+e- annihilation", "energy": 511.00},
    {"name": "Am-241", "energy": 59.54},
    {"name": "Co-57", "energy": 122.06},
    {"name": "Eu-152", "energy": 121.78},
    {"name": "Eu-152", "energy": 344.28},
    {"name": "Ba-133", "energy": 356.01},
    {"name": "Tl-208", "energy": 583.19},
    {"name": "Bi-214", "energy": 609.31},
    {"name": "Cs-137", "energy": 661.66},
    {"name": "Mn-54", "energy": 834.85},
    {"name": "Y-88", "energy": 898.04},
    {"name": "Zn-65", "energy": 1115.54},
    {"name": "Co-60", "energy": 1173.23},
    {"name": "Na-22", "energy": 1274.54},
    {"name": "Co-60", "energy": 1332.49},
    {"name": "Eu-152", "energy": 1408.01},
    {"name": "K-40", "energy": 1460.82},
    {"name": "Bi-214", "energy": 1764.49},
    {"name": "Y-88", "energy": 1836.06},
    {"name": "Tl-208", "energy": 2614.51},
]


def _paths(board_name: str, board_id: str) -> Tuple[str, str]:
    base = os.path.join(CALIB_DIR, f"{board_name}_{board_id}")
    return base + ".cal", base + ".points.json"


def _atomic_write(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(text)
    os.replace(tmp, path)


def read_table(board_name: str, board_id: str, channels: int) -> List[Tuple[float, float]]:
    """Every channel's (offset, slope); (0, 1) — uncalibrated — where missing."""
    path, _ = _paths(board_name, board_id)
    table = [(0.0, 1.0)] * channels
    try:
        rows = np.loadtxt(path, dtype=float, ndmin=2)
        for ch in range(min(channels, len(rows))):
            if len(rows[ch]) >= 2 and np.isfinite(rows[ch][:2]).all():
                table[ch] = (float(rows[ch][0]), float(rows[ch][1]))
    except (OSError, ValueError):
        pass
    return table


def read_points(board_name: str, board_id: str) -> Dict[str, Any]:
    _, path = _paths(board_name, board_id)
    try:
        with open(path) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def is_calibrated(offset: float, slope: float) -> bool:
    return (offset, slope) != (0.0, 1.0)


# ─────────────────────────────────────────────────────────────── fitting

def fit_peak(spectrum: np.ndarray, xmin: float, xmax: float) -> Dict[str, Any]:
    """A Gaussian on a straight background, over raw channels [xmin, xmax].

    Raises ValueError with a message for the operator when there is nothing
    to fit.
    """
    from scipy.optimize import curve_fit

    lo, hi = int(max(0, np.floor(xmin))), int(min(len(spectrum), np.ceil(xmax)))
    if hi - lo < 5:
        raise ValueError("Zoom on a peak first: the range holds fewer than 5 channels")
    y = np.asarray(spectrum[lo:hi], dtype=float)
    if y.sum() < 20:
        raise ValueError("Too few counts in this range to fit a peak")
    x = np.arange(lo, hi) + 0.5

    # Start values: the background through the averages of both ends, the peak
    # at the highest channel above it, its width from where it falls to half.
    k = max(1, (hi - lo) // 10)
    b1 = (y[-k:].mean() - y[:k].mean()) / max(1.0, x[-k:].mean() - x[:k].mean())
    b0 = y[:k].mean() - b1 * x[:k].mean()
    net = y - (b0 + b1 * x)
    top = int(np.argmax(net))
    amp = float(max(net[top], 1.0))
    above = np.flatnonzero(net > amp / 2)
    sigma0 = max(0.5, (above[-1] - above[0] + 1) / 2.355) if above.size else (hi - lo) / 6

    def model(x, a, mu, sigma, c0, c1):
        return a * np.exp(-0.5 * ((x - mu) / sigma) ** 2) + c0 + c1 * x

    err = np.sqrt(np.maximum(y, 1.0))
    try:
        p, cov = curve_fit(model, x, y, p0=[amp, x[top], sigma0, b0, b1], sigma=err,
                           absolute_sigma=True, maxfev=5000)
    except Exception:
        raise ValueError("The fit did not converge: zoom so the peak fills most of the view")
    a, mu, sigma = p[0], p[1], abs(p[2])
    perr = np.sqrt(np.clip(np.diag(cov), 0, None)) if cov is not None and np.all(np.isfinite(cov)) else [np.nan] * 5
    if not (lo <= mu <= hi) or a <= 0 or not np.isfinite(mu):
        raise ValueError("No peak found in this range")
    chi2 = float((((y - model(x, *p)) / err) ** 2).sum())
    ndf = max(1, len(x) - 5)
    return {
        "centroid": float(mu),
        "centroid_error": float(perr[1]),
        "sigma": float(sigma),
        "fwhm": float(2.3548 * sigma),
        "area": float(a * sigma * np.sqrt(2 * np.pi)),
        "chi2_ndf": chi2 / ndf,
        "range": [lo, hi],
    }


def solve(points: List[Dict[str, float]]) -> Dict[str, Any]:
    """E = offset + slope × channel through the (channel, energy) points:
    a weighted straight line for two or more, through zero for one."""
    pts = [(float(p["channel"]), float(p["energy"]), float(p.get("channel_error") or 0.0))
           for p in points]
    if not pts:
        raise ValueError("Add at least one peak with its energy")
    x = np.array([p[0] for p in pts])
    e = np.array([p[1] for p in pts])
    if len(pts) == 1:
        if x[0] <= 0:
            raise ValueError("One peak at channel 0 or below cannot set a slope")
        offset, slope = 0.0, float(e[0] / x[0])
    else:
        if np.ptp(x) <= 0:
            raise ValueError("The peaks must be at different channels")
        sx = np.array([p[2] for p in pts])
        w = 1.0 / np.maximum(sx, 1e-3) ** 2 if np.all(sx > 0) else np.ones(len(pts))
        slope, offset = np.polyfit(x, e, 1, w=np.sqrt(w))
        offset, slope = float(offset), float(slope)
    residuals = [float(ei - (offset + slope * xi)) for xi, ei in zip(x, e)]
    return {"offset": offset, "slope": slope, "residuals": residuals,
            "method": "line" if len(pts) > 1 else "through zero"}


# ─────────────────────────────────────────────────────────────── saving

def save(board: Dict[str, Any], channel: int, offset: float, slope: float,
         points: Optional[List[Dict[str, Any]]] = None,
         run_dir: Optional[str] = None) -> Dict[str, Any]:
    """Write one channel's calibration and keep everything that depends on it
    in step. Returns the previous and the new coefficients."""
    if not np.isfinite(offset) or not np.isfinite(slope) or slope == 0:
        raise ValueError("The slope must be a non-zero number")
    name, bid = str(board["name"]), str(board["id"])
    channels = max(int(board.get("chan", 16) or 16), channel + 1)
    cal_path, points_path = _paths(name, bid)
    with _lock:
        table = read_table(name, bid, channels)
        old = table[channel]
        table[channel] = (float(offset), float(slope))
        _atomic_write(cal_path, "".join(f"{o!r} {s!r}\n" for o, s in table))

        stored = read_points(name, bid)
        if points is not None:
            stored[str(channel)] = {"points": points, "offset": offset, "slope": slope,
                                    "updated": datetime.now().isoformat(timespec="seconds")}
            _atomic_write(points_path, json.dumps(stored, indent=2))

    _move_axis_objects(bid, channel, old, (offset, slope))

    if run_dir:
        entry = {"time": datetime.now().isoformat(timespec="seconds"), "board": bid,
                 "board_name": name, "channel": channel, "offset": offset, "slope": slope,
                 "previous": {"offset": old[0], "slope": old[1]}}
        if points is not None:
            entry["points"] = points
        try:
            with open(os.path.join(run_dir, HISTORY_FILE), "a") as f:
                f.write(json.dumps(entry) + "\n")
        except OSError as e:
            logger.warning(f"Could not log the calibration change in {run_dir}: {e}")
    logger.info(f"Calibration of board {bid} channel {channel}: "
                f"E = {offset:g} + {slope:g} x (was {old[0]:g} + {old[1]:g} x)")
    return {"previous": {"offset": old[0], "slope": old[1]},
            "offset": offset, "slope": slope}


def _move_axis_objects(board_id: str, channel: int, old: Tuple[float, float],
                       new: Tuple[float, float]) -> None:
    """ROIs and saved zooms are in axis units: move them to the new axis so they
    stay on the same peaks."""
    if old == new:
        return

    def convert(value: float) -> float:
        raw = (value - old[0]) / old[1]
        return new[0] + new[1] * raw

    try:
        from .histogram_config import get_histogram_config
        get_histogram_config().rescale_axis(board_id, channel, convert)
    except Exception as e:
        logger.warning(f"ROIs of board {board_id} channel {channel} were not moved "
                       f"to the new calibration: {e}")
