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

    def test_unreadable_rules_are_kept_rather_than_replaced(self):
        self.rule(BEAM_CURRENT, threshold=5.0)
        with open(os.path.join(self.tmp, 'conf', 'alerts.json'), 'w') as f:
            f.write('{ this is not json')

        fresh = AlertManager(sources=self.sources,
                             transports={'telegram': self.telegram})

        # It falls back to the default rule, but the operator's file is still there.
        self.assertEqual([r['type'] for r in fresh.get_rules()], [BOARD_FAILURE])
        import glob
        self.assertTrue(glob.glob(os.path.join(self.tmp, 'conf',
                                               'alerts.json.unreadable-*')),
                        'the unreadable file was not kept')

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

        # A second episode inside the quiet window is held back rather than
        # sending a near-duplicate...
        self.current = 2.0
        self.tick()
        self.assertEqual(self.tick(40.0), [])

        # ...and a later one is announced again.
        self.current = 50.0
        self.tick(30.0)
        self.current = 2.0
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


class ThingsBreakingTests(AlertTestCase):
    """What a shift actually meets: a board, a monitor or Graphite giving up."""

    def test_the_settings_page_survives_alerts_arriving_while_it_reads(self):
        # The state is written by the watcher and by the board monitor while every
        # settings poll reads it: an unguarded dict raised "changed size during
        # iteration" and 500'd the page.
        import threading
        self.rule(BOARD_FAILURE)
        errors = []
        stop = threading.Event()

        def hammer():
            n = 0
            while not stop.is_set():
                try:
                    self.mgr.board_failure(f"board{n % 50}", 'Board FAIL flag', 42)
                    self.mgr.get_status()
                except Exception as e:                  # noqa: BLE001 - that is the test
                    errors.append(e)
                n += 1

        threads = [threading.Thread(target=hammer) for _ in range(4)]
        for t in threads:
            t.start()
        for _ in range(200):
            try:
                self.mgr.get_status()
            except Exception as e:                      # noqa: BLE001
                errors.append(e)
        stop.set()
        for t in threads:
            t.join(timeout=5)

        self.assertEqual(errors, [])

    def test_a_rule_with_no_working_destination_says_so(self):
        # Enabled, watching, and telling nobody: the page has to show that.
        self.telegram.enabled = False
        self.telegram.is_configured = lambda: True
        self.zulip.enabled = True
        self.zulip.is_configured = lambda: False
        rule = self.rule(BEAM_CURRENT, threshold=5.0, transports=['telegram', 'zulip'])

        status = self.mgr.get_status()['rules'][0]

        self.assertEqual(status['id'], rule['id'])
        self.assertFalse(status['deliverable'])
        self.assertEqual(sorted(status['transports_not_ready']), ['telegram', 'zulip'])

    def test_a_rule_with_one_working_destination_is_deliverable(self):
        self.telegram.enabled = True
        self.telegram.is_configured = lambda: True
        self.zulip.enabled = False
        self.zulip.is_configured = lambda: False
        self.rule(BOARD_FAILURE, transports=['telegram', 'zulip'])

        status = self.mgr.get_status()['rules'][0]

        self.assertTrue(status['deliverable'])
        self.assertEqual(status['transports_not_ready'], ['zulip'])

    def test_local_rules_are_evaluated_before_graphite_ones(self):
        # One thread does the pass; a Graphite server that accepts and then stalls
        # must not delay noticing that a board stopped reading.
        order = []
        self.rule(GRAPHITE_METRIC, metric='luna.slow', seconds=0, poll_seconds=5)
        self.rule(STALLED_BUFFERS, seconds=0)
        self.diagnostics = {'0': {'buffers_read': 10, 'board_failures': 0}}
        self.sources.metric_value = lambda path: (order.append('graphite'), None)[1]
        original = self.sources.board_diagnostics
        self.sources.board_diagnostics = lambda: (order.append('boards'), original())[1]

        self.tick()

        self.assertEqual(order[0], 'boards')

    def test_a_board_that_vanishes_mid_run_is_not_reported_as_recovered(self):
        self.rule(STALLED_BUFFERS, seconds=5)
        self.diagnostics = {'0': {'buffers_read': 100, 'board_failures': 0}}
        self.tick()
        self.tick(10.0)                      # stalled -> alert
        self.assertEqual(len(self.telegram.messages), 1)

        # caendaq stops reporting the board at all (run torn down, module gone).
        self.diagnostics = {}
        self.assertEqual(self.tick(10.0), [])
        self.assertEqual(len(self.telegram.messages), 1)

    def test_a_transport_that_raises_does_not_stop_the_other(self):
        def explode(message):
            raise RuntimeError('socket closed')
        self.telegram.send_message = explode
        self.rule(BOARD_FAILURE, transports=['telegram', 'zulip'])

        sent = self.mgr.board_failure('0', 'Board FAIL flag', 42)

        self.assertEqual(sent[0]['results'], {'telegram': False, 'zulip': True})
        self.assertEqual(len(self.zulip.messages), 1)


