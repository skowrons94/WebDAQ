"""
Energy calibration of the spy histograms' x axis (spy_manager.calibrate_x_axis).

The calibration maps the axis limits, so it is right for any binning: the 1-D
spectra run from 0 to nbins, the PSD TH2 from 0 to QLONG_MAX in PSD_XBINS bins.
Mapping the bin count instead put the PSD axis at 1/32 of its range.
"""

import unittest

from app.services.spy_manager import calibrate_x_axis


class _Axis:
    def __init__(self, nbins, xmin, xmax):
        self.n, self.lo, self.hi = nbins, xmin, xmax

    def GetXmin(self):
        return self.lo

    def GetXmax(self):
        return self.hi

    def GetNbins(self):
        return self.n

    def SetLimits(self, lo, hi):
        self.lo, self.hi = lo, hi


class _Histo:
    """The few TH1/TH2 calls the calibration uses."""

    def __init__(self, nbins, xmin, xmax):
        self.ax = _Axis(nbins, xmin, xmax)

    def GetXaxis(self):
        return self.ax

    def GetNbinsX(self):
        return self.ax.n


class CalibrateXAxisTests(unittest.TestCase):
    def test_1d_spectrum_axis_runs_from_offset_to_offset_plus_slope_times_nbins(self):
        h = _Histo(32768, 0.0, 32768.0)
        calibrate_x_axis(h, 1.5, 0.09)
        # Bin k (value k) is centred at E(k): the limits sit half a channel lower.
        self.assertAlmostEqual(h.ax.GetXmin(), 1.5 - 0.045)
        self.assertAlmostEqual(h.ax.GetXmax(), 1.5 + 0.09 * 32767.5)
        self.assertAlmostEqual((h.ax.GetXmin() + 0.09 / 2), 1.5 + 0.09 * 0)
        self.assertEqual(h.ax.GetNbins(), 32768)

    def test_psd_axis_maps_its_full_qlong_range_not_its_bin_count(self):
        qlong_max, psd_xbins = 65536.0, 2048
        h = _Histo(psd_xbins, 0.0, qlong_max)
        calibrate_x_axis(h, 0.0, 0.1)
        self.assertAlmostEqual(h.ax.GetXmax(), 0.1 * (qlong_max - 0.5))
        self.assertNotAlmostEqual(h.ax.GetXmax(), 0.1 * psd_xbins)

    def test_identity_calibration_only_centres_the_bins(self):
        h = _Histo(2048, 0.0, 65536.0)
        calibrate_x_axis(h, 0.0, 1.0)
        self.assertEqual((h.ax.GetXmin(), h.ax.GetXmax()), (-0.5, 65535.5))

    def test_nonzero_axis_start_is_mapped_too(self):
        h = _Histo(100, 10.0, 110.0)
        calibrate_x_axis(h, 2.0, 0.5)
        self.assertAlmostEqual(h.ax.GetXmin(), 6.75)
        self.assertAlmostEqual(h.ax.GetXmax(), 56.75)


if __name__ == '__main__':
    unittest.main()
