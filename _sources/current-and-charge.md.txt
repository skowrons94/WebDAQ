# Beam current and accumulated charge

WebDAQ reads the beam current from one of three sources — a **TetrAMM**, an
**RBD 9103**, or a **monitored value** already published to Graphite — and
integrates it into two separate numbers. Both appear on the dashboard in the
*Beam & Charge* card, and both end up in the run record.

Whichever source you pick behaves identically everywhere else: the same plot, the
same `current.txt`, the same accumulated charge. Choose it in
Settings → Current Measurement Module.

---

## 1. The two charges, and why they differ

| Figure | Integrates | Reset | Use |
|--------|-----------|-------|-----|
| **This run** | only while a run is in progress | at every run start | Normalisation for the online analysis: counts per unit charge for *this* measurement. |
| **Total** | always, run or no run | only when you press reset | How much beam this target has seen, so you know how old it is. |

That is the whole design. The run figure must cover the run and nothing else,
or a cross section comes out wrong; the total must not skip the beam delivered
while you were setting up, or it stops being a target history.

The run figure follows the DAQ's own run state, not the browser. If you close
the tab, if the run is stopped by the auto-restart, or if the run saves no data,
the charge is still integrated for exactly the length of the run. It is written
into the run's metadata when the run ends.

A small dot next to *This run* on the dashboard card shows whether it is
integrating: green during a run, grey between runs. A number that is not moving
between runs is correct behaviour, not a stalled readout.

---

## 2. TetrAMM

Four-channel picoammeter on Ethernet. Settings → Current Module.

| Setting | Where | Meaning |
|---------|-------|---------|
| IP address | Settings → Current Module | Factory default is `169.254.145.10`. |
| Port | same | `10001`. |
| Charge channel | same | Which of the four inputs is integrated into the charge. The others are still recorded. |

Device parameters live in `conf/tetram.json` and are pushed to the instrument at
initialisation:

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `CHN` | `4` | Number of channels read out (1–4). Reading fewer channels is faster. |
| `RNG` | `AUTO` | Measurement range. `AUTO` follows the current; fix it if you want a constant noise floor. |
| `NRSAMP` | `1000` | Samples averaged per reported value. Higher = quieter and slower. |
| `ASCII` | `ON` | Output format. |
| `TRG` | `OFF` | External trigger mode. |
| `NAQ` | `1` | Acquisitions per trigger. |

**Wiring.** The TetrAMM is a current *sink*: connect the Faraday cup (or the
target insulated from ground) to a channel input, and keep the cable short and
screened. A floating or noisy input shows as a current that follows nothing —
check with the beam off first; a well-connected channel reads a few pA.

**If it does not connect.** The TetrAMM answers on its own subnet. From the DAQ
machine, `ping 169.254.145.10` must work before WebDAQ can. A link-local address
means the PC needs an interface on `169.254.x.x`.

---

## 3. RBD 9103

Single-channel picoammeter on USB (a serial port). Settings → Current Module.

| Setting | Where | Meaning |
|---------|-------|---------|
| Serial port | Settings → Current Module | `/dev/ttyUSB0` on Linux. The page lists the ports it can see. |
| Baud rate | same | `57600`. |
| High-speed mode | same | Faster sampling, more noise per sample. |

Device parameters live in `conf/rbd9103.json` and are sent as the instrument's
own command codes:

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `range` | `R0` | `R0` is autorange; `R1`…`R7` fix a range (20 nA, 200 nA, …). Fix the range when the current is stable and you want a constant response time. |
| `filter` | `F032` | Rolling average over 32 samples. `F000` disables it. More averaging = quieter reading, slower response to a beam trip. |
| `input_mode` | `G0` | Normal input. |
| `bias` | `B0` | Internal bias off. |
| `sample_rate` | `I1000` | Sampling interval in ms. |

**Choosing the filter.** The filter is the trade between seeing a beam trip
quickly and having a stable number. `F032` at 1000 ms sampling means the reading
follows the beam over ~30 s. For tuning the accelerator, drop it; for a long
run, keep it.

---

## 4. Monitored value (a Graphite metric)

Not every setup has a picoammeter on the target. If the accelerator already
publishes its own beam current to the laboratory's Graphite server, WebDAQ can
use that number directly. Settings → Current Measurement Module → **Monitored
value**.

