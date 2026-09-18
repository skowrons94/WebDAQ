# CAEN digitizers: settings, filters and synchronisation

This chapter covers what the digitizer does with a detector pulse, which
register controls which part of that, how to set them from WebDAQ, and how to
make several boards share one time origin.

Everything here is per board. A board is identified by the **board ID** you gave
it when adding it; that ID names its configuration file (`conf/<model>_<id>.json`),
labels its data inside the run file, and decides which board is the master of a
synchronised chain.

---

## 1. Adding a board

Settings → Boards.

**Scan first.** Press *Scan for boards*. The server probes the links the way
CoMPASS does — it opens each candidate, asks the board what it is, and closes it
again — then lists what answered: model, serial number, channel count, ADC bits
and firmware. Press *Use these settings* on a result and the add form is filled
in for you. Check the ID and the DPP firmware, then press *Add Board*.

What the scan covers, from *Options*:

| Link | What is probed |
|------|----------------|
| USB | Link 0…N, node 0. Desktop boards (DT5720, DT5724, DT5781). |
| Optical (CONET) | Link 0…3 × node 0…7. Follows a daisy chain of boards on one A2818/A3818. |
| A4818 | The adapter's PID, taken from the USB bus; type it in if it is not detected. |
| VME | A range of base addresses through a V1718/V2718 bridge. Off by default. |

The VME range is limited to 1024 addresses. A board's base address comes from
two rotary switches that set bits 31…16, so only multiples of `0x10000` can hold
a board — scanning `0x32000000`–`0x32FF0000` in steps of `0x10000` is 256 probes
and takes seconds. Keep the range near the addresses you actually use: a probe
reads the configuration ROM at every address it tries.

Two things the scan will not do: it refuses to run while a run is in progress
(during a run the boards belong to the acquisition), and it reports a board that
is already added rather than probing it again.

**Adding by hand** works too — fill in ID, VME address (`0` for USB/desktop),
link type, link number and DPP firmware. Get one field wrong and the board will
not open; the scan exists so you do not have to guess.

When a board is added, WebDAQ reads every acquisition register out of it and
writes them to `conf/<model>_<id>.json`. That file is the source of truth from
then on: the dashboard displays it, the tuner edits it, and the acquisition
replays it into the board at the start of every run.

---

## 2. The signal chain

A pulse from your preamplifier goes through these stages inside the board:

```
detector → preamp → [ analogue input: DC offset, dynamic range, polarity ]
                  → ADC
                  → [ trigger filter: RC-CR2 (PHA) or CFD/leading edge (PSD) ]
                  → [ energy filter: trapezoid (PHA) or gated charge integration (PSD) ]
                  → histogram + optional waveform
```

You set up the stages in that order. Getting the analogue input wrong makes
every later stage impossible to tune.

### 2.1 Analogue input

| Setting | Register | What it does |
|---------|----------|--------------|
| Input polarity | `0x1n80` bit 16 ("Invert Input") | Set it when the preamp delivers **negative** pulses. Get this wrong and nothing triggers. |
| DC offset | `0x1n98` | Moves the baseline inside the ADC range. The tuner shows it in %. |
| Input dynamic range | `0x1n28` | `0` = 2 Vpp, `1` = 0.5 Vpp on x725/x730. The smaller range gives finer ADC steps for small pulses. |

Set the DC offset from the *direction* of the pulses: positive pulses need the
baseline near the bottom of the range (10–20 %), negative pulses near the top
(80–90 %). Watch the waveform in the Tuner while you change it — the trace must
sit inside the window with the full pulse amplitude visible and no clipping at
either rail.

### 2.2 Trigger

The trigger decides *when* an event exists. It runs on a filtered copy of the
input, not the raw samples, so its threshold is in counts of the filtered
signal, not millivolts.

**DPP-PHA** uses an RC-CR² filter:

| Setting | Register | What it does |
|---------|----------|--------------|
| Trigger Threshold | `0x1n6C` | Level the filtered signal must cross. |
| Input Rise Time | `0x1n58` | Rise time of your preamp signal; the trigger filter is matched to it. |
| RC-CR2 Smoothing Factor | `0x1n54` | Number of samples averaged in the trigger filter. More smoothing = less noise, slower response. |
| Trigger Hold-Off Width | `0x1n74` | Dead time after a trigger before the next one is accepted. Use it to stop one pulse triggering several times. |
| Rise Time Validation Window | `0x1n70` | Rejects triggers whose rise time does not match a real pulse. |

**DPP-PSD** triggers on a leading edge or a CFD:

| Setting | Register | What it does |
|---------|----------|--------------|
| Trigger Threshold | `0x1n60` | Level above baseline that starts an event. |
| CFD Settings | `0x1n3C` | Delay and fraction of the constant-fraction discriminator, when CFD timing is enabled in `0x1n80`. |
| Trigger Hold-Off Width | `0x1n74` | Same meaning as for PHA. |

**How to set a threshold.** Put the board in a quiet state (beam off, source
off if you can), open the Tuner on the channel, and lower the threshold until
the trigger rate climbs steeply — that is the noise floor. Then set the
threshold roughly 20–30 % above it. Check the rate again with the source on: it
should follow the source, not the noise.

### 2.3 Energy: the trapezoidal filter (DPP-PHA)

A preamplifier pulse is a fast step followed by a slow exponential decay. The
trapezoidal filter turns that step into a trapezoid whose height is proportional
to the deposited energy, and averages away noise while doing it.

```
preamp     ___/‾‾‾‾‾-.__          trapezoid      ___/‾‾‾‾‾\___
signal    /            ‾‾‾--.__                 /  k   m   \
                                               rise  flat  fall
```

| Setting | Register | What it does | How to choose it |
|---------|----------|--------------|------------------|
| Trapezoid Rise Time | `0x1n5C` | Length of the rising edge — this is the noise-averaging time. | Longer = better resolution, worse pile-up at high rate. HPGe: 3–6 µs. Silicon/scintillator at rate: 0.5–2 µs. |
| Trapezoid Flat Top | `0x1n60` | Length of the flat part. | Must be longer than the spread in charge collection time, otherwise large events lose amplitude (ballistic deficit). HPGe: ~1 µs. Fast detectors: 100–300 ns. |
| Peaking Time | `0x1n64` | Where inside the flat top the height is sampled. | ~80 % of the flat top. It must be shorter than the flat top. |
| Decay Time | `0x1n68` | Compensates the preamp decay (pole-zero cancellation). | **Set it to your preamplifier's decay constant.** Too short and the flat top droops downwards; too long and it slopes up. Tune it by watching the trapezoid trace until the top is flat. |
| Peak Hold-Off | `0x1n78` | Pile-up rejection window around the peak. | Roughly rise + flat top. |
| Fine Gain | `0x1nC4` | Digital gain on the trapezoid height. | Use it to move the spectrum into the histogram range without touching the analogue chain. |

The order that works: polarity and DC offset → decay time (flat top actually
flat) → rise time and flat top (resolution) → peaking time → fine gain (spectrum
in range) → threshold and hold-off (rate right).

**Resolution against rate.** The rise time is the trade. Doubling it improves
the signal-to-noise of the energy measurement but doubles the time the filter is
busy, so pile-up starts at half the rate. Set it as long as your rate allows,
not as long as possible.

### 2.4 Energy: charge integration (DPP-PSD)

DPP-PSD integrates the pulse over two windows and reports both charges. The
ratio separates particle types in a scintillator, since a slow component that
differs between particles shows up in the long gate but not the short one.

