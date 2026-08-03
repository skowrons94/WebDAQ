"""Keep the portable run-directory metadata snapshot in sync with SQLite.

SQLite remains the application's live source of truth, while ``metadata.json``
makes a copied or archived run directory self-describing.  Every metadata
mutation should call :func:`sync_run_metadata_file` after its database commit.
"""

import json
import logging
import os
import tempfile
from datetime import datetime
from typing import Any, Dict, List, Optional

from . import run_data

logger = logging.getLogger(__name__)

METADATA_SCHEMA_VERSION = 1
METADATA_FILENAME = "metadata.json"


def _isoformat(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() if value else None


def _artifact_role(name: str) -> str:
    if name.endswith(".caendat"):
        return "raw-data"
    if name.endswith(".root"):
        return "root"
    if name == run_data.CURRENT_FILE:
        return "beam-current"
    if name == "stats.csv":
        return "statistics"
    if name.endswith(".json"):
        return "board-configuration"
    return "other"


def _artifact_manifest(directory: str) -> List[Dict[str, Any]]:
    """Describe every run artifact other than the manifest file itself."""
    artifacts: List[Dict[str, Any]] = []
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        return artifacts

    for name in names:
        path = os.path.join(directory, name)
        if name == METADATA_FILENAME or name.startswith(".metadata."):
            continue
        if not os.path.isfile(path):
            continue
        try:
            size = os.path.getsize(path)
        except OSError:
            size = 0
        artifacts.append({
            "Name": name,
            "Role": _artifact_role(name),
            "Bytes": size,
        })
    return artifacts


def build_run_metadata_snapshot(run_metadata, directory: Optional[str] = None) -> Dict[str, Any]:
    """Build the complete, versioned metadata document for one run."""
    directory = directory or run_data.run_dir(run_metadata.run_number)
    artifacts = _artifact_manifest(directory)

    by_role: Dict[str, List[str]] = {}
    for artifact in artifacts:
        by_role.setdefault(artifact["Role"], []).append(artifact["Name"])

    duration = None
    if run_metadata.start_time and run_metadata.end_time:
        duration = round(
            (run_metadata.end_time - run_metadata.start_time).total_seconds(), 3)

    return {
        "Schema Version": METADATA_SCHEMA_VERSION,
        "Updated At": datetime.now().isoformat(),
        "Run Number": run_metadata.run_number,
        "Start Time": _isoformat(run_metadata.start_time),
        "Stop Time": _isoformat(run_metadata.end_time),
        "Duration (s)": duration,
        "Terminal Voltage": run_metadata.terminal_voltage,
        "Probe Voltage": run_metadata.probe_voltage,
        "Run Type": run_metadata.run_type,
        "Target Name": run_metadata.target_name,
        "Accumulated Charge": run_metadata.accumulated_charge,
        "User ID": run_metadata.user_id,
        "Notes": run_metadata.notes,
        "Flag": run_metadata.flag,
        "Acquisition": {
            "Synchronisation": run_metadata.sync_mode or "independent",
            "Software": run_metadata.get_software_versions(),
            "Boards": run_metadata.get_board_info(),
        },
        "Files": {
            # Keep the original keys for readers of the earlier unversioned
            # metadata format, and add the other run artifacts alongside them.
            "Data": by_role.get("raw-data", []),
            "Board Configuration": by_role.get("board-configuration", []),
            "Current": by_role.get("beam-current", []),
            "Statistics": by_role.get("statistics", []),
            "ROOT": by_role.get("root", []),
            "Other": by_role.get("other", []),
            "Metadata": METADATA_FILENAME,
            "Total Artifact Bytes": sum(item["Bytes"] for item in artifacts),
            "Manifest": artifacts,
        },
    }


def sync_run_metadata_file(run_metadata) -> bool:
    """Atomically replace a run's ``metadata.json`` with its current snapshot.

    A missing run directory is legitimate for old database-only records, so it
    is logged and reported to the caller without creating a misleading empty
    dataset.  ``os.replace`` ensures readers see either the previous complete
    JSON document or the new one, never a half-written file.
    """
    directory = run_data.run_dir(run_metadata.run_number)
    if not os.path.isdir(directory):
        logger.warning(
            "Cannot update metadata.json for run %s: %s does not exist",
            run_metadata.run_number,
            directory,
        )
        return False

    temp_path = None
    try:
        snapshot = build_run_metadata_snapshot(run_metadata, directory)
        fd, temp_path = tempfile.mkstemp(
            prefix=".metadata.", suffix=".tmp", dir=directory, text=True)
        with os.fdopen(fd, "w") as output:
            json.dump(snapshot, output, indent=4, ensure_ascii=False)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temp_path, os.path.join(directory, METADATA_FILENAME))
        return True
    except Exception:
        logger.exception(
            "Could not update metadata.json for run %s", run_metadata.run_number)
        return False
    finally:
        if temp_path and os.path.exists(temp_path):
            try:
                os.unlink(temp_path)
            except OSError:
                logger.warning("Could not remove temporary metadata file %s", temp_path)
