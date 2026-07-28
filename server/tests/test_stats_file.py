"""
The per-run stats file and the metric configuration behind it.

A stats.csv is read months later by someone who was not on shift, so the tests
below are about the file staying machine-readable and self-describing.
"""

import csv
import json
import os
import shutil
import tempfile
import unittest

from app.services.stats_manager import StatsManager


class CsvFormattingTests(unittest.TestCase):
    def test_fields_are_comma_separated(self):
        self.assertEqual(StatsManager._format_row(['1.000', '3.4', '12']), '1.000,3.4,12')

    def test_fields_containing_a_comma_are_quoted(self):
        self.assertEqual(StatsManager._format_row(['a,b', 'c']), '"a,b",c')

    def test_quotes_are_doubled_as_csv_requires(self):
        self.assertEqual(StatsManager._format_row(['say "hi"']), '"say ""hi"""')

    def test_column_title_carries_the_unit(self):
        self.assertEqual(
            StatsManager._column_title({'alias': 'Terminal Voltage', 'unit': 'kV',
                                        'path': 'accelerator.terminal_voltage'}),
            'Terminal Voltage [kV]')

    def test_column_title_without_a_unit_is_just_the_name(self):
        self.assertEqual(
            StatsManager._column_title({'alias': 'Board 0 rate', 'unit': '',
                                        'path': 'daq.rate1'}),
            'Board 0 rate')

    def test_column_title_falls_back_to_the_graphite_path(self):
        self.assertEqual(StatsManager._column_title({'path': 'daq.rate1'}), 'daq.rate1')

    def test_missing_samples_are_recorded_as_zero(self):
        self.assertEqual(StatsManager._format_value(None), '0')
        self.assertEqual(StatsManager._format_value('not a number'), '0')
        self.assertEqual(StatsManager._format_value(3.14159265), '3.14159')


