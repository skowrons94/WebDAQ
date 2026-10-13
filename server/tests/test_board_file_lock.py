"""
Concurrent register writes to one board file (round-2 review S1).

Each write reads, changes and rewrites the board's JSON file. The server runs
several request threads, so without the board-file lock two interleaved
writes lose an edit. Many parallel writes to different registers must all land,
and the file must stay valid JSON.
"""

import os
import threading
import unittest

os.environ.setdefault('TEST_FLAG', 'True')

from app import create_app                      # noqa: E402
from app.utils.jwt_utils import generate_token  # noqa: E402


class BoardFileLockTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = create_app()
        with cls.app.app_context():
            cls.token = generate_token(1)
        cls.auth = {'Authorization': f'Bearer {cls.token}'}

    def test_parallel_writes_to_one_board_all_land(self):
        client = self.app.test_client()
        regs = client.get('/digitizer/0/registers', headers=self.auth).get_json()
        if not isinstance(regs, dict) or len(regs) < 16:
            self.skipTest('no simulated board register file')
        keys = sorted(regs)[:16]
        want = {k: 1000 + i for i, k in enumerate(keys)}
        errors = []

        def write(k, v, online):
            c = self.app.test_client()
            if online:
                r = c.post(f'/digitizer/0/setting/{k}', headers=self.auth, json={'value': v, 'online': False})
                ok = r.status_code == 200 and r.get_json().get('saved')
            else:
                r = c.get(f'/digitizer/0/{k}/{v}', headers=self.auth)
                ok = r.status_code == 200 and r.get_json() == 0
            if not ok:
                errors.append((k, r.status_code, r.get_data(as_text=True)[:80]))

        threads = [threading.Thread(target=write, args=(k, v, i % 2 == 0)) for i, (k, v) in enumerate(want.items())]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])
        after = client.get('/digitizer/0/registers', headers=self.auth).get_json()
        self.assertIsInstance(after, dict, 'the board file must still parse')
        lost = {k: (v, after[k]['value_dec']) for k, v in want.items() if after[k]['value_dec'] != v}
        self.assertEqual(lost, {}, 'every parallel write must be kept')


if __name__ == '__main__':
    unittest.main()
