# User guide

Every page, what it shows and what you can change from it. For the workflow of a
single run from start to logbook entry, read [A complete
session](example-session.md) first; this chapter is the reference you come back
to.

The navigation is the same on every page: **Dashboard, Logbook, Stats, DAQ,
Tuner, Troubleshoot, Alerts, Settings**. The header carries four things worth
knowing about:

* the **run status** — *Running* with an elapsed clock, *Stopped*, or *CAEN
  Error* when a board raised its FAIL flag during this run;
* the **DAQ Server** badge, which starts and stops the server itself and shows
  its log;
* the **bell**, which counts alerts nobody has looked at yet and turns amber when
  something was raised that reached nobody;
* **Search**, a command palette that jumps to any page, any dashboard tab or any
  settings section.

Logging in is per browser, and the session does not expire on its own. If it is
cleared you are told plainly that the run is unaffected: the DAQ server keeps
taking data with nobody logged in.

---

## 1. Dashboard

Six tabs: **Overview**, **Board Health**, **Data Rates**, **Histograms**,
**Waveforms** and **PSD**. The last three can be switched off in Settings →
Appearance, and the tab strip follows.

### 1.1 Overview — taking the run

**System status** is the band of cards at the top. Drag the handle beneath it to
show one row more or less; the height is remembered per browser.

| Card | What it tells you |
|---|---|
| **Run Status** | The run number, *Running* or *Stopped*, how long ago it started (or how long the last one lasted), the file write rate, and a **Save** switch. While the DAQ is stopped the run number is a button that opens *Next run*, where you set the number the next run will take. |
| **DAQ Status** | Four lines — data saving, waveforms, current, stats — each with a tick or a cross, so you can see at a glance what this run will actually record. |
| **Picoammeter** | Only for a real device: connected or not, whether it is sampling, its address and range. A monitored Graphite value has no device card, because it has no device. |
| **Board *n*** | One per board: *Ready*, *Running*, *Board Failure* or *Disconnected*, the firmware and channel count, and a waveform switch (locked while a run is going). |
| **ROIs** and **Metrics** | The regions of interest you defined, with live integrals, and the Graphite values you selected on the Stats page. |

**Run Setup & Control** is where a run begins. Fill in **Run Name**, **Run Type**
(long run, scan, background, calibration), **TV (kV)** and **PV (kV)** — all four
are pre-filled from the last run, and all four are locked while a run is in
progress. Then **Start Run**.

If the directory for that run number already exists, WebDAQ asks before using it
again rather than quietly overwriting. If the run number is not set at all, it
refuses and says so.

A run starts even when something next to it fails: if the current module or the
statistics cannot be started, the run still starts and the toast names what is
missing — *"Run 1276 is acquiring, but beam current is not being recorded"*. A
run without its current log is worth more than no run.

The **Maintenance** section underneath holds the things you need rarely: connect
the current module, refresh the board connections (not while running), and reset
the acquisition. **Reset total charge** clears the lifetime charge counter and is
deliberately outside that section, because it is a bookkeeping action rather than
a repair.

**Acquisition setup** shows what this run will do — saving on or off, the file
size limit, the auto-restart delay — and **Adjust** opens the dialog where those
are set, including **Auto-Restart on Board Failure** and its delay.

**Beam Control** plots the current on target with the charge beside it: *This run*
(with a dot that says whether it is integrating) and *Lifetime total*. While a
run is going the plot covers the run from its start; while stopped you can pick a
30 s to 5 min window. The **Position** button moves the panel to one of four
places on the Overview.

### 1.2 Board Health — what the boards are actually doing

One card per board with the readout counters CaenDAQ keeps for the run: **data
blocks** read, **events decoded**, **bytes read** and **bytes sent to file**, each
with its rate, and then the three numbers that matter when something is wrong:

| Counter | Read it as |
|---|---|
| **FAIL blocks** | The board could not sustain the readout for that block — a full buffer or a lost link. Data from that point may be incomplete. |
| **Dropped** | Blocks the write queue refused because it was full. **This is lost data** and should always be zero. |
| **Read errors** | CAEN read errors on the link. |

The badge on each card is the quick answer: *Reading*, *No data for n s*, *FAIL
flag*, *No answer* (the last request to the server failed, so the numbers are the
last known ones) or *Not reported* (this CaenDAQ build does not publish that
counter). A dash in a counter means the same thing.

Every counter belongs to the run. They start at zero when a run starts and are
gone when it ends, which is why the tab says so plainly between runs instead of
showing zeros.

### 1.3 Data Rates — counts per second, per channel

A tile per board with its total event rate, then four tiles for the selected
board — **Events**, **Pile-ups**, **Lost events**, **Saturations** — and the
write rate for the board and for all boards together. Pile-up, lost and
saturation turn amber when they are not zero.

The plot shows one metric for up to six channels of one board. Two controls sit
above it:

