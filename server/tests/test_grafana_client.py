"""
Grafana client: settings handling, and how Grafana's answers reach the browser.
"""

import io
import json
import os
import shutil
import tempfile
import unittest
import urllib.error
from unittest import mock

from app.services.grafana_client import DEFAULT_URL, GrafanaClient, GrafanaError


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def http_error(code, body=b'{}'):
    return urllib.error.HTTPError('http://grafana', code, 'error', {}, io.BytesIO(body))


class GrafanaClientTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='webdaq-grafana-')
        self.cwd = os.getcwd()
        os.chdir(self.tmp)
        self.client = GrafanaClient()

    def tearDown(self):
        os.chdir(self.cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def stored(self):
        with open(os.path.join(self.tmp, 'conf', 'grafana_settings.json')) as f:
            return json.load(f)

    def test_defaults_to_the_previous_hard_coded_address(self):
        self.assertEqual(self.client.get_settings()['url'], DEFAULT_URL)

    def test_settings_survive_a_restart(self):
        self.client.set_settings(url='http://grafana.example:3000/', api_key='glsa_secret')
        again = GrafanaClient()
        self.assertEqual(again.url, 'http://grafana.example:3000')
        self.assertEqual(again.api_key, 'glsa_secret')
        self.assertEqual(self.stored()['api_key'], 'glsa_secret')

    def test_a_bare_host_gets_a_scheme(self):
        self.client.set_settings(url='lunaserver:3000')
        self.assertEqual(self.client.url, 'http://lunaserver:3000')

    def test_the_token_is_never_returned(self):
        self.client.set_settings(api_key='glsa_secret')
        self.assertNotIn('glsa_secret', json.dumps(self.client.get_settings()))

    def test_an_empty_token_keeps_the_stored_one_and_clear_removes_it(self):
        self.client.set_settings(api_key='glsa_secret')
        self.client.set_settings(url='http://other:3000', api_key='')
        self.assertEqual(self.client.api_key, 'glsa_secret')
        self.client.set_settings(clear_api_key=True)
        self.assertEqual(self.client.api_key, '')

    def test_requests_go_to_the_configured_url_with_the_token(self):
        self.client.set_settings(url='http://grafana.example:3000', api_key='glsa_secret')
        with mock.patch('urllib.request.urlopen',
                        return_value=FakeResponse(b'[{"uid": "a"}]')) as urlopen:
            rules = self.client.list_alert_rules()
        req = urlopen.call_args[0][0]
        self.assertEqual(req.full_url,
                         'http://grafana.example:3000/api/v1/provisioning/alert-rules')
        self.assertEqual(req.get_header('Authorization'), 'Bearer glsa_secret')
        self.assertEqual(rules, [{'uid': 'a'}])

    def test_grafana_auth_errors_do_not_look_like_an_expired_webdaq_session(self):
        # The frontend logs out on 401/422; Grafana's refusal must not trigger that.
        with mock.patch('urllib.request.urlopen', side_effect=http_error(401)):
            with self.assertRaises(GrafanaError) as ctx:
                self.client.list_alert_rules()
        self.assertEqual(ctx.exception.status, 502)
        self.assertIn('token', str(ctx.exception))

    def test_a_missing_rule_stays_404(self):
        with mock.patch('urllib.request.urlopen', side_effect=http_error(404)):
            with self.assertRaises(GrafanaError) as ctx:
                self.client.get_alert_rule('abc123')
        self.assertEqual(ctx.exception.status, 404)

    def test_an_unsafe_uid_is_refused_without_a_request(self):
        with mock.patch('urllib.request.urlopen') as urlopen:
            with self.assertRaises(GrafanaError) as ctx:
                self.client.get_alert_rule('../../api/admin')
        urlopen.assert_not_called()
        self.assertEqual(ctx.exception.status, 400)

    def test_an_unreachable_server_is_described(self):
        with mock.patch('urllib.request.urlopen',
                        side_effect=urllib.error.URLError('Connection refused')):
            result = self.client.test_connection()
        self.assertFalse(result['success'])
        self.assertIn('unreachable', result['message'])


if __name__ == '__main__':
    unittest.main()
