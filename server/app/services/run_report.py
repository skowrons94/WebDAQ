"""
Turn a finished run into a draft ELOG entry.

Everything needed to write up a run is already on disk by the time it stops —
the database row, the run's ``metadata.json``, the logged beam current, the
accelerator readings and any ROIs that were defined. Writing that out by hand is
the part of a shift nobody enjoys and the part most likely to be skipped, so this
assembles it into a body text and a set of ELOG attributes.

The result is a *draft*: the operator sees it in the composer and edits it before
posting. Nothing here is authoritative — it only reports what the run recorded.

The attribute mapping is deliberately by keyword rather than by exact name. Every
LUNA logbook names its fields slightly differently ('Probe Voltage (V)' in one,
'Extraction Voltage (kV)' in another, 'Run name' vs 'Run Name'), and the composer
learns the real field list from the logbook itself, so this matches whatever it
is handed instead of hard-coding one logbook's schema.
"""

import csv
import json
import logging
import os
import re
from datetime import datetime
from typing import Any, Dict, List, Optional, Sequence

from . import run_data

logger = logging.getLogger(__name__)

STATS_FILE = "stats.csv"
ROI_FILE = "roi.json"

# Below this mean current a run is treated as beam-off when choosing a category.
_BEAM_ON_UA = 1e-3


# ───────────────────────────────────────────────────────────────── formatting

def _norm(text: str) -> str:
    """Fold a field label to lowercase words, so labels can be matched loosely."""
    return re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).strip()


def _duration(seconds: Optional[float]) -> str:
    if not seconds or seconds < 0:
        return "-"
    seconds = int(round(seconds))
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    if hours:
        return f"{hours}h {minutes:02d}m {secs:02d}s"
    if minutes:
        return f"{minutes}m {secs:02d}s"
    return f"{secs}s"


def _stamp(value: Optional[datetime]) -> str:
    return value.strftime("%Y-%m-%d %H:%M:%S") if value else "-"


def _bytes(n: int) -> str:
    size = float(n or 0)
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if size < 1024 or unit == "TiB":
            return f"{size:.1f} {unit}" if unit != "B" else f"{int(size)} B"
        size /= 1024
    return f"{size:.1f} TiB"


def _number(value: Any, digits: int = 3) -> str:
    """A number an operator can read: no 1.2000000000000002, no 0.00000e+00."""
    if value is None:
        return "-"
    try:
        value = float(value)
    except (TypeError, ValueError):
        return str(value)
    if value == 0:
        return "0"
    if 1e-3 <= abs(value) < 1e6:
        text = f"{value:.{digits}f}"
        # Drop trailing zeros only past the decimal point, so 120.0 stays 120.
        return text.rstrip("0").rstrip(".") if "." in text else text
    return f"{value:.{digits}e}"


def _table(rows: Sequence[Sequence[str]]) -> List[str]:
    """Left-aligned two-or-more column block, padded to line up."""
    if not rows:
        return []
    widths = [max(len(str(r[i])) for r in rows) for i in range(len(rows[0]))]
    return ["  ".join(str(cell).ljust(widths[i]) for i, cell in enumerate(row)).rstrip()
            for row in rows]


# ─────────────────────────────────────────────────────────── on-disk readers

def read_stats(run_number: int) -> Dict[str, Any]:
    """
    The accelerator readings logged during the run.

    stats.csv carries a commented preamble naming each metric, then one row per
    sample. Only columns that actually varied are worth reporting, so each is
    summarised by min/mean/max and constant-zero ones are flagged as not read.
    """
    path = os.path.join(run_data.run_dir(run_number), STATS_FILE)
    out: Dict[str, Any] = {"available": False, "metrics": [], "n_samples": 0}
    if not os.path.isfile(path):
        return out

    header: List[str] = []
    rows: List[List[float]] = []
    try:
        with open(path, "r") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = next(csv.reader([line]))
                if not header:
                    # The first non-comment line names the columns.
                    header = [p.strip() for p in parts]
                    continue
                try:
                    rows.append([float(p) for p in parts])
                except ValueError:
                    continue
    except OSError as e:
        logger.warning(f"Could not read {path}: {e}")
        return out

    if not header or not rows:
        return out

    out["available"] = True
    out["n_samples"] = len(rows)
    for col in range(1, len(header)):
        values = [r[col] for r in rows if col < len(r)]
        if not values:
            continue
        out["metrics"].append({
            "name": header[col],
            "min": min(values),
            "max": max(values),
            "mean": sum(values) / len(values),
            # A channel that never moved off zero was almost certainly not read
            # at all, which is worth saying rather than reporting "0.0".
            "recorded": any(v != 0 for v in values),
        })
    return out


