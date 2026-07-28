# app/utils/board_defaults.py
"""
Default register dumps for boards added in test mode.

With real hardware a board's ``conf/<name>_<id>.json`` is produced by reading the
digitizer (``Digitizer.read_pha`` / ``read_psd``). In test mode there is no board
to read, so this module fabricates an equivalent dump: the same register set, the
same JSON shape, and plausible starting values.

That matters because the register file is the single source of truth for the
whole system — the CAEN dashboard edits it, ``caendaq`` applies it to the (mock)
board, and Acquisition Control (0x8100) in it decides how a run starts. An empty
dump leaves the dashboard blank and the synchronisation controls with nothing to
act on.

Register addresses and their meanings follow the CAEN register manuals:
UM5678 (725/730 DPP-PHA) rev.3 and UM4380 (725/730 DPP-PSD) rev.6.
"""

from typing import Any, Dict

# Per-channel registers live at 0x1nXY, where n is the channel: channel c sits at
# base + c * 0x100. Anything at or above this is a single board-wide register.
_PER_CHANNEL_LIMIT = 0x2000
_CHANNEL_STRIDE = 0x100

# Board Configuration (0x8000) bits the manuals mark "must be 1" for both DPP
# firmwares: [4] reserved-must-be-1, [8] individual trigger, [18] time stamp
# recording, [19] energy/charge recording. A board programmed without these does
# not produce well-formed events.
# (UM5678 rev.3 pp.38-39 / UM4380 rev.6 p.38)
_MANDATORY_BOARD_CONFIG = (1 << 4) | (1 << 8) | (1 << 18) | (1 << 19)

# ── DPP-PHA ──────────────────────────────────────────────────────────────────
# (address, name, default value). Mirrors the register map in Digitizer.read_pha.
_PHA_REGISTERS = [
    # Per channel
    (0x1020, "Record Length", 500),
    (0x1028, "Input Dynamic Range", 0),     # 0 = 2 Vpp
    (0x1034, "Number of Events per Aggregate", 10),
    (0x1038, "Pre Trigger", 100),
    # Only 8 values are legal here (UM5678 p.16); 0x4 = 8 samples.
    (0x1054, "RC-CR2 Smoothing Factor", 0x4),
    (0x1058, "Input Rise Time", 6),
    (0x105C, "Trapezoid Rise Time", 50),
    (0x1060, "Trapezoid Flat Top", 25),
    (0x1064, "Peaking Time", 12),
    (0x1068, "Decay Time", 500),
    (0x106C, "Trigger Threshold", 100),
    (0x1070, "Rise Time Validation Window", 0),
    (0x1074, "Trigger Hold-Off Width", 100),
    (0x1078, "Peak Hold-Off", 100),
    # Trapezoid rescaling = 4 (bits[5:0]) + baseline averaging = 1024 samples
    # (bits[22:20] = 100b).
    (0x1080, "DPP Algorithm Control", 0x400004),
    (0x1084, "Shaped Trigger Width", 10),
    (0x1098, "DC Offset", 0x8000),          # DAC mid-scale
    (0x10A0, "DPP Algorithm Control 2", 0x0),
    (0x10C4, "Fine Gain", 0x1000),
    (0x10D4, "Veto Width", 0),
    # Board wide
    (0x8000, "Board Configuration", _MANDATORY_BOARD_CONFIG),
    (0x800C, "Aggregate Configuration", 0),
    (0x8100, "Acquisition Control", 0x0),   # SW controlled — see note below
    (0x810C, "Global Trigger Mask", 0),
    (0x8110, "Front Panel TRG-OUT Enable Mask", 0),
    (0x811C, "Front Panel I/O Control", 0),
    (0x8120, "Channel Enable Mask", None),  # filled from the channel count
    (0x8170, "Run/Start/Stop Delay", 0),
    (0x817C, "Disable External Trigger", 0),
    (0x81C4, "Extended Veto Delay", 0),
    (0xEF08, "Board ID", None),             # filled from the board id
    (0xEF1C, "Aggregate Number per BLT", 1000),
]

