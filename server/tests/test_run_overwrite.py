"""
Starting a run under a number that already has data: the old directory is set
aside, never mixed with the new run's files; and the run number cannot be
changed while a run is going.
"""

import os
import shutil
import tempfile
import unittest

os.environ.setdefault('TEST_FLAG', 'True')

from app import create_app                              # noqa: E402
from app.routes import experiment                       # noqa: E402
from app.utils.jwt_utils import generate_token          # noqa: E402


class RunDirectoryTests(unittest.TestCase):
    def setUp(self):
        self.cwd = os.getcwd()
        self.tmp = tempfile.mkdtemp(prefix='webdaq-overwrite-')
        os.chdir(self.tmp)
        self.mgr = experiment.daq_mgr
        self.mgr._claimed_run = None

    def tearDown(self):
        self.mgr._claimed_run = None
        os.chdir(self.cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_an_old_runs_files_are_moved_aside_once_per_start(self):
        os.makedirs('data/run7')
        open('data/run7/run_7_0000.caendat', 'w').close()
        open('data/run7/run7.root', 'w').close()
        self.mgr.claim_run_directory(7)
        aside = [d for d in os.listdir('data') if d.startswith('run7.overwritten-')]
        self.assertEqual(len(aside), 1)
        self.assertEqual(sorted(os.listdir(f'data/{aside[0]}')), ['run7.root', 'run_7_0000.caendat'])
        self.assertEqual(os.listdir('data/run7'), [])
        # The current log, stats.csv and the acquisition all claim it in one
        # start: the files the first of them wrote stay where they are.
        open('data/run7/current.txt', 'w').close()
        self.mgr.claim_run_directory(7)
        self.assertEqual(os.listdir('data/run7'), ['current.txt'])
        # Once the run has stopped, starting run 7 again sets it aside too.
        self.mgr._claimed_run = None
        self.mgr.claim_run_directory(7)
        self.assertEqual(len([d for d in os.listdir('data') if d.startswith('run7.overwritten-')]), 2)

    def test_an_empty_directory_is_simply_used(self):
        os.makedirs('data/run8')
        self.mgr.claim_run_directory(8)
        self.assertEqual(os.listdir('data'), ['run8'])


class RunNumberGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = create_app()
        with cls.app.app_context():
            token = generate_token(1)
        cls.client = cls.app.test_client()
        cls.auth = {'Authorization': f'Bearer {token}'}

    def setUp(self):
        self.mgr = experiment.daq_mgr
        self.saved = (self.mgr.daq_state.get('run'), self.mgr.daq_state.get('running'))

    def tearDown(self):
        self.mgr.daq_state['run'], self.mgr.daq_state['running'] = self.saved

    def post(self, value):
        return self.client.post('/experiment/set_run_number', json={'value': value}, headers=self.auth)

    def test_not_while_a_run_is_going(self):
        self.mgr.daq_state.update({'run': 40, 'running': True})
        self.assertEqual(self.post(2).status_code, 409)
        self.assertEqual(self.mgr.daq_state['run'], 40)

    def test_a_whole_number_only(self):
        self.mgr.daq_state.update({'run': 40, 'running': False})
        self.assertEqual(self.post('x').status_code, 400)
        self.assertEqual(self.post(-1).status_code, 400)
        self.assertEqual(self.post('41').status_code, 200)
        self.assertEqual(self.mgr.daq_state['run'], 41)
        self.assertIsInstance(self.mgr.daq_state['run'], int)


if __name__ == '__main__':
    unittest.main()
