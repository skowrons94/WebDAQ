"""
Only one backend may run against one set of digitizers.

The failure this prevents is not "the second server exits with a port error".
Creating the app opens the CAEN boards and the picoammeter, and that happens at
import time — before waitress ever tries to bind. A second launch therefore
reaches the hardware first, then fails the bind, then runs its shutdown path,
which stops acquisition and closes digitizer handles belonging to the server
that is still running. The guard exists to make that impossible, so these tests
are about the decision, not the message.
"""

import os
import socket
import tempfile
import unittest
from unittest import mock

from app.utils import single_instance


class RunningServerPidTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.pid_file = os.path.join(self.tmp.name, 'daq-server.pid')

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, contents):
        with open(self.pid_file, 'w') as f:
            f.write(contents)

    def test_no_pid_file_is_no_obstacle(self):
        self.assertIsNone(single_instance.running_server_pid(self.pid_file))

    def test_garbage_is_no_obstacle(self):
        self.write('not a pid')
        self.assertIsNone(single_instance.running_server_pid(self.pid_file))

    def test_empty_file_is_no_obstacle(self):
        self.write('')
        self.assertIsNone(single_instance.running_server_pid(self.pid_file))

    def test_our_own_pid_is_no_obstacle(self):
        # Otherwise a server could refuse to restart over its own pid file.
        self.write(str(os.getpid()))
        self.assertIsNone(single_instance.running_server_pid(self.pid_file))

    def test_a_dead_pid_is_no_obstacle(self):
        self.write('999999')
        with mock.patch.object(single_instance.os, 'kill',
                               side_effect=ProcessLookupError()):
            self.assertIsNone(single_instance.running_server_pid(self.pid_file))

    def test_a_recycled_pid_belonging_to_something_else_is_no_obstacle(self):
        # A stale pid file naming an unrelated live process must not lock the
        # operator out of starting the server at all.
        self.write('4242')
        with mock.patch.object(single_instance.os, 'kill', return_value=None), \
             mock.patch.object(single_instance, '_is_webdaq_process', return_value=False):
            self.assertIsNone(single_instance.running_server_pid(self.pid_file))

    def test_a_live_backend_is_reported(self):
        self.write('4242')
        with mock.patch.object(single_instance.os, 'kill', return_value=None), \
             mock.patch.object(single_instance, '_is_webdaq_process', return_value=True):
            self.assertEqual(single_instance.running_server_pid(self.pid_file), 4242)

    def test_a_backend_owned_by_another_user_still_counts(self):
        self.write('4242')
        with mock.patch.object(single_instance.os, 'kill',
                               side_effect=PermissionError()), \
             mock.patch.object(single_instance, '_is_webdaq_process', return_value=True):
            self.assertEqual(single_instance.running_server_pid(self.pid_file), 4242)


class PortProbeTests(unittest.TestCase):
    def test_a_free_port_is_free(self):
        probe = socket.socket()
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
        probe.close()
        self.assertFalse(single_instance.port_in_use(port))

    def test_a_listening_port_is_detected(self):
        held = socket.socket()
        held.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        held.bind(('0.0.0.0', 0))
        held.listen(1)
        try:
            port = held.getsockname()[1]
            self.assertTrue(single_instance.port_in_use(port))
        finally:
            held.close()


class RefusalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.pid_file = os.path.join(self.tmp.name, 'daq-server.pid')

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_clean_machine_starts(self):
        with mock.patch.object(single_instance, 'port_in_use', return_value=False):
            self.assertIsNone(
                single_instance.refuse_if_already_running(5001, self.pid_file))

    def test_a_live_backend_refuses_and_names_the_pid(self):
        with open(self.pid_file, 'w') as f:
            f.write('4242')
        with mock.patch.object(single_instance.os, 'kill', return_value=None), \
             mock.patch.object(single_instance, '_is_webdaq_process', return_value=True):
            message = single_instance.refuse_if_already_running(5001, self.pid_file)
        self.assertIsNotNone(message)
        self.assertIn('4242', message)

    def test_a_held_port_refuses_even_without_a_pid_file(self):
        # Covers a server whose pid file was deleted by hand.
        with mock.patch.object(single_instance, 'port_in_use', return_value=True):
            message = single_instance.refuse_if_already_running(5001, self.pid_file)
        self.assertIsNotNone(message)
        self.assertIn('5001', message)


class PidFileOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.pid_file = os.path.join(self.tmp.name, 'daq-server.pid')

    def tearDown(self):
        self.tmp.cleanup()

    def test_we_remove_our_own_pid_file(self):
        single_instance.write_pid_file(self.pid_file)
        with open(self.pid_file) as f:
            self.assertEqual(int(f.read()), os.getpid())
        single_instance.remove_pid_file(self.pid_file)
        self.assertFalse(os.path.exists(self.pid_file))

    def test_we_do_not_remove_somebody_elses(self):
        # A mistaken second launch shutting down must not leave the real server
        # with no pid file, which is what made a stray backend hard to find.
        with open(self.pid_file, 'w') as f:
            f.write('4242')
        single_instance.remove_pid_file(self.pid_file)
        self.assertTrue(os.path.exists(self.pid_file))
        with open(self.pid_file) as f:
            self.assertEqual(int(f.read()), 4242)

    def test_removing_a_missing_file_is_harmless(self):
        single_instance.remove_pid_file(self.pid_file)


if __name__ == '__main__':
    unittest.main()
