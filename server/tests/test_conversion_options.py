"""
The RUReader command line the dashboard builds.

Every option is a flag on a binary that may be older than this repository, so
two things have to hold: an option the installed RUReader does not advertise is
never passed (it would exit with "Unknown option" instead of converting), and a
value the operator can type must be clamped to what RUReader accepts (it exits
on an out-of-range one too). Both failure modes look identical from the
dashboard — "conversion failed" — which is why they are pinned here.
"""

import os
import shutil
import tempfile
import unittest
from unittest import mock

from app.services import run_data
from app.services.run_data import ConversionManager, _clamp_int, _wave_selection


ALL_CAPS = {
    "ts_unit": True, "compression": True, "ignore_fail": True,
    "header_boards": True, "algo": True, "buffer": True, "wave": True,
    "force_dual_trace": True, "ignore_psd_boards": True, "verbose": True,
}
NO_CAPS = {key: False for key in ALL_CAPS}


class ClampTests(unittest.TestCase):

    def test_a_value_inside_the_range_is_kept(self):
        self.assertEqual(_clamp_int(5, 0, 9), 5)

    def test_a_value_above_the_range_is_pulled_down(self):
        self.assertEqual(_clamp_int(99, 0, 9), 9)

    def test_a_value_below_the_range_is_pulled_up(self):
        self.assertEqual(_clamp_int(-4, 1, 1024), 1)

    def test_a_string_of_digits_is_accepted(self):
        # The dashboard sends JSON built from an <input type="number">, which
        # is a string whenever the browser cannot coerce it.
        self.assertEqual(_clamp_int("7", 0, 9), 7)

    def test_nonsense_falls_back_to_the_low_end(self):
        self.assertEqual(_clamp_int("not a number", 0, 9), 0)
        self.assertEqual(_clamp_int(None, 1, 1024), 1)


class WaveSelectionTests(unittest.TestCase):

    def test_board_ids_and_waves_are_parsed_from_strings(self):
        self.assertEqual(_wave_selection({"wave_select": {"0": 2, "1": "1"}}),
                         {0: 2, 1: 1})

    def test_a_wave_other_than_1_or_2_is_dropped(self):
        # RUReader exits on it rather than converting.
        self.assertEqual(_wave_selection({"wave_select": {"0": 3}}), {})

    def test_a_board_id_outside_the_five_bit_header_field_is_dropped(self):
        self.assertEqual(_wave_selection({"wave_select": {"32": 1}}), {})

    def test_missing_or_malformed_input_gives_nothing(self):
        self.assertEqual(_wave_selection({}), {})
        self.assertEqual(_wave_selection({"wave_select": "trace 1"}), {})


class CommandLineTests(unittest.TestCase):
    """What actually reaches subprocess.run, for a given set of options."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.run_dir = os.path.join(self.tmp, "data", "run7")
        os.makedirs(self.run_dir)
        open(os.path.join(self.run_dir, "run_7_0000.caendat"), "wb").close()

        self.cwd = os.getcwd()
        os.chdir(self.tmp)
        self.addCleanup(self._restore)

        self.manager = ConversionManager()

    def _restore(self):
        os.chdir(self.cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _command(self, options, caps=ALL_CAPS):
        """Run one conversion with the converter stubbed out, return its argv."""
        recorded = {}

        def fake_run(cmd, **kwargs):
            recorded["cmd"] = cmd
            return mock.Mock(returncode=0, stdout="", stderr="")

        self.manager._capabilities = dict(caps)
        # _convert() picks up the job start() left behind; going straight to it
        # skips the thread but has to leave the same record.
        self.manager._jobs[7] = {"state": "running", "started_at": 0.0,
                                 "output": None, "log": [], "returncode": None}
        with mock.patch.object(run_data.subprocess, "run", side_effect=fake_run), \
             mock.patch.object(run_data.shutil, "which", return_value="/usr/bin/RUReader"):
            self.manager._convert(7, "/usr/bin/RUReader", options)
        return recorded["cmd"]

    def test_the_input_is_the_run_directory_so_split_files_stay_in_order(self):
        cmd = self._command({})
        self.assertEqual(cmd[0], "/usr/bin/RUReader")
        self.assertIn("-i", cmd)
        self.assertTrue(cmd[cmd.index("-i") + 1].endswith(os.path.join("data", "run7")))

    def test_every_option_reaches_the_command_line(self):
        cmd = self._command({
            "ts_unit": "ns", "algo": "zstd", "compression": 5, "buffer_mb": 128,
            "ignore_psd_boards": True, "verbose": True,
        })
        self.assertEqual(cmd[cmd.index("-t") + 1], "ns")
        self.assertEqual(cmd[cmd.index("-a") + 1], "zstd")
        self.assertEqual(cmd[cmd.index("-c") + 1], "5")
        self.assertEqual(cmd[cmd.index("-b") + 1], "128")
        self.assertIn("--ignore-psd-boards", cmd)
        self.assertIn("-v", cmd)

    def test_an_out_of_range_value_is_clamped_rather_than_passed_on(self):
        # RUReader rejects a level above 9 and a buffer above 1024 MB.
        cmd = self._command({"compression": 42, "buffer_mb": 99999})
        self.assertEqual(cmd[cmd.index("-c") + 1], "9")
        self.assertEqual(cmd[cmd.index("-b") + 1], "1024")

    def test_an_unknown_algorithm_is_left_out(self):
        cmd = self._command({"algo": "brotli"})
        self.assertNotIn("-a", cmd)

    def test_the_trace_choice_is_sent_per_board(self):
        cmd = self._command({"wave_select": {"0": 2, "2": 1}})
        self.assertEqual(cmd[cmd.index("-w") + 1:cmd.index("-w") + 3], ["2", "0"])
        self.assertEqual(cmd.count("-w"), 2)

    def test_keeping_both_traces_supersedes_the_per_board_choice(self):
        # --force-dual-trace keeps both, so selecting one of them is meaningless
        # and sending it alongside would only be noise.
        cmd = self._command({"force_dual_trace": True, "wave_select": {"0": 2}})
        self.assertIn("--force-dual-trace", cmd)
        self.assertNotIn("-w", cmd)

    def test_nothing_the_installed_binary_lacks_is_passed(self):
        cmd = self._command({
            "ts_unit": "ns", "algo": "zstd", "compression": 5, "buffer_mb": 128,
            "force_dual_trace": True, "ignore_psd_boards": True, "verbose": True,
        }, caps=NO_CAPS)
        for flag in ("-t", "-a", "-c", "-b", "-w", "-v",
                     "--force-dual-trace", "--ignore-psd-boards", "--ignore-fail"):
            self.assertNotIn(flag, cmd)

    def test_an_option_that_was_dropped_is_reported_in_the_log(self):
        self._command({"algo": "zstd", "buffer_mb": 128}, caps=NO_CAPS)
        log = self.manager.status(7)["log"]
        self.assertTrue(log and log[0].startswith("NOTE:"))
        self.assertIn("compression algorithm 'zstd'", log[0])
        self.assertIn("read buffer size", log[0])

    def test_an_older_binary_is_told_the_boards_it_cannot_read_from_the_header(self):
        caps = dict(NO_CAPS)
        cmd = self._command({"boards": [{"name": "V1724", "id": 0}]}, caps=caps)
        self.assertEqual(cmd[cmd.index("-d") + 1:cmd.index("-d") + 3], ["V1724", "0"])


if __name__ == "__main__":
    unittest.main()