class MetricConfigurationTests(unittest.TestCase):
    """add/update/remove against a real conf/stats.json in a temp directory."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='webdaq-stats-')
        self.cwd = os.getcwd()
        os.chdir(self.tmp)
        self.manager = StatsManager(graphite_host='localhost', graphite_port=80)

    def tearDown(self):
        os.chdir(self.cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def stored_paths(self):
        with open(os.path.join(self.tmp, 'conf', 'stats.json')) as f:
            return json.load(f)['paths']

    def test_a_metric_is_stored_with_its_name_and_unit(self):
        self.assertTrue(self.manager.add_path('accelerator.terminal_voltage',
                                              'Terminal Voltage', 'kV'))
        entry = self.stored_paths()[0]
        self.assertEqual(entry['path'], 'accelerator.terminal_voltage')
        self.assertEqual(entry['alias'], 'Terminal Voltage')
        self.assertEqual(entry['unit'], 'kV')
        self.assertTrue(entry['enabled'])

    def test_a_metric_without_a_unit_stores_an_empty_one(self):
        self.manager.add_path('daq.rate1', 'Rate')
        self.assertEqual(self.stored_paths()[0]['unit'], '')

    def test_the_same_path_is_not_added_twice(self):
        self.assertTrue(self.manager.add_path('daq.rate1', 'Rate', 'counts/s'))
        self.assertFalse(self.manager.add_path('daq.rate1', 'Rate again', 'Hz'))
        self.assertEqual(len(self.stored_paths()), 1)

    def test_name_and_unit_can_be_changed_afterwards(self):
        self.manager.add_path('accelerator.charge', 'Charge', 'uC')
        self.assertTrue(self.manager.update_path('accelerator.charge',
                                                 alias='Accumulated charge', unit='mC'))
        entry = self.stored_paths()[0]
        self.assertEqual(entry['alias'], 'Accumulated charge')
        self.assertEqual(entry['unit'], 'mC')

    def test_a_unit_can_be_cleared(self):
        self.manager.add_path('daq.rate1', 'Rate', 'Hz')
        self.manager.update_path('daq.rate1', unit='')
        self.assertEqual(self.stored_paths()[0]['unit'], '')

    def test_disabling_a_metric_keeps_its_name_and_unit(self):
        self.manager.add_path('daq.rate1', 'Rate', 'Hz')
        self.manager.update_path('daq.rate1', enabled=False)
        entry = self.stored_paths()[0]
        self.assertFalse(entry['enabled'])
        self.assertEqual(entry['unit'], 'Hz')

    def test_updating_an_unknown_path_reports_failure(self):
        self.assertFalse(self.manager.update_path('nope.nothing', alias='x'))

    def test_removing_a_metric(self):
        self.manager.add_path('daq.rate1', 'Rate', 'Hz')
        self.assertTrue(self.manager.remove_path('daq.rate1'))
        self.assertEqual(self.stored_paths(), [])
        self.assertFalse(self.manager.remove_path('daq.rate1'))


class StatsFileTests(unittest.TestCase):
    """The file a run actually produces."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='webdaq-statsfile-')
        self.cwd = os.getcwd()
        os.chdir(self.tmp)
        self.manager = StatsManager(graphite_host='localhost', graphite_port=80)
        self.manager.add_path('accelerator.terminal_voltage', 'Terminal Voltage', 'kV')
        self.manager.add_path('daq.rate1', 'Board 0 rate', 'counts/s')
        self.manager.add_path('daq.rate2', 'Board 1 rate', '')
        # No Graphite here: every sample is missing, which is itself the case
        # worth covering (the file must still be well formed).
        self.manager.get_last_value = lambda path, from_time='-10s': (None, None)

    def tearDown(self):
        if self.manager.is_collecting():
            self.manager.stop_run()
        os.chdir(self.cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def collect_briefly(self, run_number=1):
        self.assertTrue(self.manager.start_run(run_number))
        # The collection loop writes one row per second.
        import time
        time.sleep(1.5)
        self.manager.stop_run()
        with open(os.path.join(self.tmp, 'data', f'run{run_number}', 'stats.csv')) as f:
            return f.read().splitlines()

    def test_the_file_is_csv_with_a_commented_header(self):
        lines = self.collect_briefly()
        comments = [line for line in lines if line.startswith('#')]
        data = [line for line in lines if not line.startswith('#')]

        self.assertTrue(any('Run number: 1' in line for line in comments))
        self.assertTrue(any('Start time:' in line for line in comments))
        # Every metric is described with its unit and its Graphite source, so a
        # column can be traced back without the configuration file.
        self.assertTrue(any('Terminal Voltage | unit: kV | source: accelerator.terminal_voltage'
                            in line for line in comments))
        self.assertTrue(any('Board 1 rate | unit: - ' in line for line in comments))

        header = data[0].split(',')
        self.assertEqual(header, ['Time [s]', 'Terminal Voltage [kV]',
                                  'Board 0 rate [counts/s]', 'Board 1 rate'])

    def test_every_row_has_one_field_per_column(self):
        lines = self.collect_briefly(run_number=2)
        rows = list(csv.reader(line for line in lines if not line.startswith('#')))
        self.assertGreater(len(rows), 1, "no data rows were written")
        self.assertTrue(all(len(row) == len(rows[0]) for row in rows))

    def test_a_standard_csv_reader_parses_it_when_comments_are_skipped(self):
        lines = self.collect_briefly(run_number=3)
        rows = list(csv.DictReader(line for line in lines if not line.startswith('#')))
        self.assertGreater(len(rows), 0)
        self.assertIn('Terminal Voltage [kV]', rows[0])
        self.assertEqual(rows[0]['Terminal Voltage [kV]'], '0')   # missing sample

    def test_disabled_metrics_are_not_columns(self):
        self.manager.update_path('daq.rate2', enabled=False)
        lines = self.collect_briefly(run_number=4)
        header = [line for line in lines if not line.startswith('#')][0]
        self.assertNotIn('Board 1 rate', header)

    def test_the_column_set_is_frozen_for_the_run(self):
        # Adding a metric mid-run must not shift the columns under the rows
        # already written.
        self.assertTrue(self.manager.start_run(5))
        import time
        time.sleep(1.2)
        self.manager.add_path('daq.rate3', 'Late arrival', 'Hz')
        time.sleep(1.2)
        self.manager.stop_run()

        with open(os.path.join(self.tmp, 'data', 'run5', 'stats.csv')) as f:
            lines = f.read().splitlines()
        rows = list(csv.reader(line for line in lines if not line.startswith('#')))
        self.assertNotIn('Late arrival [Hz]', rows[0])
        self.assertTrue(all(len(row) == len(rows[0]) for row in rows))


if __name__ == '__main__':
    unittest.main()
