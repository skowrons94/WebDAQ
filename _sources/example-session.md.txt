# A complete session, start to finish

One run from a cold machine to a written logbook entry. Follow it once and the
rest of the documentation is reference material.

---

## 1. Start the application

Two processes: the **web app** (port 3000) and the **DAQ server** (port 5001).
The web app runs all the time; the DAQ server is started for a working directory
from the interface.

```bash
LunaDAQ                 # start the web app
LunaDAQ status          # what is running on which port
LunaDAQ stop            # stop both, including after a crash
LunaDAQ restart         # stop both, start the web app again
LunaDAQ backend         # start the DAQ server in this terminal, without the UI
```

`stop` asks each process to exit and forces it only if it refuses; a port held by
an unrelated program is reported and left alone. Use it when a start fails with
*address already in use*.

Open `http://localhost:3000` (or the DAQ machine's address from another PC) and
log in. Then press **Start an Experiment**, choose the working directory for this
campaign, and the DAQ server is launched there. That directory is where `conf/`,
`calib/` and `data/` are created — everything below is relative to it.

---

## 2. Check the hardware

**Boards.** Settings → Boards. Every configured board has a card showing its
model, DPP firmware, link and live connection state. Green means the server has
the board open and ready.

If a board is missing, press **Scan for boards**, let it probe the links, and add
what it finds. See [CAEN digitizers](caen-settings.md) for the scan options and
for the VME range.

**Picoammeter.** Settings → Current Module. Pick TetrAMM or RBD 9103 and check it
connects. With the beam off the reading should be near zero; if it is not, fix
that before anything else ([Beam current and charge](current-and-charge.md)).

**Metrics.** Settings, or the Stats page. The light next to the title must be
green — that is the Graphite server answering. Add the metrics this campaign
needs (terminal voltage, beam current, board rates) with a name and a unit each;
they become the columns of every run's `stats.csv`.

---

## 3. Tune a channel

Tuner page. Pick the board and the channel.

1. Press **Start** — the tuner starts an acquisition with data saving switched
   off, so nothing you do here lands in the data.
2. Turn **Online** on. Changes now go to the board immediately as well as to the
   configuration.
3. Look at the waveform. Set the input polarity and the DC offset until the pulse
   sits inside the window with the baseline visible and no clipping.
4. Set the trigger threshold: lower it until the rate runs away on noise, then
   put it 20–30 % above that point.
5. For DPP-PHA, set the decay time until the trapezoid's flat top is flat, then
   the rise time and flat top for the resolution you need at your rate. For
   DPP-PSD, set the gate offset and the two gates over the pulse.
6. Watch the spectrum on the right while you do it. Fine gain moves the peaks
   into the histogram range.
7. Press **Stop**.

Fields marked *next run* are saved to the configuration but not written to a live
board — record length and anything else that changes the shape of the readout.
They take effect the next time a run starts.

The details of every filter are in [CAEN digitizers](caen-settings.md).

---

## 4. Take a run

Dashboard.

1. Fill in the run metadata: target, terminal voltage, probe voltage, run type.
   It is stored with the run and is what makes the data findable later.
2. Check **Save data** is on (the tuner leaves it off).
3. Press **Start**. In order, WebDAQ then: applies the save settings, starts the
   current acquisition and the stats collection, configures every board from its
   JSON file, arms the synchronised boards, fires the chain from the master, and
   starts the readout.
4. Watch:
   * **Run control** — run number, elapsed time, state.
   * **Board cards** — connection, waveform switch, failure flags.
   * **Beam & Charge** — live current, the charge for this run (integrating,
     green dot) and the lifetime total.
   * **Histograms / waveforms** — per board and channel.
   * **Stats** — the metrics you selected.
5. Press **Stop** when done. The run's charge is written into its record, the
   stats file is closed, and auto-managed Grafana alerts are silenced again.

If a board fails mid-run, a Telegram message goes out (once per run) and, if
auto-restart is enabled, the run is restarted after the configured delay.

---

## 5. What the run leaves behind

```
data/run1276/
├── run1276_0.caendat      raw data, one file per board set, rotated by size
├── current.txt            beam current samples
├── stats.csv              the Graphite metrics, one row per second
└── metadata.json          run number, times, boards, firmware, file list
```

plus a row in the run database — target, voltages, notes, accumulated charge —
which is what Logbook → Runs shows.

`stats.csv` is plain CSV with a commented header:

```python
import pandas as pd
stats = pd.read_csv('data/run1276/stats.csv', comment='#')
stats.columns          # ['Time [s]', 'Terminal Voltage [kV]', 'Board 0 rate [counts/s]']
```

---

## 6. Write it down

Logbook → ELOG → **New entry**. What happened, what you changed, what the
spectrum looked like, which run numbers. Attach a screenshot if it makes the
point faster than a paragraph. Reply to the shift's first entry to keep a thread
together.

The run record already holds the numbers. The logbook is for the reasons.

---

## 7. Without hardware

Everything above works on a laptop with no CAEN boards and no picoammeter:

```bash
cd server
TEST_FLAG=True python main.py
```

Test mode substitutes a simulated digitizer and a simulated picoammeter: boards
can be scanned, added and tuned, runs produce data files, and the charge
integrates. Use it to try a procedure or to reproduce a problem before touching
the real setup.

---

## 8. After changing the code

```bash
cd server
./tests/run_tests.sh            # the server test suite, no hardware needed
cd ../frontend
npx tsc --noEmit                # type check
npm run build                   # required before npm run start picks up changes
```

The test suite runs in its own scratch directory and never touches a real
`conf/` or `data/`. `server/tests/README.md` says what each file covers.