def read_rois(run_number: int) -> Dict[str, Any]:
    """Regions of interest defined for the run, with their counts."""
    path = os.path.join(run_data.run_dir(run_number), ROI_FILE)
    out: Dict[str, Any] = {"available": False, "regions": []}
    if not os.path.isfile(path):
        return out
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        logger.warning(f"Could not read {path}: {e}")
        return out

    for histogram in data.get("histograms", []) or []:
        label = histogram.get("label") or f"board {histogram.get('boardId')} ch {histogram.get('channel')}"
        for roi in histogram.get("rois", []) or []:
            if not roi.get("enabled", True):
                continue
            out["regions"].append({
                "detector": label,
                "name": roi.get("name", ""),
                "low": roi.get("low"),
                "high": roi.get("high"),
                "gross": roi.get("gross"),
                "net": roi.get("net"),
                "background": roi.get("background"),
            })
    out["available"] = bool(out["regions"])
    out["rebin_factor"] = data.get("rebin_factor")
    return out


def read_run_metadata_file(run_number: int) -> Dict[str, Any]:
    """The metadata.json snapshot written when the run stopped."""
    path = os.path.join(run_data.run_dir(run_number), run_data.METADATA_FILE)
    if not os.path.isfile(path):
        return {}
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        logger.warning(f"Could not read {path}: {e}")
        return {}


# ───────────────────────────────────────────────────────────── the body text

def _build_text(run, facts: Dict[str, Any]) -> str:
    current = facts["current"]
    stats = facts["stats"]
    rois = facts["rois"]
    files = facts["files"]
    snapshot = facts["snapshot"]

    lines: List[str] = []
    heading = f"Run {facts['run_number']}"
    if run is not None and run.run_type:
        heading += f" — {run.run_type}"
    lines.append(heading)
    lines.append("=" * len(heading))
    lines.append("")

    # ── what the run was ──────────────────────────────────────────────────
    summary = [
        ["Start", _stamp(getattr(run, "start_time", None))],
        ["Stop", _stamp(getattr(run, "end_time", None))],
        ["Duration", _duration(facts["duration_s"])],
    ]
    if run is not None:
        if run.run_type:
            summary.append(["Run type", str(run.run_type)])
        if run.target_name:
            summary.append(["Target", str(run.target_name)])
        if run.terminal_voltage is not None:
            summary.append(["Terminal voltage", f"{_number(run.terminal_voltage)} kV"])
        if run.probe_voltage is not None:
            summary.append(["Probe voltage", f"{_number(run.probe_voltage)} V"])
        if run.flag:
            summary.append(["Flag", str(run.flag)])
    lines += _table(summary)
    lines.append("")

    # ── beam ──────────────────────────────────────────────────────────────
    integration = (current or {}).get("integration") or {}
    channels = integration.get("channels") or []
    if channels:
        lines.append("Beam current")
        rows = [["  Channel", "Mean", "Charge"]]
        for channel in channels:
            rows.append([
                f"  {channel['name']}",
                f"{_number(channel['mean_current_uA'])} uA",
                f"{_number(channel['charge_uC'])} uC",
            ])
        lines += _table(rows)
        lines.append(f"  Integrated over {_duration(integration.get('duration_s'))} "
                     f"from {current.get('n_samples', 0)} samples "
                     f"({integration.get('method', 'trapezoidal')} rule)")
        lines.append("")
    elif run is not None and run.accumulated_charge is not None:
        lines.append(f"Accumulated charge  {_number(run.accumulated_charge)} uC")
        lines.append("")

    # ── accelerator ───────────────────────────────────────────────────────
    if stats.get("available"):
        recorded = [m for m in stats["metrics"] if m["recorded"]]
        missing = [m for m in stats["metrics"] if not m["recorded"]]
        if recorded or missing:
            lines.append("Accelerator")
        if recorded:
            rows = [["  Metric", "Min", "Mean", "Max"]]
            for metric in recorded:
                rows.append([f"  {metric['name']}", _number(metric["min"]),
                             _number(metric["mean"]), _number(metric["max"])])
            lines += _table(rows)
        if missing:
            # Flat zero for a whole run means the reading never arrived, which is
            # a different statement from "the voltage was zero".
            lines.append(f"  No readings logged: {', '.join(m['name'] for m in missing)}")
        if recorded or missing:
            lines.append("")

    # ── regions of interest ───────────────────────────────────────────────
    if rois.get("available"):
        lines.append("Regions of interest")
        rows = [["  Detector", "Region", "Range", "Gross", "Net"]]
        for region in rois["regions"]:
            rows.append([
                f"  {region['detector']}",
                region["name"],
                f"{_number(region['low'], 1)}-{_number(region['high'], 1)}",
                _number(region["gross"], 0),
                _number(region["net"], 0),
            ])
        lines += _table(rows)
        lines.append("")

    # ── how it was taken ──────────────────────────────────────────────────
    boards = (run.get_board_info() if run is not None else []) or snapshot.get("Acquisition", {}).get("Boards", [])
    versions = (run.get_software_versions() if run is not None else {}) or \
        snapshot.get("Acquisition", {}).get("Software", {})
    acquisition: List[List[str]] = []
    if boards:
        models = sorted({b.get("model_name", "?") for b in boards})
        acquisition.append(["Boards", f"{len(boards)} x {', '.join(models)}"])
    sync = (run.sync_mode if run is not None else None) or \
        snapshot.get("Acquisition", {}).get("Synchronisation")
    if sync:
        acquisition.append(["Synchronisation", str(sync)])
    if versions:
        parts = [f"WebDAQ {versions['webdaq']}"] if versions.get("webdaq") else []
        if versions.get("caendaq"):
            parts.append(f"caendaq {versions['caendaq']}")
        if parts:
            acquisition.append(["Software", ", ".join(parts)])
    if files.get("data"):
        acquisition.append(["Data files",
                            f"{len(files['data'])} ({_bytes(files.get('total_bytes', 0))} total)"])
    if acquisition:
        lines.append("Acquisition")
        lines += _table([["  " + row[0], row[1]] for row in acquisition])
        lines.append("")

    # ── the shift's own words ─────────────────────────────────────────────
    if run is not None and run.notes:
        lines.append("Notes")
        lines += [f"  {line}" for line in str(run.notes).splitlines()]
        lines.append("")

    lines.append(f"-- drafted by WebDAQ from {run_data.run_dir(facts['run_number'])}")
    return "\n".join(lines)


