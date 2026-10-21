"""
A channel whose energies are unusable says so on its histogram card.

Found on the V1725S on 2026-10-21: with Trapezoid Rescaling 0 and Fine Gain
0xFFFF every event came out with energy 0, and the spectrum was simply empty;
with the gain too high instead, every event sat in the last bin. Both are
judged on the data, whatever register combination causes them.
"""

import unittest

import numpy as np

from app.services.caen_acquisition import energy_warning


class EnergyWarningTests(unittest.TestCase):
    def spectrum(self, bins=32768, **fill):
        h = np.zeros(bins, np.uint32)
        for b, n in fill.items():
            h[int(b[1:])] = n
        return h

    def test_all_energies_zero(self):
        w = energy_warning(500, self.spectrum())
        self.assertIn("100% of the events have energy 0", w)
        self.assertIn("Trapezoid Rescaling", w)

    def test_no_spectrum_at_all(self):
        # CaenDAQ allocates a spectrum on the first non-zero energy only.
        self.assertIn("100% of the events have energy 0", energy_warning(500, np.zeros(0, np.uint32)))

    def test_pinned_at_the_top(self):
        w = energy_warning(500, self.spectrum(b32767=450, b1000=50))
        self.assertIn("90% of the events are at the top of the energy scale", w)

    def test_a_normal_spectrum_is_quiet(self):
        self.assertIsNone(energy_warning(500, self.spectrum(b1126=480, b0=0)))

    def test_too_few_events_to_judge(self):
        self.assertIsNone(energy_warning(20, self.spectrum()))

    def test_psd_charge(self):
        self.assertIn("charge 0", energy_warning(300, self.spectrum(bins=65536), psd=True))


if __name__ == "__main__":
    unittest.main()
