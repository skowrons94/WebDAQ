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

    def _run(self, gates, board, offsets=None, latency_ms=2000, calib=None):
        b = C.CoincidenceBuilder(self.path)
        table = calib or {}
        src = C.HitSource("0", "board-0", take=board.take, dropped=lambda: 0,
                          enable=lambda on: setattr(board, "enabled", on), energy_bins=32768)
        acq = mock.Mock()
        acq.get_boards.return_value = [{"id": "0", "name": "V1725S", "dpp": "DPP-PHA"}]
        with mock.patch.object(C, "sources_for_run", return_value={"0": src}), \
             mock.patch.object(C, "clock_domains", return_value={"0": "board-0"}), \
             mock.patch.object(C, "read_calibrations",
                               side_effect=lambda boards, keys: {k: table.get(k, (0.0, 1.0)) for k in keys}):
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

    def test_saving_keeps_what_unchanged_gates_collected(self):
        data, _ = synthetic()
        board = FakeBoard(data)
        b = self._run([self.gate(), self.gate(id="h", window_ns=200)], board)
        kept = b._gates["g"]
        self.assertGreater(sum(kept.passed.values()), 0)
        b._acq = mock.Mock()
        b._acq.get_boards.return_value = [{"id": "0", "name": "V1725S", "dpp": "DPP-PHA"}]
        src = C.HitSource("0", "board-0", take=board.drain, dropped=lambda: 0,
                          enable=lambda on: None, energy_bins=32768)
        with mock.patch.object(C, "sources_for_run", return_value={"0": src}), \
             mock.patch.object(C, "clock_domains", return_value={"0": "board-0"}):
            cfg = b.get_config()
            cfg["gates"][1]["window_ns"] = 300
            b.set_config(cfg)
            self.assertIs(b._gates["g"], kept)
            self.assertEqual(sum(b._gates["h"].passed.values()), 0)
            # A time offset of one of its channels does start it over.
            cfg["offsets_ns"] = {"0:1": 5.0}
            b.set_config(cfg)
            self.assertIsNot(b._gates["g"], kept)

    # ── sum spectrum ───────────────────────────────────────────────────────
    # ch0: E = 10 + 0.5 × energy; ch1: E = 5 + 2 × energy (keV).
    CAL = {"0:0": (10.0, 0.5), "0:1": (5.0, 2.0)}

    @staticmethod
    def two_partner_hits(n=2000):
        """Events 1 ms apart: ch0 (energy 1000, 510 keV), then ch1 10 ns
        later (energy 500, 1005 keV) and 40 ns later (energy 300, 605 keV)."""
        t = (np.arange(1, n + 1) * 1e9).astype(np.int64)
        tb = np.sort(np.concatenate((t + 10_000, t + 40_000)))
        eb = np.where(np.isin(tb, t + 10_000), 500, 300).astype(np.uint16)
        return {0: (t, np.full(n, 1000, np.uint16)), 1: (tb, eb)}, n

    def test_sum_all_and_nearest(self):
        data, n = self.two_partner_hits()
        b = self._run([self.gate(sum=True)], FakeBoard(data), calib=self.CAL)
        s, bin_kev = b.sum_spectrum("g")
        self.assertEqual(bin_kev, 1.0)
        self.assertEqual(s.size, 16384)
        self.assertEqual(int(s[510 + 1005 + 605]), n)          # every partner hit
        self.assertEqual(int(s.sum()), n)
        b = self._run([self.gate(sum=True, sum_partners="nearest")], FakeBoard(data), calib=self.CAL)
        s, _ = b.sum_spectrum("g")
        self.assertEqual(int(s[510 + 1005]), n)                 # the nearest ch1 hit only
        st = b.gate("g").status(0)["sum"]
        self.assertTrue(st["filling"])
        self.assertEqual((st["entries"], st["overflow"]), (n, 0))

    def test_sum_bin_width(self):
        data, n = self.two_partner_hits()
        b = self._run([self.gate(sum=True, sum_bin_kev=4.0, sum_max_kev=4096)], FakeBoard(data), calib=self.CAL)
        s, bin_kev = b.sum_spectrum("g")
        self.assertEqual((s.size, bin_kev), (1024, 4.0))
        self.assertEqual(int(s[2120 // 4]), n)

    def test_sum_anchor_rule_no_double_counting(self):
        """Channels 0 and 1 both gated and both partners: each event is
        summed once, from its earliest hit, whichever channel that is."""
        n = 1000
        t = (np.arange(1, n + 1) * 1e9).astype(np.int64)
        # ch1 leads in the first half, ch0 in the second.
        t1 = np.where(np.arange(n) < n // 2, t - 10_000, t + 10_000)
        data = {0: (t, np.full(n, 1000, np.uint16)), 1: (t1, np.full(n, 500, np.uint16))}
        both = [{"board": "0", "channel": 0}, {"board": "0", "channel": 1}]
        for how in ("all", "nearest"):
            b = self._run([self.gate(channels=both, partners=both, sum=True, sum_partners=how)],
                          FakeBoard(data), calib=self.CAL)
            s, _ = b.sum_spectrum("g")
            self.assertEqual(int(s.sum()), n, how)
            self.assertEqual(int(s[1515]), n, how)
            # The gated spectra still count every hit that passed.
            self.assertEqual(int(b.spectrum("g", "0:0")[1000]), n)
            self.assertEqual(int(b.spectrum("g", "0:1")[500]), n)

    def test_sum_matches_a_brute_force_count(self):
        """Random hits on three channels, overlapping sides, delivered out of
        order in chunks: the vectorised sum equals the event-by-event rule."""
        rng = np.random.default_rng(11)
        seconds, w = 1.0, 1_000_000
        data, hits = {}, []
        for ch, rate in ((0, 20000.0), (1, 15000.0), (2, 10000.0)):
            tt = np.sort(rng.choice(int(seconds * 1e9), int(rate * seconds), replace=False)) * 1000
            ee = rng.integers(1, 4000, tt.size).astype(np.uint16)
            data[ch] = (tt.astype(np.int64), ee)
            hits += [(int(x), ch, int(y)) for x, y in zip(tt, ee)]
        hits.sort()
        cal = {"0:0": (1.5, 0.75), "0:1": (-2.0, 1.25), "0:2": (0.25, 0.5)}
        chans, partners = [0, 1], [1, 2]
        times = np.array([h[0] for h in hits])
        for how in ("all", "nearest"):
            for need in (1, 2):
                expect = np.zeros(16384, np.int64)
                for i, (ti, ci, ei) in enumerate(hits):
                    if ci not in chans:
                        continue
                    j0, j1 = np.searchsorted(times, [ti - w, ti + w + 1])
                    near = [hits[j] for j in range(j0, j1) if j != i and hits[j][1] in partners]
                    if len({h[1] for h in near}) < need:
                        continue
                    if ci in partners and any(h[0] < ti and h[1] in chans for h in near):
                        continue                               # not the anchor
                    total = cal[f"0:{ci}"][0] + cal[f"0:{ci}"][1] * ei
                    if how == "all":
                        picked = near
                    else:
                        picked = [min((h for h in near if h[1] == p), key=lambda h: (abs(h[0] - ti), h[0]))
                                  for p in {h[1] for h in near}]
                    total += sum(cal[f"0:{h[1]}"][0] + cal[f"0:{h[1]}"][1] * h[2] for h in picked)
                    expect[int(np.floor(total))] += 1
                gate = self.gate(channels=[{"board": "0", "channel": c} for c in chans],
                                 partners=[{"board": "0", "channel": c} for c in partners],
                                 min_partners=need, sum=True, sum_partners=how, window_ns=1000)
                s, _ = self._run([gate], FakeBoard(data, chunk_s=0.05, skew_s=0.1), calib=cal).sum_spectrum("g")
                np.testing.assert_array_equal(s, expect, err_msg=f"{how}, at least {need}")

    def test_sum_overflow_is_counted(self):
        data, n = self.two_partner_hits()
        b = self._run([self.gate(sum=True, sum_max_kev=2000)], FakeBoard(data), calib=self.CAL)
        st = b.gate("g").status(0)["sum"]
        self.assertEqual((st["entries"], st["overflow"]), (0, n))

    def test_sum_needs_calibrations(self):
        data, n = self.two_partner_hits()
        b = self._run([self.gate(sum=True)], FakeBoard(data), calib={"0:0": (10.0, 0.5)})
        s, _ = b.sum_spectrum("g")
        self.assertEqual(int(s.sum()), 0)
        self.assertEqual(int(b.spectrum("g", "0:0")[1000]), n)     # the rest of the gate works
        st = b.gate("g").status(0)["sum"]
        self.assertFalse(st["filling"])
        self.assertEqual(st["missing"], ["0:1"])
        with mock.patch.object(C, "check_gates", return_value={"g": []}):
            status = b.status()
        self.assertEqual(status["problems"]["g"], [])
        self.assertIn("Sum spectrum needs an energy calibration on: V1725S 0 · ch 1", status["warnings"]["g"][0])

    def test_sum_is_off_for_vetoes_and_by_default(self):
        data, _ = self.two_partner_hits(100)
        self.assertIsNone(self._run([self.gate()], FakeBoard(data), calib=self.CAL).sum_spectrum("g"))
        self.assertIsNone(self._run([self.gate(sum=True, mode="anticoincidence")], FakeBoard(data),
                                    calib=self.CAL).sum_spectrum("g"))

    def test_sum_kept_on_save_and_restarted_by_a_calibration(self):
        data, n = self.two_partner_hits()
        board = FakeBoard(data)
        b = self._run([self.gate(sum=True), self.gate(id="h", window_ns=200)], board, calib=self.CAL)
        kept = b._gates["g"]
        self.assertEqual(int(kept.sum.sum()), n)
        src = C.HitSource("0", "board-0", take=board.drain, dropped=lambda: 0,
                          enable=lambda on: None, energy_bins=32768)
        b._acq = mock.Mock()
        b._acq.get_boards.return_value = [{"id": "0", "name": "V1725S", "dpp": "DPP-PHA"}]
        cal = dict(self.CAL)
        with mock.patch.object(C, "sources_for_run", return_value={"0": src}), \
             mock.patch.object(C, "clock_domains", return_value={"0": "board-0"}), \
             mock.patch.object(C, "read_calibrations",
                               side_effect=lambda boards, keys: {k: cal.get(k, (0.0, 1.0)) for k in keys}):
            cfg = b.get_config()
            cfg["gates"][1]["window_ns"] = 300
            b.set_config(cfg)
            self.assertIs(b._gates["g"], kept)
            self.assertEqual(int(kept.sum.sum()), n)
            self.assertFalse(kept.sum_restarted)
            # A new calibration of one of its channels empties it, and says so.
            cal["0:1"] = (4.0, 2.0)
            b._check_calibrations(0.0)
            self.assertEqual(int(kept.sum.sum()), 0)
            st = kept.status(0)["sum"]
            self.assertTrue(st["restarted"] and st["filling"])
            # Changing the sum's options is a change of the gate.
            cfg["gates"][0]["sum_partners"] = "nearest"
            b.set_config(cfg)
            self.assertIsNot(b._gates["g"], kept)

    def test_sum_config_validation(self):
        cfg = C.normalise_config({"gates": [{}]})
        g = cfg["gates"][0]
        self.assertEqual((g["sum"], g["sum_partners"], g["sum_max_kev"], g["sum_bin_kev"]),
                         (False, "all", 16384.0, 1.0))
        for bad in ({"sum_partners": "some"}, {"sum_bin_kev": 0}, {"sum_max_kev": -1},
                    {"sum_max_kev": 70000, "sum_bin_kev": 1.0}):
            with self.assertRaises(ValueError):
                C.normalise_config({"gates": [bad]})
        C.normalise_config({"gates": [{"sum_max_kev": 65536, "sum_bin_kev": 1.0}]})

    def test_read_calibrations_follows_the_file(self):
        boards = [{"id": "0", "name": "V1725S"}]
        cwd = os.getcwd()
        os.chdir(self.tmp.name)
        try:
            self.assertEqual(C.read_calibrations(boards, ["0:1"]), {"0:1": (0.0, 1.0)})
            os.makedirs("calib")
            with open("calib/V1725S_0.cal", "w") as f:
                f.write("0 1\n5 2\n")
            self.assertEqual(C.read_calibrations(boards, ["0:1", "0:3"]), {"0:1": (5.0, 2.0), "0:3": (0.0, 1.0)})
            with open("calib/V1725S_0.cal.tmp", "w") as f:
                f.write("0 1\n6 2\n")
            os.replace("calib/V1725S_0.cal.tmp", "calib/V1725S_0.cal")
            self.assertEqual(C.read_calibrations(boards, ["0:1"]), {"0:1": (6.0, 2.0)})
        finally:
            os.chdir(cwd)

    def test_chained_boards_share_a_clock_only_through_clk_in(self):
        def domains(controls):
            boards = [{"id": str(i), "name": "V1725S", "dpp": "DPP-PHA", "_8100": c}
                      for i, c in enumerate(controls)]
            with mock.patch("app.services.caen_acquisition.acquisition_control_of",
                            side_effect=lambda b: b["_8100"]):
                return C.clock_domains(boards)
        first_trigger, sin, ext_clock = 0x3, 0x1, 1 << 6
        # Master on its own clock, the slave on CLK-IN: one time base.
        d = domains([first_trigger, sin | ext_clock])
        self.assertEqual(d["0"], d["1"])
        # Started together, each on its own oscillator: they drift apart.
        d = domains([first_trigger, sin])
        self.assertNotEqual(d["0"], d["1"])
        # Not in a chain (software start): its own clock, whatever bit 6 says.
        d = domains([first_trigger, sin | ext_clock, 0x0 | ext_clock])
        self.assertEqual(d["0"], d["1"])
        self.assertNotEqual(d["2"], d["0"])


if __name__ == "__main__":
    unittest.main()
