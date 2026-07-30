#!/usr/bin/env python3
"""
Check a .caendat run for the readout corruption that produced run 847.

Three V1724s sharing one V1718 USB bridge were shipping channel aggregates
whose two-word header was correct and whose event payload was never written —
uniform random words, all-or-nothing per aggregate, up to 88% of the events.
Random 30-bit time tags read as counter wraps and random EXTRAS bits look like
roll-over markers, so a six-hour run reconstructed to 162 hours. The cause was
caendaq serialising board access per board instead of per link; fixed in
CaenDAQ 400a25f.

This is the instrument that tells you whether it has come back. It reads the
raw file directly — no RUReader, no ROOT, nothing but the standard library —
so it works on a live run, on a laptop, from cron, wherever.

    scripts/check_run_integrity.py /path/to/run848
    scripts/check_run_integrity.py ~/12C12C/LunaDAQ/data/run848 --quiet
    scripts/check_run_integrity.py run_848_0000.caendat --profile

Exit status is 0 when the run looks sound, 1 when it does not, and 2 when the
file could not be read at all — so `check ... || alert` is enough for cron.

WHAT IT TESTS

  1. Framing. Every board aggregate starts with 0xA, sizes chain exactly, and
     the per-board aggregate counter never skips. Framing survived even the
     worst of run 847, so a failure here is something new.

  2. Uninitialised payload. x724/x781/x782 DPP-PHA never sets bit 31 of the
     time word, nor bits 31-28 and 25-24 of the energy word. Both patterns were
     confirmed against clean data first, so there are no false positives, and
     random words trip the test with probability 127/128 each. The corruption
     has only ever been seen all-or-nothing per channel aggregate, so one bad
     event condemns the aggregate it sits in.

     Only that board family is checked. The reserved bits of the others have
     not been verified, and guessing at them would mean throwing away good
     events, so for those this test reports "not applicable" rather than a
     reassuring zero.

  3. Agreement between channels. Every channel of a synchronised set counts the
     same clock, so their reconstructed durations must agree to well under a
     second and their roll-over counts must be equal. In run 847 they ranged
     from 6 to 162 hours. This catches corruption the bit test would miss.

  4. Onset profile (--profile). Run 847 was clean for its first megabyte and
     only then went bad, so a single overall percentage can hide a problem that
     starts an hour in.
"""

import argparse
import os
import struct
import sys

# ── Format constants ────────────────────────────────────────────────────────

AGG_HEADER_WORDS = 4          # board aggregate header, in 32-bit words
BOARD_ID_BITS = 5             # the aggregate header addresses ids 0-31
TS_COUNTER_BITS = 30          # x724 DPP-PHA trigger time tag
TS_PERIOD = 1 << TS_COUNTER_BITS

# Bits a working x724/x781/x782 DPP-PHA board never sets. See the module
# docstring; these mirror DataFrame::ResolveLayout in RUReader.
RESERVED_TIME = 0x80000000            # [31]
RESERVED_ENERGY = 0xF3000000          # [31:28] and [25:24]

# EXTRAS bits of the energy word, [23:16] (UM6769 rev.2).
EXTRAS_SHIFT = 16
EXTRAS_ROLL_OVER = 0x02
EXTRAS_TT_RESET = 0x04
EXTRAS_FAKE = 0x08
# The board's own fake roll-over event carries FAKE together with ROLL_OVER (or
# with TT_RESET for an external reset). ROLL_OVER alone rides along on ordinary
# events that merely follow one, and does not mark a wrap.
ROLL_OVER_MARKERS = (EXTRAS_FAKE | EXTRAS_ROLL_OVER, EXTRAS_FAKE | EXTRAS_TT_RESET)

# Time stamp LSB by board family, in ns. The counter runs at the sampling clock;
# the header's "ns per time tag" field is not a reliable source for it.
NS_PER_TICK = {"x724": 10, "x725": 4, "x730": 2, "x720": 4}

# How far channels of one synchronised set may disagree, in counter periods
# (10.7 s for an x724). They share a clock, so in principle they should not
# disagree at all — but a file always ends somewhere, and a channel whose last
# roll-over marker fell just past that end reconstructs one period short. Clean
# run 846 spreads over 2 periods for exactly that reason, and RUReader shows the
# same, so anything under a handful is a boundary artefact rather than a fault.
#
# The failure this exists to catch is not subtle: run 847's channels disagreed
# by 156 HOURS, some 52 000 periods. Five leaves four orders of magnitude of
# margin, which is the right place to sit when the alternative is crying wolf at
# 03:00.
DURATION_TOLERANCE_PERIODS = 5
WRAP_COUNT_TOLERANCE = 5


