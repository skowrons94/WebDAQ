"""
Settings model of one SIS3316 and its defaults.

The JSON stored in ``conf/SIS3316_<id>.json`` (and edited by the WebDAQ settings
page) has three parts::

    {
      "board":            {...},   # board/group-wide acquisition settings
      "channel_defaults": {...},   # applied to every channel
      "channels":         {"0": {...}, ...}  # per-channel overrides, sparse
    }

Units: times are in samples (1 sample = 4 ns at 250 MHz), the trigger
thresholds are in ADC counts of pulse height (the driver multiplies by the
trigger peaking time, since the trapezoid sums P samples).
"""

import copy
from typing import Any, Dict

# sample clock MHz -> (Si570 HS_DIV, N1, IOB delay for ADC firmware rev >= 4,
# IOB delay for older ADC firmware); 14-bit 250 MHz board values from Struck's
# sis3316_root_gui (iob_delay_14bit_array).
CLOCK_TABLE = {
    250.0: (5, 4, 0x1002, 0x48),
    125.0: (5, 8, 0x50, 0x50),
    100.0: (5, 10, 0x1020, 0x1020),
    62.5: (5, 16, 0x1060, 0x1060),
    50.0: (5, 20, 0x20, 0x20),
    25.0: (5, 40, 0x20, 0x20),
}

# Input range -> gain control bits (manual 6.7). 1.9 V is the 2nd 2 V setting.
GAIN_CODES = {"5V": 0x0, "2V": 0x1, "1.9V": 0x2}

BOARD_DEFAULTS: Dict[str, Any] = {
    "sample_clock_mhz": 250.0,
    "header_id": 0,
    # Readout
    "readout_interval_ms": 200,         # bank swap at least this often
    "bank_threshold_words": 0x400000,   # swap early when a channel bank reaches this
    # Event content (same for all channels)
    "trigger_gate_window": 400,         # samples
    "pre_trigger_delay": 100,           # samples
    "raw_samples": 500,                 # waveform samples saved per event (0 = none)
    "raw_start_index": 0,
    "pileup_window": 0,
    "repileup_window": 0,
    "save_peak_accumulators": False,
    "save_maw_values": False,
    "maw_test_buffer_length": 0,        # trapezoid samples saved per event (0 = none)
    "maw_test_buffer_pretrigger": 100,
    "maw_test_buffer_energy": True,     # True: energy MAW, False: trigger MAW
    # On-board 64K-bin energy histograms
    "onboard_histograms": True,
    # Board-wide trigger / NIM I/O
    "nim_ti_as_trigger": False,
    "nim_ti_timestamp_clear": False,
    "lemo_co_select": 0,
    "lemo_to_select": 0,
    "lemo_uo_select": 0,
    # Online spectra built by the software from the event energies
    "spectrum_bins": 16384,
}

CHANNEL_DEFAULTS: Dict[str, Any] = {
    "enabled": False,
    "invert": False,                    # True for negative signals
    "input_range": "5V",
    "termination_50ohm": True,
    "dac_offset": 0x8000,               # 0x8000 = centred range
    # Trigger (fast trapezoid)
    "internal_trigger": True,
    "external_trigger": False,
    "trigger_peaking": 8,
    "trigger_gap": 8,
    "trigger_threshold": 100,           # ADC counts of pulse height
    "high_energy_threshold": 0,
    "cfd": "50",                        # off | zero | 50
    "trigger_pulse_length": 10,
    # Energy (slow trapezoid)
    "energy_peaking": 200,
    "energy_gap": 50,
    "tau_table": 0,
    "tau_factor": 0,                    # 0 = no decay correction
    "energy_extra_filter": 0,
    "energy_pickup_index": 0,
    # Energy scale: spectrum bin = max energy / divider (also the on-board divider)
    "histogram_divider": 200,
    "histogram_offset": 0,
    "histogram_pileup": False,
}

N_CHANNELS = 16


def default_settings() -> Dict[str, Any]:
    return {
        "board": copy.deepcopy(BOARD_DEFAULTS),
        "channel_defaults": copy.deepcopy(CHANNEL_DEFAULTS),
        "channels": {},
    }


def apply_defaults(settings: Dict[str, Any]) -> Dict[str, Any]:
    """Return a complete copy of settings, missing keys taken from the defaults."""
    out = default_settings()
    settings = settings or {}
    out["board"].update(settings.get("board", {}) or {})
    out["channel_defaults"].update(settings.get("channel_defaults", {}) or {})
    for key, val in (settings.get("channels", {}) or {}).items():
        out["channels"][str(int(key))] = dict(val or {})
    return out


