"""
Evaluating the configured ROIs, and recording them with the run.

Two jobs, both of which need the server to know what the ROIs are — which it now
does, via histogram_config:

  * `compute_integrals` answers the whole dashboard in one call. The browser used
    to ask for one integral per ROI per tick, and each of those requests read the
    spectrum from the spy socket again: sixteen histograms with three ROIs meant
    forty-eight round trips and forty-eight spy reads every few seconds. Here the
    spectrum is read once per board/channel and every ROI on it is integrated
    from that one copy.

  * `write_run_snapshot` drops a roi.json into the run directory when the run
    ends, so a run carries the regions it was analysed with and their final
    counts. Until now that information only existed in a browser.

Results are shaped {gross, background, net} rather than a bare number. Nothing
computes a background yet — 'background' is None and 'net' equals 'gross' — but
the shape means adding an estimator later changes neither the API nor the files
already written.
"""

import json
import logging
import os
from datetime import datetime
from typing import Any, Dict, List, Optional

from .daq_manager import get_daq_manager
from .histogram_config import get_histogram_config
from .spy_manager import get_spy_manager

logger = logging.getLogger(__name__)

TEST_FLAG = os.getenv('TEST_FLAG', False)
ROI_FILE = "roi.json"

# The run whose ROIs the next stop should record. Captured when the run starts
# because by the time a stop reaches the listeners the run number has already
# been incremented for the next run (experiment.py increments before it calls
# set_running_state(False)), so asking the DAQ manager at stop time names the
# wrong run.
_run_number_at_start: Optional[int] = None


def _integrate(histogram: Any, low: float, high: float) -> float:
    """Counts between two axis values, in whatever units the axis is calibrated in."""
    try:
        return float(histogram.Integral(
            histogram.FindBin(low), histogram.FindBin(high)))
    except Exception as e:
        logger.debug(f"ROI integration failed over [{low}, {high}]: {e}")
        return 0.0


def compute_integrals(visible_only: bool = True,
                      enabled_only: bool = True) -> List[Dict[str, Any]]:
    """
    Every configured ROI's integral, one spectrum read per board/channel.

    Never raises: a board that cannot be read yields zeros for its ROIs rather
    than failing the whole dashboard's update.
    """
    store = get_histogram_config()
    targets = store.integral_targets(visible_only=visible_only,
                                     enabled_only=enabled_only)
    if not targets:
        return []

    spy_mgr = get_spy_manager(test_flag=TEST_FLAG)
    daq_mgr = get_daq_manager(test_flag=TEST_FLAG)
    try:
        boards = daq_mgr.get_boards()
    except Exception as e:
        logger.error(f"Could not read the board configuration: {e}")
        boards = []

    results: List[Dict[str, Any]] = []
    for target in targets:
        histogram = None
        try:
            histogram = spy_mgr.get_histogram(
                target["boardId"], int(target["channel"]), boards)
        except Exception as e:
            logger.error(f"Could not read board {target['boardId']} "
                         f"channel {target['channel']}: {e}")

        for roi in target["rois"]:
            gross = _integrate(histogram, roi["low"], roi["high"]) if histogram else 0.0
            results.append({
                "histogramId": roi["histogramId"],
                "roiId": roi["roiId"],
                "gross": gross,
                # Reserved for the background estimator; see the module docstring.
                "background": None,
                "net": gross,
            })
    return results


def build_snapshot(run_number: int) -> Dict[str, Any]:
    """The full ROI picture for a run: definitions plus their final counts."""
    store = get_histogram_config()
    # Everything defined, not just what happened to be visible and switched on
    # in someone's browser — the record should describe the setup, not the view.
    results = {
        (row["histogramId"], row["roiId"]): row
        for row in compute_integrals(visible_only=False, enabled_only=False)
    }

    histograms = []
    for entry in store.list_histograms():
        rois = []
        for roi in entry["rois"]:
            result = results.get((entry["id"], roi["id"]), {})
            rois.append({
                **roi,
                "gross": result.get("gross"),
                "background": result.get("background"),
                "net": result.get("net"),
            })
        if not rois:
            continue
        histograms.append({
            "id": entry["id"],
            "boardId": entry["boardId"],
            "channel": entry["channel"],
            "label": entry["customLabel"] or entry["label"],
            "rois": rois,
        })

    return {
        "run_number": int(run_number),
        "written_at": datetime.now().astimezone().isoformat(),
        "rebin_factor": store.get_settings().get("rebinFactor", 1),
        "histograms": histograms,
    }


def write_run_snapshot(run_number: int) -> Optional[str]:
    """
    Write data/run<N>/roi.json. Returns the path, or None if there was nothing
    to write or the run has no directory (a run that saved no data).
    """
    from . import run_data

    snapshot = build_snapshot(run_number)
    if not snapshot["histograms"]:
        return None

    directory = run_data.run_dir(run_number)
    if not os.path.isdir(directory):
        logger.info(f"Run {run_number} has no data directory; not writing {ROI_FILE}")
        return None

    path = os.path.join(directory, ROI_FILE)
    try:
        with open(path, "w") as f:
            json.dump(snapshot, f, indent=2)
        logger.info(f"Wrote {path} with "
                    f"{sum(len(h['rois']) for h in snapshot['histograms'])} ROIs")
        return path
    except OSError as e:
        logger.error(f"Could not write {path}: {e}")
        return None


def _on_run_state_changed(running: bool) -> None:
    global _run_number_at_start

    daq_mgr = get_daq_manager(test_flag=TEST_FLAG)
    if running:
        try:
            _run_number_at_start = int(daq_mgr.get_run_number())
        except (TypeError, ValueError):
            _run_number_at_start = None
        return

    run_number = _run_number_at_start
    _run_number_at_start = None
    if run_number is None:
        return
    try:
        write_run_snapshot(run_number)
    except Exception as e:
        # A failed snapshot must never be able to disturb stopping a run.
        logger.error(f"Could not record the ROIs for run {run_number}: {e}")


_registered = False


def register_run_hook() -> None:
    """Record the ROIs whenever a run ends, however it was stopped."""
    global _registered
    if _registered:
        return
    get_daq_manager(test_flag=TEST_FLAG).add_run_state_listener(_on_run_state_changed)
    _registered = True
    # A server that restarts mid-run still knows which run to record at its end.
    daq_mgr = get_daq_manager(test_flag=TEST_FLAG)
    if daq_mgr.is_running():
        try:
            globals()['_run_number_at_start'] = int(daq_mgr.get_run_number())
        except (TypeError, ValueError):
            pass
