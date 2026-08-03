"""
Graphite must never be able to stall the DAQ.

These are regression tests for a real incident: the render API host stopped
answering — not refusing connections, silently dropping them — and every query
then waited out a 30s connect timeout on a waitress worker thread. With ten
workers and a stats poll that walked four time windows twice each, the request
queue grew without bound and the whole interface became unusable while the
digitizers were perfectly healthy.

Two independent guards are tested here:

  * the read side (GraphiteClient), used by the dashboard and the stats page;
  * the write side (CarbonPusher), used by the picoammeter acquisition loops.

The property that matters for both is the same: an unreachable collector costs
a bounded amount of time once, and nothing at all thereafter until it is worth
retrying. The last test covers the other half of the incident — that the push
does not happen while holding the lock the web layer needs.
"""

import socket
import threading
import time
import unittest
from unittest import mock

import requests

from app.utils.carbon import CarbonPusher
from app.utils.graphite import GraphiteClient, GraphiteUnavailable


def closed_port() -> int:
    """A port nothing listens on, so connecting to it is refused at once."""
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


class ReadSideBreakerTests(unittest.TestCase):
    """GraphiteClient stops querying a server that does not answer."""

    def setUp(self):
        self.client = GraphiteClient('graphite.example', 80, timeout=5,
                                     failure_threshold=3, cooldown_s=60)

    def fail_with(self, exc):
        return mock.patch('app.utils.graphite.requests.get', side_effect=exc)

    def test_connect_deadline_is_separate_from_the_read_deadline(self):
        # The whole point: a host that never completes the handshake must be
        # given up on in seconds, not after the (much longer) read timeout.
        with mock.patch('app.utils.graphite.requests.get') as get:
            get.return_value = mock.Mock(
                json=lambda: [{'datapoints': []}], raise_for_status=lambda: None,
                status_code=200)
            self.client.get_data('some.metric', '-10s')
        connect_timeout, read_timeout = get.call_args.kwargs['timeout']
        self.assertLess(connect_timeout, read_timeout)
        self.assertLessEqual(connect_timeout, 5)

    def test_breaker_opens_after_the_threshold(self):
        with self.fail_with(requests.exceptions.ConnectTimeout('no route')):
            for _ in range(3):
                with self.assertRaises(Exception):
                    self.client.get_data('some.metric', '-10s')
        self.assertFalse(self.client.available)

    def test_open_breaker_fails_without_touching_the_network(self):
        with self.fail_with(requests.exceptions.ConnectTimeout('no route')):
            for _ in range(3):
                with self.assertRaises(Exception):
                    self.client.get_data('some.metric', '-10s')

        with mock.patch('app.utils.graphite.requests.get') as get:
            with self.assertRaises(GraphiteUnavailable):
                self.client.get_data('some.metric', '-10s')
            get.assert_not_called()

    def test_it_probes_again_once_the_cooldown_expires(self):
        self.client.cooldown_s = 0.2
        with self.fail_with(requests.exceptions.ConnectTimeout('no route')):
            for _ in range(3):
                with self.assertRaises(Exception):
                    self.client.get_data('some.metric', '-10s')
        self.assertFalse(self.client.available)

        time.sleep(0.25)
        with mock.patch('app.utils.graphite.requests.get') as get:
            get.return_value = mock.Mock(
                json=lambda: [{'datapoints': [[1.5, 1000]]}],
                raise_for_status=lambda: None, status_code=200)
            data = self.client.get_data('some.metric', '-10s')
            get.assert_called_once()
        self.assertEqual([v for _, v in data], [1.5])
        self.assertTrue(self.client.available, 'a good answer must close the breaker')

    def test_an_http_error_does_not_open_the_breaker(self):
        # A 500 means Graphite is up and talking. That is a different problem,
        # and must not stop us asking — otherwise one bad metric blinds the lot.
        with mock.patch('app.utils.graphite.requests.get') as get:
            get.return_value = mock.Mock(
                status_code=500,
                raise_for_status=mock.Mock(side_effect=requests.exceptions.HTTPError('boom')))
            for _ in range(5):
                with self.assertRaises(Exception):
                    self.client.get_data('some.metric', '-10s')
        self.assertTrue(self.client.available)


class StatsManagerAmplificationTests(unittest.TestCase):
    """One dead server must not become eight stalled queries."""

    def test_get_last_value_stops_at_the_first_unavailable(self):
        from app.services.stats_manager import StatsManager

        manager = StatsManager('graphite.example', 80)
        # Widening the window cannot help a server that is known to be down,
        # and this loop is four windows times two attempts.
        with mock.patch.object(manager.graphite_client, 'get_data',
                               side_effect=GraphiteUnavailable('down')) as get_data:
            value, timestamp = manager.get_last_value('some.metric')

        self.assertIsNone(value)
        self.assertIsNone(timestamp)
        self.assertEqual(get_data.call_count, 1)


