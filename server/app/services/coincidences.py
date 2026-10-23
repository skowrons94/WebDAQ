"""
Online coincidences between channels, configured from the Coincidences page.

The operator describes what to look at as *gates*, each one a sentence:

    "Spectrum of <channels> [in coincidence with | with a veto from]
     <partner channels> within ±<window> ns [at least <n> of them]"

and gets, per gate and live during the run: the gated (or vetoed) energy
spectrum of each channel, the Δt spectrum between each channel and each
partner (to choose the window and align the channels in time), optionally
the energy-energy matrix, the sum spectrum, and the rates.

How it works
------------
Every board involved exports its hits (caendaq/sis3316daq ``take_hits``: time
in ps, energy, channel, flags — 16 bytes each, off unless a gate needs it).
Hits can only be compared on one clock, so boards are grouped into clock
domains: the CAEN boards of a synchronised chain share one, every other board
is its own. A gate must stay inside one domain.

Per domain the builder keeps the recent hits sorted in time (after the
per-channel offsets). The boards do not deliver in time order — a channel's
events wait in the board until its aggregate is full — so a hit is only
evaluated once every live board of the domain has delivered data at least
``latency`` later: then nothing earlier can still arrive. A hit that does
arrive later than that is counted as *late* and left out (it is still in the
singles spectra and the file). Raise the latency if late hits appear; it
costs memory and display delay only.

Memory is bounded: the pending hits (16 bytes each) are capped at
MAX_PENDING_HITS, the oldest evaluated early beyond it, which is counted.
Spectra are fixed-size arrays; nothing grows with the run length.

Sum spectrum
------------
A coincidence gate can also fill the spectrum of the summed calibrated energy
(keV) of each hit that passes and of its partners within the window: every
partner hit ("all"), or the nearest hit of each partner channel ("nearest").
When a channel is both a gate channel and a partner, one event would be summed
once from each of its hits; it is summed only from its earliest hit (the
*anchor*): a hit is skipped when an earlier hit within the window could have
summed it. The calibrations are read when the gate is set up and checked
again every second; a change starts the sum spectrum over, since its bins
would no longer mean the same energies.
"""

import json
import logging
import os
import threading
import time
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

logger = logging.getLogger(__name__)

CONFIG_FILE = os.path.join("conf", "coincidences.json")
SCHEMA_VERSION = 1

TICK_S = 0.25                 # how often hits are collected and evaluated
DT_BINS = 1000                # Δt spectrum bins over [-dt_range, +dt_range]
MATRIX_BINS = 512             # energy-energy matrix, per axis
MAX_PENDING_HITS = 4_000_000  # ~64 MB per domain at most
MAX_PAIRS_PER_TICK = 5_000_000  # Δt pairs filled per gate and tick (bounds a burst)
IDLE_BOARD_S = 10.0           # a board silent this long no longer holds the domain back
RATE_WINDOW_S = 5.0

MAX_GATES = 16
MAX_CHANNELS_PER_SIDE = 32
MAX_SUM_BINS = 65536          # sum spectrum, uint32: 256 kB per gate at most
CALIB_CHECK_S = 1.0           # how often the sum's calibrations are compared with the files

DEFAULT_CONFIG: Dict[str, Any] = {
    "version": SCHEMA_VERSION,
    "latency_ms": 2000,
    "offsets_ns": {},
    "gates": [],
}

DEFAULT_GATE: Dict[str, Any] = {
    "name": "",
    "enabled": True,
    "channels": [],
    "partners": [],
    "mode": "coincidence",        # or "anticoincidence" (veto)
    "window_ns": 100.0,
    "min_partners": 1,
    "dt_range_ns": 1000.0,
    "matrix": False,
    "sum": False,                 # sum spectrum, coincidence gates only
    "sum_partners": "all",        # or "nearest": the nearest hit of each partner channel
    "sum_max_kev": 16384.0,
    "sum_bin_kev": 1.0,
}


def channel_key(board: Any, channel: Any) -> str:
    return f"{board}:{int(channel)}"


def _ref(item: Any) -> Tuple[str, int]:
    return str(item["board"]), int(item["channel"])


# ───────────────────────────────────────────────────────────── configuration

