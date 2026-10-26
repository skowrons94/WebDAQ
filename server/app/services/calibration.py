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
    # Beam-induced lines seen at LUNA, from contaminants hit by the proton
    # beam: gamma energies (recoil-corrected, not level energies) from ENSDF.
    # Capture lines whose energy follows the beam energy are left out.
    {"name": "Li-7, 7Li(p,p'g)", "energy": 477.60},
    {"name": "Ne-20, 23Na(p,ag)", "energy": 1633.67},
    {"name": "Si-28, 27Al(p,g)", "energy": 1778.97},
    {"name": "C-12, 15N(p,ag) / 11B", "energy": 4438.94},
    {"name": "O-16, 19F(p,ag)", "energy": 6128.63},
    {"name": "O-16, 19F(p,ag)", "energy": 6915.5},
    {"name": "O-16, 19F(p,ag)", "energy": 7115.15},
    # 14N(p,g)15O campaign. Gamma energies (recoil-corrected) from ENSDF,
    # adopted 15O levels and gammas (Ajzenberg-Selove 1991), via the IAEA
    # LiveChart API. The ground-state decays of the 6.79, 6.18 and 5.18 MeV
    # levels follow every capture to them, whatever the beam energy (ENSDF
    # puts the 6.18 MeV level at 6176.3(17) keV; recent LUNA work quotes 6172).
    # These are energies at rest: in beam the 15O recoil moves at beta ~ 0.002,
    # which shifts a 6.79 MeV gamma by up to ~13 keV in a forward detector, so
    # they calibrate a detector at 90 degrees, or one corrected for the shift.
    {"name": "O-15, 14N(p,g) 6.79 MeV level (at rest)", "energy": 6791.4},
    {"name": "O-15, 14N(p,g) 6.18 MeV level (at rest)", "energy": 6174.9},
    {"name": "O-15, 14N(p,g) 5.18 MeV level (at rest)", "energy": 5182.0},
    # On the Ep = 278 keV resonance (the 7556.5 keV level) the primaries have
    # fixed energies too.
    {"name": "O-15, 14N(p,g) 278 keV res. -> 6.18 (at rest)", "energy": 1380.1},
    {"name": "O-15, 14N(p,g) 278 keV res. -> 6.79 (at rest)", "energy": 763.4},
    {"name": "O-15, 14N(p,g) 278 keV res. -> 5.18 (at rest)", "energy": 2373.3},
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
    return read_table_file(path, channels)


def read_table_file(path: str, channels: int) -> List[Tuple[float, float]]:
    """The table of one .cal file wherever it is: calib/ for the live one, a
    run directory for the copy that run was taken with."""
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


# Peak channels are the integer energy values (bin k holds value k). Until
# WebDAQ 5.0 the fit worked on bin centres, k + 0.5, so its points and the
# calibrations solved from them sit half a channel off this convention.
CONVENTION = "value"


