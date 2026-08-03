"""
The histogram dashboard's configuration, owned by the server.

Which histograms exist, what they are called, which ROIs are drawn on them and
where each one is zoomed used to live in the browser and be persisted to the
*web* server's working directory (frontend/cache/*.json). That put it in the one
process that knows nothing about boards, runs or the run directory, with three
consequences this module exists to remove:

  * the DAQ server could not record a run's ROIs, because it could not see them;
  * every browser kept its own copy, so two operators saw two dashboards;
  * the definitions were declared three times in TypeScript and drifted.

Configuration lives in conf/histograms.json, next to the board and system
settings, so it survives a restart and can be copied between setups or edited by
hand. Writes are atomic and serialised: the dashboard saves on every ROI edit and
every zoom, and a half-written file would lose the lot.

ROI records carry an optional 'background' field that nothing computes yet. It is
here so that adding a background estimator later is a change to spy_manager and
the UI, not a migration of everyone's stored configuration.
"""

import json
import logging
import os
import threading
import uuid
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

CONFIG_PATH = os.path.join("conf", "histograms.json")
SCHEMA_VERSION = 1

DEFAULT_SETTINGS: Dict[str, Any] = {
    "layout": "grid",
    "gridCols": 3,
    "isLogScale": False,
    "syncZoom": False,
    "showLabels": True,
    "showROIs": True,
    "showIntegrals": True,
    "autoUpdate": True,
    "updateInterval": 5000,
    "theme": "auto",
    "rebinFactor": 1,
}

# The hex values ROOT's colour converter recognises. Anything else falls back to
# red once it reaches the canvas, so it is not worth storing.
DEFAULT_ROI_COLOR = "#ff0000"

_SIZES = ("small", "medium", "large")


