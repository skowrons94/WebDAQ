# Directory Structure

This page describes what lives where in the WebDAQ / LunaDAQ repository, so you
can find the right file quickly and know which directories are runtime data,
configuration, or legacy.

## Top level

| Path | What it is |
|------|------------|
| `server/` | Flask backend (the DAQ server, port 5001). |
| `frontend/` | Next.js web interface (port 3000). |
| `doc/` | Sphinx documentation source (this manual). |
| `imgs/` | Images used by the README / docs. |
| `environment.yml` | Conda environment definition (`luna`). |
| `install.sh` | Installation helper script. |
| `README.md`, `CLAUDE.md`, `RELEASE_NOTES_*.md` | Project readme, agent guidance, release notes. |

> **Note on the mobile app:** the React Native / Expo mobile client
> (`WebDAQMobile/`) referenced in `CLAUDE.md` is not part of this checkout. It
> lives in a separate location/repository; ignore those instructions when
> working here.

## `server/` — Flask backend

| Path | What it is |
|------|------------|
| `main.py` | **Production entry point.** Boots the app under the Waitress WSGI server. This is what the launcher (and `python3 main.py`) runs. |
| `server.py` | Flask CLI app object. Hosts management commands such as `flask --app server create-user`. Not the runtime server. |
| `config.py` | App configuration (database URL, JWT secret, etc.). |
| `app/` | The application package (see below). |
| `migrations/` | Alembic/Flask-Migrate database migrations. Seeded into each measurement directory on first init. |
| `scripts/` | Helper shell scripts: `check_db.sh` (safe DB upgrade used at launch), `convert.sh`, `sync.sh`. |
| `conf/` | **Active runtime configuration** (read/written while running). Board configs (`DT5720B_0.json`, …), `settings.json`, `histograms.json` (histogram dashboard and ROIs), `current.json`, `rbd9103.json`, `tetram.json`, `stats.json`, `telegram_settings.json`, `elog_settings.json`. |
| `json/` | **Template/reference register maps** per board model and firmware (`DT5720_PSD.json`, `V1730_PHA.json`, …). Source definitions used to build a board's `conf/` entry; not modified at runtime. |
| `calib/` | Energy-calibration files per board (`*.cal`). |
| `data/` | Acquired run data (runtime output). |
| `jupyter/` | Offline analysis notebooks (`Analysis.ipynb`, …). Not part of the running DAQ. |
| `app.db` | Default SQLite database (when not using a per-measurement directory). |

### `server/app/` — application package

| Path | What it is |
|------|------------|
| `__init__.py` | App factory: creates the Flask app and registers blueprints. |
| `models/` | SQLAlchemy models (`User`, `RunMetadata`). |
| `routes/` | API endpoints grouped by area: `experiment.py` (run control), `digitizer.py` (board config), `histograms.py` (spectra, plus the dashboard/ROI configuration), `current.py` (beam current), `auth.py`, `stats.py`, `calib.py`, `elog.py`, `data.py`, `faraday.py`. |
| `services/` | Long-lived state and background work: `daq_manager.py` (run state), `caen_acquisition.py` (the in-process CaenDAQ acquisition), `spy_manager.py` (online spectra), `histogram_config.py` (the histogram dashboard), `roi_analysis.py` (ROI integrals and the per-run `roi.json`), `stats_manager.py`, `run_data.py`. |
| `utils/` | Hardware/driver interfaces and helpers: `dgtz.py` (CAEN digitizer wrapper), `spy.py` (spectrum snapshots from CaenDAQ), `tetramm.py`, `rbd9103.py`, `graphite_current.py` (beam current from a monitored metric), `graphite.py`, JWT utilities. |

## `frontend/` — Next.js web interface

| Path | What it is |
|------|------------|
| `src/app/` | Next.js App Router pages: `dashboard/`, `board/`, `logbook/`, `settings/`, `stats/`, `tuner/`, `alerts/`, `auth/`, plus `api/` route handlers (server-side, e.g. `server-control/` which launches the backend). |
| `src/components/` | React components, including dashboards (`caen-dashboard.tsx`, `histo-dashboard.tsx`, `wave-dashboard.tsx`) and `ui/` (shadcn/ui primitives). |
| `src/lib/` | Shared helpers, notably `api.ts` (Axios client with JWT). |
| `src/store/` | Zustand state stores (`auth-store.ts`, `run-control-store.ts`, …). |
| `cache/` | **Runtime UI state written by the app** (dashboard settings, visualization channels, working directories, server-control state). Not source; safe to delete to reset UI state. |
| `package.json`, `next.config.mjs`, `tailwind.config.ts`, `tsconfig.json` | Build / tooling configuration. |

## Configuration vs. data vs. templates — quick guide

- **Edit by hand:** `server/config.py`, `frontend/.env`, files under `server/conf/`
  (board/device settings) — although `conf/` is also written by the app.
- **Generated/runtime (don't hand-edit, safe to regenerate):**
  `server/data/`, `frontend/cache/`, `server/app.db`, `__pycache__/`.
- **Reference templates (read-only source of truth):** `server/json/`
  (per-model register maps), `server/conf/topology.xml` (seed copied into each
  measurement directory).
