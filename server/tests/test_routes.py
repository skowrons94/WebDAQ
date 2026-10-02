"""
The HTTP surface, driven through Flask's test client in TEST_FLAG mode.

These are the contracts the frontend depends on: which status code comes back,
and what the body says when something is refused. They run without hardware and
without a Graphite server.
"""

import json
import os
import unittest

os.environ.setdefault('TEST_FLAG', 'True')

from app import create_app                      # noqa: E402
from app.utils.jwt_utils import generate_token  # noqa: E402


class RouteTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = create_app()
        with cls.app.app_context():
            cls.token = generate_token(1)
        cls.client = cls.app.test_client()
        cls.auth = {'Authorization': f'Bearer {cls.token}'}

    def get(self, url, **kwargs):
        return self.client.get(url, headers=self.auth, **kwargs)

    def post(self, url, payload=None, **kwargs):
        return self.client.post(url, headers=self.auth, json=payload, **kwargs)


class AuthenticationTests(RouteTestCase):
    def test_endpoints_require_a_token(self):
        for url in ('/digitizer/scan', '/digitizer/boards', '/elog/entries', '/grafana/settings',
                    '/grafana/alert-rules',
                    '/notifications/transports', '/notifications/rules',
                    '/notifications/status', '/experiment/board_diagnostics',
                    '/notifications/events', '/notifications/events/summary',
                    '/recovery/actions',
                    '/data/runs/1/stats',
                    '/stats/paths', '/stats/connection'):
            response = self.client.get(url)
            self.assertEqual(response.status_code, 401, f'{url} is unauthenticated')


class CurrentHistoryRouteTests(RouteTestCase):
    def test_recent_history_has_real_timestamps_and_values(self):
        import time

        time.sleep(0.2)
        response = self.get('/current/history?seconds=30')
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertIn('sample_interval_s', body)
        self.assertIn('channel', body)
        self.assertTrue(body['samples'])
        timestamp, value = body['samples'][-1]
        self.assertLess(abs(time.time() - timestamp), 2.0)
        self.assertIsInstance(value, float)

    def test_history_rejects_an_invalid_range(self):
        response = self.get('/current/history?seconds=not-a-number')
        self.assertEqual(response.status_code, 400)


class BoardScanRouteTests(RouteTestCase):
    def wait_for_idle(self, timeout=15.0):
        import time
        deadline = time.time() + timeout
        while time.time() < deadline:
            status = self.get('/digitizer/scan').get_json()
            if status['status'] != 'running':
                return status
            time.sleep(0.05)
        self.fail('scan did not finish')

    def test_status_is_available_before_any_scan(self):
        status = self.get('/digitizer/scan').get_json()
        self.assertIn(status['status'], ('idle', 'done', 'cancelled', 'error'))
        self.assertIn('progress', status)

    def test_a_scan_runs_and_reports_boards(self):
        response = self.post('/digitizer/scan',
                             {'usb': {'enabled': True, 'links': 2},
                              'optical': {'enabled': True, 'links': 1, 'nodes': 2}})
        self.assertEqual(response.status_code, 202)
        status = self.wait_for_idle()

        self.assertEqual(status['status'], 'done')
        self.assertTrue(status['found'], 'the scan reported no boards at all')
        for board in status['found']:
            for field in ('model', 'link_type', 'link_num', 'id', 'vme',
                          'already_configured'):
                self.assertIn(field, board)

    def test_a_board_already_added_is_reported_as_such(self):
        # The working directory this suite runs in has one board on USB link 0,
        # so the scan must recognise it instead of probing a handle that is
        # already open.
        boards = self.get('/digitizer/boards').get_json()
        if not boards:
            self.skipTest('no board configured in this working directory')

        self.post('/digitizer/scan', {'usb': {'enabled': True, 'links': 2}})
        status = self.wait_for_idle()
        configured = [b for b in status['found'] if b['already_configured']]
        self.assertTrue(configured, 'the configured board was not reported')
        self.assertEqual(configured[0]['link_type'], 'USB')

    def test_scanning_nothing_is_a_bad_request(self):
        response = self.post('/digitizer/scan', {})
        self.assertEqual(response.status_code, 400)
        self.assertIn('message', response.get_json())

    def test_an_oversized_vme_range_is_refused(self):
        response = self.post('/digitizer/scan', {
            'vme': {'enabled': True, 'link_type': 'Optical', 'link_num': '0',
                    'start': '0', 'end': 'FFFF0000', 'step': '10000'}})
        self.assertEqual(response.status_code, 400)
        self.assertIn('limit', response.get_json()['message'])

    def test_scanning_is_refused_during_a_run(self):
        from app.services.daq_manager import get_daq_manager
        daq = get_daq_manager(test_flag=True)
        daq.daq_state['running'] = True
        try:
            response = self.post('/digitizer/scan', {'usb': {'enabled': True, 'links': 1}})
            self.assertEqual(response.status_code, 409)
            self.assertIn('run', response.get_json()['message'].lower())
        finally:
            daq.daq_state['running'] = False

    def test_cancelling_without_a_scan(self):
        self.wait_for_idle()
        response = self.post('/digitizer/scan/cancel')
        self.assertEqual(response.status_code, 409)


