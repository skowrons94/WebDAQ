"""
Auto-restart after a board failure.

A run started from the browser is more than the acquisition: the browser also
points the beam-current recording and stats.csv at the run and fills in its
target and voltages. The auto-restart has no browser, and used to restart only
the acquisition, so the new run's current file, charge and stats.csv went on
landing in the failed run (its charge overwritten by the new run's), and the new
run had no target or voltages. These tests run the real restart against a fake
acquisition, current controller and stats collector, with a real database.
"""

import json
import os
import unittest
from unittest import mock

os.environ.setdefault('TEST_FLAG', 'True')

from app import create_app, db                     # noqa: E402
from app.models.run_metadata import RunMetadata    # noqa: E402
from app.routes import experiment, current as current_routes, stats as stats_routes  # noqa: E402
from app.services.daq_manager import DAQManager    # noqa: E402

OLD_RUN = 100
NEW_RUN = 101


class TestConfig:
    SECRET_KEY = 'test'
    JWT_SECRET_KEY = 'test'
    SQLALCHEMY_DATABASE_URI = 'sqlite://'
    SQLALCHEMY_TRACK_MODIFICATIONS = False


class FakeStats:
    def __init__(self, collecting=True):
        self.collecting = collecting
        self.started = []
        self.stops = 0

    def start_run(self, run_number):
        self.collecting = True
        self.started.append(run_number)
        return True

    def stop_run(self):
        self.collecting = False
        self.stops += 1
        return True


class AutoRestartTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = create_app(TestConfig)
        with cls.app.app_context():
            db.create_all()

    def setUp(self):
        self.daq_mgr = experiment.daq_mgr
        self.saved_state = json.loads(json.dumps(self.daq_mgr.daq_state))
        self.saved_app = self.daq_mgr.flask_app
        self.daq_mgr.flask_app = self.app
        self.daq_mgr.daq_state.update({'run': OLD_RUN, 'save': True, 'running': True})

        with self.app.app_context():
            RunMetadata.query.delete()
            db.session.add(RunMetadata(
                run_number=OLD_RUN, target_name='Ta2O5', terminal_voltage=400.0,
                probe_voltage=1.5, run_type='target', user_id=7))
            db.session.commit()

        # The picoammeter: the run's charge is 5 µC when the failed run stops.
        self.controller = mock.MagicMock()
        self.controller.is_connected.return_value = True
        self.controller.is_acquiring = True
        self.controller.get_accumulated_charge.return_value = 5.0

        self.caen = mock.MagicMock()
        self.caen.configure.return_value = True
        self.caen.start.return_value = True
        self.caen.board_info_all.return_value = []
        self.caen.software_versions.return_value = {}
        self.caen.sync_mode.return_value = 'independent'

        self.stats = FakeStats()

        patches = [
            mock.patch.object(current_routes, 'controller', self.controller),
            mock.patch.object(current_routes, 'running', True),
            mock.patch.object(current_routes, 'current_accumulating_run_number', OLD_RUN),
            mock.patch.object(stats_routes, 'stats_manager', self.stats),
            mock.patch.object(experiment, 'caen_acq', self.caen),
            mock.patch.object(experiment, 'spy_mgr', mock.MagicMock()),
            mock.patch.object(self.daq_mgr, 'stop_board_monitoring'),
            mock.patch.object(self.daq_mgr, 'start_board_monitoring'),
            mock.patch.object(self.daq_mgr, 'reacquire_digitizers', return_value={}),
            mock.patch.object(self.daq_mgr, 'release_digitizers'),
            mock.patch('time.sleep'),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self):
        self.daq_mgr.daq_state.clear()
        self.daq_mgr.daq_state.update(self.saved_state)
        self.daq_mgr._update_project()
        self.daq_mgr.flask_app = self.saved_app

    def run_meta(self, run_number):
        with self.app.app_context():
            row = RunMetadata.query.filter_by(run_number=run_number).first()
            if row is not None:
                db.session.expunge(row)
            return row

    def test_restart_starts_the_next_run(self):
        experiment.perform_auto_restart('0', 'Board FAIL flag (2 data blocks)')

        self.assertTrue(self.daq_mgr.is_running())
        self.assertEqual(self.daq_mgr.get_run_number(), NEW_RUN)
        self.caen.configure.assert_called_once()
        self.assertEqual(self.caen.configure.call_args[0][1], NEW_RUN)

    def test_current_recording_moves_to_the_new_run(self):
        experiment.perform_auto_restart('0', 'Board FAIL flag (2 data blocks)')

        # The failed run's log is closed (by the stop and by the run-state
        # listener; closing twice is harmless) and only the new run's is opened.
        calls = self.controller.set_save_data.call_args_list
        self.assertEqual(calls[-1], mock.call(True, f'./data/run{NEW_RUN}/'))
        self.assertTrue(calls[:-1])
        self.assertTrue(all(c == mock.call(False, './') for c in calls[:-1]))
        self.assertTrue(current_routes.is_recording_run())
        self.assertEqual(current_routes.current_accumulating_run_number, NEW_RUN)

    def test_each_run_keeps_its_own_charge(self):
        experiment.perform_auto_restart('0', 'Board FAIL flag (2 data blocks)')
        self.assertEqual(self.run_meta(OLD_RUN).accumulated_charge, 5.0)

        # The new run is later stopped with 7 µC.
        self.controller.get_accumulated_charge.return_value = 7.0
        with self.app.app_context():
            current_routes.stop_run_recording()

        self.assertEqual(self.run_meta(NEW_RUN).accumulated_charge, 7.0)
        self.assertEqual(self.run_meta(OLD_RUN).accumulated_charge, 5.0)

    def test_stats_move_to_the_new_run(self):
        experiment.perform_auto_restart('0', 'Board FAIL flag (2 data blocks)')

        self.assertEqual(self.stats.stops, 1)
        self.assertEqual(self.stats.started, [NEW_RUN])

    def test_new_run_continues_the_failed_runs_parameters(self):
        experiment.perform_auto_restart('0', 'Board FAIL flag (2 data blocks)')

        old, new = self.run_meta(OLD_RUN), self.run_meta(NEW_RUN)
        self.assertEqual(old.flag, 'bad')
        self.assertIsNotNone(old.end_time)
        self.assertIn('[AUTO-RESTART]', old.notes)
        self.assertEqual((new.target_name, new.terminal_voltage, new.probe_voltage, new.run_type),
                         ('Ta2O5', 400.0, 1.5, 'target'))
        self.assertEqual(new.user_id, 7)
        self.assertIn(f'in run {OLD_RUN}', new.notes)
        self.assertIsNone(new.end_time)

    def test_nothing_is_started_that_was_not_running(self):
        self.stats.collecting = False
        with mock.patch.object(current_routes, 'running', False):
            experiment.perform_auto_restart('0', 'Board FAIL flag (2 data blocks)')

        self.assertEqual(self.stats.started, [])
        # Closing the failed run's log is fine; opening one is not.
        for c in self.controller.set_save_data.call_args_list:
            self.assertEqual(c, mock.call(False, './'))

    def test_a_failed_restart_leaves_no_recording_open(self):
        self.caen.start.return_value = False

        experiment.perform_auto_restart('0', 'Board FAIL flag (2 data blocks)')

        self.assertFalse(self.daq_mgr.is_running())
        self.assertFalse(current_routes.is_recording_run())
        self.assertFalse(self.stats.collecting)
        self.assertEqual(self.controller.set_save_data.call_args_list[-1], mock.call(False, './'))