# ───────────────────────────────────────────────────────── attribute mapping

def _charge_in(label: str, charge_uC: Optional[float]) -> Optional[str]:
    """Express the accumulated charge in whatever unit the field's label names."""
    if charge_uC is None:
        return None
    unit = _norm(label)
    # A field counting integrator pulses is not a charge we can convert to, so
    # leave it for the operator rather than filling in microcoulombs mislabelled.
    if re.search(r"\bcts\b|\bcounts\b", unit):
        return None
    if re.search(r"\bnc\b", unit):
        return _number(charge_uC * 1e3)
    if re.search(r"\bmc\b", unit):
        return _number(charge_uC * 1e-3)
    if re.search(r"\bc\b", unit):
        return _number(charge_uC * 1e-6)
    # 'uC', 'µC' or no unit at all: report the stored microcoulombs.
    return _number(charge_uC)


def _pick_option(options: Sequence[str], *wanted: str) -> Optional[str]:
    """
    The option that unambiguously means one of ``wanted``, or None.

    Matching is deliberately conservative — every word of the wanted phrase has
    to appear in the option. A loose substring match happily reads 'measurement
    beam off' as a logbook's unrelated 'NRA measurements' category, and a wrong
    value pre-filled is worse than an empty one the operator has to think about.
    """
    if not options:
        return None
    for want in wanted:
        target = _norm(want)
        if not target:
            continue
        for option in options:
            if _norm(option) == target:
                return option
        words = set(target.split())
        for option in options:
            if words and words <= set(_norm(option).split()):
                return option
    return None