| Setting | Meaning |
|---------|---------|
| Metric path | The Graphite path, e.g. `accelerator.beam_current`. Use **Search** to pick it from the tree rather than typing it. |
| Metric unit | The unit the metric is published in — nA, µA, mA or A. Everything downstream works in µA; **getting this wrong scales the accumulated charge by the same factor.** |
| Poll interval | How often Graphite is asked. Polling faster than the value is published adds load without adding samples. |

The module is read-only: it does not configure the accelerator, it just follows
the number. The charge is integrated by the trapezoid rule using the metric's own
timestamps, not wall-clock, so a poll that returns three archived points
contributes the charge of those three points.

**What it refuses to integrate.** A monitored value is not a dedicated
instrument, and it fails in ways a picoammeter does not:

- **Gaps.** If Graphite is unreachable for ten minutes, those ten minutes count
  as unmeasured and contribute nothing. The alternative — assuming the current
  held — would invent charge that was never delivered.
- **NaN and negative readings** are dropped. A NaN would poison the running total
  irrecoverably; a negative reading, which is what an unplugged or
  wrongly-wired readout produces, would silently subtract charge that really was
  delivered. Zero is kept, because beam off is a real measurement.

**Connected** on this module means *the metric is arriving*, not that the
Graphite server answers. A reachable server publishing nothing for this path
reads as disconnected, which is the honest answer — otherwise a run could start
against a dead number.

```{note}
Two different Graphite endpoints are involved and they are easy to confuse. The
**Carbon** ingest (port 2003, Settings → Current Module) is where WebDAQ *sends*
measured current. The **render API** (Settings → Stats page) is where it *reads*
values back — including this module and the long-run history behind the current
plot. A monitored value that never arrives is usually the render API pointing at
port 2003.
```

---

## 5. The current plot

The dashboard plots the beam current from the start of the run. Two behaviours
are worth understanding:

- **The plot is binned, not thinned.** However long the run, the server reduces
  the window to a fixed number of points before sending it, so a three-day run
  costs the browser the same as a three-minute one. Each point carries the mean
  *and* the extremes of its time bin, drawn as a shaded band — so a two-second
  beam trip that a plain average would smooth away stays visible even when one
  bin spans seven minutes. The averaging window is shown next to the plot
  whenever it exceeds a couple of seconds.
- **It refreshes at the rate it can meaningfully change.** A short window updates
  every second; a multi-day run updates every fifteen. A long run therefore makes
  the dashboard lighter, not heavier.

When the run is stopped the plot shows a rolling window instead — 30 s to 5 min,
selectable above the plot.

For a run longer than the in-memory buffer (roughly fourteen hours), the history
is fetched from Graphite, which is why the plot is complete even if you open the
dashboard on the third day of a run.

---

## 6. What is recorded

| File | Written when | Contents |
|------|--------------|----------|
| `data/run<N>/current.txt` | during a run with data saving on | Time and current, one row per sample. |
| Run metadata (database) | at run stop | The run's accumulated charge, alongside target, voltages and notes. |
| `data/run<N>/stats.csv` | during a run | The current as a Graphite metric, if you added it on the Stats page. |

The `current.txt` file is written only when data saving is enabled. The charge
integration is not: it follows the run itself, so a no-save run still reports its
charge.

---

## 7. Checks that catch most problems

1. **Beam off, current near zero?** If not, the input is floating or picking up
   noise. Nothing downstream will be right until this is.
2. **Beam on, current follows the accelerator?** Compare against the accelerator's
   own reading in Grafana. A constant factor means a wrong range or a split
   current path; a lag means too much filtering.
3. **Between runs, does *This run* stay still while *Total* climbs?** That is the
   expected behaviour. If *This run* moves between runs, the DAQ still thinks a
   run is in progress — check the run state on the dashboard.
4. **After a run, does the logbook entry show a charge?** It is written at run
   stop. Zero means the picoammeter was disconnected or the current was zero for
   the whole run.

When you change the target, clear the lifetime figure with **Reset Total Charge**
in the run control bar on the dashboard. Nothing else clears it — not a restart,
not a new run — and the new value is written to `conf/current.json` straight
away, so the old total does not come back.
