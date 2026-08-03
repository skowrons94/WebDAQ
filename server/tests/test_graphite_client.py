"""
Graphite client: metric discovery and the reachability check.

Both are tested against fake HTTP responses, because the two Graphite versions
in use answer /metrics/find in different shapes and the client has to survive
either — plus the malformed answers a wrong host produces.
"""

import unittest
from unittest import mock

from app.utils.graphite import GraphiteClient


class FakeResponse:
    def __init__(self, payload, status_code=200, raises_json=False):
        self._payload = payload
        self.status_code = status_code
        self._raises_json = raises_json

    def json(self):
        if self._raises_json:
            raise ValueError('not json')
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f'HTTP {self.status_code}')


class FindMetricsTests(unittest.TestCase):
    def setUp(self):
        self.client = GraphiteClient('graphite.example', 80)

    def find_with(self, payload, **kwargs):
        with mock.patch('app.utils.graphite.requests.get',
                        return_value=FakeResponse(payload, **kwargs)):
            return self.client.find_metrics('*')

    def test_plain_shape_is_understood(self):
        nodes = self.find_with([
            {'path': 'accelerator', 'is_leaf': False},
            {'path': 'accelerator.terminal_voltage', 'is_leaf': True},
        ])
        self.assertEqual(nodes, [
            {'path': 'accelerator', 'is_leaf': False},
            {'path': 'accelerator.terminal_voltage', 'is_leaf': True},
        ])

    def test_treejson_shape_is_understood(self):
        nodes = self.find_with([
            {'id': 'daq', 'text': 'daq', 'leaf': 0, 'expandable': 1},
            {'id': 'daq.rate1', 'text': 'rate1', 'leaf': 1, 'expandable': 0},
        ])
        self.assertEqual(nodes, [
            {'path': 'daq', 'is_leaf': False},
            {'path': 'daq.rate1', 'is_leaf': True},
        ])

    def test_a_node_without_leaf_flags_is_read_from_expandable(self):
        nodes = self.find_with([{'id': 'daq.rate1', 'expandable': 0}])
        self.assertEqual(nodes, [{'path': 'daq.rate1', 'is_leaf': True}])

    def test_results_come_back_sorted(self):
        nodes = self.find_with([
            {'path': 'zeta', 'is_leaf': True},
            {'path': 'alpha', 'is_leaf': True},
        ])
        self.assertEqual([n['path'] for n in nodes], ['alpha', 'zeta'])

    def test_junk_entries_are_skipped_not_fatal(self):
        nodes = self.find_with(['a string', {'no_path': 1}, {'path': 'ok', 'is_leaf': True}])
        self.assertEqual(nodes, [{'path': 'ok', 'is_leaf': True}])

    def test_a_non_list_answer_yields_nothing(self):
        self.assertEqual(self.find_with({'unexpected': 'shape'}), [])

    def test_a_dead_server_yields_nothing_rather_than_raising(self):
        with mock.patch('app.utils.graphite.requests.get', side_effect=OSError('refused')):
            self.assertEqual(self.client.find_metrics('*'), [])


class ConnectionCheckTests(unittest.TestCase):
    def setUp(self):
        self.client = GraphiteClient('graphite.example', 80)

    def check_with(self, **kwargs):
        with mock.patch('app.utils.graphite.requests.get',
                        return_value=FakeResponse(**kwargs)):
            return self.client.check_connection()

    def test_a_graphite_answer_counts_as_reachable(self):
        self.assertTrue(self.check_with(payload=[{'path': 'daq', 'is_leaf': False}]))

    def test_an_empty_but_valid_tree_counts_as_reachable(self):
        self.assertTrue(self.check_with(payload=[]))

    def test_another_web_service_on_the_port_is_not_reachable(self):
        # A wrong port often has *something* listening; answering 200 with HTML
        # is not Graphite, and reporting it as connected hides the mistake.
        self.assertTrue(not self.check_with(payload=None, raises_json=True))

    def test_an_http_error_is_not_reachable(self):
        self.assertFalse(self.check_with(payload=[], status_code=404))

    def test_a_refused_connection_is_not_reachable(self):
        with mock.patch('app.utils.graphite.requests.get', side_effect=OSError('refused')):
            self.assertFalse(self.client.check_connection())


if __name__ == '__main__':
    unittest.main()
