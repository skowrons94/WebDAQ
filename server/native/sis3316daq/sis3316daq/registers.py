"""
SIS3316 register map (SIS3316 user manual V1.28, chapter 5/6).

Group registers repeat per ADC FPGA (4 channels each) at 0x1000 steps; use
``grp(addr, g)`` to address group g (0-3) and ``chan_reg(base, ch, stride)``
for the per-channel registers inside a group.
"""

# ── Link interface (UDP command 0x10/0x11) ──────────────────────────────────
LINK_CONTROL_STATUS = 0x00
LINK_MODID = 0x04
LINK_UDP_PROTOCOL_CONFIG = 0x08
LINK_LAST_ACK_STATUS = 0x0C
LINK_ARBITRATION = 0x10
LINK_ERROR_COUNTERS = 0x14
LINK_HARDWARE_VERSION = 0x1C

# ── VME FPGA registers ──────────────────────────────────────────────────────
TEMPERATURE = 0x20
SERIAL_NUMBER = 0x28
ADC_CLK_OSC_I2C = 0x40
SAMPLE_CLOCK_DISTRIBUTION = 0x50
NIM_CLK_MULTIPLIER_SPI = 0x54
FP_BUS_CONTROL = 0x58
NIM_INPUT_CONTROL = 0x5C
ACQUISITION_CONTROL = 0x60
LEMO_OUT_CO_SELECT = 0x70
LEMO_OUT_TO_SELECT = 0x74
LEMO_OUT_UO_SELECT = 0x78
INTERNAL_TRIGGER_FEEDBACK_SELECT = 0x7C
DATA_TRANSFER_CTRL = 0x80          # + 4 * group
DATA_TRANSFER_STATUS = 0x90        # + 4 * group
VME_FPGA_LINK_ADC_PROT_STATUS = 0xA0
ADC_FPGA_SPI_BUSY_STATUS = 0xA4
INTERNAL_TRIGGER_COUNTER = 0xC0    # + 4 * channel

# ── Key addresses (write any value) ─────────────────────────────────────────
KEY_RESET = 0x400
KEY_USER_FUNCTION = 0x404
KEY_ARM = 0x410
KEY_DISARM = 0x414
KEY_TRIGGER = 0x418
KEY_TIMESTAMP_CLEAR = 0x41C
KEY_DISARM_AND_ARM_BANK1 = 0x420
KEY_DISARM_AND_ARM_BANK2 = 0x424
KEY_ENABLE_BANK_SWAP_NIM = 0x428
KEY_PPS_LATCH_CLEAR = 0x430
KEY_ADC_FPGA_RESET = 0x434
KEY_ADC_CLOCK_DCM_RESET = 0x438

# ── ADC FPGA group registers (group 0 = ch1-4) ──────────────────────────────
GROUP_OFFSET = 0x1000
INPUT_TAP_DELAY = 0x1000
ANALOG_CTRL = 0x1004               # gain / termination
DAC_OFFSET_CTRL = 0x1008
SPI_CTRL = 0x100C
EVENT_CONFIG = 0x1010
CHANNEL_HEADER = 0x1014
ADDRESS_THRESHOLD = 0x1018
TRIGGER_GATE_WINDOW_LENGTH = 0x101C
RAW_DATA_BUFFER_CONFIG = 0x1020
PILEUP_CONFIG = 0x1024
PRE_TRIGGER_DELAY = 0x1028
AVERAGE_CONFIG = 0x102C
DATAFORMAT_CONFIG = 0x1030
MAW_TEST_BUFFER_CONFIG = 0x1034
INTERNAL_TRIGGER_DELAY_CONFIG = 0x1038
INTERNAL_GATE_LENGTH_CONFIG = 0x103C
FIR_TRIGGER_SETUP = 0x1040         # + 0x10 * channel-in-group
FIR_TRIGGER_THRESHOLD = 0x1044     # + 0x10 * channel-in-group
FIR_HIGH_ENERGY_THRESHOLD = 0x1048 # + 0x10 * channel-in-group
SUM_FIR_TRIGGER_SETUP = 0x1080
SUM_FIR_TRIGGER_THRESHOLD = 0x1084
SUM_FIR_HIGH_ENERGY_THRESHOLD = 0x1088
TRIGGER_STATISTIC_COUNTER_MODE = 0x1090
PEAK_CHARGE_CONFIG = 0x1094
EXTENDED_RAW_DATA_BUFFER_CONFIG = 0x1098
EXTENDED_EVENT_CONFIG = 0x109C
ACCUMULATOR_GATE_CONFIG = 0x10A0   # + 4 * gate (0-7)
FIR_ENERGY_SETUP = 0x10C0          # + 4 * channel-in-group
ENERGY_HISTOGRAM_CONFIG = 0x10D0   # + 4 * channel-in-group
MAW_START_INDEX_ENERGY_PICKUP = 0x10E0  # + 4 * channel-in-group
ADC_FPGA_VERSION = 0x1100
ADC_FPGA_STATUS = 0x1104
DAC_OFFSET_READBACK = 0x1108
SPI_READBACK = 0x110C
ACTUAL_SAMPLE_ADDRESS = 0x1110     # + 4 * channel-in-group
PREVIOUS_BANK_SAMPLE_ADDRESS = 0x1120  # + 4 * channel-in-group

# ── Memory ──────────────────────────────────────────────────────────────────
FPGA_MEM_BASE = 0x100000           # group FIFO, + 0x100000 * group
FPGA_MEM_OFFSET = 0x100000
HISTOGRAM_MEMORY_OFFSET = 0x00FF0000   # 64K-bin energy histogram, bank 1
HISTOGRAM_BINS = 65536
STATISTIC_COUNTER_SPACE = 0x30000000   # data transfer space select = 3
STATISTIC_WORDS_PER_GROUP = 24         # 6 counters x 4 channels
STATISTIC_COUNTER_NAMES = ("internal", "hit", "deadtime", "pileup", "veto", "high_energy")

N_CHANNELS = 16
N_GROUPS = 4

# Data transfer control commands
TRANSFER_RESET = 0x00000000
TRANSFER_READ = 0x80000000
TRANSFER_WRITE = 0xC0000000


def grp(addr: int, group: int) -> int:
    """Address of a group register for ADC FPGA group 0-3."""
    return addr + GROUP_OFFSET * group


def chan_reg(addr: int, channel: int, stride: int) -> int:
    """Per-channel register inside its group (channel 0-15)."""
    return addr + GROUP_OFFSET * (channel >> 2) + stride * (channel & 3)


def memory_offset(channel: int, bank2: bool = False) -> int:
    """32-bit word address of a channel's event memory (Data Transfer start address).

    Each ADC FPGA has two memory chips (ch1/2 and ch3/4) selected by the space
    bits [29:28]; inside a chip the second channel sits at 0x02000000 and
    bank 2 at 0x01000000.
    """
    off = 0x01000000 if bank2 else 0
    if channel & 1:
        off += 0x02000000
    if channel & 2:
        off += 0x10000000
    return off
