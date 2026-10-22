"""
An SIS3316 board through the HTTP surface, in TEST_FLAG mode (sis3316daq's
mock board): add, settings, a run with live spectra and an HDF5 file, remove.
"""

import json
import os
import time
import unittest

os.environ.setdefault('TEST_FLAG', 'True')

from app import create_app                      # noqa: E402
from app.utils.jwt_utils import generate_token  # noqa: E402

BOARD_ID = 77


class Sis3316RouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = create_app()
        with cls.app.app_context():
            cls.token = generate_token(1)
        cls.client = cls.app.test_client()
        cls.auth = {'Authorization': f'Bearer {cls.token}'}

    def get(self, url, **kwargs):
        return self.client.get(url, headers=self.auth, **kwargs)

    def post(self, url, payload=None, **kwargs):
        return self.client.post(url, headers=self.auth, json=payload, **kwargs)

    def setUp(self):
        self.post('/experiment/remove_board', {'id': BOARD_ID})
        r = self.post('/experiment/add_board',
                      {'vendor': 'sis3316', 'id': BOARD_ID, 'link_num': '192.168.1.100'})
        self.assertEqual(r.status_code, 200, r.get_json())

    def tearDown(self):
        if self.get('/experiment/get_run_status').get_json():
            self.post('/experiment/stop_run')
        self.post('/experiment/remove_board', {'id': BOARD_ID})

    def board(self):
        return next(b for b in self.get('/experiment/get_board_configuration').get_json()
                    if b['id'] == BOARD_ID)

    def enable_channel(self, ch, **extra):
        s = self.get(f'/sis3316/{BOARD_ID}/settings').get_json()['settings']
        s['channels'][str(ch)] = dict({'enabled': True}, **extra)
        s['board']['readout_interval_ms'] = 50
        return self.post(f'/sis3316/{BOARD_ID}/settings', {'settings': s})

    def test_the_board_is_added_as_an_ethernet_sis3316(self):
        b = self.board()
        self.assertEqual((b['name'], b['vendor'], b['link_type'], b['chan']),
                         ('SIS3316', 'sis3316', 'Ethernet', 16))
        self.assertTrue(os.path.exists(f'conf/SIS3316_{BOARD_ID}.json'))
        self.assertTrue(os.path.exists(f'calib/SIS3316_{BOARD_ID}.cal'))
        info = self.get(f'/sis3316/{BOARD_ID}/info').get_json()
        self.assertEqual(info['model'], 'SIS3316')

    def test_settings_are_validated(self):
        self.assertEqual(self.enable_channel(3).status_code, 200)
        s = self.get(f'/sis3316/{BOARD_ID}/settings').get_json()['settings']
        self.assertTrue(s['channels']['3']['enabled'])
        s['channels']['3']['input_range'] = '10V'
        r = self.post(f'/sis3316/{BOARD_ID}/settings', {'settings': s})
        self.assertEqual(r.status_code, 400)
        self.assertIn('input range', r.get_json()['error'])

    def test_caen_routes_and_register_writes_refuse_the_board(self):
        r = self.post(f'/digitizer/{BOARD_ID}/setting/reg_1080', {'value': 1, 'online': True})
        self.assertNotEqual(r.status_code, 500)
        self.assertEqual(self.get('/sis3316/0/info').status_code in (400, 404), True)

    def test_a_run_produces_rates_spectra_and_an_hdf5_file(self):
        self.enable_channel(2)
        self.post('/experiment/set_save_data', {'value': True})
        run = self.get('/experiment/get_run_number').get_json()
        r = self.post('/experiment/start_run')
        self.assertEqual(r.status_code, 200, r.get_json())
        try:
            deadline = time.time() + 6
            rate = 0.0
            while time.time() < deadline and rate == 0.0:
                time.sleep(0.3)
                stats = self.get('/experiment/stats').get_json()
                entry = next((s for s in stats if s['board_id'] == BOARD_ID), None)
                if entry:
                    rate = entry['channels'][2]['event_rate']
            self.assertGreater(rate, 0.0)
            diag = self.get('/experiment/board_diagnostics').get_json()
            self.assertIn(str(BOARD_ID), json.dumps(diag))
            histo = self.get(f'/histograms/{BOARD_ID}/2')
            self.assertEqual(histo.status_code, 200)
            self.assertIn('TH1', histo.get_data(as_text=True))
            # Raw length fixes the run file's waveform width: refused mid-run
            s = self.get(f'/sis3316/{BOARD_ID}/settings').get_json()['settings']
            s['board']['raw_samples'] = 64
            self.assertEqual(self.post(f'/sis3316/{BOARD_ID}/settings', {'settings': s}).status_code, 409)
            onboard = self.get(f'/sis3316/{BOARD_ID}/onboard_histogram/2?format=json&bins=4096')
            self.assertGreater(onboard.get_json()['entries'], 0)
        finally:
            self.assertEqual(self.post('/experiment/stop_run').status_code, 200)
        files = os.listdir(f'data/run{run}')
        self.assertTrue(any(f.endswith('.h5') for f in files), files)
        listed = self.get(f'/data/runs/{run}')
        if listed.status_code == 200:
            self.assertIn('.h5', json.dumps(listed.get_json()))

    def test_scalers_live_time_counter_input_and_integrity_note(self):
        self.enable_channel(2)
        s = self.get(f'/sis3316/{BOARD_ID}/settings').get_json()['settings']
        s['channels']['14'] = {'enabled': True, 'counter_input': True,
                               'counter_name': 'Beam charge', 'counter_scale': 10,
                               'counter_unit': 'pC'}
        self.assertEqual(self.post(f'/sis3316/{BOARD_ID}/settings', {'settings': s}).status_code, 200)
        self.post('/experiment/set_save_data', {'value': True})
        run = self.get('/experiment/get_run_number').get_json()
        self.assertEqual(self.post('/experiment/start_run').status_code, 200)
        try:
            deadline = time.time() + 6
            live = None
            while time.time() < deadline:
                time.sleep(0.3)
                live = self.get(f'/sis3316/{BOARD_ID}/counters').get_json()
                if live.get('run') and live['run']['channels'][2]['internal'] > 0 \
                        and live['run']['temperature_c'] is not None:
                    break
            self.assertEqual(live['source'], 'run')
            self.assertEqual(len(live['channels']), 16)
            ch2 = live['run']['channels'][2]
            self.assertTrue(ch2['enabled'])
            self.assertIsNotNone(ch2['live_fraction'])
            counters = live['run']['counters']
            self.assertEqual([(c['name'], c['unit'], c['channel']) for c in counters],
                             [('Beam charge', 'pC', 14)])
            self.assertAlmostEqual(counters[0]['total'], 10 * counters[0]['counts'])
            # The board loses hits: the run's notes must say so at the stop.
            from app.services.sis3316_acquisition import get_sis3316_acquisition
            acq = get_sis3316_acquisition()
            dev = acq._daq.boards[acq.local_index(BOARD_ID)].dev
            dev._stats[2, 0] += 400
            dev._stats[2, 1] += 400
            time.sleep(0.3)
        finally:
            self.assertEqual(self.post('/experiment/stop_run').status_code, 200)
        files = os.listdir(f'data/run{run}')
        self.assertIn('sis3316_scalers.csv', files)
        with open(f'data/run{run}/sis3316_summary.json') as f:
            summary = json.load(f)
        board = next(b for b in summary['boards'] if b['board_id'] == BOARD_ID)
        self.assertFalse(board['integrity']['ok'])
        self.assertEqual(board['counter_inputs'][0]['name'], 'Beam charge')
        meta = self.get(f'/experiment/get_run_metadata/{run}').get_json()
        self.assertIn('[sis3316]', json.dumps(meta))
        # After the stop the page still shows the run's totals and summary.
        after = self.get(f'/sis3316/{BOARD_ID}/counters').get_json()
        self.assertFalse(after['run']['running'])
        self.assertEqual(after['run']['summary']['board_id'], BOARD_ID)

    def test_waveform_switch_toggles_the_raw_length(self):
        r = self.post(f'/waveforms/activate/{BOARD_ID}')
        if r.status_code == 404:
            self.skipTest('no per-board waveform route')
        s = self.get(f'/sis3316/{BOARD_ID}/settings').get_json()['settings']
        self.assertGreater(s['board']['raw_samples'], 0)
        self.post(f'/waveforms/deactivate/{BOARD_ID}')
        s = self.get(f'/sis3316/{BOARD_ID}/settings').get_json()['settings']
        self.assertEqual(s['board']['raw_samples'], 0)


if __name__ == '__main__':
    unittest.main()
