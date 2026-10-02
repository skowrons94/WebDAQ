"""
A beam current read from a monitored metric is late, and that is normal.

A picoammeter on the target answers in milliseconds. A metric published by the
accelerator does not: it is written on its own cadence, Carbon flushes on its
own schedule, and the render API will not serve the bucket it is still filling.
At LUNA a value written every 10 s reads back around 40 s old, permanently.

Judged against a picoammeter's idea of "recent", that healthy readout was
reported as a fault on the Troubleshoot page and its 30-second plot came back
empty — while a 60-second plot of the same data worked. These tests pin the
measured-not-assumed horizon that fixes both.
"""

import os
import time
import unittest
from unittest import mock

os.environ.setdefault('TEST_FLAG', 'True')

from app.utils.graphite_current import GraphiteCurrentController  # noqa: E402


def lagging_series(now, count=12, step=10.0, lag=40.0, value=24.5):
    """``count`` points ``step`` apart, the newest ``lag`` seconds old."""
    newest = now - lag
    return [[newest - step * (count - 1 - i), value] for i in range(count)]


def polled_controller(step=10.0, lag=40.0, value=24.5):
    """A controller that has read one window of a metric published late.

    One poll is the whole story: the window Graphite answers with carries both
    facts the horizon is built from — the spacing of the points, and how far the
    newest of them is behind this machine's clock. Polling repeatedly in a test
    that takes microseconds would only re-read the same newest point.
    """
    controller = GraphiteCurrentController(
        metric='accelerator.current', scale=1.0, poll_interval_s=5.0)
    series = lagging_series(time.time(), step=step, lag=lag, value=value)
    with mock.patch('app.utils.graphite_current.graphite_reader.fetch_series',
                    return_value=series):
        controller._poll_once()
    return controller


class FreshnessHorizonTests(unittest.TestCase):
    """What max_sample_age() makes of a source it has watched for a while."""

    def _polled_controller(self, step=10.0, lag=40.0):
        return polled_controller(step=step, lag=lag)

    def test_an_unwatched_source_still_gets_the_floor(self):
        controller = GraphiteCurrentController(metric='accelerator.current')
        self.assertGreaterEqual(controller.max_sample_age(), 30.0)

    def test_the_horizon_covers_the_lag_the_source_actually_has(self):
        controller = self._polled_controller(step=10.0, lag=40.0)
        horizon = controller.max_sample_age()
        # It has to clear the lag itself, or every reading looks stale...
        self.assertGreater(horizon, 40.0)
        # ...with room for a few cadences on top, so one late publish is not a
        # fault, and not so much that a dead metric goes unnoticed for minutes.
        self.assertGreater(horizon, 60.0)
        self.assertLess(horizon, 120.0)

    def test_a_faster_metric_gets_a_tighter_horizon(self):
        slow = self._polled_controller(step=30.0, lag=60.0).max_sample_age()
        fast = self._polled_controller(step=1.0, lag=2.0).max_sample_age()
        self.assertGreater(slow, fast)

    def test_a_clock_that_disagrees_is_absorbed_rather_than_fought(self):
        # The Graphite host's clock is two minutes behind this one. Its points
        # are therefore "older" than they really are, by a constant — which is
        # measured between the same two clocks, so the horizon simply grows.
        skewed = self._polled_controller(step=10.0, lag=160.0)
        self.assertGreater(skewed.max_sample_age(), 160.0)

    def test_a_metric_that_stops_eventually_falls_outside_its_horizon(self):
        controller = self._polled_controller(step=10.0, lag=40.0)
        horizon = controller.max_sample_age()
        newest = controller.get_history(since=0)[-1][0]
        # Within the horizon the last reading still counts...
        self.assertTrue(controller.get_history(since=newest + 1 - horizon))
        # ...but once the metric has been silent for longer, nothing does.
        self.assertFalse(controller.get_history(since=newest + horizon + 1))