class BeamCurrentSourceTests(unittest.TestCase):
    """Reading the current monitor, including when it has quietly stopped."""

    def source(self, controller):
        from app.routes import current as current_routes
        from app.services.alerting import _live_beam_current
        with mock.patch.object(current_routes, 'controller', controller):
            return _live_beam_current()

    def controller(self, history=None, data=5.0, connected=True, with_history=True):
        c = mock.MagicMock()
        c.is_connected.return_value = connected
        c.get_data.return_value = data
        c.get_charge_channel.return_value = 0
        if with_history:
            c.get_history.return_value = history if history is not None else []
        else:
            del c.get_history
        return c

    def test_a_recent_sample_is_used(self):
        import time
        now = time.time()
        self.assertEqual(self.source(self.controller(history=[[now - 1, 12.5]])), 12.5)

    def test_a_monitor_with_nothing_recent_reads_unknown(self):
        # Connected, but the readings stopped: its last value is not a measurement.
        self.assertIsNone(self.source(self.controller(history=[])))

    def test_a_disconnected_monitor_reads_unknown(self):
        self.assertIsNone(self.source(self.controller(connected=False)))

    def test_a_controller_without_history_falls_back_to_the_latest_value(self):
        self.assertEqual(self.source(self.controller(data=7.0, with_history=False)), 7.0)

    def test_a_multi_channel_monitor_uses_its_charge_channel(self):
        c = self.controller(data={'0': 3.0, '1': 9.0}, with_history=False)
        self.assertEqual(self.source(c), 3.0)

    def test_nan_reads_unknown(self):
        self.assertIsNone(self.source(self.controller(data=float('nan'),
                                                      with_history=False)))

    def test_no_monitor_at_all_reads_unknown(self):
        self.assertIsNone(self.source(None))


