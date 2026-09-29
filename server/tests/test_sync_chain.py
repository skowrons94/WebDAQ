"""
The daisy chain's checks, against how caendaq actually starts a synchronised run.

The master is started by its own software trigger, so it needs that trigger on
TRG-OUT — and it does NOT need TRG-IN -> TRG-OUT, because no trigger arrives on its
TRG-IN. Demanding it there sent operators looking for a cable fault that does not
exist, and the last board in the chain was told to drive a TRG-OUT that goes
nowhere.
"""

import unittest
from unittest import mock

from app.services import caen_acquisition as acq
from app.services.sync_chain import chain_status

SW = acq.START_MODE_SW
FIRST_TRIG = acq.START_MODE_FIRST_TRIG
SIN = acq.START_MODE_SIN_GPI


def board(board_id, start_mode=FIRST_TRIG, clock_external=False, trg_out_mode=0,
          sw_to_out=True, ext_to_out=True):
    """A board whose registers say what the arguments say."""
    return {
        'id': str(board_id), 'name': 'V1730',
        'reg_8100': start_mode | (0x40 if clock_external else 0),
        'reg_811C': trg_out_mode << 16,
        'reg_8110': (0x80000000 if sw_to_out else 0) | (0x40000000 if ext_to_out else 0),
    }


class ChainTestCase(unittest.TestCase):
    """Register reads are answered from the board dicts above."""

    def setUp(self):
        patcher = mock.patch.object(
            acq, '_read_register',
            side_effect=lambda b, key: b.get(key, 0))
        patcher.start()
        self.addCleanup(patcher.stop)

    def status(self, *boards):
        return chain_status(list(boards))

    def problems(self, status, board_id):
        entry = next(e for e in status['chain'] if e['board_id'] == str(board_id))
        return entry['problems']


class IndependentBoardTests(ChainTestCase):
    def test_boards_started_by_software_are_independent(self):
        status = self.status(board(0, start_mode=SW), board(1, start_mode=SW))

        self.assertEqual(status['mode'], 'independent')
        self.assertEqual(status['synchronised_count'], 0)
        self.assertIsNone(status['master_board_id'])
        self.assertEqual([e['role'] for e in status['chain']],
                         ['independent', 'independent'])

    def test_an_independent_board_is_never_asked_about_cables(self):
        status = self.status(board(0), board(1, start_mode=SW, trg_out_mode=2,
                                             sw_to_out=False, ext_to_out=False))
        self.assertEqual(self.problems(status, 1), [])


class MasterTests(ChainTestCase):
    def test_the_master_does_not_need_trg_in_to_trg_out(self):
        # The regression: its start is its own software trigger, not an incoming one.
        status = self.status(board(0, ext_to_out=False), board(1))

        self.assertEqual(status['master_board_id'], '0')
        self.assertEqual(self.problems(status, 0), [])
        self.assertFalse(status['chain'][0]['needs']['ext_trigger_to_trg_out'])

    def test_the_master_needs_its_software_trigger_on_the_cable(self):
        status = self.status(board(0, sw_to_out=False), board(1))

        self.assertEqual(len(self.problems(status, 0)), 1)
        self.assertIn('software trigger is not routed', self.problems(status, 0)[0])

    def test_a_master_that_cannot_start_on_a_trigger_is_reported(self):
        # Armed on S-IN, it waits for a level the software trigger never provides.
        status = self.status(board(0, start_mode=SIN), board(1))

        self.assertTrue(any('will not start this board' in p
                            for p in self.problems(status, 0)))

    def test_board_zero_is_the_master_whatever_the_order(self):
        status = self.status(board(3), board(0), board(1))
        self.assertEqual(status['master_board_id'], '0')
        roles = {e['board_id']: e['role'] for e in status['chain']}
        self.assertEqual(roles, {'3': 'slave', '0': 'master', '1': 'slave'})

    def test_without_board_zero_the_first_synchronised_board_leads(self):
        status = self.status(board(2, start_mode=SW), board(5), board(7))
        self.assertEqual(status['master_board_id'], '5')

    def test_a_lone_synchronised_board_needs_no_cable_at_all(self):
        status = self.status(board(0, sw_to_out=False, ext_to_out=False,
                                   trg_out_mode=3), board(1, start_mode=SW))

        self.assertEqual(status['mode'], 'daisy-chain')
        self.assertEqual(self.problems(status, 0), [])


class SlaveTests(ChainTestCase):
    def test_a_board_in_the_middle_has_to_pass_the_trigger_on(self):
        status = self.status(board(0), board(1, ext_to_out=False), board(2))

        self.assertEqual(len(self.problems(status, 1)), 1)
        self.assertIn('boards after this one will not start', self.problems(status, 1)[0])
        self.assertEqual(self.problems(status, 2), [])

    def test_the_last_board_is_not_asked_to_drive_anything(self):
        status = self.status(board(0), board(1, ext_to_out=False, sw_to_out=False,
                                            trg_out_mode=3))

        self.assertEqual(self.problems(status, 1), [])
        self.assertFalse(status['chain'][1]['needs']['trg_out_trigger'])

    def test_trg_out_carrying_the_wrong_thing_stops_the_chain(self):
        status = self.status(board(0, trg_out_mode=2), board(1), board(2))

        self.assertTrue(any('TRG-OUT is not set to carry the trigger' in p
                            for p in self.problems(status, 0)))

    def test_a_correctly_cabled_chain_reports_nothing(self):
        status = self.status(board(0), board(1), board(2))

        for board_id in (0, 1, 2):
            self.assertEqual(self.problems(status, board_id), [])
        self.assertEqual(status['synchronised_count'], 3)
        self.assertEqual([e['chain_position'] for e in status['chain']], [0, 1, 2])


class ReportedFieldsTests(ChainTestCase):
    def test_the_panel_gets_the_register_values_it_edits(self):
        status = self.status(board(0, clock_external=True), board(1))
        entry = status['chain'][0]

        self.assertEqual(entry['start_mode'], FIRST_TRIG)
        self.assertEqual(entry['start_mode_name'], 'First trigger controlled')
        self.assertEqual(entry['clock_source'], 1)
        self.assertEqual(entry['trg_out_mode'], 0)
        self.assertEqual(entry['sw_trigger_to_trg_out'], 1)
        self.assertEqual(entry['ext_trigger_to_trg_out'], 1)
        self.assertEqual(status['register'], 'reg_8100')

    def test_a_single_board_leaves_synchronisation_inapplicable(self):
        self.assertFalse(self.status(board(0))['applicable'])
        self.assertTrue(self.status(board(0), board(1))['applicable'])


if __name__ == '__main__':
    unittest.main()