def _map_attributes(run, facts: Dict[str, Any], fields: Sequence[Dict[str, Any]]) -> Dict[str, str]:
    """
    Fill in whichever of the logbook's fields this run can answer.

    Fields the run says nothing about are left alone for the operator, and
    enumerated fields are only set to a value the logbook actually offers.
    """
    run_number = facts["run_number"]
    integration = (facts["current"] or {}).get("integration") or {}
    channels = integration.get("channels") or []
    total_charge = (run.accumulated_charge if run is not None else None)
    if total_charge is None and channels:
        total_charge = sum(c["charge_uC"] for c in channels)
    mean_current = max((c["mean_current_uA"] for c in channels), default=0.0)
    beam_on = mean_current > _BEAM_ON_UA

    run_type = (run.run_type if run is not None else "") or ""
    target = (run.target_name if run is not None else "") or ""

    subject = f"Run {run_number}"
    if run_type:
        subject += f" - {run_type}"
    if target:
        subject += f" on {target}"

    attributes: Dict[str, str] = {}
    for field in fields:
        label = field.get("label") or field.get("name") or ""
        key = field.get("label") or field.get("name")
        if not key:
            continue
        options = field.get("options") or []
        name = _norm(label)
        value: Optional[str] = None

        if name in ("subject", "title"):
            value = subject
        elif "run name" in name or name in ("run", "run number", "run no"):
            value = str(run_number)
        elif name == "type" or name.endswith(" type"):
            value = _pick_option(options, run_type) if options else (run_type or None)
        elif name == "category":
            # Only when the logbook's categories are actually about beam state;
            # many are subject areas instead, where any guess would be wrong.
            beam_state = "measurement beam off" if (run_type == "background" or not beam_on) \
                else "measurement beam on"
            value = _pick_option(options, beam_state, run_type) if options else None
        elif re.match(r"^i[ _](upstream|downstream|tube|target|beam)", name):
            # A per-electrode current, not the target material: fill it only from
            # a current channel actually named for that electrode.
            match = next((c for c in channels if _norm(c["name"]) in name), None)
            value = _number(match["mean_current_uA"]) if match else None
        elif "target" in name:
            value = target or None
        elif "terminal voltage" in name:
            value = _number(run.terminal_voltage) if run is not None and run.terminal_voltage is not None else None
        elif "extraction voltage" in name or "probe voltage" in name:
            value = _number(run.probe_voltage) if run is not None and run.probe_voltage is not None else None
        elif "realtime" in name:
            value = _number(facts["duration_s"], 1) if facts["duration_s"] else None
        elif "charge" in name:
            value = _charge_in(label, total_charge)
        elif name in ("shifters", "operators", "shifter", "operator"):
            value = None          # a person's name is not ours to invent

        if value not in (None, ""):
            attributes[key] = str(value)
    return attributes


# ───────────────────────────────────────────────────────────────── the draft

def build_draft(run_number: int, fields: Optional[Sequence[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """
    A ready-to-edit ELOG entry for one run.

    Args:
        run_number: the run to describe
        fields: the logbook's field definitions, from ElogClient.describe_fields.
                Attributes are only produced for fields that exist there.

    Returns a dict with the body ``text``, the prefilled ``attributes``, and a
    ``sources`` map saying which inputs were actually found — so the composer can
    tell the operator that, say, there was no current log for this run.
    """
    # Imported here: this module is also useful without an application context.
    from ..models.run_metadata import RunMetadata

    run = RunMetadata.query.filter_by(run_number=run_number).first()
    directory_exists = run_data.run_exists(run_number)
    if run is None and not directory_exists:
        raise LookupError(f"Run {run_number} has neither a database record nor a directory")

    snapshot = read_run_metadata_file(run_number)
    files = run_data.list_files(run_number)
    current = run_data.read_current(run_number, max_points=100) if files.get("current") else {}
    stats = read_stats(run_number)
    rois = read_rois(run_number)

    duration = None
    if run is not None and run.start_time and run.end_time:
        duration = (run.end_time - run.start_time).total_seconds()
    if duration is None:
        duration = snapshot.get("Duration (s)")
    if duration is None:
        duration = ((current or {}).get("integration") or {}).get("duration_s")

    facts = {
        "run_number": run_number,
        "duration_s": duration,
        "current": current,
        "stats": stats,
        "rois": rois,
        "files": files,
        "snapshot": snapshot,
    }

    return {
        "run_number": run_number,
        "text": _build_text(run, facts),
        "attributes": _map_attributes(run, facts, fields or []),
        "sources": {
            "database": run is not None,
            "directory": directory_exists,
            "metadata": bool(snapshot),
            "current": bool((current or {}).get("available")),
            "stats": bool(stats.get("available")),
            "rois": bool(rois.get("available")),
        },
    }
