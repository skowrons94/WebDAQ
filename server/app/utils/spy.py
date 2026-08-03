"""
Spy interface — online monitoring histograms.

Backed directly by the in-process ``caendaq.DAQ`` instance owned by
:mod:`app.services.caen_acquisition`. caendaq accumulates per-channel spectra and
waveforms continuously in C++; this module just builds a ROOT ``TH1F`` from the
current snapshot **on demand**, addressed by ``(board, channel)`` — no sockets,
no background collection thread, and no fragile global channel numbering.
"""

import os
import logging
from typing import Dict, Optional, Any

logger = logging.getLogger(__name__)

TEST_FLAG = os.getenv('TEST_FLAG', False)

try:
    import numpy as np
except ImportError:
    np = None
    logger.error("numpy is required for the spy interface")

try:
    import ROOT
    ROOT_AVAILABLE = True
    ROOT.gErrorIgnoreLevel = ROOT.kError
except ImportError as e:
    ROOT_AVAILABLE = False
    logger.warning(f"ROOT framework not available: {e}")

# Default bin counts (match the caendaq HistogramStore array sizes).
_BINS = {"energy": 32768, "qshort": 32768, "qlong": 65536}


class ReadoutUnitSpy:
    """Builds ROOT histograms on demand from the shared caendaq.DAQ."""

    def __init__(self, host: str = 'localhost', port: int = 6060):
        self.logger = logging.getLogger(__name__ + '.ReadoutUnitSpy')
        self.host = host
        self.port = port
        self.running = False

    def _empty(self, reason: str):
        """
        A histogram with nothing in it, whose title says why.

        There is always something to draw — the page would otherwise keep the
        previous plot or go blank — but an empty plot labelled "Default
        Histogram" tells the operator nothing. The title carries the reason
        instead, because that is what is drawn on the canvas.

        Deliberately small: a placeholder does not need 32768 empty bins, and
        this is polled every couple of seconds per channel.
        """
        if not ROOT_AVAILABLE:
            return None
        hist = ROOT.TH1F("no_data", reason, 100, 0, 100)
        hist.SetEntries(0)
        hist.SetStats(0)
        return hist

    # start()/stop() only track state now — acquisition itself lives in
    # caen_acquisition; there is nothing to spawn here.
    def start(self, daq_state: Optional[Dict[str, Any]] = None) -> None:
        self.running = True
        self.logger.info("Spy enabled (on-demand, caendaq backend)")

    def stop(self) -> None:
        self.running = False
        self.logger.info("Spy disabled")

    def _build(self, name: str, arr, nbins: Optional[int] = None,
               empty_reason: str = "No data"):
        """Build a fresh TH1F from a numpy array, or an explained empty one."""
        if not ROOT_AVAILABLE or np is None:
            return None
        if arr is None or len(arr) == 0:
            return self._empty(empty_reason)
        n = nbins if nbins is not None else len(arr)
        hist = ROOT.TH1F(name, name, n, 0, n)
        buf = np.zeros(n + 2, dtype=np.float64)   # underflow + n bins + overflow
        m = min(len(arr), n)
        buf[1:1 + m] = arr[:m]
        hist.SetContent(np.ascontiguousarray(buf))
        hist.SetEntries(float(arr.sum()))
        # No statistics box: it covers the part of the spectrum people look at,
        # and the numbers in it (mean/RMS over raw bin indices) mean nothing for
        # an uncalibrated ADC axis. Set here so every consumer gets it.
        hist.SetStats(0)
        return hist

    def _build_psd(self, name: str, arr2d, caendaq_mod):
        """Build a TH2F (x = qlong, y = PSD ratio) from a caendaq 2D PSD array."""
        nx = int(caendaq_mod.PSD_XBINS)
        ny = int(caendaq_mod.PSD_YBINS)
        xmax = float(caendaq_mod.QLONG_MAX)
        hist = ROOT.TH2F(name, name, nx, 0, xmax, ny, 0, 1)
        if arr2d is not None and getattr(arr2d, "size", 0):
            # ROOT global bin order is ix-fastest: content[(ny+2) rows × (nx+2) cols].
            content = np.zeros((ny + 2, nx + 2), dtype=np.float64)
            content[1:ny + 1, 1:nx + 1] = arr2d.T
            hist.SetContent(np.ascontiguousarray(content).ravel())
            hist.SetEntries(float(arr2d.sum()))
        hist.SetStats(0)
        return hist

    def histogram(self, board_index: Optional[int], channel: int, htype: str):
        """Return a histogram for (board_index, channel) of the given type.

        htype: 'energy' | 'qshort' | 'qlong' | 'wave1' | 'wave2' (TH1F),
               or 'psd' (TH2F).
        """
        if not ROOT_AVAILABLE:
            return None

        from ..services.caen_acquisition import get_caen_acquisition
        acq = get_caen_acquisition()
        daq = acq.get_daq()
        # Ask "is there a run at all?" before "is this board in it?": with no run
        # configured, no board has an index, and reporting every board as absent
        # from a run that does not exist points the operator at the wrong thing.
        if daq is None:
            # caendaq builds its spectra during a run and keeps them afterwards,
            # so there is genuinely nothing to show until the first run starts.
            return self._empty("No data yet — start a run")
        # Board indices are handed out by caendaq when a run is configured, so a
        # board with no index is one this run does not include.
        if board_index is None:
            return self._empty("This board is not part of the current run")

        try:
            name = f"{htype}_b{board_index}_ch{channel}"
            if htype == "psd":
                return self._build_psd(name, daq.psd(board_index, channel), acq._caendaq)
            if htype in ("wave1", "wave2"):
                # Only one trace is exposed today; wave2 has no source yet.
                if htype == "wave2":
                    return self._empty("Trace 2 is not available")
                arr = daq.waveform(board_index, channel)
                return self._build(
                    name, arr,
                    nbins=(len(arr) if arr is not None and len(arr) else 1),
                    # The usual cause by far: waveform recording is a per-board
                    # switch, and it is off unless somebody turned it on.
                    empty_reason="No waveform — switch waveforms on for this board")
            getter = getattr(daq, htype, None)   # daq.energy / qshort / qlong
            arr = getter(board_index, channel) if getter else None
            return self._build(name, arr, nbins=_BINS.get(htype),
                               empty_reason=f"No counts yet on channel {channel}")
        except Exception as e:
            self.logger.warning(f"histogram({board_index},{channel},{htype}) failed: {e}")
            return self._empty("Could not read this histogram — see the server log")

    def get_connection_status(self) -> Dict[str, Any]:
        from ..services.caen_acquisition import get_caen_acquisition
        acq = get_caen_acquisition()
        return {
            'running': self.running or acq.is_running(),
            'backend': 'caendaq',
            'caendaq_available': acq.is_available(),
            'test_mode': TEST_FLAG,
            'root_available': ROOT_AVAILABLE,
        }


class BuilderUnitSpy:
    """Placeholder for BuilderUnit (coincidence) monitoring — not produced by the
    single-process caendaq DAQ yet. Returns empty histograms for compatibility."""

    def __init__(self, host: str = 'localhost', port: int = 7070):
        self.host = host
        self.port = port
        self.running = False

    def histogram(self, board_index, channel, htype):
        if not ROOT_AVAILABLE:
            return None
        hist = ROOT.TH1F("no_data", "Coincidence histograms are not produced yet", 100, 0, 100)
        hist.SetEntries(0)
        hist.SetStats(0)
        return hist


# Backward-compatible aliases
ru_spy = ReadoutUnitSpy
bu_spy = BuilderUnitSpy
