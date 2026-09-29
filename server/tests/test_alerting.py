"""
The alert rules: what fires, when, and who hears it.

An alert is only useful if it arrives when something is wrong and stays quiet
otherwise, so these tests are mostly about restraint: one message per episode, no
message while a rule's condition has not held long enough, and — the one that
matters most during a beam campaign — no message invented by a monitoring path
that has itself gone blind (Graphite unreachable, current monitor disconnected).
"""

import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

from app.services.alerting import (
    BEAM_CURRENT, BOARD_FAILURE, GRAPHITE_METRIC, STALLED_BUFFERS,
    AlertConfigError, AlertManager, AlertSources)


class FakeTransport:
    """A transport that records what it was asked to send."""

    def __init__(self, name, works=True):
        self.name = name
        self.works = works
        self.messages = []

    def format(self, title, lines):
        return f"[{self.name}] {title}: " + ' | '.join(lines)

    def send_message(self, message):
        self.messages.append(message)
        return self.works


class AlertTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='webdaq-alerts-')
        self.cwd = os.getcwd()
        os.chdir(self.tmp)

        self.now = 1000.0
        self.running = True
        self.diagnostics = {}
        self.current = None
        self.metrics = {}

        self.telegram = FakeTransport('telegram')
        self.zulip = FakeTransport('zulip')
        self.sources = AlertSources(
            board_diagnostics=lambda: self.diagnostics,
            is_running=lambda: self.running,
            run_number=lambda: 42,
            beam_current=lambda: self.current,
            metric_value=lambda path: self.metrics.get(path),
        )
        self.mgr = AlertManager(
            sources=self.sources,
            transports={'telegram': self.telegram, 'zulip': self.zulip},
            clock=lambda: self.now)
        self.mgr.rules = []          # the seeded default is tested separately

    def tearDown(self):
        os.chdir(self.cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def stored(self):
        with open(os.path.join(self.tmp, 'conf', 'alerts.json')) as f:
            return json.load(f)

    def rule(self, kind, **params):
        transports = params.pop('transports', ['telegram'])
        return self.mgr.add_rule({'type': kind, 'transports': transports,
                                  'params': params})

    def tick(self, seconds=0.0):
        self.now += seconds
        return self.mgr.evaluate()


class RuleConfigTests(AlertTestCase):
    def test_the_default_rule_keeps_todays_behaviour(self):
        # A fresh install alerts Telegram about board failures, as before rules.
        fresh = AlertManager(sources=self.sources,
                             transports={'telegram': self.telegram})
        self.assertEqual([(r['type'], r['transports'], r['enabled'])
                          for r in fresh.get_rules()],
                         [(BOARD_FAILURE, ['telegram'], True)])

    def test_rules_survive_a_restart(self):
        self.rule(BEAM_CURRENT, threshold=5.0, comparison='below',
                  transports=['telegram', 'zulip'])
        again = AlertManager(sources=self.sources,
                             transports={'telegram': self.telegram})

        self.assertEqual(len(again.get_rules()), 1)
        rule = again.get_rules()[0]
        self.assertEqual(rule['params']['threshold'], 5.0)
        self.assertEqual(rule['transports'], ['telegram', 'zulip'])
        self.assertEqual(len(self.stored()['rules']), 1)

    def test_missing_params_are_filled_from_the_type_defaults(self):
        rule = self.rule(STALLED_BUFFERS)
        self.assertEqual(rule['params']['seconds'], 60)
        self.assertEqual(rule['name'], 'Board stopped producing data')

    def test_nonsense_is_refused_with_a_message_for_the_operator(self):
        for bad, expect in (
            ({'type': 'volcano'}, 'Unknown alert type'),
            ({'type': BEAM_CURRENT, 'transports': ['carrier pigeon']}, 'Unknown destination'),
            ({'type': BEAM_CURRENT, 'params': {'comparison': 'sideways'}}, 'Comparison'),
            ({'type': BEAM_CURRENT, 'params': {'threshold': 'low'}}, 'number'),
            ({'type': GRAPHITE_METRIC, 'params': {'metric': '  '}}, 'metric path'),
        ):
            with self.assertRaises(AlertConfigError) as ctx:
                self.mgr.add_rule(bad)
            self.assertIn(expect, str(ctx.exception))

    def test_a_graphite_poll_cannot_be_set_to_hammer_the_server(self):
        rule = self.rule(GRAPHITE_METRIC, metric='luna.tv', poll_seconds=0)
        self.assertGreaterEqual(rule['params']['poll_seconds'], 5)

    def test_rules_can_be_edited_and_deleted(self):
        rule = self.rule(BEAM_CURRENT, threshold=5.0)
        updated = self.mgr.update_rule(rule['id'], {'params': {'threshold': 9.0},
                                                    'enabled': False})
        self.assertEqual(updated['params']['threshold'], 9.0)
        self.assertFalse(updated['enabled'])
        self.assertEqual(updated['params']['comparison'], 'below')  # untouched

        self.mgr.delete_rule(rule['id'])
        self.assertEqual(self.mgr.get_rules(), [])
        with self.assertRaises(AlertConfigError):
            self.mgr.delete_rule(rule['id'])

    def test_a_disabled_rule_watches_nothing(self):
        rule = self.rule(BEAM_CURRENT, threshold=5.0, seconds=0)
        self.mgr.update_rule(rule['id'], {'enabled': False})
        self.current = 1.0

        self.assertEqual(self.tick(), [])
        self.assertEqual(self.telegram.messages, [])


class BoardFailureAlertTests(AlertTestCase):
    def test_a_failure_reaches_every_chosen_transport(self):
        self.rule(BOARD_FAILURE, transports=['telegram', 'zulip'])

        sent = self.mgr.board_failure('0', 'Board FAIL flag (2 data blocks)', 42)

        self.assertEqual(len(sent), 1)
        self.assertEqual(len(self.telegram.messages), 1)
        self.assertEqual(len(self.zulip.messages), 1)
        self.assertIn('Board 0', self.telegram.messages[0])
        self.assertIn('2 data blocks', self.telegram.messages[0])
        self.assertIn('Run: 42', self.zulip.messages[0])

    def test_one_message_per_board_per_run(self):
        self.rule(BOARD_FAILURE)

        self.mgr.board_failure('0', 'Board FAIL flag (1 data block)', 42)
        self.mgr.board_failure('0', 'Board FAIL flag (9 data blocks)', 42)
        self.assertEqual(len(self.telegram.messages), 1)

        # A different board is its own story...
        self.mgr.board_failure('1', 'Board FAIL flag (1 data block)', 42)
        self.assertEqual(len(self.telegram.messages), 2)

        # ...and the next run starts with a clean slate.
        self.mgr.reset_run_state()
        self.mgr.board_failure('0', 'Board FAIL flag (1 data block)', 43)
        self.assertEqual(len(self.telegram.messages), 3)

    def test_with_no_enabled_rule_nobody_is_told(self):
        self.assertEqual(self.mgr.board_failure('0', 'Board FAIL flag', 42), [])
        self.assertEqual(self.telegram.messages, [])

    def test_it_is_not_also_polled(self):
        # The board monitor owns the failure edge; polling would alert twice.
        self.rule(BOARD_FAILURE)
        self.diagnostics = {'0': {'board_failures': 3, 'buffers_read': 10}}

        self.assertEqual(self.tick(), [])
        self.assertEqual(self.telegram.messages, [])

    def test_a_transport_that_fails_is_reported_as_such(self):
        self.telegram.works = False
        self.rule(BOARD_FAILURE)

        sent = self.mgr.board_failure('0', 'Board FAIL flag', 42)

        self.assertEqual(sent[0]['results'], {'telegram': False})


class StalledBoardTests(AlertTestCase):
    def setUp(self):
        super().setUp()
        self.rule(STALLED_BUFFERS, seconds=30)
        self.diagnostics = {'0': {'buffers_read': 1000, 'board_failures': 0}}

    def test_a_board_that_keeps_reading_raises_nothing(self):
        for _ in range(5):
            self.diagnostics['0']['buffers_read'] += 100
            self.assertEqual(self.tick(10.0), [])
        self.assertEqual(self.telegram.messages, [])

    def test_a_board_that_stops_is_reported_once(self):
        self.tick()                      # first sighting
        self.assertEqual(self.tick(20.0), [])       # 20 s < 30 s: too early to tell
        sent = self.tick(15.0)                      # 35 s without a new block

        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]['subject'], '0')
        self.assertIn('no new data block', self.telegram.messages[0])
        self.assertIn('Run: 42', self.telegram.messages[0])

        self.tick(60.0)                  # still stalled: no second message
        self.assertEqual(len(self.telegram.messages), 1)

    def test_recovery_is_announced_when_the_board_comes_back(self):
        self.tick()
        self.tick(40.0)
        self.assertEqual(len(self.telegram.messages), 1)

        self.diagnostics['0']['buffers_read'] += 500
        sent = self.tick(2.0)

        self.assertEqual(len(sent), 1)
        self.assertTrue(sent[0]['recovery'])
        self.assertIn('producing data again', self.telegram.messages[1])

    def test_recovery_can_be_switched_off(self):
        self.mgr.set_notify_recovery(False)
        self.tick()
        self.tick(40.0)
        self.diagnostics['0']['buffers_read'] += 500

        self.assertEqual(self.tick(2.0), [])
        self.assertEqual(len(self.telegram.messages), 1)

    def test_a_stopped_run_is_not_a_stalled_board(self):
        self.tick()
        self.running = False

        self.assertEqual(self.tick(600.0), [])
        self.assertEqual(self.telegram.messages, [])

    def test_a_build_without_the_counter_is_not_read_as_a_stall(self):
        self.diagnostics = {'0': {'buffers_read': None, 'board_failures': 0}}
        self.tick()

        self.assertEqual(self.tick(600.0), [])
        self.assertEqual(self.telegram.messages, [])

    def test_each_board_is_watched_separately(self):
        self.diagnostics['1'] = {'buffers_read': 500, 'board_failures': 0}
        self.tick()
        self.diagnostics['1']['buffers_read'] += 100    # board 1 keeps working

        sent = self.tick(40.0)

        self.assertEqual([a['subject'] for a in sent], ['0'])


