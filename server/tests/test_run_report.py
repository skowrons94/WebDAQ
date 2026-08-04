"""
Drafting an ELOG entry from a finished run.

The draft is written by a machine and read by a physicist, so the risks are
misreported numbers and confidently wrong attributes. These tests pin down the
formatting and, more importantly, the refusal to guess: a field the run cannot
answer must be left for the operator rather than filled with something plausible.
"""

import json
import os
import shutil
import tempfile
import unittest

from app.services import run_report


def field(label, name=None, kind='text', options=(), required=False):
    return {'name': name or label, 'label': label, 'type': kind,
            'options': list(options), 'required': required,
            'conditional': False, 'value': ''}


class NumberFormattingTests(unittest.TestCase):
    def test_trailing_zeros_are_only_dropped_after_a_decimal_point(self):
        # 120 counts must not be reported as 12.
        self.assertEqual(run_report._number(120.0, 0), '120')
        self.assertEqual(run_report._number(1669.0, 0), '1669')

    def test_a_readable_value_keeps_its_digits(self):
        self.assertEqual(run_report._number(0.12425, 3), '0.124')
        self.assertEqual(run_report._number(9738.69, 1), '9738.7')

    def test_very_small_values_use_exponents(self):
        self.assertEqual(run_report._number(1.255e-05), '1.255e-05')

    def test_zero_and_missing_are_distinguishable(self):
        self.assertEqual(run_report._number(0.0), '0')
        self.assertEqual(run_report._number(None), '-')

    def test_durations_read_as_time(self):
        self.assertEqual(run_report._duration(9739), '2h 42m 19s')
        self.assertEqual(run_report._duration(75), '1m 15s')
        self.assertEqual(run_report._duration(None), '-')


class OptionMatchingTests(unittest.TestCase):
    """
    A category pre-filled wrongly is worse than one left blank: the operator
    reads a plausible value and posts it. Matching is therefore all-words.
    """

    def test_an_exact_option_is_chosen(self):
        options = ['Measurement Beam ON', 'Measurement Beam OFF', 'Setup']
        self.assertEqual(
            run_report._pick_option(options, 'measurement beam off'),
            'Measurement Beam OFF')

    def test_an_unrelated_category_list_is_left_alone(self):
        # These are subject areas, not beam states — nothing here means "beam off".
        options = ['Beam line', 'Target', 'Detectors', 'NRA measurements']
        self.assertIsNone(run_report._pick_option(options, 'measurement beam off'))

    def test_a_later_keyword_is_tried_when_the_first_misses(self):
        options = ['Setup', 'Background', 'Measurement']
        self.assertEqual(run_report._pick_option(options, 'no such thing', 'background'),
                         'Background')

    def test_a_field_with_no_options_never_matches(self):
        self.assertIsNone(run_report._pick_option([], 'anything'))


class ChargeUnitTests(unittest.TestCase):
    """The stored charge is in microcoulombs; the field's label names the unit."""

    def test_coulombs(self):
        self.assertEqual(run_report._charge_in('Charge (C)', 1_000_000.0), '1')

    def test_nanocoulombs(self):
        self.assertEqual(run_report._charge_in('Charge (nC)', 2.0), '2000')

    def test_microcoulombs_are_the_default(self):
        self.assertEqual(run_report._charge_in('Charge (uC)', 0.124251), '0.124')
        self.assertEqual(run_report._charge_in('Charge', 0.124251), '0.124')

    def test_a_counts_field_is_not_a_charge_we_can_supply(self):
        # 'Charge (cts)' counts integrator pulses — microcoulombs would be a lie.
        self.assertIsNone(run_report._charge_in('Charge (cts)', 0.124251))

    def test_no_charge_recorded(self):
        self.assertIsNone(run_report._charge_in('Charge (C)', None))


class OnDiskReaderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='webdaq-report-')
        self.cwd = os.getcwd()
        os.chdir(self.tmp)
        os.makedirs(os.path.join('data', 'run42'))

    def tearDown(self):
        os.chdir(self.cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, name, content):
        with open(os.path.join('data', 'run42', name), 'w') as f:
            f.write(content)

    def test_stats_are_summarised_per_metric(self):
        self.write('stats.csv',
                   '# LUNA DAQ statistics\n'
                   '# Run number: 42\n'
                   'Time [s],Terminal Voltage (V),Extraction Voltage (V)\n'
                   '0.0,100,5\n'
                   '1.0,200,5\n')
        stats = run_report.read_stats(42)
        self.assertTrue(stats['available'])
        self.assertEqual(stats['n_samples'], 2)
        terminal = stats['metrics'][0]
        self.assertEqual(terminal['name'], 'Terminal Voltage (V)')
        self.assertEqual((terminal['min'], terminal['mean'], terminal['max']), (100, 150, 200))

    def test_a_channel_stuck_at_zero_is_reported_as_never_read(self):
        # Flat zero means the reading never arrived, which is a different
        # statement from "the voltage was zero".
        self.write('stats.csv',
                   '# header\n'
                   'Time [s],Terminal Voltage (V)\n'
                   '0.0,0\n1.0,0\n')
        self.assertFalse(run_report.read_stats(42)['metrics'][0]['recorded'])

    def test_missing_stats_are_not_an_error(self):
        self.assertFalse(run_report.read_stats(42)['available'])
        self.assertFalse(run_report.read_rois(42)['available'])
        self.assertEqual(run_report.read_run_metadata_file(42), {})

    def test_rois_are_flattened_with_their_detector(self):
        self.write('roi.json', json.dumps({
            'run_number': 42, 'rebin_factor': 1,
            'histograms': [{
                'label': 'GePD 2', 'boardId': '0', 'channel': 0,
                'rois': [
                    {'name': 'Cs137', 'low': 655.0, 'high': 665.0,
                     'gross': 160.0, 'net': 160.0, 'enabled': True},
                    {'name': 'disabled one', 'low': 1.0, 'high': 2.0, 'enabled': False},
                ],
            }],
        }))
        rois = run_report.read_rois(42)
        self.assertEqual(len(rois['regions']), 1)
        self.assertEqual(rois['regions'][0]['detector'], 'GePD 2')
        self.assertEqual(rois['regions'][0]['name'], 'Cs137')

    def test_a_corrupt_file_is_skipped_rather_than_raising(self):
        self.write('roi.json', 'not json at all')
        self.assertFalse(run_report.read_rois(42)['available'])


class AttributeMappingTests(unittest.TestCase):
    """
    Mapping is by keyword because every LUNA logbook names its fields
    differently; only fields the logbook actually has may be filled.
    """

    class Run:
        run_number = 42
        run_type = 'background'
        target_name = 'DAQ Test'
        terminal_voltage = 0.0
        probe_voltage = 0.0
        accumulated_charge = 0.124251
        notes = None
        flag = 'unknown'
        start_time = None
        end_time = None
        sync_mode = 'daisy-chain'

        def get_board_info(self):
            return []

        def get_software_versions(self):
            return {}

    def facts(self):
        return {'run_number': 42, 'duration_s': 9738.69, 'current': {}, 'stats': {},
                'rois': {}, 'files': {}, 'snapshot': {}}

    def map(self, fields):
        return run_report._map_attributes(self.Run(), self.facts(), fields)

    def test_only_fields_the_logbook_offers_are_filled(self):
        mapped = self.map([field('Subject'), field('Run name', 'Run_name')])
        self.assertEqual(set(mapped), {'Subject', 'Run name'})
        self.assertEqual(mapped['Run name'], '42')

    def test_nothing_is_produced_for_a_logbook_with_no_fields(self):
        self.assertEqual(self.map([]), {})

    def test_an_enumerated_field_only_gets_a_value_it_accepts(self):
        mapped = self.map([field('Type', kind='radio',
                                 options=['Setup', 'Background', 'Measurement'])])
        self.assertEqual(mapped['Type'], 'Background')

    def test_an_enumerated_field_with_no_matching_option_is_left_empty(self):
        self.assertNotIn('Type', self.map([field('Type', kind='radio',
                                                 options=['Alpha', 'Gamma'])]))

    def test_an_electrode_current_does_not_get_the_target_material(self):
        # 'I_Target (uA)' is a current, not the target name.
        self.assertNotIn('I_Target (uA)', self.map([field('I_Target (uA)', 'I_Target__uA_')]))

    def test_the_target_material_still_reaches_a_target_field(self):
        self.assertEqual(self.map([field('Target')])['Target'], 'DAQ Test')

    def test_a_persons_name_is_never_invented(self):
        for label in ('Shifters', 'Operators', 'Author'):
            self.assertNotIn(label, self.map([field(label)]))

    def test_realtime_comes_from_the_run_duration(self):
        self.assertEqual(self.map([field('Realtime (s)', 'Realtime__s_')])['Realtime (s)'],
                         '9738.7')

    def test_voltages_are_reported_even_when_zero(self):
        mapped = self.map([field('Terminal Voltage (kV)'), field('Probe Voltage (V)')])
        self.assertEqual(mapped['Terminal Voltage (kV)'], '0')
        self.assertEqual(mapped['Probe Voltage (V)'], '0')


if __name__ == '__main__':
    unittest.main()
