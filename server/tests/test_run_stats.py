"""
Reading a finished run's stats.csv back out, for the logbook's plots.

The file is written by the Stats page while the run is saving: one column per
metric the operator selected, sampled from Graphite. These tests cover reading
it back — including the header, which carries the operator's own alias and unit
and is the difference between a plot labelled "Terminal Voltage (kV)" and one
labelled "accelerator.terminal_voltage".
"""

import os
import shutil
import tempfile
import unittest

os.environ.setdefault('TEST_FLAG', 'True')

from app.services import run_data  # noqa: E402

STATS = """\
# LUNA DAQ statistics
# Run number: 7
# Start time: 2026-08-27T18:26:01
# Format: CSV. The first column is the elapsed acquisition time in seconds;
# the rest are the metrics below, in this order. Missing samples are 0.
#
# Metric: Terminal Voltage | unit: kV | source: accelerator.terminal_voltage
# Metric: BS Current | unit: - | source: accelerator.current
#
Time [s],Terminal Voltage,BS Current
0.000,132.509,0
1.137,130.211,24.5
2.233,130.211,24.6
"""


class RunStatsReadingTests(unittest.TestCase):
    def setUp(self):
        self.workdir = tempfile.mkdtemp()
        self.previous = os.getcwd()
        os.chdir(self.workdir)
        os.makedirs(os.path.join('data', 'run7'))

    def tearDown(self):
        os.chdir(self.previous)
        shutil.rmtree(self.workdir, ignore_errors=True)

    def write(self, text, run=7):
        with open(os.path.join('data', f'run{run}', 'stats.csv'), 'w') as f:
            f.write(text)

    def test_a_run_with_no_stats_file_says_so_rather_than_failing(self):
        self.assertFalse(run_data.read_stats(7)['available'])

    def test_the_columns_and_rows_come_back(self):
        self.write(STATS)
        stats = run_data.read_stats(7)
        self.assertTrue(stats['available'])
        self.assertEqual(stats['columns'],
                         ['Time [s]', 'Terminal Voltage', 'BS Current'])
        self.assertEqual(stats['n_samples'], 3)
        self.assertEqual(stats['samples'][1], [1.137, 130.211, 24.5])
        self.assertEqual(stats['start_time'], '2026-08-27T18:26:01')

    def test_the_operators_alias_and_unit_survive(self):
        self.write(STATS)
        metrics = run_data.read_stats(7)['metrics']
        self.assertEqual(metrics[0],
                         {'name': 'Terminal Voltage', 'unit': 'kV',
                          'source': 'accelerator.terminal_voltage'})
        # '-' in the file means "no unit", and must not become an axis labelled '-'.
        self.assertEqual(metrics[1]['unit'], '')

    def test_a_long_run_is_downsampled_for_the_plot(self):
        rows = "\n".join(f"{i}.0,{i},{i}" for i in range(5000))
        self.write(STATS + rows + "\n")
        stats = run_data.read_stats(7, max_points=500)
        self.assertTrue(stats['downsampled'])
        self.assertLessEqual(len(stats['samples']), 501)
        self.assertEqual(stats['n_samples'], 5003)

    def test_a_line_caught_mid_write_is_dropped_not_plotted(self):
        """'4.4,12' is not a reading of 12 — it is the start of 129.5."""
        self.write(STATS + "4.0,128.0,24.1\n4.4,12")
        stats = run_data.read_stats(7)
        self.assertTrue(stats['available'])
        self.assertEqual(stats['samples'][-1], [4.0, 128.0, 24.1])

    def test_a_metric_added_to_an_open_file_does_not_shift_the_others(self):
        self.write(STATS + "4.0,128.0,24.1,999.0\n")
        self.assertEqual(run_data.read_stats(7)['samples'][-1], [4.0, 128.0, 24.1])

    def test_a_header_that_does_not_match_the_columns_is_left_out(self):
        """Better no labels than labels against the wrong series."""
        self.write(STATS.replace(
            '# Metric: BS Current | unit: - | source: accelerator.current\n', ''))
        self.assertEqual(run_data.read_stats(7)['metrics'], [])

    def test_a_file_with_only_a_header_has_nothing_to_plot(self):
        self.write("# LUNA DAQ statistics\nTime [s],Terminal Voltage\n")
        self.assertFalse(run_data.read_stats(7)['available'])


class RunStatsRouteTests(unittest.TestCase):
    """What the logbook's Stats tab actually receives."""

    @classmethod
    def setUpClass(cls):
        from app import create_app
        from app.utils.jwt_utils import generate_token

        cls.app = create_app()
        with cls.app.app_context():
            token = generate_token(1)
        cls.client = cls.app.test_client()
        cls.auth = {'Authorization': f'Bearer {token}'}

    def setUp(self):
        self.workdir = tempfile.mkdtemp()
        self.previous = os.getcwd()
        os.chdir(self.workdir)

    def tearDown(self):
        os.chdir(self.previous)
        shutil.rmtree(self.workdir, ignore_errors=True)

    def test_a_run_with_no_directory_is_a_404_not_a_500(self):
        response = self.client.get('/data/runs/4242/stats', headers=self.auth)
        self.assertEqual(response.status_code, 404)

    def test_the_tab_gets_columns_metrics_and_samples(self):
        os.makedirs(os.path.join('data', 'run7'))
        with open(os.path.join('data', 'run7', 'stats.csv'), 'w') as f:
            f.write(STATS)
        response = self.client.get('/data/runs/7/stats', headers=self.auth)
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertTrue(body['available'])
        self.assertEqual(len(body['columns']), 3)
        self.assertEqual(body['metrics'][0]['unit'], 'kV')
        self.assertEqual(len(body['samples']), 3)


if __name__ == '__main__':
    unittest.main()
