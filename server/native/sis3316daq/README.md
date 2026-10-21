# sis3316daq

Pure-Python DAQ for the **Struck SIS3316** 16-channel digitizer over
Ethernet/UDP: board initialisation, register configuration from a settings
dict, double-bank readout, online decoding into energy spectra, HDF5 run
files and trigger statistics. It is the SIS3316 counterpart of `caendaq` and
is used by WebDAQ through `server/app/services/sis3316_acquisition.py`.

Only `numpy` is needed; writing run files needs `h5py`.

```bash
pip install -e server/native/sis3316daq        # done by install.sh
python -m unittest discover -s server/native/sis3316daq/tests   # no hardware
```

## Network

The SIS3316 has no ARP of its own: its MAC address is `00:00:56:31:6x:xx`
with `xxx` the serial number in hex, and the PC maps an IP address onto it with
a static ARP entry (SIS3316 Ethernet addendum, sec. 2.1). On the LUNA DAQ PC:

| | |
|---|---|
| PC interface | `eno1`, `192.168.1.1/24` (NetworkManager profile `sis3316`, no gateway) |
| Board | serial 108 → MAC `00:00:56:31:60:6c`, at `192.168.1.100` |
| ARP entry | `/etc/NetworkManager/dispatcher.d/90-sis3316-arp`, re-applied whenever `eno1` comes up |

For another board, add an entry with its serial number in hex:

```bash
sudo ip neigh replace 192.168.1.101 lladdr 00:00:56:31:60:<serial hex> dev eno1 nud permanent
```

## Firmware notes (measured on VME FPGA V3316-2004, ADC FPGA A_0250_0004)

* **Legacy UDP protocol.** Firmware before V3316-2008 has no packet-identifier
  byte and does not answer ping. `UdpLink` detects the protocol generation
  when it opens.
* **Fixed reply port.** The board answers to UDP port `0xE000` whatever the
  source port, so the PC socket binds `0xE000`: one program per PC can talk to
  the board at a time (in WebDAQ, the server process).
* **No multi-register requests on ADC FPGA registers.** A read in a request
  that already read the same ADC FPGA returns that previous value, and writes
  land on the neighbouring register or are dropped. The transport therefore
  sends one request per ADC FPGA register (`0x1000`–`0xFFFFF`) and batches only
  VME FPGA registers. Single-register access is always correct.
* **Timestamp-Clear clears neither the on-board energy histograms nor the
  trigger statistic counters.** Histograms are zeroed by writing their memory
  (`Sis3316.clear_energy_histograms`); counters are reported relative to a
  baseline taken at each run start.
* **Raw window.** With all 16 channels recording, windows near 64K samples
  corrupt the end of some events; validation caps `raw_samples` at 32000.

## Use

```python
from sis3316daq import DAQ, default_settings

s = default_settings()
s["board"]["raw_samples"] = 1000
s["channels"]["14"] = {"enabled": True, "trigger_threshold": 100, "tau_factor": 17}

daq = DAQ(out_dir="data/run7", run=7)              # write=False: spectra only
daq.add_board("SIS3316", board_id=3, host="192.168.1.100", settings=s)  # mock=True without hardware
daq.start()
...
daq.stats()                 # per-channel rates, the shape caendaq.DAQ.stats() has
daq.energy(0, 14)           # online spectrum (bin = max energy / divider)
daq.onboard_histogram(0, 14)  # the board's own 64K-bin energy histogram
daq.stop()
```

`Sis3316` (board.py) is the low-level driver: `open()`, `initialize(settings)`,
`arm()`/`swap()`, `read_bank()`, `energy_histogram()`, `statistic_counters()`.

## Settings

`settings.py` defines the model stored in WebDAQ's `conf/SIS3316_<id>.json`:
`board` (board-wide acquisition: clock, readout interval, event window,
waveform and trapezoid lengths, NIM inputs), `channel_defaults` and sparse
per-channel overrides in `channels`. Thresholds are in ADC counts of pulse
height (the driver multiplies by the trigger peaking time); times are in
samples. `validate()` clamps everything to what the hardware accepts.

## Run files

`run_<N>_<cycle:04d>.h5`, rotated by size. Per board, `/board_<id>/events` is a
table with one row per hit (`channel`, `timestamp` in samples, `energy_max`,
`energy_start`, `pileup`, `peak_high`, `peak_index`, `maw_max`), with
row-aligned `/board_<id>/waveforms` and `/board_<id>/maw` when those are
recorded. The board info and full settings are attributes of `/board_<id>`.
See `writer.py`.
