"""
A project's app.db is brought to the current schema whatever state it is in.

Each case is a database LunaDAQ has met or can meet in a measurement directory.
They used to stop the project from starting, or — worse — let it start with
the run metadata silently unrecorded ("no such column" on the first run).
scripts/ensure_db.py is what check_db.sh runs at project start; it is run in a
subprocess per case so each gets its own engine.
"""

import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest

SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIGRATIONS = os.path.join(SERVER_DIR, "migrations")
HEAD = "b1c4e7a90f31"

OLD_SCHEMA = """
CREATE TABLE user (id INTEGER NOT NULL PRIMARY KEY, username VARCHAR(64),
                   email VARCHAR(120), password_hash VARCHAR(128));
CREATE TABLE run_metadata (id INTEGER NOT NULL PRIMARY KEY, run_number INTEGER,
    start_time DATETIME, end_time DATETIME, notes TEXT, accumulated_charge FLOAT,
    target_name VARCHAR(64), terminal_voltage FLOAT, probe_voltage FLOAT,
    run_type VARCHAR(64), flag VARCHAR(32), user_id INTEGER);
INSERT INTO run_metadata (id, run_number, notes) VALUES (1, 42, 'old run');
"""
VERSION = "CREATE TABLE alembic_version (version_num VARCHAR(32) PRIMARY KEY);"


class DatabaseRepairTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.tmp.name, "app.db")

    def tearDown(self):
        self.tmp.cleanup()

    def _sql(self, script):
        con = sqlite3.connect(self.db)
        con.executescript(script)
        con.commit()
        con.close()

    def _ensure(self):
        env = dict(os.environ, DATABASE_URL=f"sqlite:///{self.db}", TEST_FLAG="True")
        res = subprocess.run([sys.executable, os.path.join(SERVER_DIR, "scripts", "ensure_db.py"),
                              MIGRATIONS], env=env, capture_output=True, text=True, timeout=120)
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        return res.stdout

    def _assert_current(self):
        con = sqlite3.connect(self.db)
        cols = {r[1] for r in con.execute("PRAGMA table_info(run_metadata)")}
        self.assertTrue({"board_info", "software_versions", "sync_mode"} <= cols)
        self.assertEqual(con.execute("SELECT version_num FROM alembic_version").fetchall(),
                         [(HEAD,)])
        con.close()

    def _old_run_kept(self):
        con = sqlite3.connect(self.db)
        self.assertEqual(con.execute("SELECT notes FROM run_metadata WHERE run_number=42")
                         .fetchall(), [("old run",)])
        con.close()

    def test_missing_and_empty_file(self):
        self._ensure()
        self._assert_current()
        os.remove(self.db)
        open(self.db, "w").close()
        self._ensure()
        self._assert_current()

    def test_unreadable_file_is_set_aside(self):
        with open(self.db, "wb") as f:
            f.write(os.urandom(4096))
        out = self._ensure()
        self._assert_current()
        self.assertIn("unreadable", out)
        self.assertTrue(any(n.startswith("app.db.unreadable-") for n in os.listdir(self.tmp.name)))

    def test_pre_migration_database_keeps_its_runs(self):
        self._sql(OLD_SCHEMA)
        self._ensure()
        self._assert_current()
        self._old_run_kept()
        self.assertTrue(any(n.startswith("app.db.bak.") for n in os.listdir(self.tmp.name)))

    def test_stamped_at_head_without_the_columns(self):
        self._sql(OLD_SCHEMA + VERSION + f"INSERT INTO alembic_version VALUES ('{HEAD}');")
        self._ensure()
        self._assert_current()
        self._old_run_kept()

    def test_unknown_revision(self):
        self._sql(OLD_SCHEMA + VERSION + "INSERT INTO alembic_version VALUES ('deadbeef0000');")
        self._ensure()
        self._assert_current()
        self._old_run_kept()

    def test_half_created(self):
        self._sql(OLD_SCHEMA.split("CREATE TABLE run_metadata")[0])
        self._ensure()
        self._assert_current()

    def test_current_database_is_left_alone(self):
        self._ensure()
        out = self._ensure()
        self.assertNotIn("Repaired", out)
        self.assertEqual(sorted(os.listdir(self.tmp.name)), ["app.db"])


if __name__ == "__main__":
    unittest.main()
