"""
The board-failure alert must survive the dashboard polling board status.

The monitoring thread sends the Telegram alert (and triggers auto-restart) on a
board's OK -> failed transition. get_board_status, polled by the dashboard every
2 s, used to record that failure itself; when a poll landed before the thread's
next check, the thread saw no transition and no alert was ever sent.
"""

import unittest
from unittest import mock

from app.services.daq_manager import DAQManager


class FakeAcquisition:
    def __init__(self, health):
        self.health = health

    def is_running(self):
        return True

    def board_health(self):
        return self.health


class BoardFailureAlertTests(unittest.TestCase):
    def setUp(self):
        self.mgr = DAQManager.__new__(DAQManager)
        self.mgr.logger = mock.MagicMock()
        self.mgr.digitizer_container = mock.MagicMock()
        self.mgr.monitor_thread = None
        self.mgr.test_flag = True
        self.mgr.board_status = {'0': {'failed': False, 'last_value': 0}}
        self.mgr.daq_state = {'run': 42, 'boards': []}
        self.mgr.auto_restart_enabled = False
        self.mgr.restart_pending = False
        self.mgr.send_board_failure_notification = mock.MagicMock(return_value=True)

        self.acq = FakeAcquisition({'0': {'failed': True, 'failures': 3}})
        patcher = mock.patch('app.services.caen_acquisition.get_caen_acquisition',
                             return_value=self.acq)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _run_monitor_once(self):
        # One pass of the loop: not stopped on entry, stopped at the wait.
        self.mgr.monitor_stop_event = mock.MagicMock()
        self.mgr.monitor_stop_event.is_set.side_effect = [False, True]
        self.mgr.monitor_stop_event.wait.return_value = True
        self.mgr._monitor_boards_thread()

    def test_alert_sent_when_dashboard_polls_first(self):
        status = self.mgr.get_board_status()
        self.assertTrue(status['0']['failed'])   # the dashboard still sees it

        self._run_monitor_once()

        self.mgr.send_board_failure_notification.assert_called_once()
        self.assertEqual(self.mgr.send_board_failure_notification.call_args[0][0], '0')

    def test_alert_sent_once_per_failure(self):
        self._run_monitor_once()
        self.mgr.get_board_status()
        self._run_monitor_once()

        self.mgr.send_board_failure_notification.assert_called_once()

    def test_failure_stays_flagged_for_the_dashboard(self):
        self._run_monitor_once()
        self.acq.health = {'0': {'failed': False, 'failures': 0}}

        self.assertTrue(self.mgr.get_board_status()['0']['failed'])


if __name__ == '__main__':
    unittest.main()
