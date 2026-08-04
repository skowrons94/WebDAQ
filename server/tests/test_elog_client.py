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

from app.services.elog_client import ElogClient, ElogError, to_latin1


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


class Latin1Tests(unittest.TestCase):
    """
    ELOG is a latin-1 protocol and py_elog encodes with it unconditionally, so a
    single unrepresentable character used to lose the whole entry. Everything
    that survives this must be encodable; nothing already valid may change.
    """

    def assertPostable(self, text):
        cleaned = to_latin1(text)
        cleaned.encode('iso-8859-1')      # raises if the entry would still fail
        return cleaned

    def test_text_ELOG_can_already_carry_is_untouched(self):
        for text in ('plain ascii', 'Riccardo Gesuè', '25 °C at 5 µA', ''):
            self.assertEqual(to_latin1(text), text)

    def test_the_greek_mu_typed_for_microamps_becomes_u(self):
        self.assertEqual(self.assertPostable('beam 5 μA'), 'beam 5 uA')

    def test_typographic_punctuation_is_folded(self):
        self.assertEqual(self.assertPostable('run 850–851'), 'run 850-851')
        self.assertEqual(self.assertPostable('it’s fine'), "it's fine")
        self.assertEqual(self.assertPostable('“quoted”'), '"quoted"')

    def test_maths_and_arrows_are_spelled_out(self):
        self.assertEqual(self.assertPostable('A → B'), 'A -> B')
        self.assertEqual(self.assertPostable('≈ 3 keV'), '~ 3 keV')

    def test_an_unmapped_character_never_blocks_the_entry(self):
        # A lossy entry still beats a refused one.
        self.assertPostable('detector 中文 label')

    def test_non_strings_pass_through(self):
        self.assertEqual(to_latin1(7), 7)


class FormParsingTests(unittest.TestCase):
    """
    The composer learns a logbook's fields from the logbook's own entry page.
    Getting this wrong is how an entry is rejected for a missing required
    attribute, so the shapes ELOG actually emits are pinned down here.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='webdaq-elog-')
        self.cwd = os.getcwd()
        os.chdir(self.tmp)
        self.client = ElogClient()

    def tearDown(self):
        os.chdir(self.cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    SELECT_FORM = '''
    <tr><td nowrap width="10%" class="attribname">Entry time:</td><td class="attribvalue">Tue Aug 4</td></tr>
    <tr><td nowrap class="attribname">Category<font color=red>*</font>:</td>
    <td class="attribvalue">
    <select name="Category" onChange="cond_submit()">
    <option value="">- please select -
    <option value="Measurement Beam ON">Measurement Beam ON
    <option value="Setup">Setup
    </select></td></tr>
    <tr><td colspan=2 id="TextParent"><textarea name="Text"></textarea></td></tr>
    '''

    MIXED_FORM = '''
    <tr><td nowrap class="attribname">Author:</td>
    <td class="attribvalue">Federico<input type="hidden" name="Author" value="Federico"></td></tr>
    <tr><td nowrap class="attribname">Operators:</td>
    <td class="attribvalue"><input type="text" name="Operators" value="shift crew"></td></tr>
    <tr><td nowrap class="attribname">Type:</td>
    <td class="attribvalue">
    <input type=radio name="Type" value="Setup"><label>Setup</label>
    <input type=radio name="Type" value="Background"><label>Background</label>
    <input type=submit name="extend_2" value="Add Type"></td></tr>
    <tr><td nowrap class="attribname">Attachment 1:</td>
    <td class="attribvalue"><input type=file name="attfile"></td></tr>
    <tr><td colspan=2 id="TextParent"><textarea name="Text"></textarea></td></tr>
    '''

    def test_a_required_dropdown_is_read_with_its_options(self):
        fields = self.client._parse_form(self.SELECT_FORM)
        self.assertEqual(len(fields), 1)
        category = fields[0]
        self.assertEqual(category['name'], 'Category')
        self.assertEqual(category['type'], 'select')
        self.assertTrue(category['required'])
        # The placeholder is not a value the logbook accepts.
        self.assertEqual(category['options'], ['Measurement Beam ON', 'Setup'])

    def test_a_field_that_reloads_the_form_is_marked_conditional(self):
        self.assertTrue(self.client._parse_form(self.SELECT_FORM)[0]['conditional'])

    def test_elogs_own_rows_are_not_offered_as_fields(self):
        names = [f['name'] for f in self.client._parse_form(self.MIXED_FORM)]
        self.assertNotIn('attfile', names)          # the upload slot
        self.assertNotIn('extend_2', names)         # the "Add Type" button
        self.assertEqual(names, ['Author', 'Operators', 'Type'])

    def test_field_types_are_distinguished(self):
        by_name = {f['name']: f for f in self.client._parse_form(self.MIXED_FORM)}
        # ELOG binds Author to the login, so it must not be an editable box.
        self.assertEqual(by_name['Author']['type'], 'fixed')
        self.assertEqual(by_name['Author']['value'], 'Federico')
        self.assertEqual(by_name['Operators']['type'], 'text')
        self.assertEqual(by_name['Type']['type'], 'radio')
        self.assertEqual(by_name['Type']['options'], ['Setup', 'Background'])

    def test_a_label_keeps_the_human_name_the_attribute_is_stored_under(self):
        form = ('<tr><td class="attribname">Livetime (s):</td>'
                '<td class="attribvalue"><input type="text" name="Livetime__s_"></td></tr>'
                '<tr><td id="TextParent"></td></tr>')
        field = self.client._parse_form(form)[0]
        self.assertEqual(field['label'], 'Livetime (s)')
        self.assertEqual(field['name'], 'Livetime__s_')

    def test_an_unparseable_page_yields_no_fields_rather_than_raising(self):
        self.assertEqual(self.client._parse_form('<html>not a form</html>'), [])


if __name__ == '__main__':
    unittest.main()
