# How WebDAQ works

This chapter explains what the system does when you use it — where the data
goes, what a run consists of, what is stored and what survives a restart. It is
about behaviour, not code; for the code, see the
[Server Architecture Guide](server-architecture.md).

---

## 1. The data path

```
CAEN digitizers  ──►  CaenDAQ (in process)  ──►  data/run<N>/*.caendat
                             │
                             ├──►  live spectra and waveforms  ──►  browser
                             └──►  rates  ──►  Graphite  ──►  Grafana
```

Acquisition runs **inside the DAQ server process**. The boards are opened, read,
decoded and written to disk by [CaenDAQ](https://github.com/skowrons94/CaenDAQ),
a C++ library bound into Python. There is no separate acquisition process, no
container to start, and no network hop between the boards and the file.

This matters in practice:

- **Nothing to start or restart separately.** Pressing *Start* is the whole
  operation.
- **Online monitoring costs nothing extra.** The spectra you see are the ones
  CaenDAQ is already accumulating in C++ as it decodes; the server takes a
  snapshot on demand. No second copy of the data stream, and no monitoring
  process to fall behind.
- **If the web interface dies, the run does not.** The frontend is a separate
  process that only talks to the server over HTTP. Closing the browser, reloading
  the page, or restarting the frontend has no effect on a run in progress.

```{note}
Earlier versions ran acquisition as XDAQ inside a Docker container, with a TCP
"spy" socket for monitoring. That is gone. The **file format** is unchanged —
`.caendat` files keep the exact XDAQ header layout on purpose, so runs from any
version of WebDAQ convert with the same [RUReader](https://github.com/skowrons94/RUReader).
```

---

## 2. Starting from nothing

You do not create a database, a user, or a directory layout by hand.

1. Run `LunaDAQ` and open `http://localhost:3000`.
2. Click **Start an Experiment** and choose a working directory.
3. The DAQ server is launched *in that directory* and creates what it needs:
   `conf/`, `calib/`, `data/`, an `app.db` database and a default user.

**The working directory is the experiment.** Everything the server reads and
writes is relative to it — board configurations, calibrations, run data, the
histogram dashboard, the accumulated charge. Two working directories are two
independent experiments that happen to share an installation. Starting the
server from a different directory gives you a different setup, not a broken one.

This is worth knowing when something looks "missing": a dashboard with no
histograms, or a board list that is empty, usually means the server was started
somewhere other than where you configured it.

---

## 3. Adding the boards

Boards are discovered, not typed in. **Board** page → **Scan**.

The scan walks the connection types the CAEN drivers support — USB, optical
(CONET/A4818) and VME — and reports what answers. Add a board and WebDAQ reads
its full register set from the hardware and stores it as one JSON file per board
in `conf/`, named after the model and link (`V1730_0.json`).

From then on that file *is* the board's configuration. It is written when you
change a setting in the UI, read when the server starts, and copied into the run
directory when a run begins, so every run carries the settings it was taken with.

Board settings — thresholds, trapezoid parameters, PSD gates, coincidence
windows — are covered in [CAEN digitizers](caen-settings.md).

---

## 4. What a run is

Pressing **Start** does this, in order:

1. Freezes the current board configurations and copies them into `data/run<N>/`.
2. Hands the open digitizers to CaenDAQ, which arms them and starts them
   together using the boards' own synchronised start.
3. Opens `data/run<N>/` and begins writing `.caendat` files.
4. Switches on everything that follows the run: charge integration, the rate
   collector that publishes to Graphite, the stats recorder, and any run-linked
   Grafana alerts.

Pressing **Stop** unwinds it, and additionally writes the things that describe
the run: its accumulated charge, its ROI counts, its metadata row, and the
logbook entry if you asked for one.

**Run numbering** increments automatically when data saving is on. You can set
the number by hand from the status card — click it — which is what you want
after a spoiled series.

**Data saving off** is a real mode, not a mistake: the run proceeds, spectra and
rates update, charge integrates, and nothing is written to disk. Use it for
tuning.

### If a board fails mid-run

With **auto-restart** enabled, a board that stops responding causes the run to be
stopped, flagged `bad` in the logbook with an explanatory note, and a new run
started automatically. A Telegram message is sent if notifications are
configured. The intent is that a night shift loses one run rather than the rest
of the night.

---

## 5. Changing settings while running

Some settings can move during a run and some cannot, and WebDAQ enforces the
difference rather than letting you find out the hard way.

| Setting | During a run |
|---|---|
| Thresholds, trapezoid parameters, PSD gates | **Yes** — see [online tuning](caen-settings.md) |
| Rebinning, log scale, ROIs, dashboard layout | **Yes** — display only |
| Rate sampling cadence | Yes, applied from the next run |
| Beam current module and its settings | Yes |
| Adding or removing a board, sync mode | No — stop the run first |
| Run number, data saving | No |

**Online tuning** is the useful one: open the tuner, change a threshold, and
watch the trace and the spectrum react. Only the registers that are safe to write
while the board is armed are sent; the rest are stored and applied at the next
run. This turns filter tuning from a stop-change-start loop into something you
do while watching the peak.

---

## 6. What is stored, and where

Everything is under the working directory.

| Path | What | Survives restart |
|---|---|---|
| `conf/<board>.json` | One file per board: its full register configuration | Yes |
| `conf/settings.json` | Run number, data saving, size limits, sync mode | Yes |
| `conf/histograms.json` | The histogram dashboard: which spectra, their ROIs, zooms, layout | Yes |
| `conf/current.json` | Beam current module, its settings, lifetime accumulated charge | Yes |
| `conf/stats.json` | Graphite server, metric subtree, monitored metrics, sampling cadence | Yes |
| `conf/telegram_settings.json`, `conf/elog_settings.json` | Notification and logbook credentials | Yes |
| `calib/<board>.cal` | Per-channel energy calibration | Yes |
| `app.db` | Run metadata, users | Yes |
| `data/run<N>/` | The run itself — see below | Yes |

A run directory contains:

| File | Written | Contents |
|---|---|---|
| `*.caendat` | during | The data. Split across files when the size limit is reached. |
| `<board>.json` | at start | The board configurations this run was taken with. |
| `current.txt` | during | Beam current, one row per sample. |
| `stats.csv` | during | The monitored Graphite metrics, sampled on the rate cadence. |
| `roi.json` | at stop | Every defined ROI, its bounds, and its final counts. |
| `metadata.json` | at stop | The run's FAIR metadata record. |

The point of the per-run copies is that a run is **self-describing**: months
later, the ROOT file, the settings it was taken with, the charge it collected and
the regions it was analysed with are all in one folder.

---

## 7. Monitoring

Three different things, often confused:

| | Answers | Lives |
|---|---|---|
| **Spectra and waveforms** | "What is this detector doing right now?" | In memory, from CaenDAQ. Not stored. |
| **Rates** (event, pile-up, lost, saturation) | "Is the DAQ keeping up?" | Published to Graphite every cadence tick; also `stats.csv`. |
| **Slow control** (beam current, accelerator values) | "What are the beam conditions?" | Graphite, plus `current.txt` and `stats.csv`. |

Spectra are live and disposable — they reset when a run starts. Rates and slow
control are archived in Graphite, which is what makes it possible to ask what the
beam was doing three days ago. See
[Monitoring and alerts](monitoring-and-alerts.md).

---

## 8. After the run

`.caendat` is a raw format. To analyse a run, convert it to ROOT with
[RUReader](https://github.com/skowrons94/RUReader), which WebDAQ installs and
drives from the conversion tab: pick a run, pick the options, convert. Point it
at the run *directory* and a run split across several files converts into one
ROOT file.

`scripts/check_run_integrity.py` verifies a run's files without converting them —
useful when a run was interrupted and you want to know how much of it is good.

---

## 9. Interfaces

| | |
|---|---|
| **Web** | The main interface. Any browser on the network; see the README for reaching it from another PC. |
| **Mobile** | A React Native app for run status, spectra and logbook entries from a phone. |
| **REST API** | Everything the browser does is an HTTP call the server serves, so scripting a run is a matter of calling the same endpoints. JWT-authenticated. See the [Server Architecture Guide](server-architecture.md). |

The frontend has no privileged path into the DAQ — it is one API client among
several, which is why a browser crash cannot take a run with it.