* **Plot** — the sampling cadence, from 0.5 s to 60 s. This is not a display
  setting: one CaenDAQ tick samples the counters, differences them and publishes
  them, so the same number sets the refresh rate, the averaging window and the
  resolution of what reaches Graphite. Changing it starts the trace over.
* **Rate shown** — which of the four rates is drawn. All four are recorded, so
  switching keeps the history you already have.

A badge reads *Running*, *Stopped* or *No answer*. A run that stops leaves its
trace on screen; a run that starts clears it.

### 1.4 Histograms, Waveforms and PSD

The histogram dashboard is covered in [Spectra and
ROIs](histograms-and-rois.md): which spectra are shown, their ROIs, zoom,
rebinning and the per-run `roi.json`. It belongs to the experiment rather than to
your browser — the layout lives on the DAQ server, so every screen in the control
room shows the same thing.

**Waveforms** and **PSD** are tabs on the same dashboard. Waveforms also carries
the board-configuration controls that decide what the board digitises into a
trace — dual trace, what trace 1 and trace 2 carry, and the digital probe. Those
go to the board immediately, so treat them as a setup activity rather than
something to touch mid-measurement.

---

## 2. Logbook

Two logbooks live here: the run metadata WebDAQ records itself (**Runs**) and the
collaboration's ELOG (**ELOG**).

### 2.1 Runs

A table of every run, newest first. Search covers run numbers, targets, notes and
voltages; the type and flag filters narrow it; **Columns** chooses what is shown
and **Export CSV** writes out exactly the rows you have filtered to.

Two columns are editable in place: the **Flag** (good, unknown, bad) and the
**Notes**. **Actions → Edit entry…** corrects the run name, voltages and type of
a run already taken — useful when a shift realises the target was mistyped.

The run number is a link to the run's own page.

### 2.2 One run

Six tabs, reading the database and the run directory together:

* **Overview** — the notes, the timeline, the run conditions, the data products
  with their sizes, and the acquisition provenance (which WebDAQ, which CaenDAQ,
  which platform, and whether the data came from real boards or from the mock).
* **Notes** — a Markdown editor with a preview. It warns you before leaving with
  an unsaved draft.
* **Beam Current** — `current.txt` plotted, with the charge integrated over every
  sample rather than over the drawn points.
* **Stats** — one plot per monitored metric from `stats.csv`, each labelled with
  the name and unit you gave it on the Stats page.
* **Boards** — the register dump each board ran with, copied into the run
  directory at start. This is what makes the run reproducible.
* **Convert** — RUReader, offering only the options the installed converter
  advertises. See [Run data and conversion](run-data.md).

A run still in progress is marked *in progress* and its duration reads *still in
progress*; nothing on the page pretends the run is finished.

### 2.3 ELOG

Read and write the collaboration logbook without leaving run control: the entry
list with search, the reading pane with attachments, and a composer whose fields
come from the logbook's own form definition, so required attributes are required
here too.

**Write up a run** fills a new entry from the run's own record — timing, beam
current, ROIs, board configuration — and tells you if some of that was missing.
Everything stays editable before you post. See [ELOG](elog.md).

---

## 3. Stats

The Graphite values this experiment watches. Each card is one metric, with its
latest value, a sparkline, and buttons to rename it, stop reading it or remove it.
*N/A* means no reading came back; the light at the top says whether Graphite is
answering at all, so "server down" never looks like "metric with no data".

**Add metric** browses the metric tree or searches it by name, which beats typing
a path from memory. The **name and unit** you give a metric are not cosmetic:
they become the column heading in every run's `stats.csv`.

The **Graphite server** card holds the host, the port and the **metric prefix**
for this experiment. Give each campaign its own subtree — `ancillary.rates.12c12c`
— and no campaign ever shares a series with another. A live run picks up a change
at its next stats interval.

---

## 4. DAQ

Three tabs: **Configuration**, **Calibration** and **Hardware Info**.

### 4.1 Configuration

**Board Settings** is the whole register set of one board, grouped by function and
in the order the signal is processed. **Advanced** shows every register rather
than the tuned ones; **Binary** shows bit fields. Registers carry their CAEN
manual description, and values are shown in the units you think in — per cent for
the DC offset, nanoseconds for the time registers.

