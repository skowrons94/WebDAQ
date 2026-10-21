"""
Calibrating a channel from the Histograms page.

A peak is fitted in the raw spectrum, the line goes through the peaks given
their energies, and saving it rewrites only that channel, keeps the points,
logs the change in the run being recorded, and moves the channel's ROIs and
zoom so they stay on the same peaks.
"""

import json
import os
import tempfile
import unittest
from unittest import mock

import numpy as np

from app.services import calibration as C


def spectrum(peaks, background=20.0, bins=4096, seed=1):
    rng = np.random.default_rng(seed)
    x = np.arange(bins) + 0.5
    y = np.full(bins, background) - 0.002 * x
    for mu, sigma, area in peaks:
        y += area / (sigma * np.sqrt(2 * np.pi)) * np.exp(-0.5 * ((x - mu) / sigma) ** 2)
    return rng.poisson(np.clip(y, 0, None)).astype(np.uint32)


class FitTests(unittest.TestCase):
    def test_peak_on_a_sloped_background(self):
        h = spectrum([(1200.3, 4.0, 20000)])
        r = C.fit_peak(h, 1160, 1240)
        self.assertAlmostEqual(r["centroid"], 1200.3, delta=0.1)
        self.assertAlmostEqual(r["fwhm"], 2.3548 * 4.0, delta=0.4)
        self.assertAlmostEqual(r["area"], 20000, delta=600)
        self.assertLess(r["centroid_error"], 0.1)

    def test_nothing_to_fit_says_why(self):
        with self.assertRaisesRegex(ValueError, "Zoom on a peak"):
            C.fit_peak(spectrum([]), 100, 102)
        with self.assertRaisesRegex(ValueError, "Too few counts"):
            C.fit_peak(np.zeros(4096, np.uint32), 100, 200)


class SolveTests(unittest.TestCase):
    def test_line_through_two_peaks(self):
        r = C.solve([{"channel": 1000, "energy": 1173.23}, {"channel": 1135.6, "energy": 1332.49}])
        self.assertAlmostEqual(r["offset"] + r["slope"] * 1000, 1173.23, places=6)
        self.assertAlmostEqual(r["offset"] + r["slope"] * 1135.6, 1332.49, places=6)
        self.assertEqual(r["method"], "line")

    def test_one_peak_goes_through_zero(self):
        r = C.solve([{"channel": 1460.82 / 0.5, "energy": 1460.82}])
        self.assertEqual(r["offset"], 0.0)
        self.assertAlmostEqual(r["slope"], 0.5)

    def test_residuals_of_three(self):
        r = C.solve([{"channel": 100, "energy": 100}, {"channel": 200, "energy": 201},
                     {"channel": 300, "energy": 300}])
        self.assertEqual(len(r["residuals"]), 3)
        self.assertAlmostEqual(sum(r["residuals"]), 0.0, places=6)

    def test_refused(self):
        with self.assertRaises(ValueError):
            C.solve([])
        with self.assertRaises(ValueError):
            C.solve([{"channel": 5, "energy": 10}, {"channel": 5, "energy": 20}])


class SaveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cwd = os.getcwd()
        os.chdir(self.tmp.name)
        os.makedirs("calib")
        with open("calib/V1725S_0.cal", "w") as f:
            f.write("0.0 1.0\n" * 3)             # three channels, one line each
        self.board = {"name": "V1725S", "id": "0", "chan": 16}

    def tearDown(self):
        os.chdir(self.cwd)
        self.tmp.cleanup()

    def test_only_that_channel_changes_and_the_file_grows(self):
        rescale = mock.Mock()
        with mock.patch("app.services.histogram_config.get_histogram_config") as cfg:
            cfg.return_value.rescale_axis = rescale
            C.save(self.board, 5, 1.5, 0.25, points=[{"channel": 100, "energy": 26.5}])
        table = C.read_table("V1725S", "0", 16)
        self.assertEqual(table[5], (1.5, 0.25))
        self.assertEqual(table[0], (0.0, 1.0))
        self.assertEqual(table[15], (0.0, 1.0))
        self.assertEqual(C.read_points("V1725S", "0")["5"]["points"][0]["energy"], 26.5)
        board_id, channel, convert = rescale.call_args.args
        # An ROI drawn at raw channel 100 on the old axis is at 26.5 keV now.
        self.assertEqual((board_id, channel), ("0", 5))
        self.assertAlmostEqual(convert(100.0), 26.5)

    def test_a_change_during_a_run_is_logged_there(self):
        os.makedirs("data/run7")
        with mock.patch("app.services.histogram_config.get_histogram_config"):
            C.save(self.board, 1, 0.0, 0.5, run_dir="data/run7")
            C.save(self.board, 1, 0.1, 0.5, run_dir="data/run7")
        with open("data/run7/" + C.HISTORY_FILE) as f:
            entries = [json.loads(line) for line in f]
        self.assertEqual([e["slope"] for e in entries], [0.5, 0.5])
        self.assertEqual(entries[1]["previous"], {"offset": 0.0, "slope": 0.5})

    def test_a_zero_slope_is_refused(self):
        with self.assertRaises(ValueError):
            C.save(self.board, 0, 0.0, 0.0)


class RescaleAxisTests(unittest.TestCase):
    def test_rois_and_zoom_follow_the_peak(self):
        from app.services.histogram_config import HistogramConfigStore
        with tempfile.TemporaryDirectory() as tmp:
            hc = HistogramConfigStore(os.path.join(tmp, "histograms.json"))
            h = hc.add_histogram({"boardId": "0", "channel": 2})
            hc.add_roi(h["id"], {"low": 1000, "high": 1100})
            hc.set_zoom(h["id"], {"xmin": 900, "xmax": 1200})
            other = hc.add_histogram({"boardId": "0", "channel": 3})
            hc.add_roi(other["id"], {"low": 1000, "high": 1100})
            hc.rescale_axis("0", 2, lambda v: 2.0 * v + 5)
            moved = hc.get_histogram(h["id"])
            self.assertEqual((moved["rois"][0]["low"], moved["rois"][0]["high"]), (2005, 2205))
            self.assertEqual((moved["zoom"]["xmin"], moved["zoom"]["xmax"]), (1805, 2405))
            self.assertEqual(hc.get_histogram(other["id"])["rois"][0]["low"], 1000)


if __name__ == "__main__":
    unittest.main()
