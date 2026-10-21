"""
HDF5 run files for SIS3316 data.

Layout of ``run_<N>_<cycle:04d>.h5``::

    /                      attrs: run, created (UTC ISO), software, format_version
    /board_<id>/           attrs: name, board_id, info (JSON), settings (JSON),
                                  sample_clock_mhz, ns_per_sample
    /board_<id>/events     compound table, one row per hit:
                           channel u1, timestamp u8 (samples), energy_max i4,
                           energy_start i4, pileup u1, peak_high u2,
                           peak_index u2, maw_max i4
    /board_<id>/waveforms  (n_events, raw_samples) u2, row-aligned with events
                           (only when raw samples are recorded and saved)
    /board_<id>/maw        (n_events, maw_length) i4, row-aligned with events
                           (only when the MAW test buffer is recorded)

Rows are appended per bank readout, channel by channel, so they are not
globally time-ordered: sort by timestamp for coincidences. Every append is
followed by a flush, so a crash loses at most the bank being written.
"""

import datetime as _dt
import json
import os
import threading
from typing import Any, Dict, Optional

import numpy as np

try:
    import h5py
except ImportError:          # writing is then unavailable; reading/decoding still work
    h5py = None

FORMAT_VERSION = 1

EVENT_DTYPE = np.dtype([
    ("channel", "u1"),
    ("timestamp", "<u8"),
    ("energy_max", "<i4"),
    ("energy_start", "<i4"),
    ("pileup", "u1"),
    ("peak_high", "<u2"),
    ("peak_index", "<u2"),
    ("maw_max", "<i4"),
])

_CHUNK_ROWS = 4096


class Hdf5RunWriter:
    """Appends decoded SIS3316 events of one run to rotating HDF5 files."""

    def __init__(self, out_dir: str, run: int, max_file_bytes: int = 0,
                 software: str = ""):
        if h5py is None:
            raise RuntimeError("h5py is not installed: cannot write SIS3316 run files")
        self.out_dir = out_dir
        self.run = int(run)
        self.max_file_bytes = int(max_file_bytes or 0)
        self.software = software
        self.cycle = 0
        self.bytes_written = 0
        self._boards: Dict[int, Dict[str, Any]] = {}
        self._file = None
        self._lock = threading.Lock()
        os.makedirs(out_dir, exist_ok=True)

    # ── files ──────────────────────────────────────────────────────────────
    def _path(self) -> str:
        base = os.path.join(self.out_dir, f"run_{self.run}_{self.cycle:04d}")
        path = base + ".h5"
        n = 1
        while os.path.exists(path):          # never overwrite an earlier file
            path = f"{base}_{n}.h5"
            n += 1
        return path

    def _open(self) -> None:
        self.path = self._path()
        f = h5py.File(self.path, "w", libver="latest")
        f.attrs["run"] = self.run
        f.attrs["cycle"] = self.cycle
        f.attrs["created"] = _dt.datetime.now(_dt.timezone.utc).isoformat()
        f.attrs["software"] = self.software
        f.attrs["format_version"] = FORMAT_VERSION
        self._file = f
        for board_id, meta in self._boards.items():
            self._create_board(board_id, meta)
        f.flush()

    def _create_board(self, board_id: int, meta: Dict[str, Any]) -> None:
        g = self._file.create_group(f"board_{board_id}")
        g.attrs["board_id"] = board_id
        g.attrs["name"] = meta["name"]
        g.attrs["info"] = json.dumps(meta["info"])
        g.attrs["settings"] = json.dumps(meta["settings"])
        g.attrs["sample_clock_mhz"] = float(meta["clock_mhz"])
        g.attrs["ns_per_sample"] = 1000.0 / float(meta["clock_mhz"])
        g.create_dataset("events", shape=(0,), maxshape=(None,), dtype=EVENT_DTYPE,
                         chunks=(_CHUNK_ROWS,), compression="lzf")
        if meta["raw_samples"] > 0:
            g.create_dataset("waveforms", shape=(0, meta["raw_samples"]),
                             maxshape=(None, meta["raw_samples"]), dtype="<u2",
                             chunks=(max(1, min(_CHUNK_ROWS, 2 ** 20 // (2 * meta["raw_samples"]))),
                                     meta["raw_samples"]),
                             compression="lzf")
        if meta["maw_length"] > 0:
            g.create_dataset("maw", shape=(0, meta["maw_length"]),
                             maxshape=(None, meta["maw_length"]), dtype="<i4",
                             chunks=(max(1, min(_CHUNK_ROWS, 2 ** 20 // (4 * meta["maw_length"]))),
                                     meta["maw_length"]),
                             compression="lzf")

    def add_board(self, board_id: int, name: str, info: Dict[str, Any],
                  settings: Dict[str, Any], clock_mhz: float, raw_samples: int,
                  maw_length: int) -> None:
        with self._lock:
            meta = {"name": name, "info": info, "settings": settings,
                    "clock_mhz": clock_mhz, "raw_samples": int(raw_samples),
                    "maw_length": int(maw_length)}
            self._boards[int(board_id)] = meta
            if self._file is not None:
                self._create_board(int(board_id), meta)

    def close(self) -> None:
        with self._lock:
            if self._file is not None:
                self._file.flush()
                self._file.close()
                self._file = None

    # ── data ───────────────────────────────────────────────────────────────
    def append(self, board_id: int, channel: int, fields: Dict[str, np.ndarray],
               waveforms: Optional[np.ndarray] = None,
               maw: Optional[np.ndarray] = None) -> None:
        n = fields["timestamp"].size
        if n == 0:
            return
        rows = np.zeros(n, dtype=EVENT_DTYPE)
        rows["channel"] = channel
        for key in ("timestamp", "energy_max", "energy_start", "pileup",
                    "peak_high", "peak_index", "maw_max"):
            rows[key] = fields[key]
        with self._lock:
            if self._file is None:
                self._open()
            g = self._file[f"board_{board_id}"]
            nbytes = self._extend(g["events"], rows)
            if waveforms is not None and "waveforms" in g and waveforms.shape[1] == g["waveforms"].shape[1]:
                nbytes += self._extend(g["waveforms"], waveforms)
            if maw is not None and "maw" in g and maw.shape[1] == g["maw"].shape[1]:
                nbytes += self._extend(g["maw"], maw)
            self.bytes_written += nbytes

    @staticmethod
    def _extend(ds, data: np.ndarray) -> int:
        start = ds.shape[0]
        ds.resize(start + data.shape[0], axis=0)
        ds[start:] = data
        return data.nbytes

    def flush(self) -> None:
        """Flush after each readout cycle; rotate when the file is too big."""
        with self._lock:
            if self._file is None:
                return
            self._file.flush()
            if self.max_file_bytes and os.path.getsize(self.path) >= self.max_file_bytes:
                self._file.close()
                self._file = None
                self.cycle += 1
