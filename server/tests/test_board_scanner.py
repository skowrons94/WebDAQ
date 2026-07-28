"""
Board discovery: firmware decoding, VME range limits, and the scan lifecycle.

The scan runs against hardware in production, so the parts worth testing are the
ones that decide *what* gets probed and how a scan is reported.
"""

import time
import unittest

from app.services.board_scanner import (
    BoardScanner,
    MAX_VME_PROBES,
    dpp_from_firmware,
    parse_vme_range,
)


class FirmwareDecodingTests(unittest.TestCase):
    def test_known_amc_codes_map_to_their_firmware(self):
        self.assertEqual(dpp_from_firmware('128.53'), 'DPP-PHA')   # x724
        self.assertEqual(dpp_from_firmware('136.20'), 'DPP-PSD')   # x730/x725
        self.assertEqual(dpp_from_firmware('139.4'), 'DPP-PHA')    # x730/x725

    def test_unknown_or_malformed_firmware_yields_no_suggestion(self):
        for value in ('4.25', '', 'not-a-firmware', None, '999.1'):
            self.assertIsNone(dpp_from_firmware(value))


class VmeRangeTests(unittest.TestCase):
    def test_typical_range_expands_to_one_address_per_switch_setting(self):
        addresses = parse_vme_range({'start': '32000000', 'end': '32FF0000', 'step': '10000'})
        self.assertEqual(len(addresses), 256)
        self.assertEqual(addresses[0], 0x32000000)
        self.assertEqual(addresses[-1], 0x32FF0000)

    def test_0x_prefix_is_accepted(self):
        addresses = parse_vme_range({'start': '0x32000000', 'end': '0x32010000', 'step': '0x10000'})
        self.assertEqual(addresses, [0x32000000, 0x32010000])

    def test_a_full_sweep_is_refused(self):
        with self.assertRaises(ValueError) as ctx:
            parse_vme_range({'start': '0', 'end': 'FFFF0000', 'step': '10000'})
        self.assertIn(str(MAX_VME_PROBES), str(ctx.exception))

    def test_step_below_switch_granularity_is_refused(self):
        # No board can sit between two multiples of 0x10000, so a finer step is
        # only a slower scan.
        with self.assertRaises(ValueError) as ctx:
            parse_vme_range({'start': '32000000', 'end': '32FF0000', 'step': '1000'})
        self.assertIn('0x10000', str(ctx.exception))

    def test_reversed_and_malformed_ranges_are_refused(self):
        with self.assertRaises(ValueError):
            parse_vme_range({'start': '32100000', 'end': '32000000', 'step': '10000'})
        with self.assertRaises(ValueError):
            parse_vme_range({'start': 'zz', 'end': '1', 'step': '10000'})
        with self.assertRaises(ValueError):
            parse_vme_range({'start': '0', 'end': '10000', 'step': '0'})


class ScanLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.scanner = BoardScanner(test_flag=True)

    def wait_for_scan(self, timeout=15.0):
        deadline = time.time() + timeout
        while self.scanner.is_running() and time.time() < deadline:
            time.sleep(0.05)
        self.assertFalse(self.scanner.is_running(), "scan did not finish in time")
        return self.scanner.get_status()

    def test_scan_reports_progress_and_finds_the_simulated_boards(self):
        self.scanner.start({'usb': {'enabled': True, 'links': 2},
                            'optical': {'enabled': True, 'links': 1, 'nodes': 4}}, [])
        status = self.wait_for_scan()

        self.assertEqual(status['status'], 'done')
        self.assertEqual(status['progress']['done'], status['progress']['total'])
        models = sorted(board['model'] for board in status['found'])
        self.assertEqual(models, ['DT5724', 'V1730'])

    def test_a_found_board_carries_what_the_add_form_needs(self):
        self.scanner.start({'usb': {'enabled': True, 'links': 1}}, [])
        board = self.wait_for_scan()['found'][0]

        for field in ('model', 'serial', 'channels', 'dpp', 'link_type',
                      'link_num', 'id', 'vme', 'already_configured'):
            self.assertIn(field, board)
        # The VME address goes back to add_board, which parses it as hex.
        self.assertEqual(int(board['vme'], 16), 0)
        self.assertEqual(board['dpp'], 'DPP-PHA')          # DT5724, AMC 128
        self.assertFalse(board['already_configured'])

    def test_configured_boards_are_reported_not_probed(self):
        configured = [{'id': 0, 'vme': '0', 'link_type': 'USB', 'link_num': '0',
                       'name': 'DT5724', 'dpp': 'DPP-PHA', 'chan': 4}]
        self.scanner.start({'usb': {'enabled': True, 'links': 1}}, configured)
        found = self.wait_for_scan()['found']

        self.assertEqual(len(found), 1)
        self.assertTrue(found[0]['already_configured'])
        self.assertEqual(found[0]['model'], 'DT5724')

    def test_a_second_scan_is_refused_while_one_runs(self):
        self.scanner.start({'optical': {'enabled': True, 'links': 4, 'nodes': 8}}, [])
        with self.assertRaises(RuntimeError):
            self.scanner.start({'usb': {'enabled': True, 'links': 1}}, [])
        self.scanner.cancel()
        self.wait_for_scan()

    def test_cancel_stops_the_scan_early(self):
        self.scanner.start({'optical': {'enabled': True, 'links': 4, 'nodes': 8}}, [])
        self.assertTrue(self.scanner.cancel())
        status = self.wait_for_scan()

        self.assertEqual(status['status'], 'cancelled')
        self.assertLess(status['progress']['done'], status['progress']['total'])

    def test_cancel_without_a_scan_reports_nothing_to_cancel(self):
        self.assertFalse(self.scanner.cancel())

    def test_empty_options_are_refused(self):
        with self.assertRaises(ValueError):
            self.scanner.start({}, [])
        with self.assertRaises(ValueError):
            self.scanner.start({'usb': {'enabled': False}}, [])

    def test_unknown_vme_link_type_is_refused(self):
        with self.assertRaises(ValueError):
            self.scanner.start({'vme': {'enabled': True, 'link_type': 'Nope',
                                        'start': '0', 'end': '0', 'step': '10000'}}, [])


if __name__ == '__main__':
    unittest.main()
