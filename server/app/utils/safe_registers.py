"""
Which digitizer registers may be written straight to the board.

Online tuning changes a register on a board that is acquiring, so the operator
sees the effect in the waveform and the spectrum immediately instead of
stopping, editing the configuration and starting again.

Not every register can take that. The DPP parameters of a channel — thresholds,
gates, shaping times, offsets — are meant to be adjusted while data flows, and
CAEN's own tools do exactly that. The registers that define the *shape* of the
readout are a different matter: record length, the aggregate organisation, the
channel enable mask, the acquisition control and the board configuration all
describe what the running readout expects to receive. Changing one of those
underneath a live acquisition produces buffers the decoder cannot make sense of,
in the best case, and stops the board in the worst.

So this module keeps an allowlist rather than a denylist: a register is written
to the board only if it is known to be safe, and anything unrecognised is left
to the configuration file, where it takes effect at the next start. That way a
register added to the dump later cannot quietly become writable mid-run.

Addresses are per-channel in the 0x1n?? range, where 'n' is the channel; they
are normalised to their channel-0 form (0x10??) before lookup.
"""

from typing import Dict, Optional, Tuple

# Per-channel DPP parameters, keyed by their channel-0 address.
# The name is the one the board's register dump uses, for the message shown
# when a write is refused.

_SAFE_PHA: Dict[int, str] = {
    0x1054: "RC-CR2 Smoothing Factor",
    0x1058: "Input Rise Time",
    0x105C: "Trapezoid Rise Time",
    0x1060: "Trapezoid Flat Top",
    0x1064: "Peaking Time",
    0x1068: "Decay Time",
    0x106C: "Trigger Threshold",
    0x1070: "Rise Time Validation Window",
    0x1074: "Trigger Hold-Off Width",
    0x1078: "Peak Hold-Off",
    # Trace and probe selection, input polarity and baseline averaging live
    # here: watching a different probe is a large part of what tuning is.
    0x1080: "DPP Algorithm Control",
    0x1084: "Shaped Trigger Width",
    0x1098: "DC Offset",
    0x10A0: "DPP Algorithm Control 2",
    0x10C4: "Fine Gain",
    0x10D4: "Veto Width",
}

_SAFE_PSD: Dict[int, str] = {
    0x103C: "CFD Settings",
    0x1044: "Charge Zero Suppression Threshold",
    0x1054: "Short Gate",
    0x1058: "Long Gate",
    0x105C: "Gate Offset",
    0x1060: "Trigger Threshold",
    0x1064: "Fixed Baseline",
    0x106C: "Trigger Latency",
    0x1070: "Shaped Trigger Width",
    0x1074: "Trigger Hold-Off Width",
    0x1078: "Threshold for the PSD",
    0x107C: "PUR-GAP Threshold",
    0x1080: "DPP Algorithm Control",
    0x1084: "DPP Algorithm Control 2",
    0x1098: "DC Offset",
    0x10D4: "Veto Width",
    0x10D8: "Early Baseline Freeze",
}

# Named here only so a refusal can say *why* rather than "not in the list".
_STRUCTURAL: Dict[int, str] = {
    0x1020: "Record Length",
    0x1028: "Input Dynamic Range",     # needs an ADC calibration afterwards
    0x1034: "Number of Events per Aggregate",
    0x1038: "Pre Trigger",             # moves the trace window under the decoder
    0x8000: "Board Configuration",
    0x800C: "Aggregate Configuration",
    0x8100: "Acquisition Control",
    0x810C: "Global Trigger Mask",
    0x8110: "Front Panel TRG-OUT Enable Mask",
    0x811C: "Front Panel I/O Control",
    0x8120: "Channel Enable Mask",
    0x8170: "Run/Start/Stop Delay",
    0x817C: "Disable External Trigger",
    0x81C4: "Extended Veto Delay",
    0xEF08: "Board ID",
    0xEF1C: "Aggregate Number per BLT",
}


def channel_base(address: int) -> int:
    """
    The channel-0 form of a per-channel address (0x1A6C -> 0x106C).

    Addresses outside the per-channel range come back unchanged.
    """
    if 0x1000 <= address <= 0x1FFF:
        return address & 0xF0FF
    return address


def channel_of(address: int) -> Optional[int]:
    """The channel a per-channel address belongs to, or None if it is global."""
    if 0x1000 <= address <= 0x1FFF:
        return (address >> 8) & 0xF
    return None


def is_online_safe(address: int, dpp: str) -> Tuple[bool, str]:
    """
    May this register be written straight to the board?

    Args:
        address: register address, e.g. 0x1A6C
        dpp: the board's firmware, "DPP-PHA" or "DPP-PSD"

    Returns:
        (allowed, reason). `reason` is empty when allowed, and otherwise says
        what to do instead, in terms an operator can act on.
    """
    base = channel_base(int(address))
    safe = _SAFE_PHA if str(dpp).upper().endswith("PHA") else _SAFE_PSD

    if base in safe:
        return True, ""

    if base in _STRUCTURAL:
        return False, (
            f"{_STRUCTURAL[base]} defines how the readout is organised, so it cannot be "
            "changed while the board is acquiring. It has been saved to the configuration "
            "and will take effect at the next run.")

    other = _SAFE_PSD if safe is _SAFE_PHA else _SAFE_PHA
    if base in other:
        wanted = "DPP-PHA" if safe is _SAFE_PHA else "DPP-PSD"
        return False, (
            f"Register 0x{base:04X} is not a {wanted} parameter, so it is not written to "
            "the board. The configuration has been saved.")

    return False, (
        f"Register 0x{base:04X} is not on the list of parameters that are safe to change "
        "on a live board. The configuration has been saved and applies at the next run.")


def safe_register_names(dpp: str) -> Dict[str, str]:
    """The allowlist for a firmware, as {"0x106C": "Trigger Threshold"} — the UI
    uses it to mark which fields can be tuned online before anything is sent."""
    safe = _SAFE_PHA if str(dpp).upper().endswith("PHA") else _SAFE_PSD
    return {f"0x{address:04X}": name for address, name in safe.items()}