def normalise_config(cfg: Any) -> Dict[str, Any]:
    """Fill defaults and coerce types; raise ValueError on anything unusable."""
    if not isinstance(cfg, dict):
        raise ValueError("Expected a configuration object")
    out = dict(DEFAULT_CONFIG)
    out["latency_ms"] = int(min(60000, max(100, float(cfg.get("latency_ms", out["latency_ms"])))))
    offsets = cfg.get("offsets_ns") or {}
    if not isinstance(offsets, dict):
        raise ValueError("offsets_ns must map 'board:channel' to nanoseconds")
    out["offsets_ns"] = {}
    for k, v in offsets.items():
        board, _, ch = str(k).rpartition(":")
        if not board or not ch.isdigit():
            raise ValueError(f"Bad channel '{k}' in offsets_ns (expected 'board:channel')")
        if float(v) != 0.0:
            out["offsets_ns"][channel_key(board, ch)] = float(v)

    gates = cfg.get("gates") or []
    if not isinstance(gates, list):
        raise ValueError("gates must be a list")
    if len(gates) > MAX_GATES:
        raise ValueError(f"At most {MAX_GATES} coincidence gates")
    out["gates"] = []
    seen_ids = set()
    for i, g in enumerate(gates):
        if not isinstance(g, dict):
            raise ValueError(f"Gate {i + 1} is not an object")
        gate = dict(DEFAULT_GATE)
        gate.update({k: g[k] for k in DEFAULT_GATE if k in g})
        gate["id"] = str(g.get("id") or uuid.uuid4().hex[:8])
        if gate["id"] in seen_ids:
            gate["id"] = uuid.uuid4().hex[:8]
        seen_ids.add(gate["id"])
        label = gate["name"] or f"Gate {i + 1}"
        gate["name"] = str(gate["name"])[:80]
        gate["enabled"] = bool(gate["enabled"])
        for side in ("channels", "partners"):
            refs = []
            for item in gate[side] or []:
                try:
                    ref = _ref(item)
                except (KeyError, TypeError, ValueError):
                    raise ValueError(f"{label}: bad channel {item!r}")
                if not 0 <= ref[1] < 64:
                    raise ValueError(f"{label}: channel {ref[1]} is out of range")
                if ref not in refs:
                    refs.append(ref)
            if len(refs) > MAX_CHANNELS_PER_SIDE:
                raise ValueError(f"{label}: at most {MAX_CHANNELS_PER_SIDE} channels per side")
            gate[side] = [{"board": b, "channel": c} for b, c in refs]
        if gate["mode"] not in ("coincidence", "anticoincidence"):
            raise ValueError(f"{label}: mode must be 'coincidence' or 'anticoincidence'")
        gate["window_ns"] = float(gate["window_ns"])
        if not 0 < gate["window_ns"] <= 1e6:
            raise ValueError(f"{label}: the window must be between 0 and 1 ms")
        gate["dt_range_ns"] = float(gate["dt_range_ns"])
        if not 0 < gate["dt_range_ns"] <= 1e7:
            raise ValueError(f"{label}: the Δt range must be between 0 and 10 ms")
        gate["min_partners"] = max(1, int(gate["min_partners"]))
        gate["matrix"] = bool(gate["matrix"])
        gate["sum"] = bool(gate["sum"])
        if gate["sum_partners"] not in ("all", "nearest"):
            raise ValueError(f"{label}: the sum's partners must be 'all' or 'nearest'")
        gate["sum_max_kev"] = float(gate["sum_max_kev"])
        gate["sum_bin_kev"] = float(gate["sum_bin_kev"])
        if not (np.isfinite(gate["sum_max_kev"]) and np.isfinite(gate["sum_bin_kev"])
                and gate["sum_max_kev"] > 0 and gate["sum_bin_kev"] > 0):
            raise ValueError(f"{label}: the sum spectrum's range and bin width must be positive")
        # The sum spectrum is one fixed array per gate: its size is bounded
        # here, not by how long the run lasts.
        if round(gate["sum_max_kev"] / gate["sum_bin_kev"]) > MAX_SUM_BINS:
            raise ValueError(f"{label}: the sum spectrum would have more than {MAX_SUM_BINS} bins; "
                             f"widen the bins or shorten the range")
        if round(gate["sum_max_kev"] / gate["sum_bin_kev"]) < 1:
            raise ValueError(f"{label}: the sum spectrum's bin is wider than its range")
        out["gates"].append(gate)
    return out


def load_config(path: str = CONFIG_FILE) -> Dict[str, Any]:
    try:
        with open(path) as f:
            return normalise_config(json.load(f))
    except FileNotFoundError:
        return normalise_config({})
    except (OSError, ValueError) as e:
        logger.error(f"Could not read {path} ({e}); starting with no coincidence gates")
        return normalise_config({})


def save_config(cfg: Dict[str, Any], path: str = CONFIG_FILE) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cfg, f, indent=2)
    os.replace(tmp, path)


# ──────────────────────────────────────────────────────────── hit sources

class HitSource:
    """One board's hits: how to take them, and which clock they are on."""

    def __init__(self, board_id: str, domain: str, take, dropped, enable, energy_bins: int,
                 skipped=None):
        self.board_id = board_id
        self.domain = domain
        self.take = take
        self.dropped = dropped            # hits not kept between two takes
        self.skipped = skipped or (lambda: 0)   # raw blocks the decoder skipped
        self.enable = enable
        self.energy_bins = int(energy_bins)


def sources_for_run(acq) -> Dict[str, HitSource]:
    """The hit sources of the boards in the current run, by WebDAQ board id."""
    from .sis3316_acquisition import is_sis3316

    out: Dict[str, HitSource] = {}
    domains = clock_domains(acq.get_boards())
    for board in acq.get_boards():
        bid = str(board["id"])
        if is_sis3316(board):
            sis = acq._sis()
            idx = sis.local_index(bid)
            daq = getattr(sis, "_daq", None)
            if idx is None or daq is None or not hasattr(daq, "take_hits"):
                continue
            bins = int(daq.boards[idx].spectra.shape[1])
            out[bid] = HitSource(
                bid, f"board-{bid}",
                take=lambda d=daq, i=idx: d.take_hits(i),
                dropped=lambda d=daq, i=idx: d.hits_dropped(i),
                enable=lambda on, d=daq, i=idx: d.enable_hits(i, on),
                energy_bins=bins)
        else:
            daq = acq.daq
            idx = acq.caen_index(bid)
            if idx is None or daq is None or not hasattr(daq, "take_hits"):
                continue
            domain = domains.get(bid, f"board-{bid}")
            bins = 65536 if str(board.get("dpp", "")).upper().endswith("PSD") else 32768
            out[bid] = HitSource(
                bid, domain,
                take=lambda d=daq, i=idx: d.take_hits(i),
                dropped=lambda d=daq, i=idx: d.hits_dropped(i),
                enable=lambda on, d=daq, i=idx: d.enable_hits(i, on),
                energy_bins=bins,
                skipped=lambda d=daq, i=idx: d.decode_dropped(i))
    return out


def clock_domains(boards: List[Dict[str, Any]]) -> Dict[str, str]:
    """board id -> clock domain, for checking gates and for sorting hits.

    CAEN boards share a time base when they are in a chain (started together,
    0x8100 bits[1:0]) AND run on one oscillator: the ones taking their clock
    from CLK-IN (0x8100 bit 6) plus the single one on its own clock that feeds
    them. Two chained boards on their own oscillators start together but drift
    apart, so each is a domain of its own, as is every SIS3316.
    """
    from .caen_acquisition import acquisition_control_of, is_synchronised
    from .sis3316_acquisition import is_sis3316
    out: Dict[str, str] = {}
    chained = [b for b in boards if not is_sis3316(b) and is_synchronised(b)]
    external = [b for b in chained if acquisition_control_of(b) & (1 << 6)]
    internal = [b for b in chained if not acquisition_control_of(b) & (1 << 6)]
    # Several boards on their own clock: which one feeds the others is not
    # known, so none of them is put with the chain.
    on_chain = external + (internal if len(internal) == 1 else [])
    if len(on_chain) < 2:
        on_chain = []
    shared = {str(b["id"]) for b in on_chain}
    for b in boards:
        bid = str(b["id"])
        out[bid] = "caen-chain" if bid in shared else f"board-{bid}"
    return out