def family_of(ns_per_sample, dpp_is_pha):
    """Board family from the header, or None when it is not recognised."""
    if ns_per_sample >= 10:
        return "x724"
    if ns_per_sample == 2:
        return "x730"
    if ns_per_sample == 4:
        return "x725"
    return None


class Channel:
    __slots__ = ("events", "uninitialised", "markers", "max_ts", "epoch")

    def __init__(self):
        self.events = 0
        self.uninitialised = 0
        self.markers = 0        # fake roll-over events the board emitted
        self.max_ts = 0         # highest reconstructed tick count
        self.epoch = 0


class Result:
    def __init__(self):
        self.boards = {}                 # board id -> header info
        self.channels = {}               # (board, ch) -> Channel
        self.aggregates = 0
        self.events = 0
        self.uninitialised = 0
        self.bad_aggregates = 0
        self.resync_words = 0
        self.truncated_words = 0
        self.counter_gaps = []           # (board, previous, seen)
        self.board_fail = 0
        self.profile = []                # (byte offset, events, uninitialised)
        self.checked_families = set()
        self.unchecked_families = set()

    def channel(self, board, ch):
        key = (board, ch)
        c = self.channels.get(key)
        if c is None:
            c = self.channels[key] = Channel()
        return c


def read_header(words, result):
    """Parse the XDAQ file header. Returns the offset where aggregates start."""
    if not words:
        raise ValueError("file is empty")

    # A continuation file starts straight in with a board aggregate.
    if (words[0] >> 28) == 0xA:
        return 0

    header_words = words[0]
    if header_words < 6 or header_words > len(words):
        raise ValueError(
            f"first word is 0x{words[0]:08x}: neither an aggregate nor a header size")

    n_boards = words[2]
    if n_boards == 0 or n_boards > (1 << BOARD_ID_BITS) or header_words < 6 + n_boards:
        raise ValueError(f"header declares {n_boards} boards, which does not fit")

    for i in range(n_boards):
        info = words[6 + i]
        board_id = (info >> 24) & 0xFF
        ns_per_sample = info & 0x3F
        dpp = (info >> 12) & 0x0F           # 0 = PHA, 1 = PSD
        family = family_of(ns_per_sample, dpp == 0)
        result.boards[board_id] = {
            "ns_per_sample": ns_per_sample,
            "channels": (info >> 16) & 0xFF,
            "dpp": "PHA" if dpp == 0 else ("PSD" if dpp == 1 else f"?{dpp}"),
            "family": family,
            "ns_per_tick": NS_PER_TICK.get(family),
            # The reserved-bit test is only trusted for x724-family PHA.
            "checkable": family == "x724" and dpp == 0,
        }
    return header_words


def scan(path, profile_bucket_bytes=0):
    """Walk one .caendat file. Returns a Result."""
    with open(path, "rb") as f:
        blob = f.read()

    n_bytes = len(blob) - (len(blob) % 4)
    words = struct.unpack(f"<{n_bytes // 4}I", blob[:n_bytes])

    result = Result()
    pos = read_header(words, result)
    n = len(words)

    prev_counter = {}
    bucket_index = -1
    bucket_events = bucket_bad = 0

    while pos + AGG_HEADER_WORDS <= n:
        head = words[pos]

        # Framing. A word that is not the start of an aggregate means the stream
        # has slipped; step forward until it looks right again, as RUReader does.
        if (head >> 28) != 0xA:
            result.resync_words += 1
            pos += 1
            continue

        agg_len = head & 0x0FFFFFFF
        if agg_len < AGG_HEADER_WORDS:
            result.resync_words += 1
            pos += 1
            continue
        if pos + agg_len > n:
            # A live run always ends mid-aggregate. Not an error.
            result.truncated_words += n - pos
            break

        board = (words[pos + 1] & 0xF8000000) >> 27
        mask = words[pos + 1] & 0xFF
        if (words[pos + 1] >> 26) & 1:
            result.board_fail += 1

        counter = words[pos + 2] & 0x7FFFFF
        expected = prev_counter.get(board)
        if expected is not None and counter != ((expected + 1) & 0x7FFFFF):
            result.counter_gaps.append((board, expected, counter))
        prev_counter[board] = counter

        info = result.boards.get(board)
        checkable = bool(info and info["checkable"])
        if info:
            (result.checked_families if checkable
             else result.unchecked_families).add(info["family"] or "unknown")

        if profile_bucket_bytes:
            index = (pos * 4) // profile_bucket_bytes
            if index != bucket_index:
                if bucket_index >= 0:
                    result.profile.append(
                        (bucket_index * profile_bucket_bytes, bucket_events, bucket_bad))
                bucket_index, bucket_events, bucket_bad = index, 0, 0

        result.aggregates += 1
        p = pos + AGG_HEADER_WORDS
        end = pos + agg_len

        for ch in range(8):
            if not (mask >> ch) & 1:
                continue
            if p + 2 > end:
                break
            couple_size = words[p] & 0x7FFFFFFF
            if couple_size < 2 or p + couple_size > end:
                break

            # Two words per event: time tag, then energy. Boards recording a
            # trace put the samples between them, which this does not decode —
            # the acquisition here does not use traces, and a wrong event size
            # would be caught by the framing checks above.
            n_events = (couple_size - 2) // 2
            base = p + 2
            events = [(words[base + 2 * i], words[base + 2 * i + 1])
                      for i in range(n_events)]

            bad = checkable and any(
                (t & RESERVED_TIME) or (e & RESERVED_ENERGY) for t, e in events)

            state = result.channel(board, ch)
            result.events += n_events
            state.events += n_events
            if profile_bucket_bytes:
                bucket_events += n_events

            if bad:
                result.bad_aggregates += 1
                result.uninitialised += n_events
                state.uninitialised += n_events
                if profile_bucket_bytes:
                    bucket_bad += n_events
            else:
                for time_word, energy_word in events:
                    extras = (energy_word >> EXTRAS_SHIFT) & 0xFF
                    if any((extras & m) == m for m in ROLL_OVER_MARKERS):
                        state.markers += 1
                        state.epoch = state.markers
                    full = (time_word & (TS_PERIOD - 1)) + state.epoch * TS_PERIOD
                    if full > state.max_ts:
                        state.max_ts = full

            p += couple_size

        pos += agg_len

    if profile_bucket_bytes and bucket_index >= 0:
        result.profile.append(
            (bucket_index * profile_bucket_bytes, bucket_events, bucket_bad))

    return result


