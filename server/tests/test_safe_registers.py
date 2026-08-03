"""
The online-tuning allowlist.

These tests exist because the cost of a mistake here is asymmetric: refusing a
safe register is an inconvenience, allowing an unsafe one corrupts a run.
"""

import unittest

from app.utils.safe_registers import (
    channel_base,
    channel_of,
    is_online_safe,
    safe_register_names,
)


class ChannelAddressTests(unittest.TestCase):
    def test_per_channel_address_normalises_to_channel_zero(self):
        self.assertEqual(channel_base(0x1A6C), 0x106C)   # channel 10
        self.assertEqual(channel_base(0x1560), 0x1060)   # channel 5
        self.assertEqual(channel_base(0x1060), 0x1060)   # already channel 0

    def test_global_addresses_are_left_alone(self):
        for address in (0x8000, 0x8100, 0xEF08, 0x81C4):
            self.assertEqual(channel_base(address), address)

    def test_channel_of(self):
        self.assertEqual(channel_of(0x1A6C), 10)
        self.assertEqual(channel_of(0x1060), 0)
        self.assertIsNone(channel_of(0x8000))


class OnlineSafetyTests(unittest.TestCase):
    def test_psd_tuning_parameters_are_writable(self):
        for address in (0x1060, 0x1054, 0x1058, 0x1098, 0x1080):
            allowed, reason = is_online_safe(address, 'DPP-PSD')
            self.assertTrue(allowed, f"0x{address:04X} should be writable: {reason}")
            self.assertEqual(reason, '')

    def test_pha_tuning_parameters_are_writable(self):
        for address in (0x106C, 0x105C, 0x1064, 0x1068, 0x10C4):
            allowed, _ = is_online_safe(address, 'DPP-PHA')
            self.assertTrue(allowed, f"0x{address:04X} should be writable for PHA")

    def test_same_rules_apply_on_every_channel(self):
        allowed_ch0, _ = is_online_safe(0x1060, 'DPP-PSD')
        allowed_ch7, _ = is_online_safe(0x1760, 'DPP-PSD')
        self.assertEqual(allowed_ch0, allowed_ch7)
        self.assertTrue(allowed_ch7)

    def test_structural_registers_are_refused_with_a_reason(self):
        for address, expected in (
            (0x1020, 'Record Length'),
            (0x8000, 'Board Configuration'),
            (0x8100, 'Acquisition Control'),
            (0x8120, 'Channel Enable Mask'),
            (0xEF08, 'Board ID'),
            (0x1034, 'Number of Events per Aggregate'),
        ):
            allowed, reason = is_online_safe(address, 'DPP-PSD')
            self.assertFalse(allowed, f"0x{address:04X} must not be writable online")
            self.assertIn(expected, reason)
            # The operator has to learn what happens to their edit.
            self.assertIn('next run', reason.lower())

    def test_structural_registers_are_refused_on_any_channel(self):
        allowed, reason = is_online_safe(0x1520, 'DPP-PSD')   # Record Length, ch 5
        self.assertFalse(allowed)
        self.assertIn('Record Length', reason)

    def test_unknown_registers_are_refused_by_default(self):
        # A register nobody has classified must not become writable by accident.
        allowed, reason = is_online_safe(0x10E8, 'DPP-PSD')
        self.assertFalse(allowed)
        self.assertIn('0x10E8', reason)

    def test_firmware_specific_registers_do_not_leak_across_firmwares(self):
        # Fine Gain is DPP-PHA only.
        allowed_pha, _ = is_online_safe(0x10C4, 'DPP-PHA')
        allowed_psd, reason = is_online_safe(0x10C4, 'DPP-PSD')
        self.assertTrue(allowed_pha)
        self.assertFalse(allowed_psd)
        self.assertIn('DPP-PSD', reason)

    def test_unknown_firmware_string_falls_back_to_psd(self):
        allowed, _ = is_online_safe(0x1060, 'something-else')
        self.assertTrue(allowed)   # 0x1060 is the PSD trigger threshold

    def test_safe_register_names_are_addresses_to_names(self):
        names = safe_register_names('DPP-PHA')
        self.assertEqual(names['0x106C'], 'Trigger Threshold')
        self.assertNotIn('0x1020', names)          # structural
        self.assertTrue(all(key.startswith('0x') for key in names))


if __name__ == '__main__':
    unittest.main()
