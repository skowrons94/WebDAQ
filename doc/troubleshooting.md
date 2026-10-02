# Troubleshooting

Something is wrong and the beam is on. This chapter is ordered by what you can
see, not by which part of the code is at fault.

**Start at the Troubleshoot page.** It lists the state of each part of the system
and offers the action that repairs it, and it keeps the history of what has
already happened — including while you were asleep. Most of what follows is the
longer explanation of what that page is telling you.

```{note}
Versions before 4.0 ran acquisition as XDAQ in a Docker container with a spy
server on port 6060. Any procedure that tells you to restart a container, check
port 6060 or look at a `topology.xml` predates 4.0 and does not apply.
```

---

## 1. The five recovery actions

**Troubleshoot → Recovery.** Each action shows whether that part of the system is
healthy right now, and nothing runs by itself — you press it.

| Action | Use it when | Available during a run |
|---|---|---|
| **Reopen the boards** | A board reads *Disconnected* after a link glitch. | No — stop the run first. |
| **Reset the acquisition** | A run failed or the boards are wedged: closes the boards, reopens them, leaves them idle. | No. |
| **Reconnect the current monitor** | The beam current reads disconnected, or stops updating. | Yes. |
| **Restart the statistics** | `stats.csv` stopped being written mid-run. | Yes. |
| **Re-check Graphite** | After a Graphite outage, to clear the "unavailable" state it leaves behind. | Yes. |

Two of these are refused while a run is in progress, with *"Not while a run is in
progress"* written under the button. That is not a limitation to work around:
reopening the boards mid-run would end the run.

**Restarting the statistics never overwrites measurements.** Starting a
statistics run opens `stats.csv` for writing, so the rows already recorded are
moved to `stats.csv.part1` first and the action tells you where they went. If they
cannot be moved aside — a read-only run directory — the action refuses rather than
truncating the file. The run report reads `stats.csv` and every `part` together,
so the run's record stays whole.

---

## 2. A board

### A board reads *Disconnected*

Either nothing opened it, or something else holds it. In order: *Reopen the
boards* from Troubleshoot (with the run stopped); check that no second WebDAQ
backend is running (`LunaDAQ status`); check the cable and, for optical links,
that the right link number is configured in Settings → Boards.

A board that stayed shut after a run is the expected case for exactly one
situation: CaenDAQ closed it microseconds earlier and the link was not ready. The
server retries by itself, warns in the log which boards stayed shut, and
*Reopen the boards* is what finishes the job.

### A board shows *Board Failure*, or the header says *CAEN Error*

The board set its FAIL flag in a data block: it could not sustain the readout —
typically a full internal buffer or a lost link — and **the data from that point
may be incomplete**. Open **Dashboard → Board Health** and read the three problem
counters for that board:

* **FAIL blocks** not zero confirms it.
* **Dropped** not zero means the write queue refused blocks: that is lost data,
  and it points at the disk or at a rate the machine cannot write.
* **Read errors** not zero points at the link itself.

The run should usually be restarted. If auto-restart is on, that already happened
and the new run continues the old one's target and voltages; the old run is
flagged *bad* with a note saying why. Either way the event is in the Troubleshoot
history even if no alert was configured to deliver it.

### A board stops producing data without failing

**Board Health** shows *No data for n s* and the counters stop moving. This is
what the *Board stopped producing data* alert watches. The FAIL flag was not
raised, so suspect the trigger, the cabling into TRG-IN, or a chain that never
started (below).

### A synchronised run never starts, or one board has no data

Open **DAQ → Configuration → Synchronization**. Every board is checked against
what its position in the chain requires, and anything that would stop the start
pulse reaching the cable is listed with a ⚠ next to that board. The common ones:

| Reported | Meaning |
|---|---|
| *the master is in … mode, so the software trigger that starts the chain will not start this board* | The master must be in **On first trigger**. It is started by its own software trigger, and only that mode treats a trigger as the start of the run. |
| *the software trigger is not routed to TRG-OUT* | The master's start pulse never leaves the board, so nothing downstream starts. |
| *TRG-IN is not routed to TRG-OUT* | A board in the middle of the chain is not passing the pulse on. |
| *TRG-OUT is not set to carry the trigger* | TRG-OUT is carrying a probe signal instead of the trigger. |

