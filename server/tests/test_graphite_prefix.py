"""
The Graphite metric prefix — the root of the tree the DAQ writes rates into.

It names the EXPERIMENT, not a board: 'ancillary.rates.12c12c' and
'ancillary.rates.BGO' keep two campaigns apart in one Graphite, with the boards
below as bo_<VME board id>. Getting it wrong silently merges two campaigns'
series, so the tests below are about it round-tripping through conf/stats.json
and reaching a running acquisition.
"""

import json
import os
import shutil
import tempfile
import unittest

from app.services.stats_manager import StatsManager, DEFAULT_GRAPHITE_PREFIX


class PrefixNormalisationTests(unittest.TestCase):
    """The same normalisation caendaq's StatsCollector applies, mirrored here so
    the operator is shown what will actually be written."""

    def test_a_dotted_path_survives_untouched(self):
        self.assertEqual(
            StatsManager.normalize_prefix('ancillary.rates.12c12c'),
            'ancillary.rates.12c12c')

    def test_characters_graphite_cannot_take_become_underscores(self):
        self.assertEqual(
            StatsManager.normalize_prefix('ancillary.rates.12C 12c/beam'),
            'ancillary.rates.12C_12c_beam')

    def test_leading_and_trailing_dots_are_trimmed(self):
        # They would otherwise produce empty path segments ('..a' -> '', '', 'a').
        self.assertEqual(StatsManager.normalize_prefix('..ancillary.rates..'),
                         'ancillary.rates')

    def test_surrounding_whitespace_is_ignored(self):
        self.assertEqual(StatsManager.normalize_prefix('  ancillary.rates.BGO \n'),
                         'ancillary.rates.BGO')

    def test_a_hyphen_is_allowed(self):
        self.assertEqual(StatsManager.normalize_prefix('ancillary.rates.12c-12c'),
                         'ancillary.rates.12c-12c')

    def test_a_prefix_with_nothing_usable_is_rejected(self):
        for bad in ('', '   ', '...'):
            with self.assertRaises(ValueError):
                StatsManager.normalize_prefix(bad)


class PrefixConfigurationTests(unittest.TestCase):
    """Round-trip through a real conf/stats.json in a temp directory."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='webdaq-prefix-')
        self.cwd = os.getcwd()
        os.chdir(self.tmp)
        self.manager = StatsManager(graphite_host='localhost', graphite_port=80)

    def tearDown(self):
        os.chdir(self.cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _stored(self):
        with open('conf/stats.json') as f:
            return json.load(f)

    def test_a_fresh_configuration_uses_the_default_prefix(self):
        self.assertEqual(self.manager.get_graphite_prefix(), DEFAULT_GRAPHITE_PREFIX)

    def test_setting_a_prefix_persists_it(self):
        self.manager.set_graphite_prefix('ancillary.rates.12c12c')
        self.assertEqual(self._stored()['graphite_prefix'], 'ancillary.rates.12c12c')
        self.assertEqual(self.manager.get_graphite_prefix(), 'ancillary.rates.12c12c')

    def test_the_stored_prefix_is_the_normalised_one(self):
        returned = self.manager.set_graphite_prefix(' ancillary.rates.12c 12c ')
        self.assertEqual(returned, 'ancillary.rates.12c_12c')
        self.assertEqual(self._stored()['graphite_prefix'], 'ancillary.rates.12c_12c')

    def test_a_prefix_survives_a_reload(self):
        self.manager.set_graphite_prefix('ancillary.rates.BGO')
        reloaded = StatsManager(graphite_host='localhost', graphite_port=80)
        self.assertEqual(reloaded.get_graphite_prefix(), 'ancillary.rates.BGO')

    def test_an_empty_prefix_in_the_file_falls_back_to_the_default(self):
        config = self._stored()
        config['graphite_prefix'] = ''
        with open('conf/stats.json', 'w') as f:
            json.dump(config, f)
        reloaded = StatsManager(graphite_host='localhost', graphite_port=80)
        self.assertEqual(reloaded.get_graphite_prefix(), DEFAULT_GRAPHITE_PREFIX)

    def test_an_unusable_prefix_is_refused_and_the_old_one_kept(self):
        self.manager.set_graphite_prefix('ancillary.rates.12c12c')
        with self.assertRaises(ValueError):
            self.manager.set_graphite_prefix('...')
        self.assertEqual(self.manager.get_graphite_prefix(), 'ancillary.rates.12c12c')

    def test_changing_the_prefix_leaves_the_configured_metrics_alone(self):
        self.manager.add_path('accelerator.terminal_voltage', 'Terminal Voltage', 'kV')
        self.manager.set_graphite_prefix('ancillary.rates.12c12c')
        self.assertEqual([p['path'] for p in self.manager.get_paths()],
                         ['accelerator.terminal_voltage'])


class AcquisitionPrefixTests(unittest.TestCase):
    """What caen_acquisition reads out of conf/stats.json and hands to caendaq."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='webdaq-prefix-acq-')
        self.cwd = os.getcwd()
        os.chdir(self.tmp)
        os.makedirs('conf', exist_ok=True)

    def tearDown(self):
        os.chdir(self.cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write(self, config):
        with open('conf/stats.json', 'w') as f:
            json.dump(config, f)

    def test_the_prefix_is_read_from_the_stats_configuration(self):
        from app.services.caen_acquisition import _graphite_from_stats
        self._write({'graphite_host': 'lunaserver', 'carbon_port': 2003,
                     'graphite_prefix': 'ancillary.rates.12c12c'})
        host, port, prefix = _graphite_from_stats()
        self.assertEqual((host, port, prefix),
                         ('lunaserver', 2003, 'ancillary.rates.12c12c'))

    def test_an_older_configuration_without_a_prefix_still_works(self):
        # Files written before the prefix existed must not break a run.
        from app.services.caen_acquisition import _graphite_from_stats
        self._write({'graphite_host': 'lunaserver', 'carbon_port': 2003})
        _host, _port, prefix = _graphite_from_stats()
        self.assertEqual(prefix, DEFAULT_GRAPHITE_PREFIX)

    def test_a_missing_configuration_disables_the_push_but_keeps_a_prefix(self):
        from app.services.caen_acquisition import _graphite_from_stats
        host, port, prefix = _graphite_from_stats()
        self.assertEqual(host, '')          # no host = no Graphite push
        self.assertEqual(port, 2003)
        self.assertEqual(prefix, DEFAULT_GRAPHITE_PREFIX)


if __name__ == '__main__':
    unittest.main()
