"""
The Data rates page plots the whole run from the server's history: every
sample while it is short, pairs averaged once it is long, so memory stays
bounded and the mean rate stays right.
"""

import unittest
from unittest import mock

from app.services import rate_history as R


def stats(rate, write=100.0):
    return [{"board_id": 0, "write_rate": write,
             "channels": [{"board": 0, "channel": 3, "event_rate": rate, "pileup_rate": 1.0,
                           "lost_rate": 0.0, "satu_rate": 0.0}]}]


class RateHistoryTests(unittest.TestCase):
    def setUp(self):
        self.h = R.RateHistory()
        self.acq = mock.Mock()
        self.h._acq, self.h.run_start = self.acq, 1000.0

    def feed(self, rates, start=0):
        for i, r in enumerate(rates):
            self.acq.stats.return_value = stats(r)
            with mock.patch.object(R.time, "time", return_value=1000.0 + start + i + 1):
                self.h.sample()

    def test_every_sample_while_short(self):
        self.feed([10, 20, 30])
        snap = self.h.snapshot()
        self.assertEqual([p["b"]["0"]["ch"]["3"][0] for p in snap["points"]], [10, 20, 30])
        self.assertEqual(snap["points"][0]["b"]["0"]["w"], 100.0)

    def test_thinned_but_bounded_and_mean_kept(self):
        with mock.patch.object(R, "MAX_POINTS", 100):
            self.feed(list(range(1000)))
        snap = self.h.snapshot()
        self.assertLessEqual(len(snap["points"]), 100)
        self.assertGreater(len(snap["points"]), 25)
        values = [p["b"]["0"]["ch"]["3"][0] for p in snap["points"]]
        covered = len(values) * (1000 // len(values))
        self.assertAlmostEqual(sum(values) / len(values), (covered - 1) / 2, delta=5)
        self.assertGreater(snap["generation"], 0)

    def test_incremental_until_thinned(self):
        self.feed([1, 2])
        g = self.h.snapshot()["generation"]
        self.feed([3], start=2)                        # sampled at t = 3 s
        newer = self.h.snapshot(since=2.0, generation=g)
        self.assertTrue(newer["incremental"])
        self.assertEqual([p["t"] for p in newer["points"]], [3.0])
        stale = self.h.snapshot(since=2.0, generation=g - 1)
        self.assertFalse(stale["incremental"])


if __name__ == "__main__":
    unittest.main()
