"""
The registers a running run uses (round-3 review, trapezoid calculator B).

The energy-scale calculator compares a live peak with the settings that made
it. An edit saved to the configuration during a run must not change what
/digitizer/<id>/run_registers reports until the next run starts; between runs
the saved configuration is what it reports.
"""

import os
import unittest
from unittest import mock

os.environ.setdefault('TEST_FLAG', 'True')

from app import create_app                      # noqa: E402
from app.utils.jwt_utils import generate_token  # noqa: E402
from app.services.daq_manager import get_daq_manager  # noqa: E402


class RunRegistersTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = create_app()
        with cls.app.app_context():
            cls.token = generate_token(1)
        cls.auth = {'Authorization': f'Bearer {cls.token}'}

    def test_saved_between_runs_and_run_start_values_during_a_run(self):
        client = self.app.test_client()
        regs = client.get('/digitizer/0/registers', headers=self.auth).get_json()
        if not isinstance(regs, dict) or not regs:
            self.skipTest('no simulated board register file')
        key = sorted(regs)[0]
        daq = get_daq_manager()

        r = client.get('/digitizer/0/run_registers', headers=self.auth).get_json()
        self.assertEqual(r['source'], 'saved')

        self.assertEqual(client.get(f'/digitizer/0/{key}/11', headers=self.auth).get_json(), 0)
        with mock.patch.object(daq, 'is_running', return_value=True):
            daq._snapshot_run_registers()
            # Edited during the run: the run keeps the value it started with.
            self.assertEqual(client.get(f'/digitizer/0/{key}/22', headers=self.auth).get_json(), 0)
            r = client.get('/digitizer/0/run_registers', headers=self.auth).get_json()
            self.assertEqual(r['source'], 'run')
            self.assertEqual(r['registers'][key]['value_dec'], 11)
            # Written to the board during the run: the reference stays at the
            # start values (the live spectrum holds the counts from before too).
            addr = int(str(regs[key]['address']), 16)
            daq._note_run_register('0', addr, 33)
            r = client.get('/digitizer/0/run_registers', headers=self.auth).get_json()
            self.assertEqual(r['registers'][key]['value_dec'], 11)

        r = client.get('/digitizer/0/run_registers', headers=self.auth).get_json()
        self.assertEqual(r['source'], 'saved')
        self.assertEqual(r['registers'][key]['value_dec'], 22)

    def test_energy_scale_written_mid_run_is_reported_per_channel(self):
        """Fine gain doubled online: the run reports channel 0's scale changed;
        a write of the value already there, or of a field off the energy
        scale, does not count."""
        client = self.app.test_client()
        daq = get_daq_manager()
        # A DPP-PHA snapshot of its own: the simulated board may be a PSD one.
        fg0, algo1 = 0x1000, 0x30A
        fake = {
            'reg_10C4': {'name': 'Fine Gain', 'channel': 0, 'address': '0x10C4', 'value': hex(fg0)},
            'reg_11C4': {'name': 'Fine Gain', 'channel': 1, 'address': '0x11C4', 'value': hex(fg0)},
            'reg_1080': {'name': 'DPP Algorithm Control', 'channel': 0, 'address': '0x1080', 'value': hex(algo1)},
            'reg_1180': {'name': 'DPP Algorithm Control', 'channel': 1, 'address': '0x1180', 'value': hex(algo1)},
        }
        by_addr = {0x10C4: 'reg_10C4', 0x1180: 'reg_1180'}
        with mock.patch.object(daq, 'is_running', return_value=True):
            daq._snapshot_run_registers()
            daq._run_start_registers['0'] = fake
            r = client.get('/digitizer/0/run_registers', headers=self.auth).get_json()
            self.assertEqual(r['scale_changed'], {})

            # The same value again, and a bit outside the scale fields of 0x1n80.
            daq._note_run_register('0', 0x10C4, fg0)
            daq._note_run_register('0', 0x1180, algo1 ^ (1 << 16))
            r = client.get('/digitizer/0/run_registers', headers=self.auth).get_json()
            self.assertEqual(r['scale_changed'], {})

            daq._note_run_register('0', 0x10C4, 2 * fg0)
            r = client.get('/digitizer/0/run_registers', headers=self.auth).get_json()
            self.assertEqual(r['scale_changed'], {'0': ['Fine Gain']})
            self.assertEqual(r['registers'][by_addr[0x10C4]]['value_dec'], fg0)
            # Written back: the spectrum still holds counts from both scales.
            daq._note_run_register('0', 0x10C4, fg0)
            r = client.get('/digitizer/0/run_registers', headers=self.auth).get_json()
            self.assertEqual(r['scale_changed'], {'0': ['Fine Gain']})
            # A broadcast write of the rescaling (0x8080) reaches every channel.
            daq._note_run_register('0', 0x8080, (algo1 & ~0x3F) | 0x0B)
            r = client.get('/digitizer/0/run_registers', headers=self.auth).get_json()
            self.assertEqual(r['scale_changed'], {'0': ['Fine Gain', 'Trapezoid Rescaling'],
                                                  '1': ['Trapezoid Rescaling']})

            # The next run starts clean.
            daq._snapshot_run_registers()
            r = client.get('/digitizer/0/run_registers', headers=self.auth).get_json()
            self.assertEqual(r['scale_changed'], {})

        r = client.get('/digitizer/0/run_registers', headers=self.auth).get_json()
        self.assertEqual(r['source'], 'saved')
        self.assertEqual(r['scale_changed'], {})


if __name__ == '__main__':
    unittest.main()
