"""
The readout counters behind the Board Health page.

caendaq keeps a handful of counters per board for the run — buffers and bytes
read, bytes written, blocks the write queue refused, CAEN read errors, decoded
events, FAIL aggregates. The module is versioned separately from the server, so a
build without one of them must cost that one counter, not the whole page.
"""

import unittest
from unittest import mock

from app.services.caen_acquisition import CaenAcquisition

COUNTERS = ('buffers_read', 'bytes_read', 'bytes_written', 'blocks_dropped',
            'comm_errors', 'events_decoded', 'board_failures')


class FakeDaq:
    """A caendaq DAQ exposing `counters` only, with one value per board index."""

    def __init__(self, values, counters=COUNTERS):
        self.values = values
        for name in counters:
            setattr(self, name, self._reader(name))

    def _reader(self, name):
        def read(index):
            value = self.values[index][name]
            if isinstance(value, Exception):
                raise value
            return value
        return read


def acquisition(daq, running=True, boards=(('0',), ('1',))):
    acq = CaenAcquisition.__new__(CaenAcquisition)
    acq.logger = mock.MagicMock()
    acq.daq = daq
    acq._running = running
    acq._boards = [{'id': b[0], 'name': 'V1730'} for b in boards]
    acq._caendaq = mock.MagicMock()
    return acq


class BoardDiagnosticsTests(unittest.TestCase):
    def values(self, **overrides):
        base = {name: 10 for name in COUNTERS}
        base['board_failures'] = 0
        base.update(overrides)
        return base

    def test_every_counter_is_reported_per_board(self):
        acq = acquisition(FakeDaq([self.values(buffers_read=1000),
                                   self.values(buffers_read=2000)]))

        diag = acq.board_diagnostics()

        self.assertEqual(sorted(diag), ['0', '1'])
        self.assertEqual(diag['0']['buffers_read'], 1000)
        self.assertEqual(diag['1']['buffers_read'], 2000)
        for name in COUNTERS:
            self.assertIn(name, diag['0'])

    def test_a_board_with_fail_aggregates_is_flagged(self):
        acq = acquisition(FakeDaq([self.values(), self.values(board_failures=3)]))

        diag = acq.board_diagnostics()

        self.assertFalse(diag['0']['failed'])
        self.assertTrue(diag['1']['failed'])
        self.assertEqual(diag['1']['board_failures'], 3)

    def test_nothing_is_reported_between_runs(self):
        acq = acquisition(FakeDaq([self.values()]), running=False)
        self.assertEqual(acq.board_diagnostics(), {})

        acq = acquisition(None)
        self.assertEqual(acq.board_diagnostics(), {})

    def test_a_counter_missing_from_the_installed_build_reads_none(self):
        # An older caendaq without blocks_dropped: the rest still arrives.
        daq = FakeDaq([self.values()], counters=[c for c in COUNTERS if c != 'blocks_dropped'])
        diag = acquisition(daq, boards=(('0',),)).board_diagnostics()

        self.assertIsNone(diag['0']['blocks_dropped'])
        self.assertEqual(diag['0']['buffers_read'], 10)

    def test_a_counter_that_raises_does_not_lose_the_others(self):
        daq = FakeDaq([self.values(comm_errors=RuntimeError('CAEN_DGTZ_CommError'))])
        diag = acquisition(daq, boards=(('0',),)).board_diagnostics()

        self.assertIsNone(diag['0']['comm_errors'])
        self.assertEqual(diag['0']['bytes_read'], 10)

    def test_fail_meaning_comes_from_the_module(self):
        acq = acquisition(FakeDaq([self.values()]), boards=(('0',),))
        acq._caendaq.board_fail_meaning.return_value = 'the digitizer set the FAIL bit'
        self.assertIn('FAIL bit', acq.board_fail_meaning())

        acq._caendaq.board_fail_meaning.side_effect = AttributeError
        self.assertEqual(acq.board_fail_meaning(), '')


if __name__ == '__main__':
    unittest.main()