class OnlineTuningRouteTests(RouteTestCase):
    """/digitizer/<id>/setting/<key> — the tuner's write path."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        boards = cls.client.get('/digitizer/boards', headers=cls.auth).get_json()
        cls.board_id = str(boards[0]['id']) if boards else None

    def setUp(self):
        if self.board_id is None:
            self.skipTest('no board configured in this working directory')

    def test_the_allowlist_is_published_for_the_board(self):
        response = self.get(f'/digitizer/{self.board_id}/online_registers')
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertIn('dpp', body)
        self.assertTrue(body['registers'])

    def test_a_safe_register_is_saved_and_written(self):
        response = self.post(f'/digitizer/{self.board_id}/setting/reg_1060',
                             {'value': 120, 'online': True})
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertTrue(body['saved'])
        self.assertTrue(body['written'])
        self.assertEqual(body['value'], hex(120))

    def test_a_structural_register_is_saved_but_not_written(self):
        response = self.post(f'/digitizer/{self.board_id}/setting/reg_1020',
                             {'value': 600, 'online': True})
        body = response.get_json()
        self.assertTrue(body['saved'])
        self.assertFalse(body['written'])
        self.assertIn('Record Length', body['reason'])

    def test_without_online_nothing_reaches_the_board(self):
        response = self.post(f'/digitizer/{self.board_id}/setting/reg_1060',
                             {'value': 130, 'online': False})
        body = response.get_json()
        self.assertTrue(body['saved'])
        self.assertFalse(body['written'])

    def test_an_unknown_register_is_not_found(self):
        response = self.post(f'/digitizer/{self.board_id}/setting/reg_dead',
                             {'value': 1, 'online': True})
        self.assertEqual(response.status_code, 404)

    def test_a_non_numeric_value_is_a_bad_request(self):
        response = self.post(f'/digitizer/{self.board_id}/setting/reg_1060',
                             {'value': 'abc', 'online': False})
        self.assertEqual(response.status_code, 400)

    def test_a_negative_value_is_a_bad_request(self):
        response = self.post(f'/digitizer/{self.board_id}/setting/reg_1060',
                             {'value': -5, 'online': False})
        self.assertEqual(response.status_code, 400)

    def test_a_missing_value_is_a_bad_request(self):
        response = self.post(f'/digitizer/{self.board_id}/setting/reg_1060', {})
        self.assertEqual(response.status_code, 400)


class ElogRouteTests(RouteTestCase):
    """Without a configured logbook, every read must fail in a readable way."""

    def test_settings_report_whether_py_elog_is_installed(self):
        body = self.get('/elog/settings').get_json()
        self.assertIn('available', body)
        self.assertIn('configured', body)
        self.assertNotIn('password_plain', body)

    def test_listing_without_a_logbook_is_a_gateway_error(self):
        response = self.get('/elog/entries')
        self.assertEqual(response.status_code, 502)
        self.assertIn('message', response.get_json())

    def test_an_empty_entry_is_refused_before_reaching_elog(self):
        response = self.post('/elog/entries', {'text': '   '})
        self.assertEqual(response.status_code, 400)

    def test_bad_pagination_is_a_bad_request(self):
        self.assertEqual(self.get('/elog/entries?limit=abc').status_code, 400)

    def test_a_foreign_attachment_host_is_refused(self):
        response = self.get('/elog/attachment?url=https://evil.example.com/x.png')
        self.assertEqual(response.status_code, 502)


class NotificationRouteTests(RouteTestCase):
    """The screens in Settings -> Notifications talk to these."""

    def test_transports_are_listed_with_their_secrets_masked(self):
        response = self.get('/notifications/transports')
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertIn('telegram', body)
        self.assertIn('zulip', body)
        for transport in body.values():
            self.assertIn('configured', transport)

    def test_a_zulip_key_is_stored_but_never_returned(self):
        response = self.post('/notifications/transports/zulip', {
            'site': 'chat.example.org', 'bot_email': 'bot@example.org',
            'api_key': 'super-secret', 'stream': 'LUNA DAQ'})
        self.assertEqual(response.status_code, 200)
        settings = response.get_json()['settings']
        self.assertEqual(settings['site'], 'https://chat.example.org')
        self.assertNotIn('super-secret', json.dumps(settings))

    def test_testing_an_unknown_transport_is_refused(self):
        response = self.post('/notifications/transports/carrier-pigeon/test')
        self.assertEqual(response.status_code, 400)

    def test_rules_round_trip_through_the_api(self):
        created = self.post('/notifications/rules', {
            'type': 'beam_current', 'transports': ['telegram'],
            'params': {'comparison': 'below', 'threshold': 5, 'seconds': 10}})
        self.assertEqual(created.status_code, 201)
        rule_id = created.get_json()['rule']['id']

        listed = self.get('/notifications/rules')
        self.assertEqual(listed.status_code, 200)
        body = listed.get_json()
        self.assertIn(rule_id, [r['id'] for r in body['rules']])
        self.assertTrue(body['types'])          # the UI offers these
        self.assertIn('rules', body['status'])

        updated = self.client.put(f'/notifications/rules/{rule_id}', headers=self.auth,
                                  json={'params': {'threshold': 8}})
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.get_json()['rule']['params']['threshold'], 8.0)

        deleted = self.client.delete(f'/notifications/rules/{rule_id}', headers=self.auth)
        self.assertEqual(deleted.status_code, 200)
        self.assertNotIn(rule_id, [r['id'] for r in
                                   self.get('/notifications/rules').get_json()['rules']])

    def test_a_rule_the_operator_has_to_fix_is_refused_with_a_reason(self):
        response = self.post('/notifications/rules',
                             {'type': 'graphite_metric', 'params': {'metric': ''}})
        self.assertEqual(response.status_code, 400)
        self.assertIn('metric path', response.get_json()['error'])

    def test_editing_a_rule_that_does_not_exist_is_refused(self):
        response = self.client.put('/notifications/rules/nope', headers=self.auth,
                                   json={'enabled': False})
        self.assertEqual(response.status_code, 400)

    def test_board_diagnostics_are_empty_between_runs(self):
        response = self.get('/experiment/board_diagnostics')
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertFalse(body['running'])
        self.assertEqual(body['boards'], {})
        self.assertIn('fail_meaning', body)


class ActivityRouteTests(RouteTestCase):
    """The bell in the header and the history page talk to these."""

    def test_the_history_and_its_summary_are_served_together(self):
        response = self.get('/notifications/events')
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertIn('events', body)
        for key in ('unseen', 'total', 'undelivered', 'latest'):
            self.assertIn(key, body['summary'])

    def test_the_summary_alone_is_cheap_to_poll(self):
        response = self.get('/notifications/events/summary')
        self.assertEqual(response.status_code, 200)
        self.assertIn('unseen', response.get_json())

    def test_events_can_be_marked_seen_and_cleared(self):
        from app.services.alert_log import get_alert_log
        log = get_alert_log()
        log.record('alert', 'something happened', ['a detail'],
                   deliveries={'telegram': False})
        self.assertGreaterEqual(self.get('/notifications/events/summary')
                                .get_json()['unseen'], 1)

        marked = self.post('/notifications/events/seen')
        self.assertEqual(marked.status_code, 200)
        self.assertEqual(marked.get_json()['summary']['unseen'], 0)

        cleared = self.client.delete('/notifications/events', headers=self.auth)
        self.assertEqual(cleared.status_code, 200)
        self.assertEqual(self.get('/notifications/events').get_json()['events'], [])

    def test_plausible_but_wrong_json_is_refused_not_a_500(self):
        # A script or a hand-written curl gets a reason, not a crash — and never a
        # 401/422, which the browser reads as its own session expiring.
        cases = [
            ('/notifications/rules', [1, 2]),
            ('/notifications/rules', 'a rule'),
        ]
        for url, body in cases:
            response = self.client.post(url, headers=self.auth, json=body)
            self.assertEqual(response.status_code, 400, f'{url} with {body!r}')

        created = self.post('/notifications/rules', {'type': 'board_failure'})
        rule_id = created.get_json()['rule']['id']
        for body in ({'params': 'nope'}, {'transports': 5}):
            response = self.client.put(f'/notifications/rules/{rule_id}',
                                       headers=self.auth, json=body)
            self.assertEqual(response.status_code, 400, f'PUT with {body!r}')
        self.client.delete(f'/notifications/rules/{rule_id}', headers=self.auth)

    def test_a_numeric_chat_id_is_accepted_and_the_switch_is_not_half_applied(self):
        response = self.post('/notifications/transports/telegram',
                             {'enabled': False, 'chat_id': -1001234567890})
        self.assertEqual(response.status_code, 200)
        settings = response.get_json()['settings']
        self.assertEqual(settings['chat_id'], '-1001234567890')
        self.assertIs(settings['enabled'], False)

    def test_an_enabled_flag_given_as_a_string_is_still_a_boolean(self):
        response = self.post('/notifications/transports/telegram', {'enabled': 'false'})
        self.assertIs(response.get_json()['settings']['enabled'], True)  # non-empty string
        self.post('/notifications/transports/telegram', {'enabled': False})

    def test_marking_an_empty_list_marks_nothing(self):
        from app.services.alert_log import get_alert_log
        log = get_alert_log()
        log.mark_seen()
        log.record('alert', 'something', ['detail'])

        response = self.post('/notifications/events/seen', {'ids': []})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['marked'], 0)
        self.assertEqual(response.get_json()['summary']['unseen'], 1)
        log.mark_seen()

    def test_an_alert_with_no_destination_counts_as_undelivered(self):
        from app.services.alert_log import get_alert_log
        log = get_alert_log()
        log.mark_seen()
        log.record('alert', 'nobody asked to hear this', ['detail'], deliveries={})

        summary = self.get('/notifications/events/summary').get_json()
        self.assertEqual(summary['undelivered'], 1)
        log.mark_seen()

    def test_a_bad_id_list_is_refused(self):
        for ids in ('not-a-list', [{}], [1, 2]):
            response = self.post('/notifications/events/seen', {'ids': ids})
            self.assertEqual(response.status_code, 400, f'ids={ids!r}')

    def test_the_watcher_can_be_started_and_stopped_from_the_page(self):
        # A backend started without main.py would otherwise watch nothing, with no
        # way out of it from the UI.
        started = self.post('/notifications/watcher', {'action': 'start'})
        self.assertEqual(started.status_code, 200)
        self.assertTrue(started.get_json()['status']['watching'])

        stopped = self.post('/notifications/watcher', {'action': 'stop'})
        self.assertEqual(stopped.status_code, 200)
        self.assertFalse(stopped.get_json()['status']['watching'])

    def test_a_nonsense_watcher_action_is_refused(self):
        response = self.post('/notifications/watcher', {'action': 'hibernate'})
        self.assertEqual(response.status_code, 400)

    def test_recovery_actions_are_listed_with_their_state(self):
        response = self.get('/recovery/actions')
        self.assertEqual(response.status_code, 200)
        actions = response.get_json()['actions']
        self.assertTrue(actions)
        names = {a['name'] for a in actions}
        self.assertEqual(names, {'boards', 'acquisition', 'current', 'stats', 'graphite'})
        for action in actions:
            for key in ('label', 'description', 'ok', 'detail', 'enabled'):
                self.assertIn(key, action)

    def test_an_unknown_recovery_action_is_refused(self):
        response = self.post('/recovery/actions/make-coffee')
        self.assertEqual(response.status_code, 400)
        self.assertIn('Unknown recovery action', response.get_json()['message'])

    def test_a_recovery_action_answers_in_words(self):
        # Graphite is not reachable from the test environment: it must say so
        # rather than fail the request.
        response = self.post('/recovery/actions/graphite')
        self.assertIn(response.status_code, (200, 400))
        body = response.get_json()
        self.assertIn('success', body)
        self.assertTrue(body['message'])


class StatsRouteTests(RouteTestCase):
    def test_connection_reports_the_configured_server(self):
        body = self.get('/stats/connection').get_json()
        self.assertIn('reachable', body)
        self.assertIn('host', body)
        self.assertIsInstance(body['reachable'], bool)

    def test_browsing_an_unreachable_server_yields_an_empty_tree(self):
        body = self.get('/stats/browse').get_json()
        self.assertIn('nodes', body)
        self.assertIsInstance(body['nodes'], list)

    def test_metric_paths_round_trip_with_name_and_unit(self):
        path = 'test.suite.metric'
        self.client.delete(f'/stats/paths/{path}', headers=self.auth)
        try:
            response = self.post('/stats/paths',
                                 {'path': path, 'alias': 'Suite metric', 'unit': 'kV'})
            self.assertEqual(response.status_code, 201)

            entries = self.get('/stats/paths').get_json()
            entry = next(e for e in entries if e['path'] == path)
            self.assertEqual(entry['alias'], 'Suite metric')
            self.assertEqual(entry['unit'], 'kV')

            self.client.put(f'/stats/paths/{path}', headers=self.auth,
                            json={'alias': 'Renamed', 'unit': 'MV'})
            entries = self.get('/stats/paths').get_json()
            entry = next(e for e in entries if e['path'] == path)
            self.assertEqual(entry['alias'], 'Renamed')
            self.assertEqual(entry['unit'], 'MV')
        finally:
            self.client.delete(f'/stats/paths/{path}', headers=self.auth)

    def test_adding_a_metric_without_a_path_is_refused(self):
        response = self.post('/stats/paths', {'alias': 'No path'})
        self.assertEqual(response.status_code, 400)


if __name__ == '__main__':
    unittest.main()