The master needs no TRG-IN → TRG-OUT — no trigger arrives on its TRG-IN, it makes
its own — and the last board in the chain needs nothing on its TRG-OUT. The page
marks each switch *needed — on*, *needed — off* or *not needed here* for that
board, so you do not have to work it out from the register.

While the boards are closed the master is **assumed** from the configuration; the
page says so. Start a run and it is checked against the register ids the hardware
reports.

---

## 3. The beam current

### The current reads *Disconnected*, or does not move

*Reconnect the current monitor* from Troubleshoot, which re-opens the device and
reports what happened. If it still does not answer:

* **TetrAMM** — check the address and port in Settings → Current Module, and that
  nothing else holds the socket.
* **RBD 9103** — the serial path. Settings → Current Module lists the ports that
  actually exist and warns when the configured one is gone.
* **Monitored Graphite value** — the metric itself may have stopped arriving.
  Check it on the Stats page; "connected" for this module means the value is
  arriving, not that the server answers.

### The current is read as stale when it is fine

A picoammeter answers in milliseconds, so a reading older than 30 s means it has
stopped. A *monitored* value is different: it is published on its own cadence,
Carbon flushes on its own schedule, and the render API will not serve the bucket
it is still filling, so a value written every 10 s legitimately reads back tens of
seconds old. WebDAQ measures this rather than assuming it — the freshness horizon
for a monitored metric is derived from the observed publication cadence and lag —
so a healthy slow metric is not reported as dead. If you see a monitored current
called stale, check the metric's real cadence on the Stats page first.

### The charge looks wrong

*This run* integrates for exactly the length of the run, and follows the DAQ's own
run state rather than the browser: closing the tab, or an auto-restart, does not
affect it. *Lifetime total* never stops. A figure that does not move between runs
is correct.

A run taken with saving **off** has no metadata row, so its charge is not stored
anywhere — by design.

---

## 4. Spectra and rates

### A spectrum is empty

In order: is a run going? Is that board reading at all (**Board Health**)? Is the
channel enabled (**DAQ → Configuration → Channel Enable**)? Is the threshold
sensible (**Tuner**)?

An empty histogram says why in its own title — *No data yet — start a run*, *This
board is not part of the current run*, *No counts yet on channel n* — so read the
title before anything else.

### Waveforms are empty

Waveforms have to be switched on per board: the switch on the board card on the
Overview, or in the Waveforms tab. A board acquiring without waveforms shows *No
waveform — switch waveforms on for this board* in the plot title. Trace 2 needs
dual trace enabled.

### The rates are not updating

**Data Rates** shows *No answer* when the last request failed — the numbers on
screen are then the last known ones, not current. If it says *Stopped* while a
run is going, the page and the server disagree about the run state; reload.

Remember that the cadence control on that tab sets the averaging window as well
as the refresh rate, so at 60 s the numbers are 60 s averages.

---

## 5. Monitored values and Graphite

### Every metric reads *N/A* and the light is red

Graphite is not answering. The light distinguishes this from "the metric has no
data", which is the distinction that matters: check the host and port on the
Stats page, then *Re-check Graphite* on Troubleshoot, which also clears the
circuit breaker an outage leaves behind.

The breaker exists to protect WebDAQ, not Graphite: with the server unreachable
every request thread would park in `connect()` and the interface would become
unusable. While it is open, queries fail immediately instead of waiting.

### One metric reads *N/A*, the others are fine

Its path. Re-add it with the browser rather than typing it — a renamed metric
keeps the old path in your configuration.

### `stats.csv` has all-zero columns

Those metrics were unreachable *during that run*. The header still records which
they were, and the alias and unit you gave them.

### Grafana plots it but WebDAQ does not

Different ports for different jobs: Graphite's render API (read) is configured on
the Stats page, Carbon's ingest (write, usually 2003) in Settings → Current
Module. Grafana often reads the render API on another port than the one WebDAQ is
configured with.

---

## 6. Alerts that did not arrive

This is the failure mode worth understanding, because its symptom is silence.

