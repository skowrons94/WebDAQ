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

import json
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


class ReclaimTests(unittest.TestCase):
    """
    A leftover backend is cleared automatically; the two cases that are not ours
    to decide are not. The operators who start this server are running an
    experiment, so "go and run a script" is not an outcome.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.pid_file = os.path.join(self.tmp.name, 'daq-server.pid')
        self.settings = os.path.join(self.tmp.name, 'settings.json')
        self.stopped = []

    def tearDown(self):
        self.tmp.cleanup()

    def write_settings(self, running):
        with open(self.settings, 'w') as f:
            json.dump({'running': running, 'run': 852}, f)

    def reclaim(self, holders, webdaq=True, force=False, stops=True, free_after=True):
        """Run ensure_sole_instance against a synthetic port-holder situation."""
        def fake_stop(pid, timeout=None):
            self.stopped.append(pid)
            return stops
        with mock.patch.object(single_instance, 'pids_listening_on', return_value=holders), \
             mock.patch.object(single_instance, '_is_webdaq_process', return_value=webdaq), \
             mock.patch.object(single_instance, 'stop_process', side_effect=fake_stop), \
             mock.patch.object(single_instance, 'port_in_use', return_value=not free_after), \
             mock.patch.object(single_instance, '_describe', side_effect=lambda p: f'pid {p}'):
            return single_instance.ensure_sole_instance(
                5001, self.pid_file, force=force, settings_file=self.settings)

    def test_a_clean_machine_starts(self):
        self.assertIsNone(self.reclaim([]))
        self.assertEqual(self.stopped, [])

    def test_a_leftover_backend_is_stopped_and_the_server_starts(self):
        self.assertIsNone(self.reclaim([4242]))
        self.assertEqual(self.stopped, [4242])

    def test_every_leftover_backend_is_stopped(self):
        self.assertIsNone(self.reclaim([4242, 4243]))
        self.assertEqual(sorted(self.stopped), [4242, 4243])

    def test_a_run_in_progress_is_not_thrown_away(self):
        self.write_settings(True)
        message = self.reclaim([4242])
        self.assertIsNotNone(message)
        self.assertIn('taking data', message)
        self.assertEqual(self.stopped, [])          # nothing was killed

    def test_a_run_in_progress_can_be_overridden_deliberately(self):
        self.write_settings(True)
        self.assertIsNone(self.reclaim([4242], force=True))
        self.assertEqual(self.stopped, [4242])

    def test_a_stopped_run_is_no_obstacle(self):
        self.write_settings(False)
        self.assertIsNone(self.reclaim([4242]))
        self.assertEqual(self.stopped, [4242])

    def test_a_foreign_process_is_never_killed(self):
        message = self.reclaim([4242], webdaq=False)
        self.assertIsNotNone(message)
        self.assertIn('not a WebDAQ backend', message)
        self.assertEqual(self.stopped, [])

    def test_a_backend_that_will_not_die_is_reported(self):
        message = self.reclaim([4242], stops=False)
        self.assertIsNotNone(message)
        self.assertIn('would not stop', message)

    def test_a_port_still_held_after_the_kill_is_reported(self):
        message = self.reclaim([4242], free_after=False)
        self.assertIsNotNone(message)
        self.assertIn('still not', message)

    def test_an_unidentifiable_holder_is_left_alone(self):
        # /proc told us nothing, but the port is taken: killing blind is not an
        # option, so this is the one case that still needs a human.
        with mock.patch.object(single_instance, 'pids_listening_on', return_value=[]), \
             mock.patch.object(single_instance, 'port_in_use', return_value=True):
            message = single_instance.ensure_sole_instance(
                5001, self.pid_file, settings_file=self.settings)
        self.assertIsNotNone(message)
        self.assertIn('could not be identified', message)

    def test_a_stale_pid_file_naming_a_stopped_backend_is_removed(self):
        with open(self.pid_file, 'w') as f:
            f.write('4242')
        self.assertIsNone(self.reclaim([4242]))
        self.assertFalse(os.path.exists(self.pid_file))

    def test_a_backend_known_only_from_the_pid_file_is_stopped(self):
        # Its listening socket was not visible, but the pid file names it.
        with open(self.pid_file, 'w') as f:
            f.write('4242')
        with mock.patch.object(single_instance, 'pids_listening_on', return_value=[]), \
             mock.patch.object(single_instance, '_is_webdaq_process', return_value=True), \
             mock.patch.object(single_instance.os, 'kill', return_value=None), \
             mock.patch.object(single_instance, 'stop_process',
                               side_effect=lambda pid, timeout=None: self.stopped.append(pid) or True), \
             mock.patch.object(single_instance, 'port_in_use', return_value=False):
            message = single_instance.ensure_sole_instance(
                5001, self.pid_file, settings_file=self.settings)
        self.assertIsNone(message)
        self.assertEqual(self.stopped, [4242])


class AcquisitionFlagTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, 'settings.json')

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_running_experiment_is_reported(self):
        with open(self.path, 'w') as f:
            json.dump({'running': True}, f)
        self.assertTrue(single_instance.acquisition_in_progress(self.path))

    def test_a_stopped_experiment_is_not(self):
        with open(self.path, 'w') as f:
            json.dump({'running': False}, f)
        self.assertFalse(single_instance.acquisition_in_progress(self.path))

    def test_a_missing_file_never_blocks_a_start(self):
        self.assertFalse(single_instance.acquisition_in_progress(self.path))

    def test_a_corrupt_file_never_blocks_a_start(self):
        with open(self.path, 'w') as f:
            f.write('{not json')
        self.assertFalse(single_instance.acquisition_in_progress(self.path))


class PortHolderTests(unittest.TestCase):
    def test_our_own_listening_socket_is_found(self):
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.bind(('127.0.0.1', 0))
        server.listen(1)
        port = server.getsockname()[1]
        try:
            self.assertIn(os.getpid(), single_instance.pids_listening_on(port))
        finally:
            server.close()

    def test_a_free_port_has_no_holder(self):
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
        probe.close()
        self.assertEqual(single_instance.pids_listening_on(port), [])


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