# ── DPP-PSD ──────────────────────────────────────────────────────────────────
# Mirrors the register map in Digitizer.read_psd.
_PSD_REGISTERS = [
    # Per channel
    (0x1020, "Record Length", 500),
    (0x1028, "Input Dynamic Range", 0),     # 0 = 2 Vpp
    (0x1034, "Number of Events per Aggregate", 10),
    (0x1038, "Pre Trigger", 100),
    (0x103C, "CFD Settings", 0),
    (0x1044, "Charge Zero Suppression Threshold", 0),
    (0x1054, "Short Gate", 20),
    (0x1058, "Long Gate", 100),
    (0x105C, "Gate Offset", 10),
    (0x1060, "Trigger Threshold", 100),
    (0x1064, "Fixed Baseline", 0),
    (0x106C, "Trigger Latency", 0),
    (0x1070, "Shaped Trigger Width", 10),
    (0x1074, "Trigger Hold-Off Width", 100),
    (0x1078, "Threshold for the PSD", 100),
    (0x107C, "PUR-GAP Threshold", 100),
    # Baseline mean = 1024 samples (bits[22:20] = 100b), charge sensitivity 0.
    (0x1080, "DPP Algorithm Control", 0x400000),
    (0x1084, "DPP Algorithm Control 2", 0x0),
    (0x1098, "DC Offset", 0x8000),          # DAC mid-scale
    # NOTE: DPP-PSD has neither Fine Gain (0x1nC4) nor Trapezoid Baseline
    # Offset (0x1nB8) — those are DPP-PHA only (UM4380 rev.6 p.7).
    (0x10D4, "Veto Width", 0),
    (0x10D8, "Early Baseline Freeze", 0),
    # Board wide
    (0x8000, "Board Configuration", _MANDATORY_BOARD_CONFIG),
    (0x800C, "Aggregate Configuration", 0),
    (0x8100, "Acquisition Control", 0x0),
    (0x810C, "Global Trigger Mask", 0),
    (0x8110, "Front Panel TRG-OUT Enable Mask", 0),
    (0x811C, "Front Panel I/O Control", 0),
    (0x8120, "Channel Enable Mask", None),
    (0x8170, "Run/Start/Stop Delay", 0),
    (0x817C, "Disable External Trigger", 0),
    (0x81C4, "Extended Veto Delay", 0),
    (0xEF08, "Board ID", None),
    (0xEF1C, "Aggregate Number per BLT", 1000),
]


def _entry(address: int, name: str, value: int, channel: int) -> Dict[str, Any]:
    """One register in the on-disk format used by Digitizer._read_configuration."""
    return {
        "name": name,
        "channel": channel,
        "address": f"0x{address:04X}",
        "value": f"0x{value:X}",
    }


def default_registers(dpp: str, channels: int, board_id: int) -> Dict[str, Any]:
    """Build a full default register dump for a mock board.

    Per-channel registers are replicated for every channel at base + c*0x100, so
    the dashboard shows the same per-channel layout it would for real hardware.

    Acquisition Control defaults to 0x0 (SW controlled), i.e. the board starts on
    its own software command. Set it to first-trigger mode in the dashboard to
    put the board into a synchronised chain.
    """
    registers = _PHA_REGISTERS if "PHA" in str(dpp).upper() else _PSD_REGISTERS
    channels = max(1, int(channels))

    out: Dict[str, Any] = {}
    for address, name, value in registers:
        if name == "Channel Enable Mask":
            value = (1 << channels) - 1     # every channel on by default
        elif name == "Board ID":
            value = int(board_id)

        if address < _PER_CHANNEL_LIMIT:
            for channel in range(channels):
                addr = address + channel * _CHANNEL_STRIDE
                out[f"reg_{addr:04X}"] = _entry(addr, name, value, channel)
        else:
            out[f"reg_{address:04X}"] = _entry(address, name, value, 0)
    return out


def default_board_config(name: str, board_id: int, dpp: str, channels: int) -> Dict[str, Any]:
    """A complete conf/<name>_<id>.json body for a mock board."""
    return {
        # Mirrors the "dgtzs" block the hardware path writes, so downstream
        # consumers see the same shape whether or not a board was present.
        "dgtzs": {
            "BoardName": str(name),
            "NbChannels": str(channels),
            "BoardNb": str(board_id),
            "Firmware": "mock",
        },
        "registers": default_registers(dpp, channels, board_id),
    }