class AutoRestartSettingTests(unittest.TestCase):
    """The setting outlives a server restart."""

    def make_manager(self, state):
        mgr = DAQManager.__new__(DAQManager)
        mgr.logger = mock.MagicMock()
        mgr.daq_state = state
        mgr.digitizer_container = mock.MagicMock()
        mgr.monitor_thread = None
        mgr.monitor_stop_event = mock.MagicMock()
        mgr.board_status = {}
        mgr._update_project = mock.MagicMock()
        return mgr

    def test_setting_is_written_to_the_state(self):
        mgr = self.make_manager({})
        mgr.set_auto_restart_enabled(True)
        mgr.set_auto_restart_delay(45)

        self.assertEqual(mgr.daq_state['auto_restart_enabled'], True)
        self.assertEqual(mgr.daq_state['auto_restart_delay'], 45)
        mgr._update_project.assert_called()

    def test_setting_is_read_back_at_startup(self):
        state = {'running': False, 'run': 0, 'save': False, 'boards': [],
                 'auto_restart_enabled': True, 'auto_restart_delay': 45}
        with mock.patch.object(DAQManager, '_load_or_create_state', return_value=state), \
             mock.patch('app.services.daq_manager.DigitizerContainer'), \
             mock.patch('app.services.daq_manager.TelegramNotifier'), \
             mock.patch.object(DAQManager, '_repair_board_configs'), \
             mock.patch.object(DAQManager, '_update_project'):
            mgr = DAQManager(test_flag=True)

        self.assertTrue(mgr.get_auto_restart_enabled())
        self.assertEqual(mgr.get_auto_restart_delay(), 45)


class RestartPendingTests(unittest.TestCase):
    def setUp(self):
        self.mgr = AutoRestartSettingTests.make_manager(None, {'boards': []})
        self.mgr.telegram = mock.MagicMock()

    def test_new_run_monitoring_clears_the_pending_restart(self):
        self.mgr.restart_pending = True
        with mock.patch('app.services.daq_manager.threading.Thread'):
            self.mgr.start_board_monitoring()
        self.assertFalse(self.mgr.restart_pending)

    def test_finished_restart_does_not_clear_a_newer_pending_one(self):
        # The new run's board failed again while the first restart was finishing.
        def restart(board_id, failure_type):
            self.mgr.monitor_thread = mock.MagicMock()
            self.mgr.monitor_thread.is_alive.return_value = True
            self.mgr.restart_pending = True

        self.mgr.restart_callback = restart
        self.mgr._execute_restart_callback('0', 'Board FAIL flag (2 data blocks)')
        self.assertTrue(self.mgr.restart_pending)

    def test_restart_that_started_no_run_clears_the_flag(self):
        self.mgr.restart_pending = True
        self.mgr.restart_callback = lambda board_id, failure_type: None
        self.mgr._execute_restart_callback('0', 'Board FAIL flag (2 data blocks)')
        self.assertFalse(self.mgr.restart_pending)


if __name__ == '__main__':
    unittest.main()
