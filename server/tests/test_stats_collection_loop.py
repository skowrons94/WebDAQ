"""
Stopping a run must not wait for Graphite.

The collection loop asks Graphite for every metric once a second. A server that
accepts the connection and then stops answering makes those queries slow, and
the operator pressing Stop cannot be made to wait for them — so the loop does
its network work outside the lock that stop_run() needs.
"""

import os
import shutil
import tempfile
import threading
import time
import unittest

from app.services.stats_manager import StatsManager


class StopDuringASlowQueryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='webdaq-loop-')
        self.cwd = os.getcwd()
        os.chdir(self.tmp)
        self.manager = StatsManager(graphite_host='localhost', graphite_port=80)
        self.manager.add_path('slow.metric', 'Slow metric', 'kV')

        self.query_started = threading.Event()
        self.release_query = threading.Event()

        def hanging_query(path, from_time='-10s'):
            self.query_started.set()
            # Stands in for a server that never answers.
            self.release_query.wait(timeout=10)
            return (None, None)

        self.manager.get_last_value = hanging_query

    def tearDown(self):
        self.release_query.set()
        if self.manager.is_collecting():
            self.manager.stop_run()
        os.chdir(self.cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_stop_returns_promptly_while_a_query_is_stuck(self):
        self.assertTrue(self.manager.start_run(1))
        self.assertTrue(self.query_started.wait(timeout=5), 'collection never queried')

        started = time.time()
        self.assertTrue(self.manager.stop_run())
        elapsed = time.time() - started

        # join() waits at most 5 s for the thread; what matters is that the
        # caller is not held for the length of the query itself.
        self.assertLess(elapsed, 6.0, f'stop_run took {elapsed:.1f}s')
        self.assertFalse(self.manager.is_collecting())

    def test_no_truncated_row_is_written_when_stopping_mid_sample(self):
        self.assertTrue(self.manager.start_run(2))
        self.assertTrue(self.query_started.wait(timeout=5))
        self.manager.stop_run()
        self.release_query.set()
        time.sleep(0.5)

        path = os.path.join(self.tmp, 'data', 'run2', 'stats.csv')
        with open(path) as f:
            rows = [line for line in f.read().splitlines() if not line.startswith('#')]

        header_columns = len(rows[0].split(','))
        for row in rows[1:]:
            self.assertEqual(len(row.split(',')), header_columns,
                             f'short row written: {row!r}')


if __name__ == '__main__':
    unittest.main()
