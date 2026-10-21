"""
GET /waveforms/1/<board>/<ch>?kind=... — the latest trace of one kind of event
(clean, pile-up, saturated), for CAEN (caendaq's mock) and SIS3316 boards.
"""

import json
import os
import time
import unittest

os.environ.setdefault('TEST_FLAG', 'True')

from app import create_app                      # noqa: E402
from app.utils.jwt_utils import generate_token  # noqa: E402

SIS_ID = 78


class WaveformKindTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = create_app()
        with cls.app.app_context():
            cls.token = generate_token(1)
        cls.client = cls.app.test_client()
        cls.auth = {'Authorization': f'Bearer {cls.token}'}
        c = cls.client
        c.post('/experiment/remove_board', headers=cls.auth, json={'id': SIS_ID})
        r = c.post('/experiment/add_board', headers=cls.auth,
                   json={'vendor': 'sis3316', 'id': SIS_ID, 'link_num': '192.168.1.100'})
        assert r.status_code == 200, r.get_json()
        s = c.get(f'/sis3316/{SIS_ID}/settings', headers=cls.auth).get_json()['settings']
        s['channels']['1'] = {'enabled': True}
        s['board'].update({'raw_samples': 100, 'readout_interval_ms': 50})
        c.post(f'/sis3316/{SIS_ID}/settings', headers=cls.auth, json={'settings': s})
        # The CAEN mock board of the test setup (id 0) records traces only when
        # waveforms are switched on for it.
        c.post('/waveforms/activate/0', headers=cls.auth)
        c.post('/experiment/set_save_data', headers=cls.auth, json={'value': False})
        r = c.post('/experiment/start_run', headers=cls.auth)
        assert r.status_code == 200, r.get_json()
        time.sleep(2.5)

    @classmethod
    def tearDownClass(cls):
        cls.client.post('/experiment/stop_run', headers=cls.auth)
        cls.client.post('/waveforms/deactivate/0', headers=cls.auth)
        cls.client.post('/experiment/remove_board', headers=cls.auth, json={'id': SIS_ID})

    def trace(self, board, ch, kind):
        r = self.client.get(f'/waveforms/1/{board}/{ch}', headers=self.auth,
                            query_string={'kind': kind})
        self.assertEqual(r.status_code, 200)
        return json.loads(r.get_data(as_text=True))

    def test_caen_mock_has_clean_and_pileup_traces(self):
        # The mock flags ~5 % of its events as pile-up.
        for kind in ('any', 'good', 'pileup'):
            h = self.trace(0, 0, kind)
            self.assertGreater(h['fXaxis']['fNbins'], 100, f'{kind}: {h.get("fTitle")}')

    def test_caen_mock_never_saturates_so_that_trace_is_explained(self):
        h = self.trace(0, 0, 'saturated')
        self.assertIn('saturated', h['fTitle'])

    def test_sis3316_clean_trace_and_explained_empty_pileup(self):
        good = self.trace(SIS_ID, 1, 'good')
        self.assertEqual(good['fXaxis']['fNbins'], 100)
        # The simulated SIS3316 produces no pile-up.
        self.assertIn('pile-up', self.trace(SIS_ID, 1, 'pileup')['fTitle'])

    def test_an_unknown_kind_is_refused(self):
        r = self.client.get('/waveforms/1/0/0', headers=self.auth, query_string={'kind': 'odd'})
        self.assertEqual(r.status_code, 400)


if __name__ == '__main__':
    unittest.main()