def check_gates(cfg: Dict[str, Any], boards: List[Dict[str, Any]]) -> Dict[str, List[str]]:
    """Problems that keep each gate from producing anything, by gate id."""
    domains = clock_domains(boards)
    names = {str(b["id"]): f"{b.get('name', 'board')} {b['id']}" for b in boards}
    out: Dict[str, List[str]] = {}
    for g in cfg["gates"]:
        problems = []
        if not g["channels"]:
            problems.append("Pick at least one channel whose spectrum is gated.")
        if not g["partners"]:
            problems.append("Pick at least one partner channel.")
        refs = g["channels"] + g["partners"]
        missing = sorted({r["board"] for r in refs if r["board"] not in domains})
        for bid in missing:
            problems.append(f"Board {bid} is not configured.")
        used = {domains[r["board"]] for r in refs if r["board"] in domains}
        if len(used) > 1:
            involved = sorted({names[r["board"]] for r in refs if r["board"] in domains})
            problems.append(
                "These boards do not share a clock, so their times cannot be compared: "
                + ", ".join(involved) + ". Coincidences need one board, or CAEN boards "
                "in a synchronised chain.")
        if g["mode"] == "coincidence" and g["partners"] and g["min_partners"] > len(g["partners"]):
            problems.append(f"'At least {g['min_partners']}' partners, but only "
                            f"{len(g['partners'])} are listed.")
        out[g["id"]] = problems
    return out


# ──────────────────────────────────────────────────────────── calibrations

_calib_cache: Dict[str, Tuple[Tuple[int, int, int], List[Tuple[float, float]]]] = {}


def read_calibrations(boards: List[Dict[str, Any]], keys: List[str]) -> Dict[str, Tuple[float, float]]:
    """(offset, slope) of each 'board:channel', from calib/<name>_<id>.cal,
    (0, 1) where uncalibrated. A file is parsed again only when it has been
    rewritten, so checking every second costs a stat() per board."""
    from . import calibration
    names = {str(b["id"]): str(b.get("name", "")) for b in boards}
    out: Dict[str, Tuple[float, float]] = {}
    for k in keys:
        bid, _, ch = k.rpartition(":")
        name = names.get(bid)
        if name is None:
            out[k] = (0.0, 1.0)
            continue
        path = os.path.join(calibration.CALIB_DIR, f"{name}_{bid}.cal")
        try:
            st = os.stat(path)
            stamp = (st.st_mtime_ns, st.st_size, st.st_ino)
        except OSError:
            _calib_cache.pop(path, None)
            out[k] = (0.0, 1.0)
            continue
        cached = _calib_cache.get(path)
        if cached is None or cached[0] != stamp:
            cached = (stamp, calibration.read_table(name, bid, 64))
            _calib_cache[path] = cached
        out[k] = cached[1][int(ch)] if 0 <= int(ch) < len(cached[1]) else (0.0, 1.0)
    return out


# ──────────────────────────────────────────────────────────── evaluation

