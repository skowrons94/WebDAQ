"""utils/board_files.write_json_atomic: complete file, mode kept, no leftovers on failure."""

import json
import os
import stat
import tempfile
import unittest

from app.utils.board_files import write_json_atomic


class WriteJsonAtomicTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, 'V1730_0.json')
        with open(self.path, 'w') as f:
            json.dump({'a': 1}, f)
        os.chmod(self.path, 0o640)

    def test_replaces_the_content_and_keeps_the_mode(self):
        write_json_atomic(self.path, {'a': 2})
        with open(self.path) as f:
            self.assertEqual(json.load(f), {'a': 2})
        self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), 0o640)

    def test_a_symlink_stays_a_symlink(self):
        link = os.path.join(self.dir, 'link.json')
        os.symlink(self.path, link)
        write_json_atomic(link, {'b': 3})
        self.assertTrue(os.path.islink(link))
        with open(self.path) as f:
            self.assertEqual(json.load(f), {'b': 3})

    def test_a_failed_write_leaves_the_file_and_no_temporary(self):
        with self.assertRaises(TypeError):
            write_json_atomic(self.path, {'bad': object()})
        with open(self.path) as f:
            self.assertEqual(json.load(f), {'a': 1})
        self.assertEqual([n for n in os.listdir(self.dir) if n.endswith('.tmp')], [])


if __name__ == '__main__':
    unittest.main()
