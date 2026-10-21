"""Hardware-free tests of sis3316daq: python -m unittest discover -s tests"""

import json
import os
import sys
import tempfile
import time
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from sis3316daq import DAQ, default_settings, validate  # noqa: E402
from sis3316daq.events import decode_bank, header_words  # noqa: E402
from sis3316daq.settings import channel_settings  # noqa: E402
from sis3316daq.transport import UdpLink  # noqa: E402

try:
    import h5py
except ImportError:
    h5py = None


def make_records(n, ch=3, fmt=0x8, raw=4, energy=1000, ts0=100, pileup_every=0):
    hdr = header_words(fmt)
    rec = np.zeros((n, hdr + 1 + raw // 2), np.uint32)
    ts = ts0 + np.arange(n, dtype=np.uint64) * 1000 + (1 << 33)
    rec[:, 0] = ((ts >> np.uint64(32)).astype(np.uint32) << 16) | (ch << 4) | fmt
    rec[:, 1] = (ts & np.uint64(0xFFFFFFFF)).astype(np.uint32)
    if fmt & 0x8:
        rec[:, hdr - 2] = np.uint32(7)
        rec[:, hdr - 1] = (energy + np.arange(n)).astype(np.uint32)
    rec[:, hdr] = 0xE0000000 | (raw // 2)
    if pileup_every:
        rec[::pileup_every, hdr] |= 1 << 26
    if raw:
        rec[:, hdr + 1:] = (np.arange(raw, dtype=np.uint16) + 8000).view(np.uint32)
    return rec


class SettingsTests(unittest.TestCase):
    def test_defaults_are_complete_and_valid(self):
        s = validate(default_settings())
        self.assertEqual(s["board"]["sample_clock_mhz"], 250.0)
        self.assertFalse(channel_settings(s, 0)["enabled"])

    def test_channel_override_and_clamping(self):
        s = default_settings()
        s["channel_defaults"]["trigger_peaking"] = 7          # odd -> even
        s["channels"]["2"] = {"enabled": True, "energy_peaking": 99999}
        s["board"]["raw_samples"] = 100001
        v = validate(s)
        self.assertEqual(channel_settings(v, 0)["trigger_peaking"], 6)
        self.assertTrue(channel_settings(v, 2)["enabled"])
        self.assertEqual(channel_settings(v, 2)["energy_peaking"], 2044)
        self.assertEqual(v["board"]["raw_samples"], 32000)

    def test_bad_enum_and_clock_are_refused(self):
        s = default_settings()
        s["channels"]["1"] = {"input_range": "10V"}
        with self.assertRaises(ValueError):
            validate(s)
        s = default_settings()
        s["board"]["sample_clock_mhz"] = 300
        with self.assertRaises(ValueError):
            validate(s)


class DecoderTests(unittest.TestCase):
    def test_fast_path(self):
        rec = make_records(5, raw=6, pileup_every=2)
        f, waves, maw = decode_bank(rec.ravel())
        self.assertEqual(f["timestamp"].size, 5)
        self.assertEqual(int(f["timestamp"][0]), (1 << 33) + 100)
        self.assertEqual(f["energy_max"].tolist(), [1000, 1001, 1002, 1003, 1004])
        self.assertEqual(f["energy_start"].tolist(), [7] * 5)
        self.assertEqual(f["pileup"].tolist(), [True, False, True, False, True])
        self.assertEqual(f["channel_id"].tolist(), [3] * 5)
        self.assertEqual(waves.shape, (5, 6))
        self.assertEqual(waves[0].tolist(), [8000, 8001, 8002, 8003, 8004, 8005])
        self.assertIsNone(maw)

    def test_negative_energy_is_signed(self):
        rec = make_records(1, energy=-5)
        f, _, _ = decode_bank(rec.ravel())
        self.assertEqual(int(f["energy_max"][0]), -5)

    def test_walker_keeps_good_records_before_garbage(self):
        good = make_records(3, raw=4).ravel()
        words = np.concatenate([good, np.array([0x12345678, 0, 0, 0, 0, 0], np.uint32)])
        f, waves, _ = decode_bank(words)
        self.assertEqual(f["timestamp"].size, 3)
        self.assertEqual(waves.shape, (3, 4))

    def test_empty_bank(self):
        f, waves, maw = decode_bank(np.zeros(0, np.uint32))
        self.assertEqual(f["timestamp"].size, 0)
        self.assertIsNone(waves)


class BatchingTests(unittest.TestCase):
    def test_adc_fpga_registers_are_never_batched(self):
        addrs = [0x20, 0x28, 0x1010, 0x1014, 0x60, 0x2010]
        self.assertEqual(UdpLink._batches(addrs, lambda a: a),
                         [[0x20, 0x28], [0x1010], [0x1014], [0x60], [0x2010]])

    def test_vme_registers_batch_up_to_the_request_limit(self):
        addrs = [0x20] * 70
        self.assertEqual([len(b) for b in UdpLink._batches(addrs, lambda a: a)], [64, 6])


@unittest.skipIf(h5py is None, "h5py not installed")
class MockDaqTests(unittest.TestCase):
    def test_mock_run_writes_hdf5_and_spectra(self):
        s = default_settings()
        s["board"]["raw_samples"] = 100
        s["board"]["readout_interval_ms"] = 50
        s["channels"]["1"] = {"enabled": True}
        with tempfile.TemporaryDirectory() as tmp:
            d = DAQ(tmp, run=12, stats_interval_ms=200)
            d.add_board("SIS3316", 4, "mock", s, mock=True)
            d.start()
            time.sleep(0.6)
            self.assertTrue(d.is_running())
            spectrum = d.energy(0, 1)
            d.stop()
            self.assertGreater(int(spectrum.sum()), 0)
            # amplitude 350 x peaking 200 / divider 200 -> bin ~350
            self.assertAlmostEqual(int(spectrum.argmax()), 350, delta=3)
            self.assertEqual(d.waveform(0, 1).size, 100)
            self.assertEqual(d.diagnostics()[4]["comm_errors"], 0)
            stats = d.stats()[0]
            self.assertEqual(stats["board_id"], 4)
            self.assertEqual(len(stats["channels"]), 16)
            files = os.listdir(tmp)
            self.assertEqual(files, ["run_12_0000.h5"])
            with h5py.File(os.path.join(tmp, files[0])) as f:
                g = f["board_4"]
                self.assertEqual(f.attrs["run"], 12)
                self.assertEqual(g["events"].shape[0], g["waveforms"].shape[0])
                self.assertGreater(g["events"].shape[0], 0)
                self.assertTrue(set(g["events"]["channel"][:]) == {1})
                self.assertTrue(json.loads(g.attrs["settings"])["channels"]["1"]["enabled"])

    def test_settings_that_change_the_file_layout_are_refused_while_running(self):
        s = default_settings()
        s["channels"]["0"] = {"enabled": True}
        with tempfile.TemporaryDirectory() as tmp:
            d = DAQ(tmp, run=1, write=False)
            d.add_board("SIS3316", 0, "mock", s, mock=True)
            d.start()
            try:
                bad = json.loads(json.dumps(s))
                bad["board"]["raw_samples"] = 64
                with self.assertRaises(ValueError):
                    d.update_settings(0, bad)
                ok = json.loads(json.dumps(s))
                ok["channels"]["0"]["trigger_threshold"] = 55
                d.update_settings(0, ok)
            finally:
                d.stop()


if __name__ == "__main__":
    unittest.main()
