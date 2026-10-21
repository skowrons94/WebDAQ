"""
One SIS3316 digitizer: identification, clock/ADC initialisation, register
configuration from a settings dict, bank-swap readout, on-board energy
histograms and trigger statistic counters.

The initialisation sequence follows the SIS3316 manual (sec. 2.3.3 "Sample
Clock configuration sequence") and Struck's reference sis3316_class.cpp.
"""

import logging
import time
from typing import Any, Dict, List, Optional

import numpy as np

from . import registers as R
from .settings import (CLOCK_TABLE, GAIN_CODES, apply_defaults, channel_settings)
from .transport import Sis3316Error, Sis3316ProtocolError, Sis3316Timeout, UdpLink

logger = logging.getLogger(__name__)

# I2C bits of the programmable-oscillator register (sis3316_class.h)
_I2C_ACK, _I2C_START, _I2C_STOP, _I2C_WRITE, _I2C_READ, _I2C_BUSY = 8, 9, 11, 12, 13, 31
_SI570_ADDR = 0x55
_HSDIV_CODE = {4: 0, 5: 1, 6: 2, 7: 3, 9: 5, 11: 7}

# Bits of the acquisition control/status register
ACQ_ARMED = 1 << 16
ACQ_ARMED_BANK2 = 1 << 17
ACQ_BUSY = 1 << 18
ACQ_ADDRESS_THRESHOLD = 1 << 19


