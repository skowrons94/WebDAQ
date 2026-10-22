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
            # Written to the board during the run: the run uses it from then on.
            addr = int(str(regs[key]['address']), 16)
            daq._note_run_register('0', addr, 33)
            r = client.get('/digitizer/0/run_registers', headers=self.auth).get_json()
            self.assertEqual(r['registers'][key]['value_dec'], 33)

        r = client.get('/digitizer/0/run_registers', headers=self.auth).get_json()
        self.assertEqual(r['source'], 'saved')
        self.assertEqual(r['registers'][key]['value_dec'], 22)


if __name__ == '__main__':
    unittest.main()
