# WebDAQ — data acquisition for the LUNA experiment

![GitHub commit activity](https://img.shields.io/github/commit-activity/m/skowrons94/WebDAQ) ![GitHub Release](https://img.shields.io/github/v/release/skowrons94/WebDAQ?include_prereleases) <img alt="Documentation" src="https://img.shields.io/badge/Documentation-up-green?logo=Github&link=https%3A%2F%2Fskowrons94.github.io%2FWebDAQ%2Findex.html">

![Dashboard](imgs/dashboard.png)

Run control for CAEN digitizers, in a browser. Configure the boards, tune the
filters against a live spectrum, take runs, watch the rates and the beam
current, and write the shift entry — from the same interface, on the DAQ machine
or from any PC on the network.

Acquisition runs **in process**: the boards are read, decoded and written by
[CaenDAQ](https://github.com/skowrons94/CaenDAQ), a C++ library bound into the
Python server. There is no XDAQ, no Docker container and no spy socket in the
data path.

---

## What it does

| | |
|---|---|
| **Boards** | Scan the links for connected digitizers (USB, optical/CONET, A4818, VME), add them, and keep their full register configuration in one file per board. |
| **Acquisition** | One unified `.caendat` file per run across all boards, with multi-board synchronisation driven by the boards' own start mode. |
| **Online tuning** | Change thresholds, gates and trapezoid parameters **while the run is going**, and watch the trace and the spectrum react. Only the parameters that are safe to move mid-run are sent to the board. |
| **Monitoring** | Per-channel spectra, waveforms and PSD plots; event, pile-up, lost and saturation rates per channel; beam current and accumulated charge. |
| **Slow control** | Beam current from a TetrAMM or an RBD 9103, plus any metric on the laboratory's Graphite server, recorded into each run's `stats.csv`. |
| **Bookkeeping** | Run metadata for FAIR-compliant conversion, the collaboration's PSI ELOG logbook, Telegram alerts on board failure, and Grafana alert rules tied to the run. |

**Stack** — Flask + SQLAlchemy on the server, React/Next.js in the browser,
CaenDAQ (C++/pybind11) for acquisition, ROOT for histograms, Graphite and
Grafana for monitoring.

---

## Install

Linux for real hardware (the CAEN drivers are Linux-only). macOS works in test
mode, without boards.

```bash
git clone --recurse-submodules https://github.com/skowrons94/WebDAQ.git
cd WebDAQ
./install.sh
```

The script is **idempotent** — re-run it any time and it skips what is already
in place. It asks once for the backend API URL (see
[Reaching it from another PC](#reaching-it-from-another-pc)).

It installs, in order: system build tools → the `CaenDAQ` and `RUReader`
submodules → Miniforge if no `conda` is found → the `luna` environment from
`environment.yml` (Python, ROOT, Node.js, Flask, the ELOG client) → `RUReader`
(offline `.caendat` → ROOT converter) → the `caendaq` Python module → the
frontend build → the `LunaDAQ` shell command.

---

## Run it

```bash
LunaDAQ            # start the web app, then open http://localhost:3000
LunaDAQ stop       # stop the web app (3000) and the DAQ server (5001)
LunaDAQ status     # show what is holding each port
LunaDAQ restart    # stop both, start the web app again
LunaDAQ backend    # start the DAQ server in this terminal, without the UI
```

`stop` asks each process to exit and forces it only if it refuses; a port held
by an unrelated program is reported, never killed. Use it when a start fails
with *address already in use* after a crash. The commands live in
`scripts/lunadaq`, so fixes arrive with a `git pull`.

You do **not** need to create a database or a user by hand. Click **Start an
Experiment**, choose a working directory, and the DAQ server is launched there
with its database, default user and `conf/`, `calib/`, `data/` folders created
for you.

### Without hardware

```bash
cd server && TEST_FLAG=True python main.py
```

Simulated digitizers and a simulated picoammeter: boards can be scanned, added
and tuned, runs produce data files, and the charge integrates. Good for trying a
procedure before touching the real setup.

### Reaching it from another PC

`NEXT_PUBLIC_API_URL` is baked into the frontend at build time and used by your
**browser** to reach the DAQ server. Left at `http://127.0.0.1:5001`, the page
only works on the PC that runs the server — every other machine reads
`127.0.0.1` as *itself*.

```bash
# frontend/.env
NEXT_PUBLIC_API_URL=http://192.168.1.50:5001    # the DAQ machine's address
```

```bash
cd frontend && npm run build                     # required after changing it
```

`install.sh` sets this from its prompt. Other PCs need to reach both `:3000` and
`:5001` on that address; over the internet you additionally need a public
name and the matching firewall rules.

---

## Documentation

Everything is in `doc/`, and builds with Sphinx (`cd doc && make html`).

| Chapter | Read it for |
|---------|-------------|
| **[A complete session](doc/example-session.md)** | One run from a cold machine to a written logbook entry. **Start here.** |
| [CAEN digitizers](doc/caen-settings.md) | Scanning and adding boards, trigger and trapezoid settings, PSD gates, worked examples for HPGe and scintillators, multi-board synchronisation, online tuning. |
| [Beam current and charge](doc/current-and-charge.md) | TetrAMM and RBD 9103 settings, and what the two accumulated charges mean. |
| [Monitoring and alerts](doc/monitoring-and-alerts.md) | What Graphite and Grafana each do, the Stats page, `stats.csv`, run-linked alerts, Telegram. |
| [ELOG](doc/elog.md) | Reading and writing the collaboration logbook from run control. |
| [User guide](doc/usage.md) | Screen-by-screen reference. |
| [Server architecture](doc/server-architecture.md) | How the backend is put together. |
| [Troubleshooting](doc/troubleshooting.md) | When something does not work. |

---

## Development

```bash
cd server && ./tests/run_tests.sh     # server tests — no hardware needed
cd frontend && npx tsc --noEmit       # type check
cd frontend && npm run build          # required before `npm run start` sees changes
```

<details>
<summary>Running the pieces by hand</summary>

Only needed if you are not using `install.sh` or are working on the server.

```bash
conda env create -f environment.yml   # or: conda env update -f environment.yml
conda activate luna

cd server
flask --app server create-user        # the launcher creates a default user anyway
python main.py                        # TEST_FLAG=True for no hardware

cd ../frontend
npm install && npm run build && npm run start
```

The server brings the database schema up to date on every start, against the
database it is actually configured to use — a working directory with its own
`app.db` is upgraded too. Set `WEBDAQ_SKIP_DB_UPGRADE=1` to manage migrations
yourself.

To rebuild the acquisition module after changing the C++ (or after a `git pull`
that moves the submodule):

```bash
pip install server/native/caendaq
```

</details>

---

## License & contact

MIT — see [LICENSE](LICENSE). Contributions welcome: open an issue or a pull
request.

* jakub.skowronski@pd.infn.it
* alessandro.compagnucci@gssi.it
* gesue.riccardo@gssi.it
