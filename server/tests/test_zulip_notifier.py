"""
The Zulip transport: settings handling and what reaches the API.
"""

import io
import json
import os
import shutil
import tempfile
import unittest
import urllib.error
from unittest import mock

from app.services.zulip_notifier import DEFAULT_TOPIC, ZulipNotifier


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def http_error(code, body=b'{}'):
    return urllib.error.HTTPError('https://chat.example.org', code, 'error', {},
                                  io.BytesIO(body))


def ok():
    return FakeResponse(b'{"result": "success", "id": 42}')


class ZulipSettingsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='webdaq-zulip-')
        self.cwd = os.getcwd()
        os.chdir(self.tmp)
        self.zulip = ZulipNotifier()

    def tearDown(self):
        os.chdir(self.cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def stored(self):
        with open(os.path.join(self.tmp, 'conf', 'zulip_settings.json')) as f:
            return json.load(f)

    def configure(self, **overrides):
        settings = dict(enabled=True, site='https://chat.example.org',
                        bot_email='webdaq-bot@chat.example.org', api_key='key',
                        stream='LUNA DAQ', topic='alerts')
        settings.update(overrides)
        self.zulip.set_settings(**settings)

    def test_starts_unconfigured_and_disabled(self):
        self.assertFalse(self.zulip.enabled)
        self.assertFalse(self.zulip.is_configured())
        self.assertFalse(self.zulip.get_settings()['configured'])

    def test_settings_survive_a_restart(self):
        self.configure()
        again = ZulipNotifier()

        self.assertEqual(again.site, 'https://chat.example.org')
        self.assertEqual(again.stream, 'LUNA DAQ')
        self.assertEqual(again.topic, 'alerts')
        self.assertEqual(again.api_key, 'key')
        self.assertTrue(again.enabled)
        self.assertEqual(self.stored()['bot_email'], 'webdaq-bot@chat.example.org')

    def test_a_bare_host_gets_https_and_a_trailing_slash_goes(self):
        self.zulip.set_settings(site='chat.example.org/')
        self.assertEqual(self.zulip.site, 'https://chat.example.org')

    def test_the_api_key_is_never_returned(self):
        self.configure(api_key='secret-key')
        self.assertNotIn('secret-key', json.dumps(self.zulip.get_settings()))

    def test_an_empty_key_keeps_the_stored_one_and_clear_removes_it(self):
        self.configure(api_key='secret-key')
        self.zulip.set_settings(api_key='')
        self.assertEqual(self.zulip.api_key, 'secret-key')

        self.zulip.set_settings(clear_api_key=True)
        self.assertEqual(self.zulip.api_key, '')
        self.assertFalse(self.zulip.is_configured())

    def test_an_empty_topic_falls_back_to_the_default(self):
        self.configure(topic='   ')
        self.assertEqual(self.zulip.topic, DEFAULT_TOPIC)


class ZulipDeliveryTests(ZulipSettingsTests):
    def test_a_message_goes_to_the_configured_stream_and_topic(self):
        self.configure()
        with mock.patch('urllib.request.urlopen', return_value=ok()) as urlopen:
            self.assertTrue(self.zulip.send_message('hello'))

        request = urlopen.call_args[0][0]
        self.assertEqual(request.full_url, 'https://chat.example.org/api/v1/messages')
        body = dict(pair.split('=', 1) for pair in
                    request.data.decode().split('&'))
        self.assertEqual(body['type'], 'stream')
        self.assertEqual(body['to'], 'LUNA+DAQ')
        self.assertEqual(body['topic'], 'alerts')
        self.assertEqual(body['content'], 'hello')
        # The bot authenticates with HTTP basic auth, as Zulip's API expects.
        self.assertTrue(request.get_header('Authorization').startswith('Basic '))

    def test_nothing_is_sent_while_disabled_or_unconfigured(self):
        self.configure(enabled=False)
        with mock.patch('urllib.request.urlopen') as urlopen:
            self.assertFalse(self.zulip.send_message('hello'))
        urlopen.assert_not_called()

        self.zulip.set_settings(enabled=True, clear_api_key=True)
        with mock.patch('urllib.request.urlopen') as urlopen:
            self.assertFalse(self.zulip.send_message('hello'))
        urlopen.assert_not_called()

    def test_a_rejected_key_is_reported_without_raising(self):
        self.configure()
        with mock.patch('urllib.request.urlopen',
                        side_effect=http_error(401, b'{"msg": "Invalid API key"}')):
            self.assertFalse(self.zulip.send_message('hello'))

    def test_an_unreachable_site_is_reported_without_raising(self):
        self.configure()
        with mock.patch('urllib.request.urlopen',
                        side_effect=urllib.error.URLError('Name or service not known')):
            self.assertFalse(self.zulip.send_message('hello'))

    def test_an_api_level_refusal_is_not_taken_for_success(self):
        self.configure()
        with mock.patch('urllib.request.urlopen',
                        return_value=FakeResponse(b'{"result": "error", "msg": "no"}')):
            self.assertFalse(self.zulip.send_message('hello'))

    def test_test_connection_sends_even_while_disabled_and_restores_the_flag(self):
        self.configure(enabled=False)
        with mock.patch('urllib.request.urlopen', return_value=ok()) as urlopen:
            result = self.zulip.test_connection()

        urlopen.assert_called_once()
        self.assertTrue(result['success'])
        self.assertIn('LUNA DAQ', result['message'])
        self.assertFalse(self.zulip.enabled)      # unchanged by the test

    def test_test_connection_without_credentials_says_what_is_missing(self):
        result = self.zulip.test_connection()
        self.assertFalse(result['success'])
        self.assertIn('not configured', result['message'])

    def test_alerts_are_rendered_as_zulip_markdown(self):
        message = self.zulip.format('Board failure', ['Board 0: FAIL flag', 'Run: 42'])
        self.assertEqual(message,
                         '**Board failure**\n\n* Board 0: FAIL flag\n* Run: 42')


if __name__ == '__main__':
    unittest.main()