class LiveBeamCurrentTests(unittest.TestCase):
    """What the alert engine reads from a lagging source."""

    def setUp(self):
        self.controller = polled_controller()

    def _with_controller(self, controller):
        from app.routes import current as current_routes
        return mock.patch.object(current_routes, 'controller', controller)

    def test_a_lagging_but_healthy_source_reads_as_a_measurement(self):
        from app.services.alerting import _live_beam_current

        with self._with_controller(self.controller):
            self.assertAlmostEqual(_live_beam_current(), 24.5, places=3)

    def test_the_fixed_window_this_replaced_would_have_read_nothing(self):
        """The regression itself: 30 s cannot reach a point 40 s old."""
        import app.services.alerting as alerting

        with self._with_controller(self.controller):
            with mock.patch.object(alerting, 'max_sample_age',
                                   return_value=alerting._STALE_AFTER_S):
                self.assertIsNone(alerting._live_beam_current())

    def test_hardware_keeps_the_strict_thirty_second_window(self):
        from app.services.alerting import _STALE_AFTER_S, max_sample_age

        class Picoammeter:
            """No max_sample_age(): the default has to apply unchanged."""

        self.assertEqual(max_sample_age(Picoammeter()), _STALE_AFTER_S)

    def test_a_source_that_really_stopped_still_reads_as_nothing(self):
        from app.services.alerting import _live_beam_current

        stalled = GraphiteCurrentController(
            metric='accelerator.current', scale=1.0, poll_interval_s=5.0)
        now = time.time()
        with mock.patch(
                'app.utils.graphite_current.graphite_reader.fetch_series',
                return_value=lagging_series(now, lag=40.0)):
            stalled._poll_once()
        # An hour of silence is not a publication lag.
        with mock.patch.object(stalled, 'get_history', return_value=[]):
            with self._with_controller(stalled):
                self.assertIsNone(_live_beam_current())

    def test_the_troubleshoot_page_calls_the_lagging_source_healthy(self):
        from app.services.recovery import _current_state

        with self._with_controller(self.controller):
            state = _current_state()
        self.assertTrue(state['ok'], state['detail'])


class RollingWindowRouteTests(unittest.TestCase):
    """The 30-second plot, over HTTP, against a source that publishes late."""

    @classmethod
    def setUpClass(cls):
        from app import create_app
        from app.utils.jwt_utils import generate_token

        cls.app = create_app()
        with cls.app.app_context():
            token = generate_token(1)
        cls.client = cls.app.test_client()
        cls.auth = {'Authorization': f'Bearer {token}'}

    def _history(self, query, controller):
        from app.routes import current as current_routes

        with mock.patch.object(current_routes, 'controller', controller):
            response = self.client.get(f'/current/history?{query}', headers=self.auth)
        self.assertEqual(response.status_code, 200)
        return response.get_json()

    def test_a_thirty_second_window_draws_the_newest_samples(self):
        body = self._history('seconds=30&bins=120', polled_controller())
        self.assertTrue(body['samples'],
                        'the window fell into the publication gap and came back empty')

    def test_the_window_keeps_the_width_that_was_asked_for(self):
        body = self._history('seconds=30', polled_controller(step=10.0, lag=40.0))
        times = [point[0] for point in body['samples']]
        self.assertLessEqual(max(times) - min(times), 30.0)
        # ...and it is the END of the data, not some arbitrary slice of it.
        newest = polled_controller(step=10.0, lag=40.0).get_history(since=0)[-1][0]
        self.assertLess(abs(max(times) - newest), 2.0)

    def test_a_longer_window_still_behaves_as_it_always_did(self):
        body = self._history('seconds=300', polled_controller())
        self.assertTrue(body['samples'])

    def test_a_source_silent_for_hours_draws_nothing(self):
        """Anchoring must not dress up old data as the last 30 seconds."""
        controller = polled_controller()
        with mock.patch.object(controller, 'max_sample_age', return_value=60.0):
            with mock.patch.object(controller, 'get_history') as history:
                # Nothing inside the horizon; plenty of data from hours ago.
                history.return_value = []
                body = self._history('seconds=30', controller)
        self.assertEqual(body['samples'], [])


if __name__ == '__main__':
    unittest.main()
