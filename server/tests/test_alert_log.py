"""
The alert history: what a shift arriving at 08:00 can read about 03:00.

The point of the log is the case where nobody saw the message — the phone was on
silent, the token was wrong, the server was restarted — so it has to survive a
restart, keep whether an alert was actually delivered, and never cost an alert
when the log itself cannot be written.
"""

import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

from app.services.alert_log import AlertLog
from app.services.alerting import (
    BEAM_CURRENT, BOARD_FAILURE, STALLED_BUFFERS, AlertManager, AlertSources)


class FakeTransport:
    enabled = True

    def __init__(self, works=True):
        self.works = works
        self.messages = []

    def is_configured(self):
        return True

    def format(self, title, lines):
        return f"{title}: " + " | ".join(lines)

    def send_message(self, message):
        self.messages.append(message)
        return self.works


class AlertLogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='webdaq-alertlog-')
        self.cwd = os.getcwd()
        os.chdir(self.tmp)
        self.log = AlertLog()

    def tearDown(self):
        os.chdir(self.cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def stored(self):
        with open(os.path.join(self.tmp, 'conf', 'alert_log.json')) as f:
            return json.load(f)['events']

    def test_an_event_keeps_what_happened_and_who_got_it(self):
        self.log.record('alert', 'Board failure', ['Board 0: FAIL flag'],
                        rule_type=BOARD_FAILURE, subject='0', run_number=42,
                        deliveries={'telegram': True, 'zulip': False})

        event = self.log.list_events()[0]
        self.assertEqual(event['kind'], 'alert')
        self.assertEqual(event['title'], 'Board failure')
        self.assertEqual(event['subject'], '0')
        self.assertEqual(event['run_number'], 42)
        self.assertEqual(event['deliveries'], {'telegram': True, 'zulip': False})
        self.assertFalse(event['seen'])
        self.assertTrue(event['at'] > 0)

    def test_the_history_survives_a_restart(self):
        self.log.record('alert', 'Beam current', ['1 µA'], rule_type=BEAM_CURRENT)
        again = AlertLog()

        self.assertEqual([e['title'] for e in again.list_events()], ['Beam current'])
        self.assertEqual(len(self.stored()), 1)

    def test_the_newest_events_come_first_and_old_ones_fall_off(self):
        log = AlertLog(max_events=5)
        for i in range(8):
            log.record('alert', f'alert {i}')

        titles = [e['title'] for e in log.list_events()]
        self.assertEqual(titles, ['alert 7', 'alert 6', 'alert 5', 'alert 4', 'alert 3'])
        self.assertEqual(len(log.events), 5)

    def test_unseen_counting_and_marking(self):
        first = self.log.record('alert', 'one')
        self.log.record('alert', 'two')
        self.assertEqual(self.log.unseen_count(), 2)

        self.assertEqual(self.log.mark_seen([first['id']]), 1)
        self.assertEqual(self.log.unseen_count(), 1)

        self.assertEqual(self.log.mark_seen(), 1)       # the rest
        self.assertEqual(self.log.unseen_count(), 0)
        self.assertEqual(self.log.mark_seen(), 0)       # nothing left to mark

    def test_the_summary_says_what_the_bell_needs(self):
        self.log.record('alert', 'delivered', deliveries={'telegram': True})
        self.log.record('alert', 'reached nobody', deliveries={'telegram': False})

        summary = self.log.summary()
        self.assertEqual(summary['unseen'], 2)
        self.assertEqual(summary['total'], 2)
        self.assertEqual(summary['undelivered'], 1)
        self.assertEqual(summary['latest']['title'], 'reached nobody')

    def test_events_can_be_filtered_by_kind_and_to_the_unseen(self):
        alert = self.log.record('alert', 'a problem')
        self.log.record('recovery', 'back to normal')
        self.log.mark_seen([alert['id']])

        self.assertEqual([e['title'] for e in self.log.list_events(kind='recovery')],
                         ['back to normal'])
        self.assertEqual([e['title'] for e in self.log.list_events(unseen_only=True)],
                         ['back to normal'])

    def test_a_corrupt_log_is_not_fatal(self):
        os.makedirs('conf', exist_ok=True)
        with open('conf/alert_log.json', 'w') as f:
            f.write('{not json at all')

        log = AlertLog()
        self.assertEqual(log.list_events(), [])
        log.record('alert', 'still works')
        self.assertEqual(len(log.list_events()), 1)

    def test_a_log_that_cannot_be_written_does_not_raise(self):
        with mock.patch('json.dump', side_effect=OSError('disk full')):
            event = self.log.record('alert', 'the disk is full')

        self.assertEqual(event['title'], 'the disk is full')
        self.assertEqual(len(self.log.list_events()), 1)

    def test_clearing_empties_the_history(self):
        self.log.record('alert', 'one')
        self.assertEqual(self.log.clear(), 1)
        self.assertEqual(self.log.list_events(), [])
        self.assertEqual(self.stored(), [])


class AlertsAreLoggedTests(unittest.TestCase):
    """Every alert and recovery the manager raises reaches the history."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='webdaq-alertlog-mgr-')
        self.cwd = os.getcwd()
        os.chdir(self.tmp)

        self.now = 5000.0
        self.telegram = FakeTransport()
        self.diagnostics = {'0': {'buffers_read': 100, 'board_failures': 0}}
        self.mgr = AlertManager(
            sources=AlertSources(board_diagnostics=lambda: self.diagnostics,
                                 is_running=lambda: True,
                                 run_number=lambda: 77,
                                 beam_current=lambda: None,
                                 metric_value=lambda path: None),
            transports={'telegram': self.telegram},
            clock=lambda: self.now)
        self.mgr.rules = []

        from app.services import alert_log as module
        module._log = None                       # a fresh log in this temp dir
        self.log = module.get_alert_log()
        self.addCleanup(setattr, module, '_log', None)

    def tearDown(self):
        os.chdir(self.cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_a_board_failure_is_logged_with_its_run_and_delivery(self):
        self.mgr.add_rule({'type': BOARD_FAILURE, 'transports': ['telegram']})

        self.mgr.board_failure('1', 'Board FAIL flag (2 data blocks)', 77)

        event = self.log.list_events()[0]
        self.assertEqual(event['kind'], 'alert')
        self.assertEqual(event['subject'], '1')
        self.assertEqual(event['rule_type'], BOARD_FAILURE)
        self.assertEqual(event['run_number'], 77)
        self.assertEqual(event['deliveries'], {'telegram': True})
        self.assertTrue(any('2 data blocks' in line for line in event['lines']))

    def test_an_alert_nobody_received_is_still_in_the_history(self):
        # The point of the log: the message failed, the record did not.
        self.telegram.works = False
        self.mgr.add_rule({'type': BOARD_FAILURE, 'transports': ['telegram']})

        self.mgr.board_failure('0', 'Board FAIL flag', 77)

        event = self.log.list_events()[0]
        self.assertEqual(event['deliveries'], {'telegram': False})
        self.assertEqual(self.log.summary()['undelivered'], 1)

    def test_a_recovery_is_logged_too(self):
        self.mgr.add_rule({'type': STALLED_BUFFERS, 'transports': ['telegram'],
                           'params': {'seconds': 5}})
        self.mgr.evaluate()
        self.now += 10.0
        self.mgr.evaluate()                      # stalled -> alert
        self.diagnostics['0']['buffers_read'] += 50
        self.now += 2.0
        self.mgr.evaluate()                      # reading again -> recovery

        kinds = [(e['kind'], e['title']) for e in self.log.list_events()]
        self.assertEqual(kinds[0][0], 'recovery')
        self.assertEqual(kinds[1][0], 'alert')

    def test_a_broken_log_does_not_stop_the_alert(self):
        self.mgr.add_rule({'type': BOARD_FAILURE, 'transports': ['telegram']})
        with mock.patch.object(self.log, 'record', side_effect=RuntimeError('no disk')):
            sent = self.mgr.board_failure('0', 'Board FAIL flag', 77)

        self.assertEqual(len(sent), 1)
        self.assertEqual(len(self.telegram.messages), 1)


if __name__ == '__main__':
    unittest.main()