class BeamCurrentTests(AlertTestCase):
    def setUp(self):
        super().setUp()
        self.rule(BEAM_CURRENT, comparison='below', threshold=10.0, seconds=30)

    def test_a_current_in_range_raises_nothing(self):
        self.current = 55.0
        self.assertEqual(self.tick(), [])

    def test_a_drop_has_to_hold_before_it_is_reported(self):
        self.current = 2.0
        self.assertEqual(self.tick(), [])            # just seen
        self.assertEqual(self.tick(20.0), [])        # 20 s < 30 s
        sent = self.tick(15.0)

        self.assertEqual(len(sent), 1)
        self.assertIn('Beam current is 2', self.telegram.messages[0])
        self.assertIn('below 10', self.telegram.messages[0])

    def test_a_short_dip_is_never_reported(self):
        self.current = 2.0
        self.tick(10.0)
        self.current = 50.0
        self.tick(10.0)
        self.current = 2.0
        self.tick(10.0)

        self.assertEqual(self.telegram.messages, [])

    def test_recovery_is_announced_once_and_re_arms_the_rule(self):
        self.current = 2.0
        self.tick()
        self.tick(40.0)
        self.current = 50.0
        sent = self.tick(2.0)

        self.assertTrue(sent[0]['recovery'])
        self.assertIn('back in range', self.telegram.messages[1])
        self.assertEqual(self.tick(2.0), [])     # nothing more to say

        self.current = 2.0                       # a second episode does alert
        self.tick()
        self.assertEqual(len(self.tick(40.0)), 1)

    def test_an_unreadable_current_neither_alerts_nor_clears(self):
        self.current = 2.0
        self.tick()
        self.tick(40.0)
        self.assertEqual(len(self.telegram.messages), 1)

        # The monitor drops off the network: silence, not a recovery.
        self.current = None
        self.assertEqual(self.tick(60.0), [])
        self.assertEqual(len(self.telegram.messages), 1)

    def test_an_above_rule_watches_the_other_direction(self):
        rule = self.mgr.get_rules()[0]
        self.mgr.update_rule(rule['id'], {'params': {'comparison': 'above',
                                                     'threshold': 100.0,
                                                     'seconds': 0}})
        self.current = 150.0

        self.assertEqual(len(self.tick()), 1)
        self.assertIn('above 100', self.telegram.messages[0])

    def test_between_runs_a_run_only_rule_is_quiet(self):
        rule = self.mgr.get_rules()[0]
        self.mgr.update_rule(rule['id'], {'params': {'during_run_only': True,
                                                     'seconds': 0}})
        self.current = 1.0
        self.running = False

        self.assertEqual(self.tick(), [])

    def test_a_rule_that_ignores_the_run_state_still_watches(self):
        rule = self.mgr.get_rules()[0]
        self.mgr.update_rule(rule['id'], {'params': {'during_run_only': False,
                                                     'seconds': 0}})
        self.current = 1.0
        self.running = False

        self.assertEqual(len(self.tick()), 1)