def merge(into, other):
    """Fold a continuation file's result into the first file's."""
    into.aggregates += other.aggregates
    into.events += other.events
    into.uninitialised += other.uninitialised
    into.bad_aggregates += other.bad_aggregates
    into.resync_words += other.resync_words
    into.truncated_words += other.truncated_words
    into.counter_gaps += other.counter_gaps
    into.board_fail += other.board_fail
    into.checked_families |= other.checked_families
    into.unchecked_families |= other.unchecked_families
    for key, c in other.channels.items():
        target = into.channel(*key)
        target.events += c.events
        target.uninitialised += c.uninitialised
        target.markers += c.markers
        target.max_ts = max(target.max_ts, c.max_ts)
    return into


def caendat_files(path):
    if os.path.isfile(path):
        return [path]
    if not os.path.isdir(path):
        raise ValueError(f"'{path}' is neither a file nor a directory")
    # Name order is time order for a run split across files.
    files = sorted(os.path.join(path, f) for f in os.listdir(path)
                   if f.endswith(".caendat"))
    if not files:
        raise ValueError(f"'{path}' contains no .caendat files")
    return files


def duration_seconds(result, board, channel_state):
    info = result.boards.get(board) or {}
    ns = info.get("ns_per_tick")
    if not ns:
        return None
    return channel_state.max_ts * ns * 1e-9


