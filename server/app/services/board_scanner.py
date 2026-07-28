"""
BoardScanner — discover CAEN digitizers on the connected links.

Adding a board otherwise means typing link type, link number, VME address and
firmware from memory; a wrong field only ever reports "failed to connect". This
scanner probes the links the way CoMPASS does and reports what is actually
plugged in, so the operator picks a board from a list instead of guessing.

A probe is one CAEN_DGTZ_OpenDigitizer + GetInfo + CloseDigitizer, driven
through the ``Digitizer`` wrapper in ``app.utils.dgtz``. It deliberately does
*not* go through DigitizerContainer._create_digitizer(), which retries three
times with one-second sleeps — right for opening a board you know is there,
ruinous for a sweep where most probes are expected to miss.

The scan runs in a background thread: a full optical sweep is 32 probes and a
VME range can be several hundred, which is far too long for one HTTP request.
Callers start a scan, then poll for progress and results.
"""

import os
import glob
import time
import logging
import threading
from typing import Any, Dict, List, Optional

from ..utils.dgtz import Digitizer

logger = logging.getLogger(__name__)

# Link type codes as CAENDigitizer expects them, matching the map already used
# in DigitizerContainer._create_digitizer().
LINK_TYPES = {"USB": 0, "Optical": 1, "A4818": 5}

# CAEN VME digitizers take their A32 base address from two rotary switches that
# set bits 31..16, so every valid base address is a multiple of 0x10000.
VME_ADDRESS_GRANULARITY = 0x10000

# A blind sweep of the whole A32 space would be 65536 probes. Bounded ranges
# around the addresses actually in use are the only sensible way to scan VME,
# so anything beyond this is refused rather than left to run for an hour.
MAX_VME_PROBES = 1024

# AMC firmware release codes (the integer before the first '.' in
# AMC_FirmwareRel) identify the DPP firmware loaded on the board. Used to
# pre-select the DPP option in the add form — the operator can still override.
DPP_BY_FIRMWARE_CODE = {
    128: "DPP-PHA",   # x724
    130: "DPP-PSD",   # x720 (DPP-CI shares the family; PSD is the useful default)
    131: "DPP-PSD",   # x720
    132: "DPP-PSD",   # x751
    136: "DPP-PSD",   # x730 / x725
    139: "DPP-PHA",   # x730 / x725
}


def dpp_from_firmware(amc_firmware: str) -> Optional[str]:
    """Map an AMC firmware release string to the DPP firmware it implements."""
    try:
        code = int(str(amc_firmware).split('.')[0])
    except (TypeError, ValueError):
        return None
    return DPP_BY_FIRMWARE_CODE.get(code)


def detect_a4818_pids() -> List[str]:
    """
    Best-effort discovery of A4818 PIDs from the USB bus.

    The PID is printed on the adapter and is not discoverable through
    CAENDigitizer, but Linux exposes it as the USB serial number. Anything this
    misses can still be entered by hand in the scan options.
    """
    pids: List[str] = []
    for device in sorted(glob.glob('/sys/bus/usb/devices/*/serial')):
        directory = os.path.dirname(device)
        description = ''
        for field in ('manufacturer', 'product'):
            try:
                with open(os.path.join(directory, field)) as f:
                    description += f.read().strip().lower() + ' '
            except OSError:
                continue
        if 'caen' not in description and 'a4818' not in description:
            continue
        try:
            with open(device) as f:
                serial = f.read().strip()
        except OSError:
            continue
        if serial and serial not in pids:
            pids.append(serial)
    return pids


def parse_vme_range(vme_options: Dict[str, Any]) -> List[int]:
    """
    Turn the VME range options into the list of base addresses to probe.

    Raises:
        ValueError: the range is malformed or too large to be reasonable.
    """
    def parse(field: str, default: str) -> int:
        raw = str(vme_options.get(field, default) or default).strip()
        raw = raw[2:] if raw.lower().startswith('0x') else raw
        try:
            return int(raw, 16)
        except ValueError:
            raise ValueError(f"VME {field} must be a hexadecimal address (got '{raw}').")

    start = parse('start', '0')
    end = parse('end', '0')
    step = parse('step', f'{VME_ADDRESS_GRANULARITY:X}')

    if step <= 0:
        raise ValueError("VME step must be greater than zero.")
    if end < start:
        raise ValueError("VME end address must not be below the start address.")
    if step % VME_ADDRESS_GRANULARITY:
        raise ValueError(
            f"VME step must be a multiple of 0x{VME_ADDRESS_GRANULARITY:X} — a board's "
            "rotary switches set bits 31..16 of the base address, so no board can sit "
            "between two such addresses.")

    count = (end - start) // step + 1
    if count > MAX_VME_PROBES:
        raise ValueError(
            f"That range is {count} addresses; the limit is {MAX_VME_PROBES}. "
            "Narrow the range (VME base addresses are usually clustered, e.g. "
            "0x32000000-0x32FF0000).")

    return [start + i * step for i in range(count)]


