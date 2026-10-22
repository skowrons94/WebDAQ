"""
Run numbers the pages derive from the server's data: whether a recorded run
has a data directory, the next free number Start offers instead of
overwriting a run, and the beam current at the start of a run.
"""

import os
import unittest
from datetime import datetime

os.environ.setdefault('TEST_FLAG', 'True')

from app import create_app, db                    # noqa: E402
from app.models.run_metadata import RunMetadata    # noqa: E402
from app.utils.jwt_utils import generate_token     # noqa: E402


class RunNumberTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = create_app()
        with cls.app.app_context():
            cls.token = generate_token(1)
        cls.client = cls.app.test_client()
        cls.auth = {'Authorization': f'Bearer {cls.token}'}

    def get(self, url):
        return self.client.get(url, headers=self.auth)

    def setUp(self):
        with self.app.app_context():
            for n in (901, 902):
                RunMetadata.query.filter_by(run_number=n).delete()
            db.session.add(RunMetadata(run_number=901, start_time=datetime.now(), end_time=datetime.now()))
            db.session.add(RunMetadata(run_number=902, start_time=datetime.now()))
            db.session.commit()
        os.makedirs('data/run901', exist_ok=True)

    def tearDown(self):
        with self.app.app_context():
            for n in (901, 902):
                RunMetadata.query.filter_by(run_number=n).delete()
            db.session.commit()
        for d in ('data/run901', 'data/run905'):
            if os.path.isdir(d):
                os.rmdir(d)

    def test_the_run_list_says_which_runs_have_data(self):
        rows = {r['run_number']: r for r in self.get('/experiment/get_run_metadata').get_json()}
        self.assertTrue(rows[901]['has_data'])
        self.assertFalse(rows[902]['has_data'])
        one = self.get('/experiment/get_run_metadata/902').get_json()
        self.assertFalse(one['has_data'])
        self.assertIsNone(one['end_time'])

    def test_the_next_free_run_is_above_records_and_directories(self):
        self.assertEqual(self.get('/experiment/next_free_run').get_json()['run'], 903)
        os.makedirs('data/run905', exist_ok=True)
        self.assertEqual(self.get('/experiment/next_free_run').get_json()['run'], 906)

    def test_no_start_current_without_a_run(self):
        body = self.get('/current/run_start').get_json()
        self.assertIsNone(body['current'])

    def test_the_first_logged_reading_is_the_start_current(self):
        from app.routes import current
        os.makedirs('data/run901', exist_ok=True)
        path = 'data/run901/current.txt'
        with open(path, 'w') as f:
            f.write('### Start time: 2026-10-22 09:50:48.733722 ###\n'
                    '# Time(s)\tCh0(uA)\tCh1(uA)\n'
                    '9.4e-02\t7.195e+00\t7.2e-01\n'
                    '1.9e-01\t7.226e+00\t7.3e-01\n')
        try:
            self.assertAlmostEqual(current._first_logged_current(901, 0), 7.195)
            self.assertAlmostEqual(current._first_logged_current(901, 1), 0.72)
            self.assertIsNone(current._first_logged_current(902, 0))
        finally:
            os.remove(path)


if __name__ == '__main__':
    unittest.main()
