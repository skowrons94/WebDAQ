# Directory structure

**This chapter is an inventory: what lives where, and which of it is source, runtime data or legacy.** Two of those distinctions matter more than the rest — the repository is not the same thing as a working directory (see [How WebDAQ works](details.md)), and a few paths are still present only so that old links and old setups keep working.

---

## 1. Top level

| Path | What it is |
|---|---|
| `server/` | The DAQ server: a Flask application served by waitress on port 5001. |
| `frontend/` | The web interface: Next.js 14 on port 3000. |
| `scripts/` | What you run from a shell: `lunadaq` (start/stop/status for both processes, freeing stuck ports) and `check_run_integrity.py` (verify a run's files without converting them). |
| `doc/` | The Sphinx/MyST source of this manual. |
| `manual/` | A `Makefile` that builds the same material as a single PDF with pdflatex. |
| `imgs/`, `doc/imgs/` | Screenshots used by the README and the manual. |
| `environment.yml` | The conda environment (`luna`) the server and the tests expect. |
| `install.sh` | Installation helper: CAEN libraries, the environment, the native modules. |
| `.github/workflows/documentation.yml` | Builds the documentation in CI. |
| `README.md`, `LICENSE` | Project readme and licence. |

Two more things may be present without being tracked: `manuals/`, which holds the CAEN register manuals that `app/utils/board_defaults.py` cites and is gitignored because the PDFs are large, and `CLAUDE.md`/`AGENTS.md`, which are notes for coding agents.

**There is no mobile client in this checkout.** The React Native app that [How WebDAQ works](details.md) lists as an interface is a separate repository; nothing here builds, serves or configures it. It is a supported interface because it speaks the same JWT-authenticated REST API as the browser, not because its source is here.

---

## 2. `server/` — the Flask backend

| Path | What it is |
|---|---|
| `main.py` | **The entry point.** Refuses a second instance, brings the database schema up to date, writes a pid file, starts the alert watcher and serves the app. |
| `server.py` | The Flask CLI app object, for management commands such as `flask --app server create-user`. It does not serve. |
| `config.py` | Secret keys, the database URL and the JWT policy. |
| `app/` | The application package — see below. |
| `native/` | Two git submodules: `caendaq/` (the C++/pybind11 acquisition library that reads the boards) and `rureader/` (the `.caendat` → ROOT converter). |
| `migrations/` | Alembic revisions for `app.db`. The directory next to `main.py` is always the one applied, whichever working directory the server runs in. |
| `tests/` | The server test suite — plain `unittest`, no hardware, driven by `tests/run_tests.sh`. |
| `scripts/` | `check_db.sh` (backup, upgrade or stamp `app.db`), `kill-server.sh` (kill a dangling backend), `convert.sh`, `sync.sh`. |
| `jupyter/` | Offline analysis notebooks. Not part of the running DAQ. |
| `conf/`, `calib/`, `data/`, `cache/`, `app.db` | Runtime state of whichever working directory the server was started in — see section 5. |

### `server/app/routes/` — the HTTP surface

| File | Serves |
|---|---|
| `auth.py` | Registration, login, and a token check. |
| `experiment.py` | Run control, run metadata, boards, data-saving settings, diagnostics, auto-restart, and the legacy Telegram settings. |
| `digitizer.py` | Board register reads and writes, the board scan, and online tuning. |
| `histograms.py` | Spectra, PSD maps, waveforms, the dashboard/ROI configuration, batch ROI integrals, and `/spy/status`. |
| `current.py` | The beam-current module: its type, settings, readings, history and accumulated charge. |
| `stats.py` | The Graphite server, the monitored metric list, the per-run `stats.csv`, and board-rate queries. |
| `data.py` | Completed runs: inventory, current log, `stats.csv`, and the RUReader conversion. |
| `elog.py` | PSI ELOG: settings, entries, attributes, attachments and the run draft. |
| `grafana.py` | Grafana settings and alert rules. |
| `notifications.py` | Notification transports, alert rules, the event log, the alert watcher — and the `/recovery/*` actions. |
| `calib.py` | Per-channel energy calibration. |
| `faraday.py` | **Dead code.** A Faraday-cup blueprint that `app/__init__.py` never registers, so `/faraday/*` is unreachable. |

### `server/app/services/` — state and background work

| File | Owns |
|---|---|
| `daq_manager.py` | The DAQ state: run number, saving, boards, run-state listeners, board-failure monitoring, auto-restart. |
| `caen_acquisition.py` | The single in-process `caendaq.DAQ` that reads the boards, writes the files and accumulates the spectra. |
| `digitizer_container.py` | The persistent probe connections to the boards, released to caendaq during a run. |
| `board_scanner.py` | The background sweep of USB, optical and VME links that discovers boards. |
| `sync_chain.py` | What the daisy chain needs per board, read back from the registers. |
| `spy_manager.py` | Online spectra, waveforms and ROI reads, plus the calibration applied to their axes. |
| `histogram_config.py` | The server-owned histogram dashboard in `conf/histograms.json`. |
| `roi_analysis.py` | Every ROI integral in one pass, and the per-run `roi.json`. |
| `stats_manager.py` | The Graphite metric list and the loop that writes a run's `stats.csv`. |
| `graphite_reader.py` | Read-side Graphite access for everything that plots history. |
| `run_data.py` | A finished run directory: its files, its current, its charge, and the ROOT conversion. |
| `run_metadata_snapshot.py` | Keeps each run's `metadata.json` in step with its database row. |
| `run_report.py` | Assembles a finished run into a draft ELOG entry. |
| `alerting.py` | The alert rules, the watcher thread that evaluates them, and the dispatch to transports. |
| `alert_log.py` | The durable record of every alert and recovery, in `conf/alert_log.json`. |
| `recovery.py` | The named recovery actions, whether each is currently needed, and running one on request. |
| `telegram_notifier.py`, `zulip_notifier.py` | The two notification transports. |
| `grafana_client.py` | Grafana's alert-rule API, with the service-account token kept on the server. |
| `elog_client.py` | The PSI ELOG logbook, through py_elog. |

### `server/app/utils/` — hardware and helpers

| File | What it is |
|---|---|
| `dgtz.py` | The ctypes wrapper around CAENDigitizer: open, info, register access, register dumps. |
| `safe_registers.py` | Which registers may be written to a board that is acquiring. |
| `board_defaults.py` | Fabricated register dumps so test mode has something to configure and edit. |
| `spy.py` | Builds a ROOT histogram from a caendaq snapshot, on demand. |
| `tetramm.py`, `rbd9103.py` | The two picoammeter controllers. |
| `graphite_current.py` | A beam-current module whose readings come from a monitored Graphite metric. |
| `mock_current.py` | The simulated picoammeter used when `TEST_FLAG` is set. |
| `graphite.py` | The Graphite render-API client. |
| `carbon.py` | The guarded push to Carbon's plaintext ingest, so a dead collector cannot stall an acquisition loop. |
| `single_instance.py` | The guard that stops a second backend reaching into running hardware. |
| `jwt_utils.py` | Token issue and the `jwt_required_custom` decorator. |

`app/models/` holds the two SQLAlchemy models, `user.py` and `run_metadata.py`.

---

## 3. `frontend/` — the web interface

| Path | What it is |
|---|---|
| `src/app/` | App Router pages: `dashboard/`, `logbook/` (and `logbook/[run_number]/`), `stats/`, `DAQ/` (board configuration, calibration, hardware info), `tuner/`, `troubleshoot/`, `alerts/`, `settings/`, `auth/login/`. |
| `src/app/api/` | Route handlers that run in the Next.js process, not in the browser: `server-control/` launches and stops the backend in a chosen working directory, `cache/` keeps the per-browser UI state. |
| `src/components/` | The React components. Dashboards (`caen-dashboard`, `histo-dashboard`, `wave-dashboard`, `psd-dashboard`, `calib-dashboard`, `data-dashboard`), run control (`run-control`, `run-control-buttons`, `daq-state`, `run-status-indicator`), boards (`board`, `board-scan`, `board-health`, `board-info`, `param-tuner`), current (`current-plot`, `current-graph`, `current-module-settings`, `beam-control-panel`), monitoring (`stats/`, `metrics-settings`, `activity-log`, `notification-settings`, `grafana-settings`, `grafana-alert-manager`), the logbook (`logbook-table/`, `run-notes-editor`, `elog/`), and `ui/` (shadcn/ui primitives). |
| `src/lib/` | `api.ts` (the Axios client with the JWT interceptor), `grafana-api.ts`, `histogram-config.ts`, `caen-registers.ts`, `load-jsroot.ts`, `chart-format.ts`. |
| `src/store/` | Zustand stores: auth, run control, histograms, stats, metrics, Grafana alerts, dashboard tab, visualisation settings. |
| `cache/` | Runtime UI state written by the Next.js process (`visualization-channels.json`, `wave-config.json`, `working-directories.json`, `server-control-state.json`). Not source; safe to delete. |
| `package.json`, `next.config.mjs`, `tailwind.config.ts`, `tsconfig.json`, `components.json` | Build and tooling configuration. |

---

## 4. The repository versus a working directory

**Every relative path the server opens is relative to the directory it was started in, not to `server/`.** `conf/`, `calib/`, `data/`, `cache/` and `app.db` are therefore the state of one experiment, and the copies under `server/` are simply the state of the experiment someone last ran from there.

| Written into the working directory | By |
|---|---|
| `conf/settings.json` | The DAQ state: run number, saving, size limits, boards, auto-restart. |
| `conf/<name>_<id>.json` | One full register dump per board. Copied into each run directory at start. |
| `conf/histograms.json` | The histogram dashboard: histograms, ROIs, zooms, layout. |
| `conf/current.json`, `conf/tetram.json`, `conf/rbd9103.json` | The beam-current module, its per-device settings and the lifetime charge. |
| `conf/stats.json` | The Graphite server, the monitored metrics and the sampling cadence. |
| `conf/alerts.json`, `conf/alert_log.json` | The alert rules, and the record of what they did. |
| `conf/telegram_settings.json`, `conf/zulip_settings.json` | Transport credentials. |
| `conf/grafana_settings.json`, `conf/elog_settings.json` | Grafana and ELOG addresses and service tokens. |
| `calib/<name>_<id>.cal` | Per-channel energy calibration. Not copied into the run directory. |
| `data/run<N>/` | The run: `.caendat` files, the board configurations, `current.txt`, `stats.csv`, `roi.json`, `metadata.json`. |
| `cache/daq-server.pid` | The backend's pid, so `scripts/kill-server.sh` and the single-instance guard can find it. |
| `app.db` | Run metadata and users. |

Nothing in this list needs to be created by hand; the server writes a default on first use and keeps an unreadable `conf/settings.json` aside rather than replacing it.

---

## 5. Legacy and dead paths

Say so out loud, because each of these looks live until you look twice.

| Path | Status |
|---|---|
| `server/app/routes/faraday.py` | Never registered as a blueprint. `/faraday/*` returns 404. |
| `frontend/src/api/cache/route.ts` | Outside the App Router and imported by nothing — superseded by `src/app/api/cache/route.ts`. |
| `frontend/src/app/activity/page.tsx` | A redirect to `/troubleshoot`, kept because the old address is in control-room browser histories. |
| `frontend/src/app/board/page.tsx` | Still works, but no longer in the navigation: the `Board` component is rendered inside Settings. |
| `histogram-configs.json`, `roi-cache-enhanced.json`, `dashboard-settings.json` | The dashboard's old home in `frontend/cache/`. If they are still there, the DAQ server reads them once to seed `conf/histograms.json`, and never writes them again; `WEBDAQ_FRONTEND_CACHE` pointed at an empty directory switches the import off. |
| `server/conf/tuning_backups/` | An empty directory no code refers to. |

Earlier releases also had `server/json/` (per-model register templates) and `conf/topology.xml` (the XDAQ topology). Both are gone: a board's register set is read from the hardware, or fabricated by `app/utils/board_defaults.py` in test mode, and there is no XDAQ to describe.