class NothingIsLostTests(AlertTestCase):
    """The failures a shift would only discover from missing data."""

    def test_one_bad_rule_does_not_cost_the_others(self):
        self.rule(BEAM_CURRENT, threshold=5.0)
        self.rule(BOARD_FAILURE)
        stored = json.load(open(os.path.join(self.tmp, 'conf', 'alerts.json')))
        stored['rules'].insert(1, {'type': 'graphite_metric', 'params': {'metric': ''}})
        with open(os.path.join(self.tmp, 'conf', 'alerts.json'), 'w') as f:
            json.dump(stored, f)

        fresh = AlertManager(sources=self.sources,
                            transports={'telegram': self.telegram})

        self.assertEqual([r['type'] for r in fresh.get_rules()],
                         [BEAM_CURRENT, BOARD_FAILURE])
        rejected = fresh.get_status()['rejected_rules']
        self.assertEqual(len(rejected), 1)
        self.assertIn('metric path', rejected[0]['reason'])

    def test_a_board_failure_is_recorded_even_with_no_rule_for_it(self):
        from app.services import alert_log as module
        module._log = None
        self.addCleanup(setattr, module, '_log', None)
        log = module.get_alert_log()

        self.assertEqual(self.mgr.board_failure('2', 'Board FAIL flag (1 data block)', 9), [])

        event = log.list_events()[0]
        self.assertEqual(event['kind'], 'alert')
        self.assertEqual(event['subject'], '2')
        self.assertIn('no alert configured', event['title'])

    def test_a_run_start_does_not_re_announce_a_standing_current_problem(self):
        # 40 runs a night would otherwise send 40 identical messages.
        self.rule(BEAM_CURRENT, threshold=10.0, seconds=0)
        self.current = 1.0
        self.assertEqual(len(self.tick()), 1)

        self.mgr.reset_run_state()               # what a run start does
        self.assertEqual(self.tick(120.0), [])
        self.assertEqual(len(self.telegram.messages), 1)

    def test_a_run_start_does_re_arm_the_board_rules(self):
        self.rule(BOARD_FAILURE)
        self.mgr.board_failure('0', 'Board FAIL flag', 1)
        self.mgr.reset_run_state()
        self.mgr.board_failure('0', 'Board FAIL flag', 2)

        self.assertEqual(len(self.telegram.messages), 2)

    def test_a_flapping_condition_cannot_flood_the_history(self):
        self.rule(STALLED_BUFFERS, seconds=0)
        self.diagnostics = {'0': {'buffers_read': 100, 'board_failures': 0}}

        # A board producing one block every 6 s, watched every 2 s.
        for step in range(12):
            if step % 3 == 0:
                self.diagnostics['0']['buffers_read'] += 1
            self.tick(2.0)

        alerts = [m for m in self.telegram.messages if 'stopped producing' in m]
        self.assertEqual(len(alerts), 1, f"one alert per minute, got {len(alerts)}")

    def test_a_run_with_no_board_reporting_at_all_is_reported(self):
        # The acquisition died without stopping the run: the case the stall rule
        # could not see, because it walked an empty board list.
        self.rule(STALLED_BUFFERS, seconds=10)
        self.diagnostics = {}

        self.assertEqual(self.tick(), [])
        sent = self.tick(15.0)

        self.assertEqual(len(sent), 1)
        self.assertIn('no board has reported', self.telegram.messages[0])

        # And it clears when the readout comes back.
        self.diagnostics = {'0': {'buffers_read': 5, 'board_failures': 0}}
        recovery = self.tick(2.0)
        self.assertTrue(recovery and recovery[0]['recovery'])

    def test_a_rule_that_cannot_measure_says_so(self):
        self.rule(BEAM_CURRENT, threshold=10.0, seconds=0)
        self.current = None

        self.tick()
        self.tick(30.0)
        status = self.mgr.get_status()['rules'][0]

        self.assertTrue(status['unmeasured'])
        self.assertGreaterEqual(status['unmeasured_for'], 30)
        self.assertFalse(status['alerting'])

    def test_a_rule_that_can_measure_is_not_flagged_unmeasured(self):
        self.rule(BEAM_CURRENT, threshold=10.0, seconds=0)
        self.current = 50.0

        self.tick()

        self.assertFalse(self.mgr.get_status()['rules'][0]['unmeasured'])


class WatcherRestartTests(AlertTestCase):
    def test_starting_after_a_stop_that_timed_out_really_starts(self):
        # Stop while a pass is stuck, then Start: the page used to report
        # "watching" while nothing evaluated any rule again.
        import threading, time as real_time
        release = threading.Event()
        self.mgr.evaluate = lambda: release.wait(3.0)

        self.mgr.start(interval=0.01)
        real_time.sleep(0.05)
        self.mgr._stop.set()                 # a stop whose join would time out
        self.mgr.start(interval=0.01)

        self.assertFalse(self.mgr._stop.is_set())
        self.assertTrue(self.mgr.is_watching())
        release.set()
        self.mgr.stop()


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