| What you see | What it means |
|---|---|
| **Settings → Notifications** says *Not watching* | Nothing is evaluating any rule — the server was started without its watcher. Press **Start watching**. |
| A rule badged **reaches nobody** | The rule is enabled and watching, but all of its destinations are switched off or unconfigured. |
| A rule badged **nothing to measure** | It is watching something it cannot read: Graphite unreachable, the monitor stopped, or a counter this CaenDAQ build does not report. That is not the same as everything being fine. |
| The bell is **amber** | Something was raised that reached nobody. |
| A history row badged **reached nobody** | That specific alert was recorded but not delivered — a wrong token, a network outage, or no destination. |
| *n saved alerts could not be read* | A rule in `conf/alerts.json` is malformed. The others still work; the reason is printed, and the file is kept rather than replaced. |
| **Test message** said *sent* but nothing arrives | Read the whole message: if the transport is switched off it says so, because the test forces one send regardless. |

A board failure is written to the history **even when no rule is configured for
it**, so the morning after is never blank.

Rules also hold back a repeat message for a minute per subject. A value sitting
exactly on its threshold therefore gives one message, not one per tick — if you
expected a stream of alerts and got one, that is why.

---

## 7. The server

### It will not start

| Symptom | What to do |
|---|---|
| *Port 5001 is still held by a previous WebDAQ server* | `LunaDAQ status` names it, `LunaDAQ stop` clears it. The server refuses to start over a backend that is **taking data**, which is the one case it will not resolve by itself. |
| *Port … is in use by another process not managed by WebDAQ* | Stop that program, or point `NEXT_PUBLIC_API_URL` at a free port. WebDAQ never kills a process it does not recognise. |
| `No module named caendaq` | The acquisition module is not in the active environment: `conda activate luna`, then `pip install server/native/caendaq`. |
| The database will not open | Check which working directory the server was started in. The schema is upgraded automatically at every start; there is nothing to migrate by hand. |

### It stops when the interface does

That is deliberate. The backend watches the launcher that started it and exits
when it disappears, so killing the web interface always takes the DAQ server with
it rather than leaving a process holding the digitizers.

### Something looks "missing" — no boards, no histograms

Almost always the **working directory**. Everything the server reads is relative
to the directory it was started in, so a server started somewhere else shows a
different configuration: not a broken one, a different one. The DAQ Server panel
names the directory it is running in.

### The log

`server.log` in the working directory the server was started in. **DAQ Server →
Show logs** shows the last 200 kB of it without leaving the browser. The clean
shutdown path stops the acquisition, stores the charge, closes the current log,
writes `roi.json` and closes the boards — a server stopped properly leaves no run
half-written.

---

## 8. The interface

| Symptom | Usual cause |
|---|---|
| The page loads but every request fails | `NEXT_PUBLIC_API_URL` is wrong, or the frontend was not rebuilt after it changed. It is compiled into the bundle. |
| You are sent back to the login page | The token was cleared. The notice says it plainly: the run is not affected, the DAQ server keeps taking data with nobody logged in. |
| A number is frozen | Look for *No answer* on that panel. WebDAQ shows the last known value and marks it rather than showing a plausible wrong one. |
| The ELOG panel cannot reach the logbook | The URL or the shared account in Settings → ELOG; if the message is about `py_elog`, the server is running in the wrong environment. |

---

## 9. After a crash or a power cut

1. Start the server again. A `running: true` left behind in `conf/settings.json`
   is cleared with a warning — acquisition cannot survive a restart, so a run that
   was in progress ended when the machine did.
2. Check the last run directory. A `.caendat` file has no trailer, which is why a
   run killed mid-write is still readable up to where it stopped:
   ```bash
   cd server
   python scripts/check_run_integrity.py data/run1276
   ```
3. Convert it. If the converter stops on a truncated final aggregate, the option
   that skips it is passed automatically when the installed RUReader supports it.
4. Read the Troubleshoot history for what the DAQ saw before it stopped.

---

## 10. Getting help

Say which working directory, which run number, and what `server.log` shows around
the time. The Troubleshoot history and the run's `metadata.json` together usually
answer the question before anyone has to reproduce it.

- Jakub Skowroński: [jakub.skowronski@pd.infn.it](mailto:jakub.skowronski@pd.infn.it)
- Alessandro Compagnucci: [alessandro.compagnucci@gssi.it](mailto:alessandro.compagnucci@gssi.it)
- Riccardo Gesuè: [gesue.riccardo@gssi.it](mailto:gesue.riccardo@gssi.it)