| Setting | Register | What it does |
|---------|----------|--------------|
| Short Gate | `0x1n54` | Integration window over the fast part of the pulse. |
| Long Gate | `0x1n58` | Integration window over the whole pulse. |
| Gate Offset | `0x1n5C` | How far **before** the trigger the gates open — enough to include the leading edge and a bit of baseline. |
| Threshold for the PSD | `0x1n78` | Minimum charge for a PSD value to be computed. |
| Fixed Baseline | `0x1n64` | Used when the automatic baseline is disabled in `0x1n80`. |
| Charge Zero Suppression | `0x1n44` | Drops events below a charge threshold. |
| PUR-GAP Threshold | `0x1n7C` | Pile-up rejection sensitivity. |

`PSD = (Q_long − Q_short) / Q_long`. Set the short gate to cover the fast
component only, and the long gate to cover the full tail. Check on the waveform
that the gates sit where you think they do — the gate offset is the setting that
is most often wrong.

### 2.5 Time units

The DPP time registers count in the board's DPP clock, not in samples:

| Model | ADC | One register step |
|-------|-----|-------------------|
| x730 (V1730, DT5730) | 500 MS/s | 8 ns |
| x725 (V1725, DT5725) | 250 MS/s | 16 ns |
| x724 (V1724, DT5724) | 100 MS/s | 10 ns |

The Tuner converts for you: it shows time settings in ns and writes back the
register value. Trapezoid Rise Time = 3 µs on a V1730 means 375 in the register.

### 2.6 Waveforms

Waveforms are for tuning, not for physics data — they multiply the data volume.
Enable them per board on the dashboard card, use them to check polarity, offset,
gates and the trapezoid shape, then switch them off before a production run.

| Setting | Register | What it does |
|---------|----------|--------------|
| Record Length | `0x1n20` | Number of samples in the saved trace. |
| Pre Trigger | `0x1n38` | How much of the trace is *before* the trigger. Leave enough to see the baseline. |
| Dual trace, trace 1/2, digital probe | `0x8000` | Which internal signals the trace shows — input, RC-CR², trapezoid, baseline, threshold, peaking, pile-up, trigger hold-off. |

The Tuner's trace selectors are the fastest way to see what a filter is doing:
draw the trapezoid over the input and the shape of the decay-time error is
obvious.

---

## 3. Two worked examples

### HPGe detector, DPP-PHA, low rate, best resolution

| Setting | Value | Why |
|---------|-------|-----|
| Input polarity | as the preamp | Ge preamps are usually positive; check the trace. |
| DC offset | 15 % | Positive pulses, baseline near the bottom. |
| Input dynamic range | 2 Vpp | Full range for the whole energy span. |
| Decay Time | preamp τ, typically 45–50 µs | Flat top actually flat. |
| Trapezoid Rise Time | 6 µs | Rate is low; take the resolution. |
| Trapezoid Flat Top | 1 µs | Covers the charge collection spread in a large crystal. |
| Peaking Time | 800 ns | 80 % of the flat top. |
| Trigger Threshold | just above noise | Set it as described above. |
| Trigger Hold-Off | ~10 µs | Longer than rise + flat top, so one pulse triggers once. |
| Record Length / Pre Trigger | 1 µs of trace, 30 % before the trigger, while tuning | Then switch waveforms off. |

### Plastic or liquid scintillator, DPP-PSD, high rate

| Setting | Value | Why |
|---------|-------|-----|
| Input polarity | inverted | PMT pulses are negative. |
| DC offset | 85 % | Negative pulses, baseline near the top. |
| Input dynamic range | 0.5 Vpp | Small pulses, finer steps. |
| Gate Offset | 30–50 ns before the trigger | Include the leading edge and some baseline. |
| Short Gate | 30–60 ns | Fast component only. |
| Long Gate | 300–500 ns | Full tail. |
| Trigger Hold-Off | 200–500 ns | Short, to keep the rate capability. |
| Threshold for the PSD | above the noise charge | Keeps the PSD plot clean. |

Both tables are starting points. Take a spectrum, look at it, change one setting
at a time.

---

## 4. Synchronising several boards