def _as_bool(value: Any, fallback: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return fallback


def _as_int(value: Any, fallback: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _as_float(value: Any, fallback: Optional[float]) -> Optional[float]:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return fallback
    return result if result == result else fallback  # reject NaN


class HistogramConfigStore:
    """Thread-safe, file-backed store for the histogram dashboard."""

    def __init__(self, path: str = CONFIG_PATH):
        self.path = path
        self._lock = threading.RLock()
        self._config = self._load()

    # ────────────────────────────────────────────────────────────────── loading

    def _load(self) -> Dict[str, Any]:
        if os.path.exists(self.path):
            try:
                with open(self.path) as f:
                    return self._normalise(json.load(f))
            except (OSError, ValueError) as e:
                logger.error(f"Could not read {self.path}, starting empty: {e}")
                return self._normalise({})

        imported = _import_from_frontend_cache()
        config = self._normalise(imported or {})
        self._write(config)
        if imported:
            logger.info(
                f"Imported {len(config['histograms'])} histograms from the "
                f"frontend cache into {self.path}")
        return config

    # ─────────────────────────────────────────────────────────── normalisation

    def _normalise(self, raw: Any) -> Dict[str, Any]:
        """Coerce anything file-shaped into the current schema.

        Everything reaching the store — a hand-edited file, an imported cache, a
        PUT from the dashboard — goes through here, so the rest of the module can
        assume well-formed records and the routes need no validation of their own.
        """
        raw = raw if isinstance(raw, dict) else {}

        settings = dict(DEFAULT_SETTINGS)
        for key, value in (raw.get("settings") or {}).items():
            if key not in DEFAULT_SETTINGS:
                continue
            default = DEFAULT_SETTINGS[key]
            if isinstance(default, bool):
                settings[key] = _as_bool(value, default)
            elif isinstance(default, int):
                settings[key] = _as_int(value, default)
            else:
                settings[key] = str(value) if value is not None else default
        settings["gridCols"] = max(1, min(6, settings["gridCols"]))
        settings["rebinFactor"] = max(1, settings["rebinFactor"])
        # Below a second the dashboard spends its time waiting on itself.
        settings["updateInterval"] = max(500, settings["updateInterval"])
        if settings["layout"] not in ("grid", "rows", "custom"):
            settings["layout"] = "grid"
        if settings["theme"] not in ("auto", "light", "dark"):
            settings["theme"] = "auto"

        histograms = [
            self._normalise_histogram(entry, index)
            for index, entry in enumerate(raw.get("histograms") or [])
            if isinstance(entry, dict)
        ]

        return {
            "version": SCHEMA_VERSION,
            "settings": settings,
            "histograms": histograms,
        }

    def _normalise_histogram(self, raw: Dict[str, Any], index: int) -> Dict[str, Any]:
        board_id = str(raw.get("boardId", raw.get("board_id", "")) or "")
        channel = _as_int(raw.get("channel"), 0)
        size = raw.get("size") if raw.get("size") in _SIZES else "medium"
        position = raw.get("position") if isinstance(raw.get("position"), dict) else {}

        return {
            "id": str(raw.get("id") or f"hist_{uuid.uuid4().hex[:12]}"),
            "boardId": board_id,
            "channel": channel,
            "visible": _as_bool(raw.get("visible"), True),
            "size": size,
            "label": str(raw.get("label") or f"Board {board_id} - Channel {channel}"),
            "customLabel": str(raw.get("customLabel") or ""),
            "order": _as_int(raw.get("order"), index),
            "position": {
                "row": _as_int(position.get("row"), 0),
                "col": _as_int(position.get("col"), 0),
            },
            # 'zoomRange' was the browser's name for it; accept both so an
            # imported cache does not lose the operator's zooms.
            "zoom": self._normalise_zoom(raw.get("zoom", raw.get("zoomRange"))),
            "rois": [
                self._normalise_roi(entry)
                for entry in (raw.get("rois") or [])
                if isinstance(entry, dict)
            ],
        }

    @staticmethod
    def _normalise_zoom(raw: Any) -> Optional[Dict[str, float]]:
        if not isinstance(raw, dict):
            return None
        zoom = {}
        for axis in ("xmin", "xmax", "ymin", "ymax"):
            value = _as_float(raw.get(axis), None)
            if value is not None:
                zoom[axis] = value
        # A zoom with no usable bound is not a zoom.
        if "xmin" not in zoom or "xmax" not in zoom or zoom["xmin"] >= zoom["xmax"]:
            return None
        return zoom

    @staticmethod
    def _normalise_roi(raw: Dict[str, Any]) -> Dict[str, Any]:
        low = _as_float(raw.get("low"), 0.0) or 0.0
        high = _as_float(raw.get("high"), 0.0) or 0.0
        if high < low:
            low, high = high, low
        background = raw.get("background")
        return {
            "id": str(raw.get("id") or f"roi_{uuid.uuid4().hex[:12]}"),
            "name": str(raw.get("name") or "ROI"),
            "low": low,
            "high": high,
            "color": str(raw.get("color") or DEFAULT_ROI_COLOR),
            "enabled": _as_bool(raw.get("enabled"), True),
            # Reserved for the background estimator. Stored verbatim so a future
            # model can define its own shape without a migration.
            "background": background if isinstance(background, dict) else None,
        }

    # ─────────────────────────────────────────────────────────────────── saving

    def _write(self, config: Dict[str, Any]) -> None:
        """Atomic replace: the dashboard writes on every zoom, and a truncated
        file would cost the operator every ROI they had defined."""
        directory = os.path.dirname(self.path) or "."
        os.makedirs(directory, exist_ok=True)
        temporary = f"{self.path}.tmp"
        try:
            with open(temporary, "w") as f:
                json.dump(config, f, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(temporary, self.path)
        except OSError as e:
            logger.error(f"Could not save {self.path}: {e}")
            try:
                os.remove(temporary)
            except OSError:
                pass

    def _commit(self) -> Dict[str, Any]:
        self._write(self._config)
        return self._config

    # ────────────────────────────────────────────────────────────────── reading

    def get_config(self) -> Dict[str, Any]:
        with self._lock:
            return json.loads(json.dumps(self._config))   # deep copy

    def get_settings(self) -> Dict[str, Any]:
        with self._lock:
            return dict(self._config["settings"])

    def list_histograms(self) -> List[Dict[str, Any]]:
        with self._lock:
            return json.loads(json.dumps(self._config["histograms"]))

    def get_histogram(self, histogram_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            for entry in self._config["histograms"]:
                if entry["id"] == histogram_id:
                    return json.loads(json.dumps(entry))
        return None

    def _find(self, histogram_id: str) -> Optional[Dict[str, Any]]:
        for entry in self._config["histograms"]:
            if entry["id"] == histogram_id:
                return entry
        return None

    # ────────────────────────────────────────────────────────────────── writing

    def replace_config(self, raw: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            self._config = self._normalise(raw)
            return self._commit()

    def update_settings(self, partial: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            merged = dict(self._config["settings"])
            merged.update(partial or {})
            self._config = self._normalise({
                "settings": merged,
                "histograms": self._config["histograms"],
            })
            self._commit()
            return dict(self._config["settings"])

    def add_histogram(self, raw: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            entry = self._normalise_histogram(
                raw or {}, len(self._config["histograms"]))
            # A fresh id even if the client supplied one it already used, so a
            # double-submit cannot produce two histograms that shadow each other.
            if self._find(entry["id"]):
                entry["id"] = f"hist_{uuid.uuid4().hex[:12]}"
            self._config["histograms"].append(entry)
            self._commit()
            return json.loads(json.dumps(entry))

    def update_histogram(self, histogram_id: str,
                         partial: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        with self._lock:
            entry = self._find(histogram_id)
            if entry is None:
                return None
            merged = dict(entry)
            merged.update(partial or {})
            merged["id"] = histogram_id          # never reassigned by an update
            # ROIs have their own endpoints; a histogram update that omitted them
            # would otherwise silently delete every ROI on it.
            if "rois" not in (partial or {}):
                merged["rois"] = entry["rois"]
            updated = self._normalise_histogram(merged, entry["order"])
            self._config["histograms"][
                self._config["histograms"].index(entry)] = updated
            self._commit()
            return json.loads(json.dumps(updated))

    def delete_histogram(self, histogram_id: str) -> bool:
        with self._lock:
            entry = self._find(histogram_id)
            if entry is None:
                return False
            self._config["histograms"].remove(entry)
            self._commit()
            return True

    def reorder(self, ordered_ids: List[str]) -> List[Dict[str, Any]]:
        """Apply a new order. Ids not listed keep their relative position after."""
        with self._lock:
            rank = {str(value): index for index, value in enumerate(ordered_ids or [])}
            tail = len(rank)
            for entry in self._config["histograms"]:
                entry["order"] = rank.get(entry["id"], tail)
                if entry["id"] not in rank:
                    tail += 1
            self._config["histograms"].sort(key=lambda e: e["order"])
            for index, entry in enumerate(self._config["histograms"]):
                entry["order"] = index
            self._commit()
            return json.loads(json.dumps(self._config["histograms"]))

    def set_zoom(self, histogram_id: str,
                 zoom: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        with self._lock:
            entry = self._find(histogram_id)
            if entry is None:
                return None
            entry["zoom"] = self._normalise_zoom(zoom)
            self._commit()
            return json.loads(json.dumps(entry))

    def clear_all_zoom(self) -> List[Dict[str, Any]]:
        with self._lock:
            for entry in self._config["histograms"]:
                entry["zoom"] = None
            self._commit()
            return json.loads(json.dumps(self._config["histograms"]))

    # ────────────────────────────────────────────────────────────────────── ROIs

    def add_roi(self, histogram_id: str,
                raw: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        with self._lock:
            entry = self._find(histogram_id)
            if entry is None:
                return None
            roi = self._normalise_roi(raw or {})
            if any(existing["id"] == roi["id"] for existing in entry["rois"]):
                roi["id"] = f"roi_{uuid.uuid4().hex[:12]}"
            entry["rois"].append(roi)
            self._commit()
            return json.loads(json.dumps(roi))

    def update_roi(self, histogram_id: str, roi_id: str,
                   partial: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        with self._lock:
            entry = self._find(histogram_id)
            if entry is None:
                return None
            for index, roi in enumerate(entry["rois"]):
                if roi["id"] != roi_id:
                    continue
                merged = dict(roi)
                merged.update(partial or {})
                merged["id"] = roi_id
                entry["rois"][index] = self._normalise_roi(merged)
                self._commit()
                return json.loads(json.dumps(entry["rois"][index]))
            return None

    def delete_roi(self, histogram_id: str, roi_id: str) -> bool:
        with self._lock:
            entry = self._find(histogram_id)
            if entry is None:
                return False
            remaining = [roi for roi in entry["rois"] if roi["id"] != roi_id]
            if len(remaining) == len(entry["rois"]):
                return False
            entry["rois"] = remaining
            self._commit()
            return True

    # ────────────────────────────────────────────────────────── batch integrals

    def integral_targets(self, visible_only: bool = True,
                         enabled_only: bool = True) -> List[Dict[str, Any]]:
        """
        The work list for a batch integral pass, grouped by board and channel.

        Grouped rather than flat because reading a histogram is the expensive
        part: three ROIs on one channel are three spy reads if each is fetched
        separately, and one if they share the histogram.
        """
        grouped: Dict[Any, Dict[str, Any]] = {}
        with self._lock:
            for entry in self._config["histograms"]:
                if visible_only and not entry["visible"]:
                    continue
                rois = [roi for roi in entry["rois"]
                        if roi["enabled"] or not enabled_only]
                if not rois:
                    continue
                key = (entry["boardId"], entry["channel"])
                target = grouped.setdefault(key, {
                    "boardId": entry["boardId"],
                    "channel": entry["channel"],
                    "rois": [],
                })
                for roi in rois:
                    target["rois"].append({
                        "histogramId": entry["id"],
                        "roiId": roi["id"],
                        "low": roi["low"],
                        "high": roi["high"],
                        "background": roi["background"],
                    })
        return list(grouped.values())


# ──────────────────────────────────────────────────── import from the frontend

def _frontend_cache_candidates() -> List[str]:
    """
    Where the browser-era cache might be, relative to however we were started.

    WEBDAQ_FRONTEND_CACHE overrides the search entirely rather than being tried
    first: a deployment that points it somewhere specific means *there*, and
    pointing it at an empty directory is the way to say "do not import".

    The last candidate is anchored to this file rather than to the working
    directory, so a server started from a data directory of its own still finds
    the cache belonging to its own installation.
    """
    explicit = os.getenv("WEBDAQ_FRONTEND_CACHE")
    if explicit:
        return [explicit]
    return [
        os.path.join("..", "frontend", "cache"),
        os.path.join("frontend", "cache"),
        os.path.join(os.path.dirname(os.path.abspath(__file__)),
                     "..", "..", "..", "frontend", "cache"),
    ]


def _import_from_frontend_cache() -> Optional[Dict[str, Any]]:
    """
    Seed the store from frontend/cache/*.json, once, if it is there.

    Only runs when conf/histograms.json does not yet exist, and never modifies
    the files it reads: an operator who has spent a campaign defining ROIs should
    not have to re-enter them, and should still be able to fall back.
    """
    for directory in _frontend_cache_candidates():
        configs_path = os.path.join(directory, "histogram-configs.json")
        if not os.path.isfile(configs_path):
            continue
        try:
            with open(configs_path) as f:
                histograms = json.load(f)
            if not isinstance(histograms, list) or not histograms:
                continue

            # ROIs lived in a second file, keyed by histogram id.
            roi_path = os.path.join(directory, "roi-cache-enhanced.json")
            if os.path.isfile(roi_path):
                try:
                    with open(roi_path) as f:
                        roi_map = json.load(f)
                except (OSError, ValueError):
                    roi_map = {}
                if isinstance(roi_map, dict):
                    for entry in histograms:
                        stored = roi_map.get(entry.get("id"))
                        if isinstance(stored, list) and stored:
                            entry["rois"] = stored

            settings = {}
            settings_path = os.path.join(directory, "dashboard-settings.json")
            if os.path.isfile(settings_path):
                try:
                    with open(settings_path) as f:
                        loaded = json.load(f)
                    if isinstance(loaded, dict):
                        settings = loaded
                except (OSError, ValueError):
                    pass

            logger.info(f"Found a frontend histogram cache at {directory}")
            return {"settings": settings, "histograms": histograms}
        except (OSError, ValueError) as e:
            logger.warning(f"Could not import {configs_path}: {e}")
    return None


# ─────────────────────────────────────────────────────────────────── singleton

_store: Optional[HistogramConfigStore] = None
_store_lock = threading.Lock()


def get_histogram_config() -> HistogramConfigStore:
    global _store
    with _store_lock:
        if _store is None:
            _store = HistogramConfigStore()
        return _store