def channel_settings(settings: Dict[str, Any], channel: int) -> Dict[str, Any]:
    """Effective settings of one channel (0-15)."""
    ch = dict(settings.get("channel_defaults", CHANNEL_DEFAULTS))
    for k, v in CHANNEL_DEFAULTS.items():
        ch.setdefault(k, v)
    ch.update(settings.get("channels", {}).get(str(channel), {}) or {})
    return ch


def _even(v: Any, lo: int, hi: int) -> int:
    v = int(v)
    v = max(lo, min(hi, v))
    return v - (v & 1)


def validate(settings: Dict[str, Any]) -> Dict[str, Any]:
    """Clamp a settings dict to what the hardware accepts; raises ValueError on
    unknown enum values. Returns the cleaned settings."""
    s = apply_defaults(settings)
    b = s["board"]
    clock = float(b["sample_clock_mhz"])
    if clock not in CLOCK_TABLE:
        raise ValueError(f"sample clock {clock} MHz not supported "
                         f"(choose one of {sorted(CLOCK_TABLE)})")
    b["readout_interval_ms"] = max(20, min(10000, int(b["readout_interval_ms"])))
    b["bank_threshold_words"] = max(1024, min(0xFE0000, int(b["bank_threshold_words"])))
    b["trigger_gate_window"] = _even(b["trigger_gate_window"], 2, 65536)
    b["pre_trigger_delay"] = _even(b["pre_trigger_delay"], 0, 2042)
    # Measured on V3316-2004 / A_0250_0004 with all 16 channels recording:
    # windows near 64K samples come back with a few hundred corrupt samples at
    # the end of some events (deterministically, by memory position), while
    # 30+ events of 32000 samples per channel were clean.
    b["raw_samples"] = _even(b["raw_samples"], 0, 32000)
    b["raw_start_index"] = _even(b["raw_start_index"], 0, 65534)
    b["pileup_window"] = _even(b["pileup_window"], 0, 65534)
    b["repileup_window"] = _even(b["repileup_window"], 0, 65534)
    b["maw_test_buffer_length"] = _even(b["maw_test_buffer_length"], 0, 1024)
    b["maw_test_buffer_pretrigger"] = _even(b["maw_test_buffer_pretrigger"], 2, 1022)
    b["spectrum_bins"] = max(256, min(65536, int(b["spectrum_bins"])))
    for key in ("lemo_co_select", "lemo_to_select", "lemo_uo_select"):
        b[key] = int(b[key]) & 0xFFFFFFFF
    for blk in [s["channel_defaults"]] + list(s["channels"].values()):
        if "input_range" in blk and str(blk["input_range"]) not in GAIN_CODES:
            raise ValueError(f"input range must be one of {sorted(GAIN_CODES)}")
        if "cfd" in blk and str(blk["cfd"]) not in ("off", "zero", "50"):
            raise ValueError("cfd must be off, zero or 50")
        for key, lo, hi in (("trigger_peaking", 2, 510), ("trigger_gap", 2, 510),
                            ("energy_peaking", 2, 2044), ("energy_gap", 2, 510)):
            if key in blk:
                blk[key] = _even(blk[key], lo, hi)
        if "dac_offset" in blk:
            blk["dac_offset"] = max(0, min(0xFFFF, int(blk["dac_offset"])))
        if "tau_table" in blk:
            blk["tau_table"] = max(0, min(3, int(blk["tau_table"])))
        if "tau_factor" in blk:
            blk["tau_factor"] = max(0, min(63, int(blk["tau_factor"])))
        if "energy_extra_filter" in blk:
            blk["energy_extra_filter"] = max(0, min(3, int(blk["energy_extra_filter"])))
        if "histogram_divider" in blk:
            blk["histogram_divider"] = max(1, min(4095, int(blk["histogram_divider"])))
        if "trigger_threshold" in blk:
            blk["trigger_threshold"] = max(0, min(0x7FFFFFF, int(blk["trigger_threshold"])))
        if "trigger_pulse_length" in blk:
            blk["trigger_pulse_length"] = _even(blk["trigger_pulse_length"], 2, 254)
    for key in list(s["channels"]):
        if not 0 <= int(key) < N_CHANNELS:
            raise ValueError(f"channel {key} out of range 0-15")
    return s
