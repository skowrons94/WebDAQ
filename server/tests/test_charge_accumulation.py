"""
Charge integration follows the run.

The per-run charge normalises the online analysis, so beam delivered between
runs must not enter it; the lifetime total must keep counting regardless. These
tests drive the simulated picoammeter, which integrates on the same rules as the
RBD 9103 and TetrAMM controllers.
"""

import time
import unittest

from app.utils.mock_current import MockCurrentController


class ChargeGatingTests(unittest.TestCase):
    def setUp(self):
        self.controller = MockCurrentController(single_channel=True, base_current_uA=10.0)
        self.controller.initialize()
        # Let the sampling thread produce a few samples.
        time.sleep(0.4)

    def tearDown(self):
        self.controller.disconnect()

    def charges(self):
        return (self.controller.get_accumulated_charge(),
                self.controller.get_total_accumulated_charge())

    def test_between_runs_only_the_total_grows(self):
        run_before, total_before = self.charges()
        time.sleep(1.0)
        run_after, total_after = self.charges()

        self.assertEqual(run_after, run_before, "run charge grew outside a run")
        self.assertGreater(total_after, total_before, "total charge stopped counting")

    def test_during_a_run_both_grow(self):
        self.controller.set_accumulating(True)
        run_before, total_before = self.charges()
        time.sleep(1.0)
        run_after, total_after = self.charges()

        self.assertGreater(run_after, run_before)
        self.assertGreater(total_after, total_before)

    def test_after_a_run_the_run_charge_freezes(self):
        self.controller.set_accumulating(True)
        time.sleep(1.0)
        self.controller.set_accumulating(False)
        run_at_stop, total_at_stop = self.charges()
        time.sleep(1.0)
        run_later, total_later = self.charges()

        self.assertEqual(run_later, run_at_stop, "run charge kept growing after the run")
        self.assertGreater(total_later, total_at_stop)

    def test_a_new_run_starts_from_zero_without_touching_the_total(self):
        self.controller.set_accumulating(True)
        time.sleep(1.0)
        self.controller.set_accumulating(False)
        _, total_after_first = self.charges()

        self.controller.reset_accumulated_charge()
        self.controller.set_accumulating(True)
        run_at_start, total_at_start = self.charges()

        self.assertAlmostEqual(run_at_start, 0.0, places=6)
        self.assertGreaterEqual(total_at_start, total_after_first)

    def test_is_accumulating_reports_the_state(self):
        self.assertFalse(self.controller.is_accumulating())
        self.controller.set_accumulating(True)
        self.assertTrue(self.controller.is_accumulating())

    def test_timestamped_history_can_be_filtered(self):
        cutoff = time.time() - 0.25
        history = self.controller.get_history(since=cutoff, max_points=100)

        self.assertTrue(history)
        self.assertTrue(all(timestamp >= cutoff for timestamp, _ in history))
        self.assertTrue(all(isinstance(value, float) for _, value in history))


class ControllerInterfaceTests(unittest.TestCase):
    """The three controllers are used interchangeably by the routes."""

    def test_every_controller_exposes_the_accumulation_interface(self):
        from app.utils.rbd9103 import RBD9103Controller
        from app.utils.tetramm import TetrAMMController

        for cls in (RBD9103Controller, TetrAMMController, MockCurrentController):
            for method in ('set_accumulating', 'is_accumulating',
                           'reset_accumulated_charge', 'get_accumulated_charge',
                           'get_total_accumulated_charge', 'set_total_accumulated_charge',
                           'get_history'):
                self.assertTrue(hasattr(cls, method),
                                f"{cls.__name__} is missing {method}()")

    def test_real_controllers_only_integrate_the_run_charge_when_accumulating(self):
        # Exercised without hardware: update_accumulated_charge() works off the
        # buffered value, so the gate can be checked directly.
        from app.utils.rbd9103 import RBD9103Controller

        controller = RBD9103Controller(port='/dev/null')
        controller.current_value = 5.0          # uA
        controller.previous_time = time.time() - 1.0

        controller.set_accumulating(False)
        controller.update_accumulated_charge()
        self.assertEqual(controller.get_accumulated_charge(), 0.0)
        self.assertGreater(controller.get_total_accumulated_charge(), 0.0)

        total_before = controller.get_total_accumulated_charge()
        controller.previous_time = time.time() - 1.0
        controller.set_accumulating(True)
        controller.update_accumulated_charge()
        self.assertGreater(controller.get_accumulated_charge(), 0.0)
        self.assertGreater(controller.get_total_accumulated_charge(), total_before)


if __name__ == '__main__':
    unittest.main()