There is no "sync" switch in WebDAQ. Whether a board joins the chain is decided
by that board's own **Acquisition Control** register (`0x8100`), bits [1:0],
which you edit in the CAEN dashboard:

| Value | Start mode | Meaning |
|-------|------------|---------|
| 0 | SW controlled | The board starts on the software command. It is **not** in the chain. |
| 1 | S-IN / GPI | Armed; runs while the S-IN (VME) or GPI (desktop) input is asserted. |
| 2 | First trigger | Armed; starts on the first rising edge on TRG-IN. |
| 3 | LVDS | Armed; driven by the LVDS RUN signal (VME only). |

A board in any mode other than 0 is **armed** instead of started, and then waits.

### How a run starts a chain

1. Every board is opened and configured from its JSON file.
2. Boards with start mode ≠ 0 are armed. Their readout threads are already
   running, so nothing is missed when the start arrives.
3. The **master** — the board whose register ID is 0, otherwise the first
   synchronised board — fires a software trigger.
4. That pulse leaves the master on TRG-OUT, enters the next board's TRG-IN,
   which starts it and passes the pulse on, and so on down the chain.

All boards therefore share one time origin, and timestamps can be compared
across boards.

### Cabling

```
   board 0 (master)        board 1              board 2
   start mode = 2          start mode = 2       start mode = 2
   TRG-OUT ───────────────> TRG-IN
                           TRG-OUT ───────────> TRG-IN
```

Use equal-length cables where the propagation delay matters, and remember the
chain adds a small fixed delay per hop. `Run/Start/Stop Delay` (`0x8170`) exists
to compensate it: give the earlier boards a delay so every board starts at the
same instant.

Leave a board in SW controlled mode to keep it out of the chain. It will start
on its own and its timestamps will not be comparable with the rest — which is
fine for a monitor detector, and wrong for coincidences.

The dashboard reads `0x8100` back from each board and shows the resulting roles,
so check there after changing the mode: exactly one master, everyone else
synchronised.

---

## 5. Tuning while the beam is on

Settings changed in the Tuner normally go into the JSON file and reach the board
at the next run start. That is safe, and slow: to see the effect of a threshold
you would stop, edit, start.

Switch **Online** on in the Tuner and each change is *also* written straight to
the board. With a run in progress, the spectrum and the trace react immediately.

Not every register may be changed on a live board. WebDAQ keeps a list of the
ones that may:

* **Written live** — thresholds, gates, shaping and trapezoid times, decay time,
  DC offset, fine gain, hold-offs, veto width, and the trace/probe selection.
  Anything that changes how a channel processes a pulse.
* **Saved for the next run** — record length, pre-trigger, the aggregate
  organisation, the channel enable mask, acquisition control, board
  configuration, board ID. These describe the *shape* of the readout: changing
  one underneath a running acquisition produces buffers the decoder cannot read.

Each field in the Tuner is marked **live** or **next run** while Online is on, so
you know before you type. Everything is saved to the JSON either way — the
configuration and the board never drift apart.

A register that is not on the list is refused by default. That is deliberate: a
new register added to the dump later cannot silently become live-writable.

**Requirements.** Online writes during a run go through `caendaq`, which needs
the register API — rebuild it (`pip install server/native/caendaq`) if the tuner
reports that the installed module has none.

---

## 6. Where the settings live

| File | Contains |
|------|----------|
| `conf/settings.json` | The board list: ID, model, link, VME address, DPP firmware, channel count. |
| `conf/<model>_<id>.json` | Every acquisition register of that board, with address, channel and value. |
| `calib/<model>_<id>.cal` | Two calibration coefficients per channel (offset, gain) for the energy axis. |

If a board is listed in `settings.json` but its register file is missing, the
server rebuilds it at startup — reading the registers back from the board, or
generating defaults in test mode. A board that cannot be reached is reported in
the log; the Tuner and the CAEN dashboard will have nothing to show until it is.

To start from scratch on one board: remove it in Settings → Boards, then add it
again. Its register file is rewritten from what the hardware reports.