def hms(seconds):
    h = int(seconds // 3600)
    m = int((seconds - h * 3600) // 60)
    return f"{h}h {m:02d}m {seconds - h * 3600 - m * 60:06.3f}s"


def report(result, args):
    problems = []
    out = []

    share = 100.0 * result.uninitialised / result.events if result.events else 0.0

    out.append(f"  aggregates        {result.aggregates}")
    out.append(f"  events            {result.events}")

    if result.checked_families:
        out.append(f"  uninitialised     {result.uninitialised} ({share:.2f}%)"
                   f" in {result.bad_aggregates} channel aggregate(s)")
        if result.uninitialised:
            problems.append(
                f"{share:.2f}% of the events were never written by the board "
                f"— the readout is corrupting data again")
    if result.unchecked_families:
        out.append(f"  uninitialised     not applicable to "
                   f"{', '.join(sorted(result.unchecked_families))}"
                   " — reserved bits unverified for that family")

    if result.resync_words:
        out.append(f"  resynchronised    {result.resync_words} word(s) skipped")
        problems.append(f"{result.resync_words} word(s) of framing had to be skipped")
    if result.counter_gaps:
        out.append(f"  counter gaps      {len(result.counter_gaps)}"
                   f" (first: board {result.counter_gaps[0][0]},"
                   f" {result.counter_gaps[0][1]} -> {result.counter_gaps[0][2]})")
        problems.append(f"{len(result.counter_gaps)} break(s) in the aggregate counter"
                        " — whole aggregates went missing")
    if result.board_fail:
        out.append(f"  board FAIL        {result.board_fail} aggregate(s)")
        problems.append(f"{result.board_fail} aggregate(s) carried the board-FAIL bit")
    if result.truncated_words:
        out.append(f"  trailing tail     {result.truncated_words} word(s)"
                   " (normal on a run still being written)")

    # Per channel, and the agreement between them.
    out.append("")
    out.append("  board ch     events  uninit   wraps  reconstructed")
    durations, wrap_counts = [], []
    for (board, ch), state in sorted(result.channels.items()):
        seconds = duration_seconds(result, board, state)
        shown = hms(seconds) if seconds is not None else "unknown tick"
        flag = ""
        if state.uninitialised:
            flag = f" {100.0 * state.uninitialised / state.events:5.1f}% bad"
        out.append(f"  {board:5d} {ch:2d} {state.events:10d} "
                   f"{state.uninitialised:7d} {state.markers:7d}  {shown}{flag}")
        if seconds is not None and state.events:
            durations.append(((board, ch), seconds))
            wrap_counts.append(((board, ch), state.markers))

    if len(durations) > 1:
        lo = min(durations, key=lambda x: x[1])
        hi = max(durations, key=lambda x: x[1])
        spread = hi[1] - lo[1]

        # The tolerance is in counter periods, so it means the same thing on a
        # four-minute run as on a six-hour one. See DURATION_TOLERANCE_PERIODS.
        ns = (result.boards.get(hi[0][0]) or {}).get("ns_per_tick") or 10
        period = TS_PERIOD * ns * 1e-9
        allowed = DURATION_TOLERANCE_PERIODS * period

        out.append("")
        out.append(f"  channel spread    {spread:.3f}s of {allowed:.1f}s allowed"
                   f"  ({spread / period:.1f} counter periods;"
                   f" shortest b{lo[0][0]}ch{lo[0][1]}, longest b{hi[0][0]}ch{hi[0][1]})")
        if spread > allowed:
            problems.append(
                f"channels disagree by {hms(spread)} on how long the run is "
                f"(b{lo[0][0]}ch{lo[0][1]} says {hms(lo[1])}, "
                f"b{hi[0][0]}ch{hi[0][1]} says {hms(hi[1])}) — they share a clock, "
                "so they cannot")

        counts = {c for _, c in wrap_counts}
        if len(counts) > 1:
            out.append(f"  wrap counts       {min(counts)}..{max(counts)}"
                       f" of {WRAP_COUNT_TOLERANCE} spread allowed")
            if max(counts) - min(counts) > WRAP_COUNT_TOLERANCE:
                problems.append(
                    f"roll-over counts differ across channels ({min(counts)}..{max(counts)})"
                    " — they count one shared clock, so they cannot")

    if args.profile and result.profile:
        out.append("")
        out.append("  onset profile (uninitialised share through the file)")
        for offset, events, bad in result.profile:
            pct = 100.0 * bad / events if events else 0.0
            bar = "#" * int(pct / 2.5)
            out.append(f"    {offset // (1 << 20):5d} MB {pct:6.2f}%  {bar}")

    return out, problems


def main():
    parser = argparse.ArgumentParser(
        description="Check a .caendat run for readout corruption.",
        epilog="Exit 0 = sound, 1 = problems found, 2 = unreadable.")
    parser.add_argument("path", help="run directory or a single .caendat file")
    parser.add_argument("--profile", action="store_true",
                        help="show how the corruption develops through the file")
    parser.add_argument("--bucket-mb", type=int, default=8,
                        help="profile bucket size in MB (default 8)")
    parser.add_argument("-q", "--quiet", action="store_true",
                        help="print only the verdict, for cron")
    args = parser.parse_args()

    try:
        files = caendat_files(args.path)
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2

    bucket = args.bucket_mb * (1 << 20) if args.profile else 0

    combined = None
    for path in files:
        try:
            one = scan(path, bucket)
        except (OSError, ValueError, struct.error) as e:
            print(f"ERROR: cannot read '{path}': {e}", file=sys.stderr)
            return 2
        if combined is None:
            combined = one
            combined.profile = one.profile
        else:
            # Continuation files carry no header; keep the first file's boards.
            one.boards = combined.boards
            merge(combined, one)

    lines, problems = report(combined, args)

    label = os.path.basename(os.path.normpath(args.path))
    if not args.quiet:
        print(f"\n{label}: {len(files)} file(s), "
              f"{sum(os.path.getsize(f) for f in files) / (1 << 20):.1f} MB")
        print("\n".join(lines))
        print()

    if problems:
        print(f"FAIL  {label}")
        for p in problems:
            print(f"  - {p}")
        return 1

    print(f"OK    {label}: {combined.events} events, no corruption found")
    return 0


if __name__ == "__main__":
    sys.exit(main())