class CarbonPusherTests(unittest.TestCase):
    """The write side: batched, bounded, and it gives up on a dead collector."""

    def setUp(self):
        self.received = []
        self.server = socket.socket()
        self.server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server.bind(('127.0.0.1', 0))
        self.server.listen(8)
        self.port = self.server.getsockname()[1]
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def tearDown(self):
        try:
            self.server.close()
        except OSError:
            pass

    def _serve(self):
        while True:
            try:
                conn, _ = self.server.accept()
            except OSError:
                return
            with conn:
                self.received.append(conn.recv(65536).decode())

    def test_a_sample_is_one_connection_whatever_the_channel_count(self):
        pusher = CarbonPusher('test')
        metrics = [(f'tetram.ch{i}', float(i)) for i in range(4)]
        self.assertTrue(pusher.send('127.0.0.1', self.port, metrics, 1000))

        deadline = time.time() + 2
        while not self.received and time.time() < deadline:
            time.sleep(0.01)

        self.assertEqual(len(self.received), 1, 'four channels must not be four connections')
        lines = [l for l in self.received[0].split('\n') if l]
        self.assertEqual(lines, [
            'tetram.ch0 0.0 1000',
            'tetram.ch1 1.0 1000',
            'tetram.ch2 2.0 1000',
            'tetram.ch3 3.0 1000',
        ])

    def test_it_stops_pushing_at_a_dead_collector(self):
        pusher = CarbonPusher('test', cooldown_s=60)
        dead = closed_port()
        metrics = [('tetram.ch0', 1.0)]

        for _ in range(3):
            self.assertFalse(pusher.send('127.0.0.1', dead, metrics, 1000))
        self.assertFalse(pusher.state()['available'])

        with mock.patch('app.utils.carbon.socket.create_connection') as connect:
            for _ in range(10):
                self.assertFalse(pusher.send('127.0.0.1', dead, metrics, 1000))
            connect.assert_not_called()
        self.assertEqual(pusher.state()['dropped_since_failure'], 10)

    def test_it_resumes_when_the_collector_comes_back(self):
        pusher = CarbonPusher('test', cooldown_s=0.2)
        dead = closed_port()
        metrics = [('tetram.ch0', 1.0)]

        for _ in range(3):
            pusher.send('127.0.0.1', dead, metrics, 1000)
        self.assertFalse(pusher.state()['available'])

        time.sleep(0.25)
        self.assertTrue(pusher.send('127.0.0.1', self.port, metrics, 1001))
        self.assertTrue(pusher.state()['available'])

    def test_repointing_clears_an_outage(self):
        # Otherwise fixing the address in the UI would appear to do nothing
        # until the cooldown happened to expire.
        pusher = CarbonPusher('test', cooldown_s=3600)
        dead = closed_port()
        for _ in range(3):
            pusher.send('127.0.0.1', dead, [('m', 1.0)], 1000)
        self.assertFalse(pusher.state()['available'])

        self.assertTrue(pusher.send('127.0.0.1', self.port, [('m', 1.0)], 1001))

    def test_send_never_raises(self):
        pusher = CarbonPusher('test')
        with mock.patch('app.utils.carbon.socket.create_connection',
                        side_effect=OSError('anything at all')):
            self.assertFalse(pusher.send('127.0.0.1', 2003, [('m', 1.0)], 1000))


class PushOutsideTheLockTests(unittest.TestCase):
    """
    The other half of the incident.

    Bounding the push is not enough on its own: it used to run inside
    buffer_lock, once per channel, on a loop sampling every 0.5s. Everything
    that reads the current takes that lock — the plots, the status endpoint,
    and set_accumulating() on the run start/stop path — so an unreachable
    collector held up run control itself.
    """

    def test_the_buffer_lock_is_free_while_metrics_are_pushed(self):
        import numpy as np
        from app.utils.tetramm import TetrAMMController

        controller = TetrAMMController.__new__(TetrAMMController)
        controller.logger = mock.Mock()
        controller.settings = {'CHN': '4'}
        controller.times = np.zeros(16)
        controller.values = {str(i): np.zeros(16) for i in range(4)}
        controller.buffer_lock = threading.Lock()
        controller.save_data = False
        controller.graphite_host, controller.graphite_port = '127.0.0.1', 2003
        controller._carbon = CarbonPusher('test')
        controller.charge_channel = 0
        controller.previous_time = 0.0
        controller.accumulating = False
        controller.accumulated_charge = 0.0
        controller.total_accumulated_charge = 0.0
        controller._send_command = lambda command: b'1e-6 2e-6 3e-6 4e-6'

        held = []

        def slow_push(host, port, metrics, timestamp):
            # Stand in for a collector that never completes the handshake.
            held.append(controller.buffer_lock.locked())
            time.sleep(0.2)
            return False

        with mock.patch.object(controller._carbon, 'send', side_effect=slow_push):
            controller._acquire_measurement()

        self.assertEqual(held, [False],
                         'the push must not run while buffer_lock is held')

    def test_a_sample_still_reaches_carbon(self):
        # Guard against "fixing" the stall by simply not pushing any more.
        import numpy as np
        from app.utils.tetramm import TetrAMMController

        controller = TetrAMMController.__new__(TetrAMMController)
        controller.logger = mock.Mock()
        controller.settings = {'CHN': '2'}
        controller.times = np.zeros(16)
        controller.values = {str(i): np.zeros(16) for i in range(2)}
        controller.buffer_lock = threading.Lock()
        controller.save_data = False
        controller.graphite_host, controller.graphite_port = '127.0.0.1', 2003
        controller._carbon = CarbonPusher('test')
        controller.charge_channel = 0
        controller.previous_time = 0.0
        controller.accumulating = False
        controller.accumulated_charge = 0.0
        controller.total_accumulated_charge = 0.0
        controller._send_command = lambda command: b'1e-6 2e-6'

        with mock.patch.object(controller._carbon, 'send') as send:
            controller._acquire_measurement()

        send.assert_called_once()
        metrics = send.call_args.args[2]
        self.assertEqual([path for path, _ in metrics],
                         ['tetram.ch0', 'tetram.ch1'])


if __name__ == '__main__':
    unittest.main()