Writes on this tab go to the board immediately and are not blocked while a run is
in progress. That is deliberate — it is the same dashboard used to set a board up
— but it means this is not the place to experiment during a measurement. Use the
[Tuner](#5-tuner), which knows which registers are safe to move while the boards
are acquiring.

**Synchronization** is the daisy chain: which board is master, which are slaves,
what each board's TRG-OUT carries, and whether the start pulse can actually walk
the cable. Each switch is annotated *needed — on*, *needed — off* or *not needed
here* for that board's position in the chain, and anything that would stop the
chain starting is listed with a ⚠ next to the board that causes it. The page also
draws the cable order and the start sequence. [CAEN
digitizers](caen-settings.md#4-synchronising-several-boards) explains the
mechanism.

### 4.2 Calibration

Two numbers per channel, `A` and `B`, applied to the energy axis of the spectra.
They are stored per board and channel in `calib/` and are read again whenever the
file changes.

### 4.3 Hardware Info

What the boards report about themselves — model, serial number, firmware, DPP
licence, connection, and the acquisition registers as actually programmed — plus
the software versions recorded with every run. The CAEN API only answers while
the digitizers are open, so this page is populated during a run and says so when
there is none.

---

## 5. Tuner

The place to change thresholds and shaping with beam on target. The page starts
acquisition with **data saving switched off**, so nothing you do here lands in a
run directory; a yellow badge reminds you that the Tuner is holding the run.

The **Online** switch decides where a change goes:

| Online | While a run is going | Effect |
|---|---|---|
| on | yes | Registers that are safe to move are written to the board as you save them. Each field is marked *live* or *next run*, so you know before you touch it. |
| on | no | Written to the board anyway — the next run applies the whole configuration regardless. |
| off | either | Saved to the board's configuration only, and applied at the next run. |

The allowlist of live-writable registers comes from the server per firmware and
channel, and a write the board refuses is reported as *saved, not sent to the
board* with the reason. The configuration and the hardware therefore cannot drift
apart: the save always happens, and you are told whether the board took it.

Beneath the controls are a waveform panel (with the trace and digital-probe
selectors) and the energy spectrum of the channel you are tuning.

---

## 6. Troubleshoot

The page to open when something looks wrong, and the one to read the morning
after. It has two halves: **Recovery** at the top and **History** below.
[Troubleshooting](troubleshooting.md) is the chapter that goes with it.

**Recovery** lists five actions, each with its current state — whether that part
of the system answers right now — and a **Run** button. Nothing here runs by
itself. An action that would cost data while a run is in progress is refused
before you press it, with the reason on the page.

**History** is every alert and recovery, newest first, kept on the server across
restarts. Filter it by *Everything*, *Problems*, *Recoveries* or *Actions*. Each
row carries the board or value it was about, the run it belonged to, and which
destinations received it — including the badge **reached nobody**, which is the
one you want to notice. *Mark all read* clears the bell.

---

## 7. Alerts

The Grafana alert rules, managed from here so you do not have to open Grafana
during a shift: pause or activate a rule, edit its threshold, and mark rules as
**auto-managed** with the ⚡ button.

An auto-managed rule is activated when a run starts and silenced when it stops,
which is the answer to a "beam current too low" rule that is right during a run
and pure noise while you are setting up. The marks are stored per browser, so set
them on the control-room screen.

This page talks to Grafana through the DAQ server; the address and token are in
Settings → Grafana.

---

## 8. Settings

Six sections. Everything except **Appearance** is stored on the DAQ server and is
therefore the same for everyone.

| Section | What it holds |
|---|---|
| **Boards** | The configured digitizers with their live status, a **Scan** that probes the links and lists what answers, and the form to add a board. Scan fills the form rather than adding the board — the ID and the firmware choice stay yours. |
| **Current Module** | Which source the beam current comes from — TetrAMM, RBD 9103 or a monitored Graphite value — and its settings. Also the Carbon address the measured current is *pushed* to, which is not the same as the Graphite server the Stats page *reads*. |
| **Notifications** | Telegram and Zulip credentials, and the alert rules. See [Monitoring and alerts](monitoring-and-alerts.md). |
| **ELOG** | The logbook URL, the shared account, default attributes, and whether WebDAQ may post at all. |
| **Grafana** | The Grafana address and a service-account token. The DAQ server makes those requests, so the address has to be reachable from the server machine. |
| **Appearance** | Theme, which dashboard tabs and cards are shown, and whether current acquisition is enabled at all. Browser-local. |

```{note}
`conf/telegram_settings.json`, `conf/zulip_settings.json`,
`conf/elog_settings.json` and `conf/grafana_settings.json` hold credentials in
plain text on the DAQ machine. The interface never shows them again once saved —
it masks them — but the files themselves are readable by anyone with an account
on that machine, so do not copy a working directory between sites without
emptying them.
```

---

## 9. What is refused, and when

A short list of the places WebDAQ says no, so the refusal is not a surprise:

| Action | Refused when |
|---|---|
| Start a run | No run number set; a run is already going; no boards configured. |
| Overwrite a run directory | Always asked first. |
| Change the run number, saving, the size limit, the run name, type or voltages | While a run is in progress. |
| Refresh the board connections | While a run is in progress. |
| Reopen the boards, reset the acquisition | While a run is in progress (from Troubleshoot). |
| Scan for boards | While a run is in progress. |
| Switch the current module | While the current module is acquiring. |
| Restart the statistics | With no run active, or when the run saves no data, or when the existing `stats.csv` cannot be moved aside. |
| Write a register to a live board | When it is not on the firmware's safe list — it is saved to the configuration and applied at the next run instead. |