class GraphiteMetricTests(AlertTestCase):
    def setUp(self):
        super().setUp()
        self.rule(GRAPHITE_METRIC, metric='luna.terminal_voltage', comparison='below',
                  threshold=380.0, seconds=0, poll_seconds=30)

    def test_a_metric_below_its_threshold_is_reported_with_its_path(self):
        self.metrics['luna.terminal_voltage'] = 300.0

        sent = self.tick()

        self.assertEqual(len(sent), 1)
        self.assertIn('luna.terminal_voltage is 300', self.telegram.messages[0])

    def test_the_metric_is_not_queried_more_often_than_asked(self):
        reads = []
        self.sources.metric_value = lambda path: (reads.append(path), 500.0)[1]

        self.tick()
        self.tick(5.0)
        self.tick(5.0)
        self.assertEqual(len(reads), 1)     # 10 s into a 30 s poll interval

        self.tick(30.0)
        self.assertEqual(len(reads), 2)

    def test_an_unreachable_graphite_server_raises_nothing(self):
        self.metrics['luna.terminal_voltage'] = None     # what fetch_series gives us

        self.assertEqual(self.tick(), [])
        self.assertEqual(self.telegram.messages, [])

    def test_several_metrics_can_be_watched_at_once(self):
        self.rule(GRAPHITE_METRIC, metric='luna.pressure', comparison='above',
                  threshold=1e-5, seconds=0, poll_seconds=30)
        self.metrics = {'luna.terminal_voltage': 300.0, 'luna.pressure': 1e-4}

        sent = self.tick()

        self.assertEqual(len(sent), 2)
        self.assertEqual(len(self.telegram.messages), 2)


class WatcherTests(AlertTestCase):
    def test_the_watcher_runs_passes_until_stopped(self):
        self.rule(BEAM_CURRENT, threshold=10.0, seconds=0)
        self.current = 1.0

        self.mgr.start(interval=0.01)
        try:
            deadline = 2.0
            step = 0.01
            waited = 0.0
            import time
            while not self.telegram.messages and waited < deadline:
                time.sleep(step)
                waited += step
            self.assertTrue(self.mgr.is_watching())
        finally:
            self.mgr.stop()

        self.assertTrue(self.telegram.messages)
        self.assertFalse(self.mgr.is_watching())

    def test_a_failing_source_does_not_kill_the_pass(self):
        self.rule(BEAM_CURRENT, threshold=10.0, seconds=0)
        self.rule(STALLED_BUFFERS, seconds=1)
        self.sources.board_diagnostics = mock.MagicMock(
            side_effect=RuntimeError('caendaq is gone'))
        self.current = 1.0

        sent = self.tick()

        self.assertEqual([a['type'] for a in sent], [BEAM_CURRENT])


if __name__ == '__main__':
    unittest.main()
