"""
Concurrent writes to one board file (round-2 reviews S1, R5).

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

    def _board_file(self):
        import glob
        files = glob.glob('conf/*_0.json')
        if not files:
            self.skipTest('no simulated board file')
        return files[0]

    def test_waveform_switch_does_not_undo_parallel_register_writes(self):
        """The waveform switch rewrites the same file: under the same lock."""
        client = self.app.test_client()
        regs = client.get('/digitizer/0/registers', headers=self.auth).get_json()
        if not isinstance(regs, dict) or len(regs) < 12:
            self.skipTest('no simulated board register file')
        keys = [k for k in sorted(regs) if k != 'reg_8000'][16:28]
        want = {k: 2000 + i for i, k in enumerate(keys)}

        def write(k, v):
            self.app.test_client().get(f'/digitizer/0/{k}/{v}', headers=self.auth)

        def toggle(on):
            path = '/waveforms/activate/0' if on else '/waveforms/deactivate/0'
            self.app.test_client().post(path, headers=self.auth)

        threads = [threading.Thread(target=write, args=kv) for kv in want.items()]
        threads += [threading.Thread(target=toggle, args=(i % 2 == 0,)) for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        after = client.get('/digitizer/0/registers', headers=self.auth).get_json()
        self.assertIsInstance(after, dict)
        lost = {k: (v, after[k]['value_dec']) for k, v in want.items() if after[k]['value_dec'] != v}
        self.assertEqual(lost, {}, 'a waveform switch must not overwrite register saves')

    def test_a_save_keeps_the_files_permission_mode(self):
        path = self._board_file()
        os.chmod(path, 0o640)
        try:
            client = self.app.test_client()
            regs = client.get('/digitizer/0/registers', headers=self.auth).get_json()
            key = sorted(regs)[0]
            self.assertEqual(client.get(f'/digitizer/0/{key}/7', headers=self.auth).get_json(), 0)
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o640)
            client.post('/waveforms/activate/0', headers=self.auth)
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o640)
            leftovers = [f for f in os.listdir(os.path.dirname(path) or '.') if f.endswith('.tmp')]
            self.assertEqual(leftovers, [])
        finally:
            os.chmod(path, 0o644)


if __name__ == '__main__':
    unittest.main()
