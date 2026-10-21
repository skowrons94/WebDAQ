"""
The coincidence builder finds what is there and nothing else.

Synthetic data with a known answer: channel A fires at random, 30 % of its
hits have a partner on channel B 50 ns later, and B also fires at random on
its own. Hits are delivered the way boards deliver them — in chunks, each
channel in time order but the channels out of step with one another — and
the builder must still pair them, put the Δt peak at +50 ns, move it to 0 when
asked to align, and keep the veto spectrum the exact complement.
"""

import os
import tempfile
import unittest
from unittest import mock

import numpy as np

from app.services import coincidences as C

HIT = np.dtype([("time_ps", "<i8"), ("energy", "<u2"), ("channel", "u1"),
                ("flags", "u1"), ("reserved", "<u4")])


class FakeBoard:
    """Hands out pre-made hits per channel in chunks, channels out of step."""

    def __init__(self, per_channel, chunk_s=0.2, skew_s=0.4):
        self.queue = []
        for ch, (t, e) in per_channel.items():
            h = np.zeros(t.size, HIT)
            h["time_ps"], h["energy"], h["channel"] = t, e, ch
            # Channel ch is delivered ch * skew late, in chunks of chunk_s.
            chunk = np.floor(t / (chunk_s * 1e12)).astype(np.int64) + int(ch * skew_s / chunk_s)
            for c in np.unique(chunk):
                self.queue.append((int(c), h[chunk == c]))
        self.queue.sort(key=lambda x: x[0])
        self.step = 0
        self.enabled = False

    def take(self):
        out = [h for c, h in self.queue if c == self.step]
        self.step += 1
        return np.concatenate(out) if out else np.zeros(0, HIT)

    def drain(self):
        out = [h for c, h in self.queue if c >= self.step]
        self.step = 10 ** 9
        return np.concatenate(out) if out else np.zeros(0, HIT)


def synthetic(seed=1, seconds=20.0, rate_a=2000.0, rate_b=1000.0, frac=0.3, delay_ns=50.0):
    rng = np.random.default_rng(seed)
    ta = np.sort(rng.uniform(0, seconds, int(rate_a * seconds))) * 1e12
    partner = rng.random(ta.size) < frac
    tb_true = ta[partner] + delay_ns * 1e3 + rng.normal(0, 2e3, partner.sum())
    tb_rand = rng.uniform(0, seconds, int(rate_b * seconds)) * 1e12
    tb = np.sort(np.concatenate((tb_true, tb_rand)))
    ea = np.where(partner, 1000, 2000).astype(np.uint16)    # tagged by energy
    eb = np.full(tb.size, 500, np.uint16)
    return {0: (ta.astype(np.int64), ea), 1: (tb.astype(np.int64), eb)}, int(partner.sum())


class BuilderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "coincidences.json")

    def tearDown(self):
        self.tmp.cleanup()

    def _run(self, gates, board, offsets=None, latency_ms=2000):
        b = C.CoincidenceBuilder(self.path)
        src = C.HitSource("0", "board-0", take=board.take, dropped=lambda: 0,
                          enable=lambda on: setattr(board, "enabled", on), energy_bins=32768)
        acq = mock.Mock()
        acq.get_boards.return_value = [{"id": "0", "name": "V1725S", "dpp": "DPP-PHA"}]
        with mock.patch.object(C, "sources_for_run", return_value={"0": src}), \
             mock.patch.object(C, "clock_domains", return_value={"0": "board-0"}):
            b.set_config({"gates": gates, "offsets_ns": offsets or {}, "latency_ms": latency_ms})
            b._acq = acq
            b._setup()
            board.step = 0
            for _ in range(len(board.queue) + 10):
                b._tick(final=False)
            src.take = board.drain
            b._tick(final=True)
        return b

    def gate(self, **kw):
        g = {"id": "g", "name": "A and B", "channels": [{"board": "0", "channel": 0}],
             "partners": [{"board": "0", "channel": 1}], "window_ns": 100, "dt_range_ns": 200}
        g.update(kw)
        return g

    def test_pairs_found_despite_delivery_order(self):
        data, n_true = synthetic()
        b = self._run([self.gate()], FakeBoard(data))
        st = b.gate("g").status(0)
        spec = b.spectrum("g", "0:0")
        # Every true pair is found; accidentals add 2 * 100 ns * 1 kHz = 2e-4 of A.
        self.assertEqual(int(spec[1000]), n_true)
        self.assertLess(int(spec[2000]), 0.001 * data[0][0].size)
        self.assertEqual(st["singles"], data[0][0].size)
        self.assertEqual(b._domains["board-0"].late, 0)

    def test_dt_peak_then_align(self):
        data, _ = synthetic()
        b = self._run([self.gate()], FakeBoard(data))
        h, rng = b.dt("g", "0:0", "0:1")
        centre = -rng + (np.argmax(h) + 0.5) * 2 * rng / C.DT_BINS
        self.assertAlmostEqual(centre, 50.0, delta=1.0)
        found = int(b.spectrum("g", "0:0")[1000])
        changed = b.align("g")          # applies the offsets and starts the gates over
        self.assertAlmostEqual(changed["0:1"], -50.0, delta=1.0)
        # With the offset applied, the pairs sit at 0 and a 10 ns window finds them.
        b2 = self._run([self.gate(window_ns=10)], FakeBoard(data), offsets=changed)
        self.assertEqual(int(b2.spectrum("g", "0:0")[1000]), found)
        h2, _ = b2.dt("g", "0:0", "0:1")
        centre2 = -rng + (np.argmax(h2) + 0.5) * 2 * rng / C.DT_BINS
        self.assertAlmostEqual(centre2, 0.0, delta=1.0)

    def test_veto_is_the_complement(self):
        data, n_true = synthetic()
        coinc = self._run([self.gate()], FakeBoard(data)).spectrum("g", "0:0")
        veto = self._run([self.gate(mode="anticoincidence")], FakeBoard(data)).spectrum("g", "0:0")
        np.testing.assert_array_equal(coinc + veto, np.bincount(data[0][1], minlength=32768))

    def test_at_least_n_partners(self):
        rng = np.random.default_rng(3)
        t = np.sort(rng.uniform(0, 5, 5000)) * 1e12
        e = np.full(t.size, 10, np.uint16)
        # ch1 always fires with ch0, ch2 only for the first half.
        data = {0: (t.astype(np.int64), e), 1: (t.astype(np.int64) + 1000, e),
                2: (t[: t.size // 2].astype(np.int64) + 2000, e[: t.size // 2])}
        gate = self.gate(partners=[{"board": "0", "channel": 1}, {"board": "0", "channel": 2}],
                         min_partners=2)
        b = self._run([gate], FakeBoard(data))
        self.assertEqual(int(b.spectrum("g", "0:0")[10]), t.size // 2)

    def test_matrix(self):
        data, n_true = synthetic()
        b = self._run([self.gate(matrix=True)], FakeBoard(data))
        m, bins = b.matrix("g")
        self.assertEqual(int(m.sum()), int(b.spectrum("g", "0:0").sum()))
        self.assertEqual(int(m[1000 * C.MATRIX_BINS // bins[0], 500 * C.MATRIX_BINS // bins[1]]), n_true)

    def test_late_hits_are_counted(self):
        data, _ = synthetic(seconds=10)
        # Channel 1 is delivered 3 s behind channel 0 with only 1 s of latency.
        b = self._run([self.gate()], FakeBoard(data, skew_s=3.0), latency_ms=1000)
        self.assertGreater(b._domains["board-0"].late, 0)

    def test_align_twice_on_the_same_data(self):
        """After the run, Align is computed against the offsets the gate was
        built with: a second click must not shift the channel again."""
        data, _ = synthetic()
        b = self._run([self.gate()], FakeBoard(data))
        b._acq = None                        # the run has ended
        first = b.align("g")["0:1"]
        second = b.align("g")["0:1"]
        self.assertAlmostEqual(first, -50.0, delta=1.0)
        self.assertEqual(first, second)

    def test_dt_pairs_in_chunks_match(self):
        data, _ = synthetic(seconds=5)
        whole, _ = self._run([self.gate()], FakeBoard(data)).dt("g", "0:0", "0:1")
        with mock.patch.object(C.GateState, "_PAIR_CHUNK", 37):
            chunked, _ = self._run([self.gate()], FakeBoard(data)).dt("g", "0:0", "0:1")
        np.testing.assert_array_equal(whole, chunked)

    def test_matrix_takes_the_nearest_partner(self):
        t = (np.arange(1, 2001) * 1e9).astype(np.int64)          # 1 ms apart
        e = np.full(t.size, 100, np.uint16)
        # Two partner hits per A hit: 40 ns before (energy 300), 10 ns after (energy 600).
        tb = np.sort(np.concatenate((t - 40_000, t + 10_000)))
        eb = np.where(np.isin(tb, t + 10_000), 600, 300).astype(np.uint16)
        b = self._run([self.gate(matrix=True)], FakeBoard({0: (t, e), 1: (tb, eb)}))
        m, bins = b.matrix("g")
        self.assertEqual(int(m[100 * C.MATRIX_BINS // bins[0], 600 * C.MATRIX_BINS // bins[1]]), t.size)

    def test_align_finds_a_broad_sparse_peak(self):
        """A real channel can jitter by several ns, and a few hundred pairs
        spread that over many bins: the peak is found from all of them, not
        from whichever bin happened to come out highest."""
        rng = np.random.default_rng(7)
        h = np.zeros(C.DT_BINS, np.uint32)
        dts = 4.0 + rng.uniform(-8, 8, 300)                     # ns, flat-topped
        dts = np.concatenate((dts, rng.uniform(-200, 200, 400)))  # chance floor
        np.add.at(h, np.floor((dts + 200) / 0.4).astype(int), 1)
        self.assertAlmostEqual(C.peak_centre(h, window_ns=50, range_ns=200), 4.0, delta=1.0)

    def test_config_validation(self):
        with self.assertRaises(ValueError):
            C.normalise_config({"gates": [{"mode": "sometimes"}]})
        with self.assertRaises(ValueError):
            C.normalise_config({"gates": [{"window_ns": 0}]})
        cfg = C.normalise_config({"gates": [{"channels": [{"board": 0, "channel": "3"}]}]})
        self.assertEqual(cfg["gates"][0]["channels"], [{"board": "0", "channel": 3}])

    def test_gates_across_clocks_are_refused(self):
        boards = [{"id": "0", "name": "V1725S", "dpp": "DPP-PHA"},
                  {"id": "1", "name": "SIS3316", "vendor": "sis3316", "dpp": "SIS3316"}]
        cfg = C.normalise_config({"gates": [self.gate(partners=[{"board": "1", "channel": 14}])]})
        with mock.patch("app.services.caen_acquisition.is_synchronised", return_value=False):
            problems = C.check_gates(cfg, boards)
        self.assertTrue(any("share a clock" in p for p in problems["g"]))


if __name__ == "__main__":
    unittest.main()
