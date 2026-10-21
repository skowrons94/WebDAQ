"""
Decoding of SIS3316 hit/event records (SIS3316 manual sec. 4.6).

Each record::

    word 0      ts[47:32] | channel id[15:4] | format bits[3:0]
    word 1      ts[31:0]
    [bit 0]     peak high index|value, info|acc gate 1, acc gates 2-6   (7 words)
    [bit 1]     acc gates 7, 8                                         (2 words)
    [bit 2]     MAW max, MAW before trigger, MAW after trigger          (3 words)
    [bit 3]     start energy, max energy                               (2 words)
    marker      0xE | MAW test flag[27] | status flag[26] | raw words[25:0]
    raw         2 x 16-bit samples per word
    [MAW test]  MAW test buffer, one 32-bit value per word

Within one channel bank every record has the same length for a given
configuration, so a bank is decoded with numpy reshapes; a record that breaks
the pattern sends the whole bank through the slower record walker, which keeps
the most common record layout and stops at the first malformed record.
"""

from typing import Dict, List, Optional, Tuple

import numpy as np

FORMAT_WORDS = ((0x1, 7), (0x2, 2), (0x4, 3), (0x8, 2))


def header_words(format_bits: int) -> int:
    """Words before the 0xE marker."""
    return 2 + sum(n for bit, n in FORMAT_WORDS if format_bits & bit)


def _empty() -> Dict[str, np.ndarray]:
    return {
        "timestamp": np.zeros(0, np.uint64),
        "channel_id": np.zeros(0, np.uint16),
        "energy_start": np.zeros(0, np.int64),
        "energy_max": np.zeros(0, np.int64),
        "pileup": np.zeros(0, bool),
        "peak_high": np.zeros(0, np.uint16),
        "peak_index": np.zeros(0, np.uint16),
        "maw_max": np.zeros(0, np.int64),
    }


def _fields(rec: np.ndarray, fmt: int) -> Dict[str, np.ndarray]:
    """Decode an (n_events, record_length) array of uint32 records."""
    w0 = rec[:, 0].astype(np.uint64)
    out = _empty()
    out["timestamp"] = ((w0 >> np.uint64(16)) << np.uint64(32)) | rec[:, 1].astype(np.uint64)
    out["channel_id"] = ((rec[:, 0] >> 4) & 0xFFF).astype(np.uint16)
    col = 2
    n = rec.shape[0]
    if fmt & 0x1:
        out["peak_high"] = (rec[:, col] & 0xFFFF).astype(np.uint16)
        out["peak_index"] = (rec[:, col] >> 16).astype(np.uint16)
        col += 7
    else:
        out["peak_high"] = np.zeros(n, np.uint16)
        out["peak_index"] = np.zeros(n, np.uint16)
    if fmt & 0x2:
        col += 2
    if fmt & 0x4:
        out["maw_max"] = (rec[:, col] & 0x0FFFFFFF).astype(np.int64)
        col += 3
    else:
        out["maw_max"] = np.zeros(n, np.int64)
    if fmt & 0x8:
        # Energies are 32-bit two's complement trapezoid values
        out["energy_start"] = rec[:, col].astype(np.int32).astype(np.int64)
        out["energy_max"] = rec[:, col + 1].astype(np.int32).astype(np.int64)
        col += 2
    else:
        out["energy_start"] = np.zeros(n, np.int64)
        out["energy_max"] = np.zeros(n, np.int64)
    out["pileup"] = ((rec[:, col] >> 26) & 1).astype(bool)
    return out


def decode_bank(words: np.ndarray, maw_words: int = 0,
                want_waveform: bool = True) -> Tuple[Dict[str, np.ndarray],
                                                     Optional[np.ndarray],
                                                     Optional[np.ndarray]]:
    """Decode one channel's bank.

    Returns (fields, waveforms, maw): fields is a dict of per-event arrays;
    waveforms is an (n_events, samples) uint16 array and maw an
    (n_events, maw_words) int32 array, row-aligned with fields, or None when
    not recorded (or want_waveform is False).
    """
    words = np.asarray(words, dtype=np.uint32)
    if words.size < 3:
        return _empty(), None, None
    fmt = int(words[0] & 0xF)
    hdr = header_words(fmt)
    if words.size <= hdr:
        return _empty(), None, None
    marker = int(words[hdr])
    if marker >> 28 != 0xE:
        return _walk(words, maw_words, want_waveform)
    raw_words = marker & 0x3FFFFFF
    maw = maw_words if marker & (1 << 27) else 0
    reclen = hdr + 1 + raw_words + maw
    if words.size % reclen:
        return _walk(words, maw_words, want_waveform)
    rec = words.reshape(-1, reclen)
    if np.any((rec[:, hdr] >> 28) != 0xE) or np.any((rec[:, 0] & 0xF) != fmt):
        return _walk(words, maw_words, want_waveform)
    fields = _fields(rec, fmt)
    wave = None
    maw_trace = None
    if want_waveform and raw_words:
        wave = np.ascontiguousarray(rec[:, hdr + 1:hdr + 1 + raw_words]).view(np.uint16)
    if want_waveform and maw:
        maw_trace = _maw_values(rec[:, hdr + 1 + raw_words:])
    return fields, wave, maw_trace


def _maw_values(words: np.ndarray) -> np.ndarray:
    """MAW test buffer words carry a 28-bit value offset by 0x8000000."""
    return (words & 0x0FFFFFFF).astype(np.int32) - 0x8000000


def _walk(words: np.ndarray, maw_words: int,
          want_waveform: bool) -> Tuple[Dict[str, np.ndarray], Optional[np.ndarray], Optional[np.ndarray]]:
    """Record-by-record decode for banks with mixed record lengths. Stops at
    the first malformed record (the rest of the bank cannot be trusted)."""
    records: Dict[Tuple[int, int], List[np.ndarray]] = {}
    layout: Dict[Tuple[int, int], Tuple[int, int, int]] = {}
    i = 0
    n = words.size
    while i + 3 <= n:
        fmt = int(words[i] & 0xF)
        hdr = header_words(fmt)
        if i + hdr >= n:
            break
        marker = int(words[i + hdr])
        if marker >> 28 != 0xE:
            break
        raw_words = marker & 0x3FFFFFF
        maw = maw_words if marker & (1 << 27) else 0
        reclen = hdr + 1 + raw_words + maw
        if i + reclen > n:
            break
        rec = words[i:i + reclen]
        records.setdefault((fmt, reclen), []).append(rec)
        layout[(fmt, reclen)] = (hdr, raw_words, maw)
        i += reclen
    if not records:
        return _empty(), None, None
    # Keep the most common record layout: waveforms of different lengths
    # cannot share one row-aligned array.
    key = max(records, key=lambda k: len(records[k]))
    rec = np.stack(records[key])
    hdr, raw_words, maw = layout[key]
    fields = _fields(rec, key[0])
    wave = maw_trace = None
    if want_waveform and raw_words:
        wave = np.ascontiguousarray(rec[:, hdr + 1:hdr + 1 + raw_words]).view(np.uint16)
    if want_waveform and maw:
        maw_trace = _maw_values(rec[:, hdr + 1 + raw_words:])
    return fields, wave, maw_trace