class Sis3316:
    """Driver for one SIS3316 reached over UDP."""

    def __init__(self, host: str, port: int = 0xE000, local_ip: str = "",
                 local_port: int = 0xE000, timeout: float = 0.1):
        self.link = UdpLink(host, port, local_ip=local_ip, local_port=local_port,
                            timeout=timeout)
        self.host = host
        self.info: Dict[str, Any] = {}
        self.settings: Dict[str, Any] = {}
        self.adc_bits = 14
        self.sample_clock_mhz = 250.0
        self.bank2_armed = False

    # ── connection ─────────────────────────────────────────────────────────
    def open(self) -> Dict[str, Any]:
        """Open the socket, take the interface grant, identify the board."""
        self.link.open()
        # Kill a grant held by the VME side, then request our own (addendum 5.5)
        self.link.link_write(R.LINK_ARBITRATION, 0x80000000)
        self.link.link_write(R.LINK_ARBITRATION, 0x1)
        arb = self.link.link_read(R.LINK_ARBITRATION)
        if not arb & (1 << 20):
            raise Sis3316Error(f"Ethernet interface did not get the grant (0x{arb:08x})")
        self.info = self.identify()
        return self.info

    def close(self) -> None:
        try:
            if self.link.is_open:
                self.link.write(R.KEY_DISARM, 0)
                self.link.link_write(R.LINK_ARBITRATION, 0x0)
        except Sis3316Error:
            pass
        self.link.close()

    def identify(self) -> Dict[str, Any]:
        modid = self.link.link_read(R.LINK_MODID)
        hw = self.link.link_read(R.LINK_HARDWARE_VERSION) & 0xF
        serial, temp = self.link.read_list([R.SERIAL_NUMBER, R.TEMPERATURE])
        adc_fw = self.link.read_list([R.grp(R.ADC_FPGA_VERSION, g) for g in range(R.N_GROUPS)])
        fw_type = (adc_fw[0] >> 16) & 0xFFFF
        self.adc_bits = 16 if fw_type == 0x0125 else 14
        return {
            "model": "SIS3316",
            "module_id": f"0x{(modid >> 16) & 0xFFFF:04x}",
            "vme_fpga_firmware": f"0x{modid & 0xFFFF:04x}",
            "udp_protocol": "packet-id" if self.link.packet_id_mode else "legacy",
            "hardware_version": hw,
            "serial": serial & 0xFFFF,
            "mac": f"00:00:56:31:6{(serial >> 8) & 0xF:x}:{serial & 0xFF:02x}",
            "adc_fpga_firmware": [f"0x{v:08x}" for v in adc_fw],
            "adc_type": "125MHz-16bit" if fw_type == 0x0125 else "250MHz-14bit",
            "adc_bits": self.adc_bits,
            "channels": R.N_CHANNELS,
            "temperature_c": self._temperature(temp),
        }

    @staticmethod
    def _temperature(raw: int) -> float:
        v = raw & 0x3FF
        if v & 0x200:
            v -= 0x400
        return v / 4.0

    def temperature(self) -> float:
        return self._temperature(self.link.read(R.TEMPERATURE))

    # ── programmable oscillator (Si570 over the board's I2C master) ─────────
    def _i2c(self, value: int) -> int:
        self.link.write(R.ADC_CLK_OSC_I2C, value)
        for _ in range(1000):
            tmp = self.link.read(R.ADC_CLK_OSC_I2C)
            if not tmp & (1 << _I2C_BUSY):
                return tmp
        raise Sis3316Error("I2C to the sample-clock oscillator stays busy")

    def _i2c_start(self):
        self._i2c(1 << _I2C_START)

    def _i2c_stop(self):
        self._i2c(1 << _I2C_STOP)

    def _i2c_write(self, byte: int) -> None:
        tmp = self._i2c((1 << _I2C_WRITE) ^ (byte & 0xFF))
        if not tmp & (1 << _I2C_ACK):
            self._i2c_stop()
            raise Sis3316Error("sample-clock oscillator did not acknowledge I2C")

    def _i2c_read(self, ack: bool) -> int:
        return self._i2c((1 << _I2C_READ) | ((1 << _I2C_ACK) if ack else 0)) & 0xFF

    def _si570_write(self, reg: int, data: List[int]) -> None:
        self._i2c_start()
        self._i2c_write(_SI570_ADDR << 1)
        self._i2c_write(reg)
        for b in data:
            self._i2c_write(b)
        self._i2c_stop()

    def _si570_read_dividers(self) -> List[int]:
        self._i2c_start()
        self._i2c_write(_SI570_ADDR << 1)
        self._i2c_write(0x0D)
        self._i2c_start()
        self._i2c_write((_SI570_ADDR << 1) + 1)
        data = [self._i2c_read(ack=(i < 5)) for i in range(6)]
        self._i2c_stop()
        return data

    def set_sample_clock(self, mhz: float) -> None:
        """Program the internal oscillator: HS_DIV and N1 only, keeping the
        factory-calibrated RFREQ, as Struck's change_frequency_HSdiv_N1div."""
        key = min(CLOCK_TABLE, key=lambda f: abs(f - mhz))
        hs_div, n1_div, _, _ = CLOCK_TABLE[key]
        rd = self._si570_read_dividers()
        hs = _HSDIV_CODE[hs_div]
        n1 = n1_div - 1
        wr = [((hs & 0x7) << 5) + ((n1 & 0x7C) >> 2),
              ((n1 & 0x3) << 6) + (rd[1] & 0x3F)] + rd[2:6]
        self._si570_write(0x89, [0x10])     # freeze DCO
        self._si570_write(0x0D, wr[:2])     # HS_DIV / N1 only (RFREQ unchanged)
        self._si570_write(0x89, [0x00])     # unfreeze DCO
        self._si570_write(0x87, [0x40])     # new frequency
        time.sleep(0.015)
        self.link.write(R.KEY_ADC_CLOCK_DCM_RESET, 0)
        time.sleep(0.02)
        self.sample_clock_mhz = key

    def _configure_iob_delays(self, delay: int) -> None:
        self.link.write_list([(R.grp(R.INPUT_TAP_DELAY, g), 0xF00) for g in range(R.N_GROUPS)])
        time.sleep(0.001)
        self.link.write_list([(R.grp(R.INPUT_TAP_DELAY, g), 0x300 + delay)
                              for g in range(R.N_GROUPS)])
        time.sleep(0.001)

    # ── ADC chips (AD9643 / AD9268) over the ADC FPGA SPI master ────────────
    def _spi_wait(self) -> None:
        for _ in range(1000):
            if (self.link.read(R.ADC_FPGA_SPI_BUSY_STATUS) & 0xF) == 0:
                return
        raise Sis3316Error("ADC SPI logic stays busy")

    def _adc_spi_write(self, group: int, chip: int, addr: int, data: int) -> None:
        reg = R.grp(R.SPI_CTRL, group)
        keep = self.link.read(reg) & 0x01000000
        mux = 0x400000 if chip else 0
        self.link.write(reg, keep + 0x80000000 + mux + ((addr & 0xFFFF) << 8) + (data & 0xFF))
        self._spi_wait()

    def _adc_spi_read(self, group: int, chip: int, addr: int) -> int:
        reg = R.grp(R.SPI_CTRL, group)
        keep = self.link.read(reg) & 0x01000000
        mux = 0x400000 if chip else 0
        self.link.write(reg, keep + 0xC0000000 + mux + ((addr & 0x1FFF) << 8))
        self._spi_wait()
        time.sleep(0.0001)
        return self.link.read(R.grp(R.SPI_READBACK, group)) & 0xFF

    def _adc_chip_setup(self) -> None:
        for g in range(R.N_GROUPS):
            self.link.write(R.grp(R.SPI_CTRL, g), 0)
        for g in range(R.N_GROUPS):
            for c in range(2):
                self._adc_spi_write(g, c, 0x00, 0x24)        # soft reset
        time.sleep(0.001)
        chip_id = self._adc_spi_read(0, 0, 1)
        for g in range(R.N_GROUPS):
            for c in range(2):
                if self._adc_spi_read(g, c, 1) != chip_id:
                    raise Sis3316Error(f"ADC chip {g}/{c} reports a different chip id")
        is_125 = (chip_id & 0xFF) == 0x32                    # AD9268
        output_mode = 0x40 if is_125 else 0x04               # LVDS / inverted output
        vref = 0xC0 if is_125 else 0x00                      # 2.0 V / 1.75 V span
        for g in range(R.N_GROUPS):
            for c in range(2):
                self._adc_spi_write(g, c, 0x14, output_mode)
                self._adc_spi_write(g, c, 0x18, vref)
                self._adc_spi_write(g, c, 0xFF, 0x01)        # transfer/update
        self._enable_adc_outputs()

    def _enable_adc_outputs(self) -> None:
        self.link.write_list([(R.grp(R.SPI_CTRL, g), 0x01000000) for g in range(R.N_GROUPS)])

    # ── analog front end ───────────────────────────────────────────────────
    def _dac_wait(self) -> None:
        for _ in range(1000):
            if (self.link.read(R.ADC_FPGA_SPI_BUSY_STATUS) & 0xF) == 0:
                return
        raise Sis3316Error("offset DAC logic stays busy")

    def write_dac_offsets(self, offsets: List[int]) -> None:
        for g in range(R.N_GROUPS):
            reg = R.grp(R.DAC_OFFSET_CTRL, g)
            self.link.write(reg, 0x80000000 + 0x08000000 + 0x00F00000 + 0x1)  # internal ref
            self._dac_wait()
            self.link.write(reg, 0xC0000000)                                  # LDAC
            self._dac_wait()
            for c in range(4):
                v = int(offsets[4 * g + c]) & 0xFFFF
                self.link.write(reg, 0x80000000 + 0x02000000 + (c << 20) + (v << 4))
                self._dac_wait()
            self.link.write(reg, 0xC0000000)
            self._dac_wait()

    # ── initialisation ─────────────────────────────────────────────────────
    def initialize(self, settings: Dict[str, Any]) -> None:
        """Bring the board from any state to configured-and-disarmed."""
        s = apply_defaults(settings)
        clock = float(s["board"]["sample_clock_mhz"])
        self.link.write(R.KEY_DISARM, 0)
        self.link.write(R.KEY_RESET, 0)
        self.link.write(R.SAMPLE_CLOCK_DISTRIBUTION, 0)          # internal oscillator
        self._adc_chip_setup()
        self.set_sample_clock(clock)
        _, _, iob_new, iob_old = CLOCK_TABLE[self.sample_clock_mhz]
        adc_rev = int(self.info.get("adc_fpga_firmware", ["0x0"])[0], 16) & 0xFF
        self._configure_iob_delays(iob_new if adc_rev >= 4 else iob_old)
        # Clear the ADC/VME FPGA link error latches after the clock change
        self.link.write_list([(R.grp(R.INPUT_TAP_DELAY, g), 0x400) for g in range(R.N_GROUPS)])
        self.link.write(R.VME_FPGA_LINK_ADC_PROT_STATUS, 0xE0E0E0E0)
        self._enable_adc_outputs()
        self.configure(s)

    def configure(self, settings: Dict[str, Any]) -> None:
        """Write every acquisition register from a settings dict (disarmed)."""
        s = apply_defaults(settings)
        self.settings = s
        b = s["board"]
        chans = [channel_settings(s, ch) for ch in range(R.N_CHANNELS)]
        w: List = []

        # Analog: gain/termination and offset DACs
        for g in range(R.N_GROUPS):
            val = 0
            for c in range(4):
                ch = chans[4 * g + c]
                code = GAIN_CODES[str(ch["input_range"])]
                if not ch["termination_50ohm"]:
                    code |= 0x4
                val |= code << (8 * c)
            w.append((R.grp(R.ANALOG_CTRL, g), val))
        self.link.write_list(w)
        self.write_dac_offsets([ch["dac_offset"] for ch in chans])

        w = []
        header_id = (int(b.get("header_id", 0)) & 0xFF) << 24
        fmt = 0x8                                    # start + max energy, always
        if b["save_peak_accumulators"]:
            fmt |= 0x1
        if b["save_maw_values"]:
            fmt |= 0x4
        if b["maw_test_buffer_length"] > 0:
            fmt |= 0x10
            if b["maw_test_buffer_energy"]:
                fmt |= 0x20
        raw_len = int(b["raw_samples"]) & 0xFFFE
        for g in range(R.N_GROUPS):
            ev = 0
            for c in range(4):
                ch = chans[4 * g + c]
                bits = 0
                if ch["invert"]:
                    bits |= 0x1
                if ch["enabled"] and ch["internal_trigger"]:
                    bits |= 0x4
                if ch["enabled"] and ch["external_trigger"]:
                    bits |= 0x8
                ev |= bits << (8 * c)
            w += [
                (R.grp(R.CHANNEL_HEADER, g), header_id | (g << 22)),
                (R.grp(R.EVENT_CONFIG, g), ev),
                (R.grp(R.EXTENDED_EVENT_CONFIG, g), 0),
                (R.grp(R.TRIGGER_GATE_WINDOW_LENGTH, g), (int(b["trigger_gate_window"]) - 2) & 0xFFFF),
                (R.grp(R.RAW_DATA_BUFFER_CONFIG, g), (raw_len << 16) | (int(b["raw_start_index"]) & 0xFFFE)),
                (R.grp(R.EXTENDED_RAW_DATA_BUFFER_CONFIG, g), 0),
                (R.grp(R.PILEUP_CONFIG, g), ((int(b["repileup_window"]) & 0xFFFE) << 16)
                                            | (int(b["pileup_window"]) & 0xFFFE)),
                (R.grp(R.PRE_TRIGGER_DELAY, g), int(b["pre_trigger_delay"]) & 0x3FFE),
                (R.grp(R.DATAFORMAT_CONFIG, g), fmt * 0x01010101),
                (R.grp(R.MAW_TEST_BUFFER_CONFIG, g), (int(b["maw_test_buffer_length"]) & 0xFFFE)
                                                    | ((int(b["maw_test_buffer_pretrigger"]) & 0x3FE) << 16)),
                (R.grp(R.INTERNAL_TRIGGER_DELAY_CONFIG, g), 0),
                (R.grp(R.INTERNAL_GATE_LENGTH_CONFIG, g), 0),
                (R.grp(R.ADDRESS_THRESHOLD, g), int(b["bank_threshold_words"]) & 0xFFFFFF),
                (R.grp(R.TRIGGER_STATISTIC_COUNTER_MODE, g), 1),   # latch on bank swap
            ]
            for gate in range(8):
                w.append((R.grp(R.ACCUMULATOR_GATE_CONFIG, g) + 4 * gate, 0))
            for c in range(4):
                ch = chans[4 * g + c]
                n = 4 * g + c
                w += [
                    (R.chan_reg(R.FIR_ENERGY_SETUP, n, 4),
                     ((int(ch["tau_table"]) & 0x3) << 30) | ((int(ch["tau_factor"]) & 0x3F) << 24)
                     | ((int(ch["energy_extra_filter"]) & 0x3) << 22)
                     | ((int(ch["energy_gap"]) & 0x3FE) << 12) | (int(ch["energy_peaking"]) & 0xFFE)),
                    (R.chan_reg(R.ENERGY_HISTOGRAM_CONFIG, n, 4), self._histogram_config(ch, b)),
                    (R.chan_reg(R.MAW_START_INDEX_ENERGY_PICKUP, n, 4),
                     ((int(ch["energy_pickup_index"]) & 0xFFFF) << 16)),
                ]
        self.link.write_list(w)

        # Trigger FIRs: setup is cleared first, its rewrite resets the logic
        for ch_no, ch in enumerate(chans):
            p = int(ch["trigger_peaking"]) & 0xFFE
            gap = int(ch["trigger_gap"]) & 0xFFE
            thr = 0x08000000 + int(ch["trigger_threshold"]) * max(p, 2)
            thr_reg = (thr & 0x0FFFFFFF)
            if ch["enabled"] and ch["internal_trigger"]:
                thr_reg |= 0x80000000
            thr_reg |= {"off": 0, "zero": 2, "50": 3}[str(ch["cfd"])] << 28
            he = 0x08000000 + int(ch["high_energy_threshold"]) * max(p, 2)
            setup = ((int(ch["trigger_pulse_length"]) & 0xFE) << 24) | (gap << 12) | p
            self.link.write_list([
                (R.chan_reg(R.FIR_TRIGGER_SETUP, ch_no, 0x10), 0),
                (R.chan_reg(R.FIR_TRIGGER_THRESHOLD, ch_no, 0x10), 0),
                (R.chan_reg(R.FIR_HIGH_ENERGY_THRESHOLD, ch_no, 0x10), he & 0x0FFFFFFF),
                (R.chan_reg(R.FIR_TRIGGER_THRESHOLD, ch_no, 0x10), thr_reg),
                (R.chan_reg(R.FIR_TRIGGER_SETUP, ch_no, 0x10), setup),
            ])

        # Board-wide trigger sources and NIM in/out
        acq = 0
        if b["nim_ti_as_trigger"]:
            acq |= 1 << 8
        if b["nim_ti_timestamp_clear"]:
            acq |= 1 << 10
        nim = 0x10 if b["nim_ti_as_trigger"] else 0      # TI enable
        self.link.write_list([
            (R.ACQUISITION_CONTROL, acq),
            (R.NIM_INPUT_CONTROL, nim),
            (R.LEMO_OUT_CO_SELECT, int(b["lemo_co_select"])),
            (R.LEMO_OUT_TO_SELECT, int(b["lemo_to_select"])),
            (R.LEMO_OUT_UO_SELECT, int(b["lemo_uo_select"])),
        ])

    @staticmethod
    def _histogram_config(ch: Dict[str, Any], b: Dict[str, Any]) -> int:
        if not (b["onboard_histograms"] and ch["enabled"]):
            return 0
        divider = max(1, min(0xFFF, int(ch["histogram_divider"])))
        offset = int(ch["histogram_offset"]) & 0xFF
        val = (divider << 16) | (offset << 8) | 0x1
        if ch["histogram_pileup"]:
            val |= 0x2
        return val

    # ── acquisition ────────────────────────────────────────────────────────
    def clear_timestamp(self) -> None:
        """Clears timestamps, statistic counters and the on-board histograms."""
        self.link.write(R.KEY_TIMESTAMP_CLEAR, 0)

    def arm(self, bank2: bool = False) -> None:
        self.link.write(R.KEY_DISARM_AND_ARM_BANK2 if bank2 else R.KEY_DISARM_AND_ARM_BANK1, 0)
        self.bank2_armed = bank2

    def swap(self) -> bool:
        """Arm the other bank. Returns True if the bank to read is bank 2."""
        read_bank2 = self.bank2_armed
        self.arm(not self.bank2_armed)
        return read_bank2

    def disarm(self) -> None:
        self.link.write(R.KEY_DISARM, 0)

    def acquisition_status(self) -> int:
        return self.link.read(R.ACQUISITION_CONTROL)

    def previous_bank_addresses(self, bank2: bool, timeout_s: float = 0.2) -> List[int]:
        """Number of 32-bit words each channel stored in the bank just closed.

        The register only becomes valid once its bank bit (24) matches the bank
        being read; poll until all 16 are valid.
        """
        addrs = [R.chan_reg(R.PREVIOUS_BANK_SAMPLE_ADDRESS, ch, 4) for ch in range(R.N_CHANNELS)]
        want = 1 if bank2 else 0
        deadline = time.monotonic() + timeout_s
        while True:
            vals = self.link.read_list(addrs)
            if all(((v >> 24) & 1) == want for v in vals):
                return [v & 0xFFFFFF for v in vals]
            if time.monotonic() > deadline:
                return [(v & 0xFFFFFF) if ((v >> 24) & 1) == want else 0 for v in vals]
            time.sleep(0.0005)

    def read_memory(self, channel: int, word_offset: int, nwords: int,
                    attempts: int = 3) -> np.ndarray:
        """Read channel event memory through the ADC FPGA data-transfer logic."""
        group = channel >> 2
        ctrl = R.DATA_TRANSFER_CTRL + 4 * group
        fifo = R.FPGA_MEM_BASE + R.FPGA_MEM_OFFSET * group
        last: Optional[Exception] = None
        for _ in range(attempts):
            try:
                self.link.write(ctrl, R.TRANSFER_READ + (word_offset & 0x3FFFFFFF))
                data = self.link.fifo_read(fifo, nwords)
                self.link.write(ctrl, R.TRANSFER_RESET)
                return data
            except (Sis3316Timeout, Sis3316ProtocolError) as e:
                last = e
                try:
                    self.link.write(ctrl, R.TRANSFER_RESET)
                except Sis3316Error:
                    pass
        raise last

    def read_bank(self, channel: int, bank2: bool, nwords: int) -> np.ndarray:
        return self.read_memory(channel, R.memory_offset(channel, bank2), nwords)

    def energy_histogram(self, channel: int, nbins: int = R.HISTOGRAM_BINS) -> np.ndarray:
        """Read the on-board 64K-bin energy histogram of one channel."""
        nbins = max(2, min(R.HISTOGRAM_BINS, int(nbins)))
        nbins += nbins & 1
        off = R.memory_offset(channel) + R.HISTOGRAM_MEMORY_OFFSET
        return self.read_memory(channel, off, nbins)

    def write_memory(self, channel: int, word_offset: int, data: np.ndarray) -> None:
        group = channel >> 2
        ctrl = R.DATA_TRANSFER_CTRL + 4 * group
        fifo = R.FPGA_MEM_BASE + R.FPGA_MEM_OFFSET * group
        self.link.write(ctrl, R.TRANSFER_WRITE + (word_offset & 0x3FFFFFFF))
        try:
            self.link.fifo_write(fifo, data)
        finally:
            self.link.write(ctrl, R.TRANSFER_RESET)

    def clear_energy_histograms(self, channels) -> None:
        """Zero the on-board histogram memory of the given channels.

        On V3316-2004 the Timestamp-Clear does not zero the histogram memory,
        which powers up with random content, so it is overwritten here.
        Must be called disarmed.
        """
        zeros = np.zeros(R.HISTOGRAM_BINS, dtype=np.uint32)
        for ch in channels:
            self.write_memory(ch, R.memory_offset(ch) + R.HISTOGRAM_MEMORY_OFFSET, zeros)

    def statistic_counters(self) -> np.ndarray:
        """(16, 6) array: internal, hit, deadtime, pileup, veto, high-energy triggers."""
        out = np.zeros((R.N_CHANNELS, 6), dtype=np.uint64)
        for g in range(R.N_GROUPS):
            ctrl = R.DATA_TRANSFER_CTRL + 4 * g
            fifo = R.FPGA_MEM_BASE + R.FPGA_MEM_OFFSET * g
            self.link.write(ctrl, R.TRANSFER_READ + R.STATISTIC_COUNTER_SPACE)
            data = self.link.fifo_read(fifo, R.STATISTIC_WORDS_PER_GROUP)
            self.link.write(ctrl, R.TRANSFER_RESET)
            out[4 * g:4 * g + 4] = data.reshape(4, 6)
        return out

    def trigger_counters(self) -> List[int]:
        """Free-running internal trigger counter of each channel (VME FPGA)."""
        return self.link.read_list([R.INTERNAL_TRIGGER_COUNTER + 4 * ch for ch in range(R.N_CHANNELS)])

    def adc_status(self) -> List[int]:
        return self.link.read_list([R.grp(R.ADC_FPGA_STATUS, g) for g in range(R.N_GROUPS)])

    def actual_sample_addresses(self) -> List[int]:
        return [v & 0xFFFFFF for v in self.link.read_list(
            [R.chan_reg(R.ACTUAL_SAMPLE_ADDRESS, ch, 4) for ch in range(R.N_CHANNELS)])]
