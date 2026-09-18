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


class RunOwnershipTests(unittest.TestCase):
    """
    Whose run the charge is filed under.

    The listener that follows the DAQ's run state runs for EVERY run, but the
    dashboard only calls /current/start when data is being saved. The run number
    was therefore left over from the previous run, and a run started with saving
    off wrote its own charge over the last saved run's record: run 887, 12.6 h
    at 60 uA, was left reading 100 uC instead of 2.7 C.
    """

    class FakeDaq:
        """Just enough of DAQManager for the run-state listener."""
        def __init__(self, run_number=0, save=True):
            self.run_number, self.save = run_number, save
            self.flask_app = None                 # keeps _persist_run_charge inert
            self.listeners = []
        def get_run_number(self):  return self.run_number
        def get_save_data(self):   return self.save
        def is_running(self):      return False
        def add_run_state_listener(self, fn): self.listeners.append(fn)

    class FakeController:
        def __init__(self):
            self.charge, self.accumulating = 0.0, False
            self.saving, self.connected = False, True
        def reset_accumulated_charge(self):   self.charge = 0.0
        def set_accumulating(self, on):       self.accumulating = bool(on)
        def get_accumulated_charge(self):     return self.charge
        def set_save_data(self, on, folder=''): self.saving = bool(on and folder)
        def is_connected(self):               return self.connected

    def setUp(self):
        from app.routes import current as current_routes
        self.mod = current_routes
        self.saved = (current_routes.daq_mgr, current_routes.controller,
                      current_routes.current_accumulating_run_number,
                      current_routes._persist_run_charge)
        self.stored = []
        self.daq = self.FakeDaq()
        self.controller = self.FakeController()
        current_routes.daq_mgr = self.daq
        current_routes.controller = self.controller
        current_routes._persist_run_charge = lambda n, c: self.stored.append((n, c))

    def tearDown(self):
        (self.mod.daq_mgr, self.mod.controller,
         self.mod.current_accumulating_run_number, self.mod._persist_run_charge) = self.saved

    def run_cycle(self, run_number, save, charge):
        self.daq.run_number, self.daq.save = run_number, save
        self.mod._on_run_state_changed(True)
        self.controller.charge = charge
        self.mod._on_run_state_changed(False)

    def test_a_saved_run_stores_its_charge_against_its_own_number(self):
        self.run_cycle(900, save=True, charge=2_744_087.0)
        self.assertEqual(self.stored, [(900, 2_744_087.0)])

    def test_an_unsaved_run_does_not_overwrite_the_last_saved_run(self):
        self.run_cycle(900, save=True, charge=2_744_087.0)
        self.run_cycle(900, save=False, charge=100.17)   # run number does not advance
        # The unsaved run has no row of its own, and must not touch run 900's.
        self.assertEqual(self.stored, [(900, 2_744_087.0), (0, 100.17)])
        self.assertEqual(self.mod.current_accumulating_run_number, 0)

    def test_the_run_number_does_not_survive_into_the_next_run(self):
        self.run_cycle(900, save=True, charge=1.0)
        self.assertEqual(self.mod.current_accumulating_run_number, 0)

    def test_an_unsaved_run_still_integrates_its_own_charge(self):
        # The live figure on the dashboard must still be right; only storing it
        # is skipped.
        self.daq.run_number, self.daq.save = 900, False
        self.mod._on_run_state_changed(True)
        self.assertTrue(self.controller.accumulating)
        self.mod._on_run_state_changed(False)
        self.assertFalse(self.controller.accumulating)

    def test_each_saved_run_is_filed_under_its_own_number(self):
        self.run_cycle(900, save=True, charge=10.0)
        self.run_cycle(901, save=True, charge=20.0)
        self.assertEqual(self.stored, [(900, 10.0), (901, 20.0)])

    def test_the_end_of_a_run_closes_the_current_log(self):
        # The log must follow the run even when no browser calls /current/stop.
        self.daq.run_number, self.daq.save = 852, True
        self.mod._on_run_state_changed(True)
        self.controller.saving = True             # /current/start opened data/run852/
        self.mod._on_run_state_changed(False)
        self.assertFalse(self.controller.saving)

    def test_a_stop_with_the_monitor_unreachable_still_closes_the_log(self):
        # Run 852: a stop that found the monitor disconnected left the log
        # open, and the readings after its reconnection went into the finished
        # run's current.txt.
        was_running = self.mod.running
        self.addCleanup(setattr, self.mod, "running", was_running)
        self.controller.saving, self.controller.connected = True, False
        message, status = self.mod.stop_run_recording()
        self.assertFalse(self.controller.saving)
        self.assertFalse(self.mod.running)
        self.assertEqual(status, 200)