class BoardScanner:
    """Probe the links for digitizers, in a background thread, once at a time."""

    def __init__(self, test_flag: bool = False):
        self.logger = logging.getLogger(__name__ + '.BoardScanner')
        self.test_flag = bool(test_flag)

        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._cancel = threading.Event()

        self._status = 'idle'
        self._message = ''
        self._found: List[Dict[str, Any]] = []
        self._errors: List[str] = []
        self._done = 0
        self._total = 0
        self._started_at = 0.0
        self._finished_at = 0.0

    # ── state ────────────────────────────────────────────────────────────────

    def is_running(self) -> bool:
        with self._lock:
            return self._status == 'running'

    def get_status(self) -> Dict[str, Any]:
        """Current scan state, safe to poll while a scan is in flight."""
        with self._lock:
            elapsed = ((self._finished_at or time.time()) - self._started_at) if self._started_at else 0.0
            eta = None
            if self._status == 'running' and self._done and self._total:
                eta = max(0.0, (elapsed / self._done) * (self._total - self._done))
            return {
                'status': self._status,
                'message': self._message,
                'progress': {'done': self._done, 'total': self._total},
                'elapsed': round(elapsed, 1),
                'eta': round(eta, 1) if eta is not None else None,
                'found': [dict(record) for record in self._found],
                'errors': list(self._errors),
            }

    def cancel(self) -> bool:
        """Ask a running scan to stop after the probe in flight."""
        if not self.is_running():
            return False
        self._cancel.set()
        return True

    # ── scanning ─────────────────────────────────────────────────────────────

    def start(self, options: Dict[str, Any], configured_boards: List[Dict[str, Any]]) -> Dict[str, Any]:
        """
        Start a scan in the background.

        Args:
            options: which link types to scan, and the VME range if enabled
            configured_boards: boards already added, so their links are reported
                rather than probed — their handles are held open elsewhere

        Returns:
            The initial status dictionary.

        Raises:
            ValueError: the options are invalid (bad VME range, nothing to scan)
            RuntimeError: a scan is already running
        """
        with self._lock:
            if self._status == 'running':
                raise RuntimeError("A scan is already running.")

        warnings: List[str] = []
        targets = self._build_targets(options or {}, warnings)
        if not targets:
            raise ValueError("Nothing to scan — enable at least one link type."
                             + (f" {warnings[0]}" if warnings else ""))

        with self._lock:
            self._status = 'running'
            self._message = ''
            self._found = []
            self._errors = warnings
            self._done = 0
            self._total = len(targets)
            self._started_at = time.time()
            self._finished_at = 0.0
        self._cancel.clear()

        known = self._index_configured(configured_boards)
        self._thread = threading.Thread(
            target=self._run, args=(targets, known), name='board-scan', daemon=True)
        self._thread.start()
        return self.get_status()

    def _build_targets(self, options: Dict[str, Any], warnings: List[str]) -> List[Dict[str, Any]]:
        """Expand the scan options into the flat list of probes to perform."""
        targets: List[Dict[str, Any]] = []

        def add(link_type: str, link_num: Any, nodes: int, vme: int = 0) -> None:
            for node in range(int(nodes)):
                targets.append({'link_type': link_type, 'link_num': str(link_num),
                                'node': node, 'vme': vme})

        usb = options.get('usb') or {}
        if usb.get('enabled'):
            # USB digitizers answer on node 0 of each link; there is no chain.
            for link in range(int(usb.get('links', 8))):
                add('USB', link, 1)

        optical = options.get('optical') or {}
        if optical.get('enabled'):
            for link in range(int(optical.get('links', 4))):
                add('Optical', link, int(optical.get('nodes', 8)))

        a4818 = options.get('a4818') or {}
        if a4818.get('enabled'):
            pids = [str(p).strip() for p in (a4818.get('pids') or []) if str(p).strip()]
            if not pids:
                pids = detect_a4818_pids()
                if not pids:
                    warnings.append(
                        "No A4818 adapter found on the USB bus — enter its PID by hand to scan it.")
            for pid in pids:
                add('A4818', pid, int(a4818.get('nodes', 8)))

        vme = options.get('vme') or {}
        if vme.get('enabled'):
            link_type = vme.get('link_type', 'Optical')
            if link_type not in LINK_TYPES:
                raise ValueError(f"Unknown link type '{link_type}' for the VME scan.")
            link_num = vme.get('link_num', 0)
            for address in parse_vme_range(vme):
                # Boards in a crate are reached through the bridge on node 0.
                targets.append({'link_type': link_type, 'link_num': str(link_num),
                                'node': 0, 'vme': address})

        return targets

    @staticmethod
    def _index_configured(boards: List[Dict[str, Any]]) -> Dict[tuple, Dict[str, Any]]:
        """Index configured boards by the link coordinates a probe would use."""
        known = {}
        for board in boards or []:
            try:
                vme = int(str(board.get('vme', '0')), 16)
            except ValueError:
                vme = 0
            key = (board.get('link_type'), str(board.get('link_num')), int(board.get('id', 0)), vme)
            known[key] = board
        return known

    def _run(self, targets: List[Dict[str, Any]], known: Dict[tuple, Dict[str, Any]]) -> None:
        """Body of the scan thread."""
        # Each probe logs several INFO lines from Digitizer.open(); across a few
        # hundred misses that buries everything else in the log.
        dgtz_logger = logging.getLogger('app.utils.dgtz')
        previous_level = dgtz_logger.level
        dgtz_logger.setLevel(logging.WARNING)

        try:
            for target in targets:
                if self._cancel.is_set():
                    self._finish('cancelled', 'Scan cancelled.')
                    return

                key = (target['link_type'], target['link_num'], target['node'], target['vme'])
                board = known.get(key)
                if board is not None:
                    # Its handle is already open in DigitizerContainer — probing
                    # it would fail and tell us nothing we do not already know.
                    self._record(self._configured_record(target, board))
                    self._advance()
                    continue

                try:
                    record = self._probe(target)
                except Exception as e:                       # a probe must never kill the scan
                    self.logger.debug(f"Probe failed at {key}: {e}")
                    record = None
                if record is not None:
                    self._record(record)
                self._advance()

            found = len(self._found)
            self._finish('done', f"Scan complete — {found} board{'s' if found != 1 else ''} found.")

        except Exception as e:
            self.logger.exception("Board scan failed")
            with self._lock:
                self._errors.append(str(e))
            self._finish('error', f"Scan failed: {e}")
        finally:
            dgtz_logger.setLevel(previous_level)

    def _probe(self, target: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Open one candidate board, read its info, close it again."""
        if self.test_flag:
            return self._mock_probe(target)

        link_type = LINK_TYPES[target['link_type']]
        try:
            link_num = int(target['link_num'])
        except ValueError:
            # A4818 link numbers are PIDs, which are numeric; anything else is
            # a typo and cannot be probed.
            raise ValueError(f"Link number '{target['link_num']}' is not a number.")

        dgtz = Digitizer(link_type, link_num, target['node'], target['vme'])
        try:
            dgtz.open()
            if not dgtz.get_connected():
                return None
            info = dgtz.get_info()
        finally:
            try:
                dgtz.close()
            except Exception as e:
                self.logger.debug(f"Error closing probed board: {e}")

        return self._record_from_info(target, info)

    def _record_from_info(self, target: Dict[str, Any], info: Dict[str, Any]) -> Dict[str, Any]:
        """Build the result record the frontend shows and pre-fills the form from."""
        amc = str(info.get('AMC_FirmwareRel', ''))
        return {
            'model': str(info.get('ModelName', 'Unknown')),
            'serial': str(info.get('SerialNumber', '')),
            'channels': int(info.get('Channels', 0) or 0),
            'adc_bits': int(info.get('ADC_NBits', 0) or 0),
            'roc_firmware': str(info.get('ROC_FirmwareRel', '')),
            'amc_firmware': amc,
            'dpp': dpp_from_firmware(amc),
            'link_type': target['link_type'],
            'link_num': str(target['link_num']),
            'id': target['node'],
            # daq_manager parses this with int(vme, 16), so keep it bare hex.
            'vme': f"{target['vme']:X}",
            'already_configured': False,
        }

    @staticmethod
    def _configured_record(target: Dict[str, Any], board: Dict[str, Any]) -> Dict[str, Any]:
        """A result entry for a board that is already added."""
        return {
            'model': str(board.get('name', 'Configured board')),
            'serial': '',
            'channels': int(board.get('chan', 0) or 0),
            'adc_bits': 0,
            'roc_firmware': '',
            'amc_firmware': '',
            'dpp': board.get('dpp'),
            'link_type': target['link_type'],
            'link_num': str(target['link_num']),
            'id': target['node'],
            'vme': f"{target['vme']:X}",
            'already_configured': True,
        }

    def _mock_probe(self, target: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Test mode: pretend two boards are plugged in, so the UI is exercisable."""
        time.sleep(0.02)
        mocks = {
            ('USB', '0', 0, 0): {
                'ModelName': 'DT5724', 'SerialNumber': 12345, 'Channels': 4,
                'ADC_NBits': 14, 'ROC_FirmwareRel': '4.19', 'AMC_FirmwareRel': '128.53',
            },
            ('Optical', '0', 0, 0): {
                'ModelName': 'V1730', 'SerialNumber': 6789, 'Channels': 16,
                'ADC_NBits': 14, 'ROC_FirmwareRel': '4.25', 'AMC_FirmwareRel': '136.20',
            },
        }
        info = mocks.get((target['link_type'], target['link_num'], target['node'], target['vme']))
        return self._record_from_info(target, info) if info else None

    # ── progress bookkeeping ─────────────────────────────────────────────────

    def _advance(self) -> None:
        with self._lock:
            self._done += 1

    def _record(self, record: Dict[str, Any]) -> None:
        with self._lock:
            self._found.append(record)

    def _finish(self, status: str, message: str) -> None:
        with self._lock:
            self._status = status
            self._message = message
            self._finished_at = time.time()


_scanner: Optional[BoardScanner] = None


def get_board_scanner(test_flag: bool = False) -> BoardScanner:
    """Get or create the process-wide scanner (only one scan may run at a time)."""
    global _scanner
    if _scanner is None:
        _scanner = BoardScanner(test_flag=test_flag)
    return _scanner