class GateState:
    """What one gate has accumulated since the run (or its last reset) started."""

    def __init__(self, gate: Dict[str, Any], energy_bins: Dict[str, int],
                 offsets_ns: Optional[Dict[str, float]] = None):
        self.gate = gate
        self.channels = [channel_key(*_ref(c)) for c in gate["channels"]]
        self.partners = [channel_key(*_ref(c)) for c in gate["partners"]]
        self.window_ps = int(round(gate["window_ns"] * 1000))
        self.range_ps = int(round(gate["dt_range_ns"] * 1000))
        self.bins = {k: energy_bins.get(k.split(":")[0], 32768) for k in self.channels + self.partners}
        self.spectra = {k: np.zeros(self.bins[k], np.uint32) for k in self.channels}
        self.dt = {(a, p): np.zeros(DT_BINS, np.uint32)
                   for a in self.channels for p in self.partners if a != p}
        self.matrix = np.zeros((MATRIX_BINS, MATRIX_BINS), np.uint32) if gate["matrix"] else None
        # One channel scale per axis, the widest of its channels: boards with
        # fewer bins fill the lower part instead of being stretched over it.
        self.matrix_bins = (max((self.bins[k] for k in self.channels), default=32768),
                            max((self.bins[k] for k in self.partners), default=32768))
        # The offsets this gate's times were shifted by: what Align corrects.
        self.offsets_ns = dict(offsets_ns or {})
        self.singles = {k: 0 for k in self.channels}
        self.passed = {k: 0 for k in self.channels}
        self.pairs_skipped = 0
        # Sum spectrum: one fixed array, filled once the calibrations of every
        # summed channel are known (set_sum_calibration).
        self.sum_on = bool(gate.get("sum")) and gate["mode"] == "coincidence"
        self.sum_bin_kev = float(gate.get("sum_bin_kev", 1.0))
        n_sum = int(round(float(gate.get("sum_max_kev", 16384.0)) / self.sum_bin_kev))
        self.sum = np.zeros(n_sum, np.uint32) if self.sum_on else None
        self.sum_cal: Optional[Dict[str, Tuple[float, float]]] = None
        self.sum_missing: List[str] = []
        self.sum_overflow = 0             # sums above the range
        self.sum_underflow = 0            # sums below 0 keV (a negative calibration offset)
        self.sum_since = time.time()
        self.sum_restarted = False        # started over because a calibration changed
        self.history: List[Tuple[float, int, int]] = []   # (wall time, singles, passed)
        self.since = time.time()                            # collecting since

    @property
    def sum_keys(self) -> List[str]:
        """Every channel whose energy can go into the sum."""
        return list(dict.fromkeys(self.channels + self.partners))

    @property
    def sum_filling(self) -> bool:
        return self.sum is not None and self.sum_cal is not None and not self.sum_missing

    def set_sum_calibration(self, table: Dict[str, Tuple[float, float]]) -> bool:
        """Take the current calibrations of the summed channels. A change
        empties the sum spectrum: what it holds was binned with the old ones.
        Returns True when the spectrum started over."""
        if self.sum is None:
            return False
        mine = {k: tuple(map(float, table.get(k, (0.0, 1.0)))) for k in self.sum_keys}
        if mine == self.sum_cal:
            return False
        was_filling = self.sum_filling and (self.sum.any() or self.sum_overflow or self.sum_underflow)
        self.sum_cal = mine
        self.sum_missing = [k for k, v in mine.items() if v == (0.0, 1.0)]
        self.sum[:] = 0
        self.sum_overflow = self.sum_underflow = 0
        self.sum_since = time.time()
        self.sum_restarted = bool(was_filling)
        return bool(was_filling)

    @property
    def reach_ps(self) -> int:
        """How far either side of a hit this gate looks."""
        return max(self.window_ps, self.range_ps)

    def evaluate(self, t: np.ndarray, det: np.ndarray, e: np.ndarray,
                 keys: Dict[str, int], lo: int, hi: int) -> None:
        """Evaluate this gate's channel hits with lo <= t < hi against the
        sorted context (t, det, e)."""
        codes = [keys[k] for k in self.channels if k in keys]
        if not codes:
            return
        # Everything this evaluation can touch lies within reach of [lo, hi):
        # work on that slice, not on the whole buffer.
        s0 = int(np.searchsorted(t, lo - self.reach_ps, "left"))
        s1 = int(np.searchsorted(t, hi + self.reach_ps, "right"))
        t, det, e = t[s0:s1], det[s0:s1], e[s0:s1]
        a0, a1 = np.searchsorted(t, [lo, hi], "left")
        rows = a0 + np.flatnonzero(np.isin(det[a0:a1], codes))
        if rows.size == 0:
            return
        tA, dA, eA = t[rows], det[rows], e[rows]
        n_found = np.zeros(rows.size, np.int32)
        mode = self.gate["mode"]
        do_sum = self.sum_filling and mode == "coincidence"
        if do_sum:
            # E = offset + slope × energy, per channel. Summed per partner
            # channel from integer prefix sums of the raw energies, so the
            # "all" sum costs no pair expansion and loses no precision.
            cal = self.sum_cal or {}
            off = np.zeros(max(keys.values()) + 1)
            slope = np.zeros_like(off)
            for k, (o, s) in cal.items():
                if k in keys:
                    off[keys[k]], slope[keys[k]] = o, s
            total = off[dA] + slope[dA] * eA
            nearest = self.gate.get("sum_partners") == "nearest"
            partner_codes = [keys[k] for k in self.partners if k in keys]
            both = {keys[k] for k in self.channels if k in keys} & set(partner_codes)
            a_is_partner = np.isin(dA, partner_codes)
            anchor = np.ones(rows.size, bool)
        # Matrix: the partner hit nearest in time, already in matrix bins.
        partner_y = np.full(rows.size, -1, np.int64)
        partner_gap = np.full(rows.size, np.iinfo(np.int64).max, np.int64)

        for pkey in self.partners:
            pcode = keys.get(pkey)
            if pcode is None:
                continue
            pidx = np.flatnonzero(det == pcode)
            tp = t[pidx]
            left = np.searchsorted(tp, tA - self.window_ps, "left")
            right = np.searchsorted(tp, tA + self.window_ps, "right")
            selfrow = dA == pcode
            count = (right - left) - selfrow.astype(np.int64)    # a hit is not its own partner
            found = count > 0
            n_found += found
            if self.matrix is not None and tp.size:
                near = np.clip(np.searchsorted(tp, tA), 0, tp.size - 1)
                prev = np.clip(near - 1, 0, tp.size - 1)
                gap_n, gap_p = np.abs(tp[near] - tA), np.abs(tp[prev] - tA)
                pick = np.where(gap_p < gap_n, prev, near)
                gap = np.minimum(gap_n, gap_p)
                better = found & ~selfrow & (gap < partner_gap)
                partner_gap[better] = gap[better]
                partner_y[better] = (e[pidx[pick[better]]].astype(np.int64) * MATRIX_BINS) // self.matrix_bins[1]
            if do_sum:
                self._add_to_sum(total, anchor, a_is_partner, pcode in both, nearest, rows, tA, selfrow,
                                 pidx, tp, e[pidx], left, right, off[pcode], slope[pcode])
            self._fill_dt(tA, dA, tp, pkey, selfrow, keys)

        passed = n_found == 0 if mode == "anticoincidence" else n_found >= self.gate["min_partners"]

        for key in self.channels:
            code = keys.get(key)
            if code is None:
                continue
            mine = dA == code
            self.singles[key] += int(mine.sum())
            sel = mine & passed
            self.passed[key] += int(sel.sum())
            spec = self.spectra[key]
            energies = eA[sel].astype(np.int64)
            energies = energies[energies < spec.size]
            if energies.size:
                spec += np.bincount(energies, minlength=spec.size).astype(np.uint32)

        if self.matrix is not None and mode == "coincidence":
            ok = passed & (partner_y >= 0)
            if ok.any():
                x = (eA[ok].astype(np.int64) * MATRIX_BINS) // self.matrix_bins[0]
                y = partner_y[ok]
                keep = (x < MATRIX_BINS) & (y < MATRIX_BINS)
                np.add.at(self.matrix, (x[keep], y[keep]), 1)

        if do_sum:
            sums = total[passed & anchor]
            idx = np.floor(sums / self.sum_bin_kev)
            low, high = idx < 0, idx >= self.sum.size
            self.sum_underflow += int(low.sum())
            self.sum_overflow += int(high.sum())
            idx = idx[~low & ~high].astype(np.int64)
            if idx.size:
                self.sum += np.bincount(idx, minlength=self.sum.size).astype(np.uint32)

    def _add_to_sum(self, total, anchor, a_is_partner, overlapping, nearest, rows, tA, selfrow,
                    pidx, tp, ep, left, right, off_p, slope_p) -> None:
        """Add one partner channel's calibrated energies to each hit's sum,
        and drop the hits that are not their event's anchor."""
        # Hits of this channel before the hit itself in the time-sorted buffer
        # (the hit itself excluded when it is on this channel): ties in time
        # are broken by buffer order, the same in every tick.
        pos = np.searchsorted(pidx, rows, "left")
        if overlapping:
            # An earlier hit within the window on a channel that is both a
            # gate channel and a partner sums this hit itself: this one is
            # not the anchor, or the event would be counted twice.
            anchor &= ~(a_is_partner & (pos > left))
        if tp.size == 0:
            return
        if nearest:
            before = pos - 1
            after = pos + selfrow.astype(np.int64)        # step over the hit itself
            okb = before >= 0
            oka = after < tp.size
            gap_b = np.where(okb, tA - tp[np.clip(before, 0, tp.size - 1)], np.iinfo(np.int64).max)
            gap_a = np.where(oka, tp[np.clip(after, 0, tp.size - 1)] - tA, np.iinfo(np.int64).max)
            pick = np.where(gap_b <= gap_a, before, after)
            found = np.minimum(gap_b, gap_a) <= self.window_ps
            if found.any():
                total[found] += off_p + slope_p * ep[pick[found]]
        else:
            csum = np.concatenate(([0], np.cumsum(ep, dtype=np.int64)))
            raw = csum[right] - csum[left]
            n = right - left
            # A hit is not its own partner.
            own = selfrow
            if own.any():
                raw = raw - np.where(own, ep[np.clip(pos, 0, tp.size - 1)], 0)
                n = n - own.astype(np.int64)
            total += n * off_p + slope_p * raw

    # Δt pairs are expanded in chunks of A rows, each at most this many pairs,
    # so a burst never allocates more than a few tens of MB.
    _PAIR_CHUNK = 1_000_000

    def _fill_dt(self, tA, dA, tp, pkey, selfrow, keys) -> None:
        left = np.searchsorted(tp, tA - self.range_ps, "left")
        right = np.searchsorted(tp, tA + self.range_ps, "right")
        count = right - left
        total = int(count.sum())
        if total == 0:
            return
        if total > MAX_PAIRS_PER_TICK:
            self.pairs_skipped += total
            return
        bin_ps = (2 * self.range_ps) / DT_BINS
        targets = [(akey, keys[akey]) for akey in self.channels
                   if akey in keys and (akey, pkey) in self.dt]
        bounds = np.searchsorted(np.cumsum(count), np.arange(self._PAIR_CHUNK, total, self._PAIR_CHUNK))
        for r0, r1 in zip(np.concatenate(([0], bounds + 1)), np.concatenate((bounds + 1, [count.size]))):
            c = count[r0:r1]
            n = int(c.sum())
            if n == 0:
                continue
            starts = np.repeat(left[r0:r1], c)
            offsets = np.arange(n) - np.repeat(np.cumsum(c) - c, c)
            dts = tp[starts + offsets] - np.repeat(tA[r0:r1], c)
            owner = np.repeat(dA[r0:r1], c)
            drop_self = np.repeat(selfrow[r0:r1], c) & (dts == 0)
            bins = np.floor((dts + self.range_ps) / bin_ps).astype(np.int64)
            good = ~drop_self & (bins >= 0) & (bins < DT_BINS)
            for akey, acode in targets:
                sel = good & (owner == acode)
                if sel.any():
                    self.dt[(akey, pkey)] += np.bincount(bins[sel], minlength=DT_BINS).astype(np.uint32)

    def status(self, now: float) -> Dict[str, Any]:
        singles = sum(self.singles.values())
        passed = sum(self.passed.values())
        self.history.append((now, singles, passed))
        while len(self.history) > 2 and now - self.history[0][0] > RATE_WINDOW_S:
            self.history.pop(0)
        t0, s0, p0 = self.history[0]
        span = now - t0
        return {
            "id": self.gate["id"],
            "since": self.since,
            "singles": singles,
            "passed": passed,
            "fraction": (passed / singles) if singles else None,
            "rate": ((passed - p0) / span) if span > 0 else 0.0,
            "singles_rate": ((singles - s0) / span) if span > 0 else 0.0,
            "per_channel": {k: {"singles": self.singles[k], "passed": self.passed[k]}
                            for k in self.channels},
            "pairs_skipped": self.pairs_skipped,
            "sum": None if self.sum is None else {
                "filling": self.sum_filling,
                "entries": int(self.sum.sum()),
                "overflow": self.sum_overflow,
                "underflow": self.sum_underflow,
                "missing": list(self.sum_missing),
                "since": self.sum_since,
                "restarted": self.sum_restarted,
                "bins": int(self.sum.size),
                "bin_kev": self.sum_bin_kev,
                "max_kev": self.sum.size * self.sum_bin_kev,
            },
        }


