# Beam current and accumulated charge

WebDAQ reads the beam current from one picoammeter — a **TetrAMM** or an
**RBD 9103** — and integrates it into two separate numbers. Both appear on the
dashboard in the *Beam & Charge* card, and both end up in the run record.

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

## 4. What is recorded

| File | Written when | Contents |
|------|--------------|----------|
| `data/run<N>/current.txt` | during a run with data saving on | Time and current, one row per sample. |
| Run metadata (database) | at run stop | The run's accumulated charge, alongside target, voltages and notes. |
| `data/run<N>/stats.csv` | during a run | The current as a Graphite metric, if you added it on the Stats page. |

The `current.txt` file is written only when data saving is enabled. The charge
integration is not: it follows the run itself, so a no-save run still reports its
charge.

---

## 5. Checks that catch most problems

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