def migrate_bin_centre_calibrations() -> List[str]:
    """Bring calibrations made by the old fit (points without a convention) to
    the integer-value convention, once: each point's channel moves down by half
    a channel and, where the .cal line is still the one solved from those
    points, its offset moves up by slope / 2, so every spectrum and ROI stays
    where it was shown. Calibrations typed in by hand are left alone."""
    done: List[str] = []
    if not os.path.isdir(CALIB_DIR):
        return done
    with _lock:
        for fname in sorted(os.listdir(CALIB_DIR)):
            if not fname.endswith(".points.json"):
                continue
            base = fname[:-len(".points.json")]
            name, _, bid = base.rpartition("_")
            stored = read_points(name, bid)
            old = {ch: e for ch, e in stored.items()
                   if isinstance(e, dict) and e.get("convention") != CONVENTION}
            if not old:
                continue
            cal_path, points_path = _paths(name, bid)
            try:
                with open(cal_path) as f:
                    rows = sum(1 for line in f if line.strip())
            except OSError:
                rows = 0
            table = read_table(name, bid, max(rows, max(int(c) for c in old) + 1))
            for ch, entry in old.items():
                for pt in entry.get("points") or []:
                    if isinstance(pt.get("channel"), (int, float)):
                        pt["channel"] = float(pt["channel"]) - 0.5
                o, sl = table[int(ch)]
                if np.isclose(o, entry.get("offset", np.nan)) and np.isclose(sl, entry.get("slope", np.nan)):
                    table[int(ch)] = (o + sl / 2, sl)
                    entry["offset"] = o + sl / 2
                    done.append(f"{base} channel {ch}: offset {o:g} -> {o + sl / 2:g}")
                entry["convention"] = CONVENTION
            if os.path.exists(cal_path):
                _atomic_write(cal_path, "".join(f"{o!r} {s!r}\n" for o, s in table))
            _atomic_write(points_path, json.dumps(stored, indent=2))
    for line in done:
        logger.warning(f"Calibration moved to the integer-value convention: {line}")
    return done


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
    # Bin k holds the integer energy value k, so x = k: the centroid is then
    # in the same units as the Energy values of the run files, and
    # E = offset + slope * Energy holds offline as it does online.
    x = np.arange(lo, hi, dtype=float)

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

    # The Gaussian integrated over each channel (value k collects [k-0.5, k+0.5)),
    # so a line a channel or two wide (a pulser) is fitted as well as a broad one.
    from scipy.special import erf

    def model(x, area, mu, sigma, c0, c1):
        z = np.sqrt(2.0) * sigma
        return 0.5 * area * (erf((x + 0.5 - mu) / z) - erf((x - 0.5 - mu) / z)) + c0 + c1 * x

    err = np.sqrt(np.maximum(y, 1.0))
    p0 = [amp * sigma0 * np.sqrt(2 * np.pi), x[top], sigma0, b0, b1]
    bounds = ([0.0, lo - 0.5, 0.05, -np.inf, -np.inf], [np.inf, hi - 0.5, np.inf, np.inf, np.inf])
    try:
        p, cov = curve_fit(model, x, y, p0=p0, sigma=err, absolute_sigma=True,
                           bounds=bounds, maxfev=5000)
    except Exception:
        raise ValueError("The fit did not converge: zoom so the peak fills most of the view")
    area, mu, sigma = p[0], p[1], abs(p[2])
    perr = np.sqrt(np.clip(np.diag(cov), 0, None)) if cov is not None and np.all(np.isfinite(cov)) else [np.nan] * 5
    if not (lo - 0.5 <= mu <= hi - 0.5) or area <= 0 or not np.isfinite(mu):
        raise ValueError("No peak found in this range")
    mu_err = float(perr[1])
    if sigma < 0.5:
        # Narrower than a channel: the shape no longer tells where in the
        # channel the line sits. Its counts do: their mean, known to within
        # the channel's own width (1/sqrt(12)) at best.
        # Only the channels next to the line: over a wide zoom the noise of
        # the background, clipped at zero, would pull the mean to the middle.
        near = np.abs(x - mu) <= 2
        w = np.where(near, np.clip(y - (p[3] + p[4] * x), 0, None), 0.0)
        if w.sum() > 0:
            mu = float((w * x).sum() / w.sum())
            spread = float(np.sqrt((w * (x - mu) ** 2).sum() / w.sum()))
            mu_err = max(spread / np.sqrt(w.sum()), 1 / np.sqrt(12))
    chi2 = float((((y - model(x, *p)) / err) ** 2).sum())
    ndf = max(1, len(x) - 5)
    return {
        "centroid": float(mu),
        "centroid_error": mu_err,
        "sigma": float(sigma),
        "fwhm": float(2.3548 * sigma),
        "area": float(area),
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
                                    "convention": CONVENTION,
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

    # An uncalibrated axis shows bin k (energy value k) at k + 0.5, a
    # calibrated one at offset + slope * k (spy_manager.calibrate_x_axis).
    def to_value(axis: float, cal: Tuple[float, float]) -> float:
        return axis - 0.5 if cal == (0.0, 1.0) else (axis - cal[0]) / cal[1]

    def to_axis(value: float, cal: Tuple[float, float]) -> float:
        return value + 0.5 if cal == (0.0, 1.0) else cal[0] + cal[1] * value

    def convert(axis: float) -> float:
        return to_axis(to_value(axis, old), new)

    try:
        from .histogram_config import get_histogram_config
        get_histogram_config().rescale_axis(board_id, channel, convert)
    except Exception as e:
        logger.warning(f"ROIs of board {board_id} channel {channel} were not moved "
                       f"to the new calibration: {e}")
