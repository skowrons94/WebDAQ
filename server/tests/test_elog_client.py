"""
ELOG client: settings handling and the guards around them.

The ELOG server itself is not contacted here — what matters is that a password
never travels back to the browser, that a missing py_elog is reported as such,
and that the attachment proxy cannot be pointed at an arbitrary host.
"""

import json
import os
import shutil
import tempfile
import unittest

from app.services.elog_client import ElogClient, ElogError


class ElogSettingsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='webdaq-elog-')
        self.cwd = os.getcwd()
        os.chdir(self.tmp)
        self.client = ElogClient()

    def tearDown(self):
        os.chdir(self.cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def stored(self):
        with open(os.path.join(self.tmp, 'conf', 'elog_settings.json')) as f:
            return json.load(f)

    def test_settings_are_persisted(self):
        self.client.set_settings(enabled=True, url='https://elog.example.org/elogs/LUNA/',
                                 user='daq', password='secret',
                                 default_attributes={'Category': 'Shift'})
        stored = self.stored()
        self.assertTrue(stored['enabled'])
        self.assertEqual(stored['url'], 'https://elog.example.org/elogs/LUNA/')
        self.assertEqual(stored['user'], 'daq')
        self.assertEqual(stored['default_attributes'], {'Category': 'Shift'})

    def test_the_password_is_never_returned(self):
        self.client.set_settings(url='https://elog.example.org/x/', user='daq',
                                 password='secret')
        settings = self.client.get_settings()
        self.assertNotIn('secret', json.dumps(settings))
        self.assertEqual(settings['password'], '*' * len('secret'))

    def test_an_empty_password_keeps_the_stored_one(self):
        # The form only ever receives a mask, so saving it back must not wipe
        # the real password.
        self.client.set_settings(url='https://elog.example.org/x/', password='secret')
        self.client.set_settings(url='https://elog.example.org/y/', password='')
        self.assertEqual(self.stored()['password'], 'secret')
        self.assertEqual(self.stored()['url'], 'https://elog.example.org/y/')

    def test_settings_survive_a_restart(self):
        self.client.set_settings(url='https://elog.example.org/x/', user='daq',
                                 password='secret', enabled=True)
        reloaded = ElogClient()
        self.assertEqual(reloaded.url, 'https://elog.example.org/x/')
        self.assertEqual(reloaded.password, 'secret')
        self.assertTrue(reloaded.enabled)

    def test_test_connection_without_a_url_says_so(self):
        result = self.client.test_connection()
        self.assertFalse(result['success'])
        self.assertIn('No ELOG URL', result['message'])

    def test_reading_without_a_url_is_an_actionable_error(self):
        with self.assertRaises(ElogError) as ctx:
            self.client.list_entries()
        self.assertIn('Settings', str(ctx.exception))

    def test_posting_while_disabled_is_refused(self):
        self.client.set_settings(url='https://elog.example.org/x/', enabled=False)
        with self.assertRaises(ElogError) as ctx:
            self.client.post_entry('text', {'Author': 'someone'})
        self.assertIn('switched off', str(ctx.exception))

    def test_attachments_from_another_host_are_refused(self):
        self.client.set_settings(url='https://elog.example.org/elogs/LUNA/')
        with self.assertRaises(ElogError) as ctx:
            self.client.download_attachment('https://elsewhere.example.com/secret.png')
        self.assertIn('does not belong', str(ctx.exception))

    def test_an_empty_attachment_url_is_refused(self):
        self.client.set_settings(url='https://elog.example.org/elogs/LUNA/')
        with self.assertRaises(ElogError):
            self.client.download_attachment('')

    def test_changing_settings_drops_the_cached_connection(self):
        self.client._logbook = object()
        self.client.set_settings(url='https://elog.example.org/other/')
        self.assertIsNone(self.client._logbook)


if __name__ == '__main__':
    unittest.main()
