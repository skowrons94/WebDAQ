"""
The beam-current recorder must not be able to stop a run, nor outlive one.

Both faults cost beam time on the DAQ:

  * a picoammeter that was connected but not sampling answered 4xx to
    /current/start, which the dashboard awaits BEFORE starting the acquisition,
    so the run never started and the operator saw only "Failed to start the run";
  * a run that saved nothing never called /current/stop, so the recorder kept
    the previous run's directory. When that directory was removed it logged one
    error per sample — 413 of them, ~1 MB/h — while recording nothing.
"""

import logging
import os
import shutil
import stat
import tempfile
import unittest
from unittest import mock

from app.utils.tetramm import TetrAMMController


class FileLoggingFailureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='webdaq-current-')
        self.c = TetrAMMController()
        self.c.run_start_time = 0.0
        self.c.values = {"0": [1.0], "1": [2.0], "2": [3.0], "3": [4.0]}
        self.c.save_data = True

    def tearDown(self):
        os.chmod(self.tmp, stat.S_IRWXU)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_a_directory_that_disappeared_is_recreated_once(self):
        gone = os.path.join(self.tmp, 'run932')
        self.c.save_folder = gone                      # never created
        with self.assertLogs('app.utils.tetramm', level='ERROR'):
            self.c._log_measurement_to_file(1.0, 4)
        self.assertTrue(os.path.isdir(gone), "the run directory should have been recreated")
        # Recovered: writing works again and nothing is latched off.
        self.c._log_measurement_to_file(2.0, 4)
        self.assertTrue(self.c.save_data)
        self.assertFalse(self.c._log_failed)
        with open(os.path.join(gone, 'current.txt')) as f:
            self.assertEqual(len(f.read().strip().splitlines()), 1)

    def test_an_unwritable_destination_switches_logging_off_instead_of_spamming(self):
        readonly = os.path.join(self.tmp, 'readonly')
        os.makedirs(readonly)
        os.chmod(readonly, stat.S_IRUSR | stat.S_IXUSR)   # no write permission
        self.c.save_folder = os.path.join(readonly, 'run932')

        with self.assertLogs('app.utils.tetramm', level='ERROR') as first:
            self.c._log_measurement_to_file(1.0, 4)
        self.assertFalse(self.c.save_data, "logging should be switched off, not retried forever")

        # Every later sample must stay silent: this is what filled the log.
        with mock.patch.object(logging.getLogger('app.utils.tetramm'), 'error') as err:
            for t in range(2, 60):
                self.c._log_measurement_to_file(float(t), 4)
            self.assertEqual(err.call_count, 0)
        self.assertGreaterEqual(len(first.output), 1)

    def test_pointing_the_recorder_somewhere_new_clears_the_latch(self):
        self.c._log_failed = True
        self.c.set_save_data(True, os.path.join(self.tmp, 'run933'))
        self.assertFalse(self.c._log_failed)
        self.c._log_measurement_to_file(1.0, 4)
        self.assertTrue(os.path.isfile(os.path.join(self.tmp, 'run933', 'current.txt')))


class RunStartIsNotBlockedTests(unittest.TestCase):
    """/current/start must never answer 4xx for a picoammeter problem."""

    class Controller:
        def __init__(self, acquiring):
            self.is_acquiring = acquiring
            self.saved = None
            self.initialised = 0
        def is_connected(self):            return True
        def reset_accumulated_charge(self): pass
        def set_save_data(self, on, folder): self.saved = (on, folder)
        def initialize(self):               self.initialised += 1

    def run_start(self, acquiring, save):
        from app.routes import current as current_routes
        ctrl = self.Controller(acquiring)
        with mock.patch.object(current_routes, 'controller', ctrl), \
             mock.patch.object(current_routes.daq_mgr, 'get_save_data', return_value=save):
            message, status = current_routes.start_run_recording(940)
        return message, status, ctrl

    def test_a_sampling_module_starts_the_recording(self):
        message, status, ctrl = self.run_start(acquiring=True, save=False)
        self.assertEqual(status, 200)
        self.assertEqual(ctrl.saved, (False, "./"))

    def test_a_module_that_is_not_sampling_does_not_fail_the_request(self):
        message, status, ctrl = self.run_start(acquiring=False, save=False)
        self.assertEqual(status, 200, "a 4xx here aborts the whole run start in the dashboard")
        self.assertIn('current', message.lower())
        self.assertEqual(ctrl.initialised, 1, "it should try to bring the module back first")


if __name__ == '__main__':
    unittest.main()
