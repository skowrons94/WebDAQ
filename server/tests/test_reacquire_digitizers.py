"""
Getting the boards back after a run.

start_run hands the digitizers to caendaq; stop_run has to take them back. The
first reopen right after a run routinely fails — caendaq closed the boards
microseconds earlier and a CAEN link is not always ready that fast — and a
single transient failure used to leave every board reading "Disconnected" on
the dashboard for the rest of the session, because nothing else reopens them.
"""

import unittest
from unittest import mock

from app.services.daq_manager import DAQManager


class FakeDigitizer:
    """A probe connection that refuses to open until the Nth attempt."""

    def __init__(self, open_succeeds_on=1, raises=True):
        self.open_succeeds_on = open_succeeds_on
        self.raises = raises
        self.attempts = 0
        self._connected = False

    def open(self):
        self.attempts += 1
        if self.attempts >= self.open_succeeds_on:
            self._connected = True
            return
        if self.raises:
            raise RuntimeError("CAEN_DGTZ_CommError")
        # else: return without connecting — a silent failure

    def close(self):
        self._connected = False

    def get_connected(self):
        return self._connected


class ReacquireTests(unittest.TestCase):
    def setUp(self):
        # A manager whose only real collaborator is the digitizer container,
        # which the tests below replace board by board. The rest is what
        # __del__ -> cleanup() touches, so a discarded instance stays quiet.
        self.mgr = DAQManager.__new__(DAQManager)
        self.mgr.logger = mock.MagicMock()
        self.mgr.digitizer_container = mock.MagicMock()
        self.mgr.monitor_thread = None
        self.mgr.monitor_stop_event = mock.MagicMock()
        self.mgr.board_status = {}

    def _install(self, boards):
        """boards: {board_id: FakeDigitizer}"""
        self.mgr.digitizer_container.get_all_board_ids.return_value = list(boards)
        self.mgr.digitizer_container.get_digitizer.side_effect = boards.get
        self.mgr.digitizer_container.get_connection_lock.side_effect = lambda b: None
        self.mgr.digitizer_container.is_connected.side_effect = (
            lambda b: boards[b].get_connected())

    def test_a_board_that_opens_first_time_is_not_retried(self):
        boards = {'0': FakeDigitizer(open_succeeds_on=1)}
        self._install(boards)
        result = self.mgr.reacquire_digitizers(attempts=3, delay=0)
        self.assertEqual(result, {'0': True})
        self.assertEqual(boards['0'].attempts, 1)

    def test_a_transient_failure_is_retried_until_the_board_comes_back(self):
        boards = {'0': FakeDigitizer(open_succeeds_on=3)}
        self._install(boards)
        result = self.mgr.reacquire_digitizers(attempts=3, delay=0)
        self.assertEqual(result, {'0': True})
        self.assertEqual(boards['0'].attempts, 3)

    def test_a_board_that_never_opens_is_reported_not_raised(self):
        boards = {'0': FakeDigitizer(open_succeeds_on=99)}
        self._install(boards)
        result = self.mgr.reacquire_digitizers(attempts=3, delay=0)
        self.assertEqual(result, {'0': False})
        self.assertEqual(boards['0'].attempts, 3)
        self.mgr.logger.warning.assert_called()

    def test_a_silent_failure_is_retried_too(self):
        # open() returning without connecting is as much a failure as raising.
        boards = {'0': FakeDigitizer(open_succeeds_on=2, raises=False)}
        self._install(boards)
        result = self.mgr.reacquire_digitizers(attempts=3, delay=0)
        self.assertEqual(result, {'0': True})
        self.assertEqual(boards['0'].attempts, 2)

    def test_one_stuck_board_does_not_stop_the_others_coming_back(self):
        boards = {
            '0': FakeDigitizer(open_succeeds_on=1),
            '1': FakeDigitizer(open_succeeds_on=99),
            '2': FakeDigitizer(open_succeeds_on=2),
        }
        self._install(boards)
        result = self.mgr.reacquire_digitizers(attempts=3, delay=0)
        self.assertEqual(result, {'0': True, '1': False, '2': True})

    def test_a_board_with_no_probe_connection_is_skipped(self):
        self.mgr.digitizer_container.get_all_board_ids.return_value = ['0']
        self.mgr.digitizer_container.get_digitizer.return_value = None
        self.mgr.digitizer_container.get_connection_lock.return_value = None
        self.assertEqual(self.mgr.reacquire_digitizers(attempts=3, delay=0), {})

    def test_an_already_open_board_is_left_alone(self):
        board = FakeDigitizer(open_succeeds_on=1)
        board._connected = True
        self._install({'0': board})
        result = self.mgr.reacquire_digitizers(attempts=3, delay=0)
        self.assertEqual(result, {'0': True})
        self.assertEqual(board.attempts, 0)   # never reopened


if __name__ == '__main__':
    unittest.main()
