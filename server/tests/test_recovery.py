"""
Recovery actions: the fix offered next to the problem.

Two things matter here. Each action has to refuse when running it would cost data
— reopening the boards mid-run would end the run — and each has to say in words
what happened, because that text is what the operator reads at 3 a.m.
"""

import os
import shutil
import tempfile
import unittest
from unittest import mock

from app.services import recovery


class RecoveryTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='webdaq-recovery-')
        self.cwd = os.getcwd()
        os.chdir(self.tmp)

        self.daq = mock.MagicMock()
        self.daq.is_running.return_value = False
        self.daq.get_save_data.return_value = True
        self.daq.get_run_number.return_value = 12
        self.daq.get_boards.return_value = [{'id': '0'}, {'id': '1'}]
        self.daq.refresh_board_connection.return_value = True
        self.daq.reset_acquisition.return_value = True
        self.daq.check_board_connectivity.return_value = {
            '0': {'connected': True, 'ready': True, 'failed': False},
            '1': {'connected': True, 'ready': True, 'failed': False},
        }

        self.controller = mock.MagicMock()
        self.controller.is_connected.return_value = True
        self.current_module = mock.MagicMock()
        self.current_module.controller = self.controller

        self.stats = mock.MagicMock()
        # No run is active in the baseline, so nothing should be collecting: the
        # two together are a fault (rows going into a finished run's file).
        self.stats.collecting = False
        self.stats.current_run_number = 12
        self.stats.start_run.return_value = True
        self.stats.graphite_client.check_connection.return_value = True
        self.stats.graphite_client.host = 'lunaserver'
        self.stats.graphite_client.port = 80

        for target, value in (('_daq', self.daq), ('_current_module', self.current_module),
                              ('_stats_manager', self.stats)):
            patcher = mock.patch.object(recovery, target, return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)

        # A live current reading unless a test says otherwise.
        patcher = mock.patch('app.services.alerting._live_beam_current', return_value=12.0)
        patcher.start()
        self.addCleanup(patcher.stop)

        from app.services import alert_log as module
        module._log = None
        self.log = module.get_alert_log()
        self.addCleanup(setattr, module, '_log', None)

    def tearDown(self):
        os.chdir(self.cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def action(self, name):
        return next(a for a in recovery.actions() if a['name'] == name)


class WhatIsOfferedTests(RecoveryTestCase):
    def test_every_action_is_described_for_the_operator(self):
        for action in recovery.actions():
            self.assertTrue(action['label'])
            self.assertTrue(action['description'])
            self.assertIn('ok', action)
            self.assertIn('detail', action)

    def test_a_healthy_system_reports_every_subsystem_ok(self):
        for action in recovery.actions():
            self.assertTrue(action['ok'], f"{action['name']}: {action['detail']}")

    def test_a_disconnected_board_is_named(self):
        self.daq.check_board_connectivity.return_value = {
            '0': {'connected': True, 'failed': False},
            '1': {'connected': False, 'failed': False},
        }
        boards = self.action('boards')
        self.assertFalse(boards['ok'])
        self.assertIn('1', boards['detail'])

    def test_a_current_monitor_that_stopped_reading_is_not_called_healthy(self):
        with mock.patch('app.services.alerting._live_beam_current', return_value=None):
            current = self.action('current')
        self.assertFalse(current['ok'])
        self.assertIn('no recent reading', current['detail'])

    def test_stats_missing_during_a_saving_run_is_a_problem(self):
        self.daq.is_running.return_value = True
        stats = self.action('stats')
        self.assertFalse(stats['ok'])
        self.assertIn('no stats.csv', stats['detail'])

    def test_statistics_collected_without_a_run_is_a_problem(self):
        # The rows are going into a finished run's file.
        self.stats.collecting = True
        stats = self.action('stats')
        self.assertFalse(stats['ok'])
        self.assertIn('although no run is active', stats['detail'])

    def test_an_unreachable_graphite_server_is_reported(self):
        self.stats.graphite_client.check_connection.return_value = False
        graphite = self.action('graphite')
        self.assertFalse(graphite['ok'])
        self.assertIn('not answering', graphite['detail'])

    def test_board_actions_are_blocked_during_a_run_and_say_why(self):
        self.daq.is_running.return_value = True

        self.assertFalse(self.action('boards')['enabled'])
        self.assertIn('run is in progress', self.action('boards')['blocked_reason'])
        # Things that are safe mid-run stay available.
        self.assertTrue(self.action('current')['enabled'])
        self.assertTrue(self.action('stats')['enabled'])


class RunningThemTests(RecoveryTestCase):
    def test_reopening_the_boards_reports_how_many_came_back(self):
        result = recovery.run_action('boards')

        self.assertTrue(result['success'])
        self.assertIn('2 board', result['message'])
        self.assertEqual(self.daq.refresh_board_connection.call_count, 2)

    def test_a_board_that_stays_shut_is_named_and_not_called_a_success(self):
        self.daq.refresh_board_connection.side_effect = lambda bid: bid != '1'

        result = recovery.run_action('boards')

        self.assertFalse(result['success'])
        self.assertIn('1', result['message'])

    def test_reopening_the_boards_is_refused_during_a_run(self):
        self.daq.is_running.return_value = True

        result = recovery.run_action('boards')

        self.assertFalse(result['success'])
        self.assertIn('not available while a run', result['message'])
        self.daq.refresh_board_connection.assert_not_called()

    def test_resetting_the_acquisition_reports_the_outcome(self):
        self.assertTrue(recovery.run_action('acquisition')['success'])

        self.daq.reset_acquisition.return_value = False
        self.assertFalse(recovery.run_action('acquisition')['success'])

    def test_reconnecting_the_current_monitor(self):
        self.assertTrue(recovery.run_action('current')['success'])
        self.controller.initialize.assert_called()

        self.controller.is_connected.return_value = False
        self.assertFalse(recovery.run_action('current')['success'])

    def test_a_monitor_that_raises_is_reported_not_propagated(self):
        self.controller.initialize.side_effect = OSError('socket timed out')

        result = recovery.run_action('current')

        self.assertFalse(result['success'])
        self.assertIn('socket timed out', result['message'])

    def test_restarting_the_statistics_needs_a_run(self):
        result = recovery.run_action('stats')
        self.assertFalse(result['success'])
        self.assertIn('no run is active', result['message'])

        self.daq.is_running.return_value = True
        self.stats.collecting = True          # it was collecting; a restart stops it
        result = recovery.run_action('stats')
        self.assertTrue(result['success'])
        self.stats.stop_run.assert_called_once()
        self.stats.start_run.assert_called_once_with(12)

    def test_restarting_the_statistics_keeps_what_was_already_collected(self):
        # start_run opens stats.csv for writing, so a restart would otherwise
        # erase the rows the run had already recorded.
        self.daq.is_running.return_value = True
        os.makedirs(os.path.join('data', 'run12'), exist_ok=True)
        path = os.path.join('data', 'run12', 'stats.csv')
        with open(path, 'w') as f:
            f.write('# LUNA DAQ statistics\n1,2,3\n')

        result = recovery.run_action('stats')

        self.assertTrue(result['success'])
        self.assertIn('stats.csv.part1', result['message'])
        with open(path + '.part1') as f:
            self.assertIn('1,2,3', f.read())

    def test_statistics_are_never_truncated_when_they_cannot_be_kept(self):
        # If the earlier rows cannot be moved aside, refuse: start_run would open
        # stats.csv for writing and the run's accelerator record would be gone.
        self.daq.is_running.return_value = True
        run_dir = os.path.join('data', 'run12')
        os.makedirs(run_dir, exist_ok=True)
        path = os.path.join(run_dir, 'stats.csv')
        with open(path, 'w') as f:
            f.write('# LUNA DAQ statistics\n1,2,3\n')

        with mock.patch('os.replace', side_effect=OSError('read-only directory')):
            result = recovery.run_action('stats')

        self.assertFalse(result['success'])
        self.assertIn('left alone rather than overwritten', result['message'])
        self.stats.start_run.assert_not_called()
        with open(path) as f:
            self.assertIn('1,2,3', f.read())

    def test_a_second_restart_keeps_both_earlier_pieces(self):
        self.daq.is_running.return_value = True
        os.makedirs(os.path.join('data', 'run12'), exist_ok=True)
        path = os.path.join('data', 'run12', 'stats.csv')
        for expected in ('part1', 'part2'):
            with open(path, 'w') as f:
                f.write(expected)
            result = recovery.run_action('stats')
            self.assertIn(expected, result['message'])
        self.assertTrue(os.path.exists(path + '.part1'))
        self.assertTrue(os.path.exists(path + '.part2'))

    def test_rechecking_graphite_clears_the_breaker_first(self):
        result = recovery.run_action('graphite')

        self.assertTrue(result['success'])
        self.stats.graphite_client.reset_breaker.assert_called_once()

    def test_an_unknown_action_is_refused(self):
        result = recovery.run_action('make-coffee')
        self.assertFalse(result['success'])
        self.assertIn('Unknown recovery action', result['message'])

    def test_what_was_done_lands_in_the_history(self):
        recovery.run_action('acquisition')
        self.daq.reset_acquisition.return_value = False
        recovery.run_action('acquisition')

        events = self.log.list_events()
        self.assertEqual(events[1]['kind'], 'recovery')      # the one that worked
        self.assertIn('done', events[1]['title'])
        self.assertEqual(events[0]['kind'], 'alert')         # the one that did not
        self.assertIn('failed', events[0]['title'])


if __name__ == '__main__':
    unittest.main()