class Domain:
    """The time-sorted hits of the boards sharing one clock."""

    def __init__(self, name: str, board_ids: List[str]):
        self.name = name
        self.boards = board_ids
        self.t = np.zeros(0, np.int64)
        self.det = np.zeros(0, np.int32)
        self.e = np.zeros(0, np.uint16)
        self.done = None                 # every hit before this has been evaluated
        self.promised = None             # the cutoff: no hit before it should still come
        self.max_t: Dict[str, int] = {}
        self.last_seen: Dict[str, float] = {}
        self.late = 0
        self.overflow = 0

    @property
    def pending(self) -> int:
        return int(self.t.size)

    def progress(self, board: str, latest: int, now: float) -> None:
        """The board has delivered data up to `latest` (any of its channels)."""
        self.max_t[board] = max(self.max_t.get(board, latest), latest)
        self.last_seen[board] = now

    def add(self, t: np.ndarray, det: np.ndarray, e: np.ndarray, reach: int) -> None:
        if t.size == 0:
            return
        if self.promised is not None:
            # Later than the cutoff said: before `done` these hits were not
            # evaluated themselves; up to the cutoff they came too late to be
            # the partners of hits already evaluated. Either way some
            # coincidences were missed. The recent ones still serve as
            # partners of hits yet to come.
            late = t < self.promised
            if late.any():
                self.late += int(late.sum())
            if self.done is not None:
                old = t < self.done - reach
                t, det, e = t[~old], det[~old], e[~old]
        # The buffer is sorted: sort only the new hits and merge them in.
        order = np.argsort(t, kind="stable")
        t, det, e = t[order], det[order], e[order]
        at = np.searchsorted(self.t, t, "right")
        self.t = np.insert(self.t, at, t)
        self.det = np.insert(self.det, at, det)
        self.e = np.insert(self.e, at, e)

    def cutoff(self, latency_ps: int, now: float, final: bool) -> Optional[int]:
        if self.t.size == 0:
            return None
        if final:
            return int(self.t[-1]) + 1
        live = [self.max_t[b] for b in self.max_t if now - self.last_seen.get(b, 0) < IDLE_BOARD_S]
        if not live:
            live = list(self.max_t.values())
        cut = min(live) - latency_ps
        if self.t.size > MAX_PENDING_HITS:
            self.overflow += 1
            cut = max(cut, int(self.t[self.t.size - MAX_PENDING_HITS // 2]))
        return cut


class CoincidenceBuilder:
    """Owns the configuration and, during a run, the evaluation thread."""

    def __init__(self, config_path: str = CONFIG_FILE):
        self.config_path = config_path
        self._lock = threading.RLock()
        self._config = load_config(config_path)
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._acq = None
        self._sources: Dict[str, HitSource] = {}
        self._domains: Dict[str, Domain] = {}
        self._gates: Dict[str, GateState] = {}
        self._keys: Dict[str, int] = {}          # 'board:ch' -> code
        self._offsets: Dict[int, int] = {}       # code -> ps
        self._dropped_base: Dict[str, int] = {}
        self._skipped_base: Dict[str, int] = {}
        self._source_problems: Dict[str, List[str]] = {}
        self._started_at = 0.0
        self._last_error = ""
        self._calib_checked = 0.0

    # ── configuration ──────────────────────────────────────────────────────
    def get_config(self) -> Dict[str, Any]:
        with self._lock:
            return json.loads(json.dumps(self._config))

    def set_config(self, cfg: Dict[str, Any]) -> Dict[str, Any]:
        clean = normalise_config(cfg)
        with self._lock:
            save_config(clean, self.config_path)
            self._config = clean
            if self._acq is not None:
                # A running build restarts with the new gates; the ones not
                # changed (gate and time offsets alike) keep what they collected.
                self._setup(keep_unchanged=True)
                self._log_change(clean)
        return self.get_config()

    HISTORY_FILE = "coincidences_history.jsonl"

    def _log_change(self, cfg: Dict[str, Any]) -> None:
        """Gates and time offsets changed during a saved run go into its
        directory with their time, as register and calibration changes do:
        the copy taken at the start no longer describes the whole run."""
        try:
            from .daq_manager import get_daq_manager
            state = get_daq_manager().daq_state
            run_dir = f"data/run{state.get('run')}"
            if not state.get('save') or not os.path.isdir(run_dir):
                return
            entry = {"time": datetime.now().isoformat(timespec="seconds"), "config": cfg}
            with open(os.path.join(run_dir, self.HISTORY_FILE), "a") as f:
                f.write(json.dumps(entry) + "\n")
        except Exception as e:
            logger.warning(f"Coincidences: the change was not logged in the run directory: {e}")

    def needed(self) -> bool:
        return any(g["enabled"] and g["channels"] and g["partners"] for g in self._config["gates"])

    # ── run lifecycle ──────────────────────────────────────────────────────
    def start(self, acq) -> None:
        # A loop still finishing the previous run's tick needs the lock to
        # end: wait for it outside the lock. If it is still alive after that,
        # it simply carries on as this run's loop.
        old = self._thread
        if old is not None and old.is_alive() and self._stop.is_set():
            old.join(timeout=5)
        with self._lock:
            self._acq = acq
            self._setup()
            self._stop.clear()
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._loop, name="coincidences", daemon=True)
                self._thread.start()

    def finish(self) -> None:
        """At run stop: evaluate everything still pending, then stand down.
        The results stay readable until the next run starts."""
        with self._lock:
            if self._acq is None:
                return
            self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
        with self._lock:
            try:
                self._tick(final=True)
            except Exception as e:
                logger.error(f"Coincidences: final evaluation failed: {e}")
            for src in self._sources.values():
                try:
                    src.enable(False)
                except Exception:
                    pass
            self._acq = None
            if self._thread is not None and not self._thread.is_alive():
                self._thread = None

    def reset(self) -> None:
        with self._lock:
            if self._acq is not None:
                self._setup()
            else:
                bins = self._energy_bins()
                fresh = {}
                for gid, g in self._gates.items():
                    fresh[gid] = GateState(g.gate, bins, g.offsets_ns)
                    if g.sum_cal is not None:
                        fresh[gid].set_sum_calibration(g.sum_cal)
                self._gates = fresh

    def _energy_bins(self) -> Dict[str, int]:
        return {bid: s.energy_bins for bid, s in self._sources.items()}

    def _setup(self, keep_unchanged: bool = False) -> None:
        """(Re)build the evaluation state from the configuration (lock held)."""
        cfg = self._config
        acq = self._acq
        self._sources = sources_for_run(acq) if acq is not None else {}
        problems = check_gates(cfg, acq.get_boards()) if acq is not None else {}
        gates = [g for g in cfg["gates"] if g["enabled"] and not problems.get(g["id"])]

        used = {}
        for g in gates:
            for ref in g["channels"] + g["partners"]:
                used.setdefault(ref["board"], set()).add(int(ref["channel"]))
        self._keys = {}
        for bid in sorted(used):
            for ch in sorted(used[bid]):
                self._keys[channel_key(bid, ch)] = len(self._keys)
        self._offsets = {code: int(round(float(cfg["offsets_ns"].get(k, 0.0)) * 1000))
                         for k, code in self._keys.items()}

        for bid, src in self._sources.items():
            try:
                src.enable(bid in used)
                if bid in used:
                    src.take()                       # start from now
            except Exception as e:
                logger.warning(f"Coincidences: could not switch hits on board {bid}: {e}")
        self._dropped_base = {bid: self._safe(src.dropped) for bid, src in self._sources.items()}
        self._skipped_base = {bid: self._safe(src.skipped) for bid, src in self._sources.items()}
        # A gate on a board that exports no hits would just stay at zero.
        self._source_problems = {}
        for g in gates:
            silent = sorted({r["board"] for r in g["channels"] + g["partners"]} - set(self._sources))
            if silent:
                self._source_problems[g["id"]] = [
                    f"Board {b} does not export hits: its online decoding is off, or the "
                    f"installed driver is too old (reinstall with install.sh)." for b in silent]

        self._domains = {}
        for bid in used:
            src = self._sources.get(bid)
            if src is None:
                continue
            self._domains.setdefault(src.domain, Domain(src.domain, [])).boards.append(bid)
        bins = self._energy_bins()
        previous = self._gates if keep_unchanged else {}
        self._gates = {}
        for g in gates:
            fresh = GateState(g, bins, cfg["offsets_ns"])
            old = previous.get(g["id"])
            if old is not None and old.gate == g and old.bins == fresh.bins and all(
                    old.offsets_ns.get(k, 0.0) == fresh.offsets_ns.get(k, 0.0)
                    for k in fresh.channels + fresh.partners):
                old.offsets_ns = fresh.offsets_ns
                fresh = old
            self._gates[g["id"]] = fresh
        self._check_calibrations(time.time())
        if not keep_unchanged:
            self._started_at = time.time()
        if gates:
            logger.info(f"Coincidences: {len(gates)} gate(s) over {len(self._keys)} channel(s)")

    def _check_calibrations(self, now: float) -> None:
        """Give the sum spectra the current calibrations. Called at setup and
        then every CALIB_CHECK_S from the tick, so a calibration saved during
        the run (from the Histograms page or any other way the file changes)
        starts the affected sum spectra over instead of mixing two scales."""
        self._calib_checked = now
        sums = [g for g in self._gates.values() if g.sum is not None]
        if not sums or self._acq is None:
            return
        try:
            boards = self._acq.get_boards()
            table = read_calibrations(boards, sorted({k for g in sums for k in g.sum_keys}))
        except Exception as e:
            logger.warning(f"Coincidences: could not read the calibrations for the sum spectra: {e}")
            return
        for g in sums:
            if g.set_sum_calibration(table):
                logger.info(f"Coincidences: gate '{g.gate['name']}': a calibration changed, "
                            f"its sum spectrum starts over")

    @staticmethod
    def _safe(counter) -> int:
        try:
            return int(counter())
        except Exception:
            return 0

    def _loop(self) -> None:
        while not self._stop.wait(TICK_S):
            try:
                with self._lock:
                    self._tick(final=False)
                self._last_error = ""
            except Exception as e:
                if str(e) != self._last_error:
                    logger.error(f"Coincidences: evaluation failed: {e}")
                self._last_error = str(e)

    def _tick(self, final: bool) -> None:
        if not self._gates:
            return
        now = time.time()
        if now - self._calib_checked >= CALIB_CHECK_S:
            self._check_calibrations(now)
        latency_ps = int(self._config["latency_ms"]) * 1_000_000_000
        reach = max(g.reach_ps for g in self._gates.values())
        for bid, src in self._sources.items():
            dom = self._domains.get(src.domain)
            if dom is None or bid not in dom.boards:
                continue
            hits = src.take()
            if hits.size == 0:
                continue
            dom.progress(bid, int(hits["time_ps"].max()), now)
            codes = np.full(64, -1, np.int32)
            shift = np.zeros(64, np.int64)
            for ch in range(64):
                code = self._keys.get(channel_key(bid, ch))
                if code is not None:
                    codes[ch] = code
                    shift[ch] = self._offsets.get(code, 0)
            ch = hits["channel"].astype(np.int64)
            det = np.where(ch < 64, codes[np.minimum(ch, 63)], -1)
            keep = det >= 0
            if not keep.any():
                continue
            t = hits["time_ps"][keep] + shift[ch[keep]]
            det = det.astype(np.int32)
            dom.add(t, det[keep], hits["energy"][keep], reach)

        for dom in self._domains.values():
            cut = dom.cutoff(latency_ps, now, final)
            if cut is None:
                continue
            hi = cut - (0 if final else reach)
            lo = dom.done if dom.done is not None else int(dom.t[0])
            if hi <= lo:
                continue
            gates = [g for g in self._gates.values() if self._in_domain(g, dom)]
            for g in gates:
                g.evaluate(dom.t, dom.det, dom.e, self._keys, lo, hi)
            dom.done = hi
            dom.promised = cut
            keep_from = np.searchsorted(dom.t, hi - reach, "left")
            if keep_from:
                dom.t, dom.det, dom.e = dom.t[keep_from:], dom.det[keep_from:], dom.e[keep_from:]

    def _in_domain(self, g: GateState, dom: Domain) -> bool:
        return all(k.split(":")[0] in dom.boards for k in g.channels + g.partners)

    # ── results ────────────────────────────────────────────────────────────
    def status(self) -> Dict[str, Any]:
        with self._lock:
            now = time.time()
            boards = self._acq.get_boards() if self._acq is not None else None
            if boards is None:
                from .daq_manager import get_daq_manager
                try:
                    boards = get_daq_manager().get_boards()
                except Exception:
                    boards = []
            dropped = sum(max(0, self._safe(s.dropped) - self._dropped_base.get(b, 0))
                          for b, s in self._sources.items())
            skipped = sum(max(0, self._safe(s.skipped) - self._skipped_base.get(b, 0))
                          for b, s in self._sources.items())
            problems = check_gates(self._config, boards)
            if self._acq is not None:
                for gid, extra in self._source_problems.items():
                    problems.setdefault(gid, []).extend(extra)
            # Problems of one output only: the rest of the gate works, so they
            # are kept apart from the problems that stop the gate.
            names = {str(b["id"]): f"{b.get('name', 'board')} {b['id']}" for b in boards}
            warnings: Dict[str, List[str]] = {}
            for gid, g in self._gates.items():
                if g.sum is not None and g.sum_missing:
                    where = ", ".join(f"{names.get(k.split(':')[0], 'board ' + k.split(':')[0])} · ch {k.split(':')[1]}"
                                      for k in g.sum_missing)
                    warnings[gid] = [f"Sum spectrum needs an energy calibration on: {where}. "
                                     f"Calibrate {'it' if len(g.sum_missing) == 1 else 'them'} on the Histograms "
                                     f"page; the other outputs of this gate work."]
            return {
                "running": self._acq is not None,
                "gates": [g.status(now) for g in self._gates.values()],
                "problems": problems,
                "warnings": warnings,
                "domains": [{"name": d.name, "boards": d.boards, "pending": d.pending,
                             "late": d.late, "overflow": d.overflow,
                             "memory_mb": round(d.pending * 14 / 1e6, 1)}
                            for d in self._domains.values()],
                "dropped": dropped,
                "skipped_blocks": skipped,
                "clock_domains": clock_domains(boards),
                "since": self._started_at or None,
            }

    def gate(self, gate_id: str) -> Optional[GateState]:
        with self._lock:
            return self._gates.get(gate_id)

    def spectrum(self, gate_id: str, key: str) -> Optional[np.ndarray]:
        with self._lock:
            g = self._gates.get(gate_id)
            return None if g is None or key not in g.spectra else g.spectra[key].copy()

    def dt(self, gate_id: str, key: str, partner: str) -> Optional[Tuple[np.ndarray, float]]:
        with self._lock:
            g = self._gates.get(gate_id)
            if g is None:
                return None
            if partner == "*":
                arrays = [v for (a, p), v in g.dt.items() if a == key or key == "*"]
                if not arrays:
                    return None
                return np.sum(arrays, axis=0).astype(np.uint32), g.gate["dt_range_ns"]
            h = g.dt.get((key, partner))
            return None if h is None else (h.copy(), g.gate["dt_range_ns"])

    def sum_spectrum(self, gate_id: str) -> Optional[Tuple[np.ndarray, float]]:
        """The gate's sum spectrum and its bin width in keV."""
        with self._lock:
            g = self._gates.get(gate_id)
            return None if g is None or g.sum is None else (g.sum.copy(), g.sum_bin_kev)

    def matrix(self, gate_id: str) -> Optional[Tuple[np.ndarray, Tuple[int, int]]]:
        with self._lock:
            g = self._gates.get(gate_id)
            return None if g is None or g.matrix is None else (g.matrix.copy(), g.matrix_bins)

    def align(self, gate_id: str) -> Dict[str, float]:
        """Shift each partner's time offset so its Δt peak against the gate's
        first channel sits at zero. Returns the offsets changed (ns)."""
        with self._lock:
            g = self._gates.get(gate_id)
            if g is None or not g.channels:
                raise ValueError("No such gate in the current run")
            ref = g.channels[0]
            cfg = json.loads(json.dumps(self._config))
            changed = {}
            for p in g.partners:
                h = g.dt.get((ref, p))
                if h is None or h.sum() < 10:
                    continue
                centre = peak_centre(h, g.gate["window_ns"], g.gate["dt_range_ns"])
                if centre is None:
                    continue
                # Relative to the offsets the gate's times were built with, not
                # to the current ones: aligning twice on the same data is the
                # same as aligning once.
                new = round(g.offsets_ns.get(p, 0.0) - centre, 3)
                cfg["offsets_ns"][p] = new
                changed[p] = new
            if not changed:
                raise ValueError("Not enough coincidences yet to find the Δt peaks")
        self.set_config(cfg)
        return changed


def peak_centre(h: np.ndarray, window_ns: float, range_ns: float) -> Optional[float]:
    """Where the coincidence peak of a Δt histogram sits, in ns.

    Real peaks are often broad — a channel's time stamp jitters by several ns —
    so the single highest bin says little. The histogram is smoothed to find
    the peak, the flat floor of chance coincidences (the median bin) is taken
    off, and the centroid is taken over the coincidence window around it.
    """
    bin_ns = 2 * range_ns / h.size
    k = max(3, int(round(min(window_ns, range_ns) / bin_ns / 4)) | 1)
    smooth = np.convolve(h.astype(np.float64), np.ones(k), mode="same")
    peak = int(np.argmax(smooth))
    half = max(2, int(round(window_ns / bin_ns)))
    lo, hi = max(0, peak - half), min(h.size, peak + half + 1)
    w = np.clip(h[lo:hi].astype(np.float64) - float(np.median(h)), 0, None)
    if w.sum() <= 0:
        return None
    centre_bin = (np.arange(lo, hi) + 0.5) @ w / w.sum()
    return float(-range_ns + centre_bin * bin_ns)


_builder: Optional[CoincidenceBuilder] = None
_builder_lock = threading.Lock()


def get_coincidence_builder() -> CoincidenceBuilder:
    global _builder
    with _builder_lock:
        if _builder is None:
            _builder = CoincidenceBuilder()
        return _builder
