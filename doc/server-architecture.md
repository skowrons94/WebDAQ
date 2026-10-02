# Server architecture

**This chapter is for whoever has to change the server.** It describes what the backend is made of, which module owns which piece of state, and why the awkward parts are the way they are. [How WebDAQ works](details.md) covers the same system from the outside; read that first if you want the behaviour rather than the structure, and [Directory structure](directory-structure.md) for the file-by-file inventory.

---

## 1. The shape of the server

One process holds everything: the Flask application, the open digitizers, the acquisition, the spectra, the picoammeter, the background threads.

```
          HTTP (JWT)                in process
browser ─────────────► Flask routes ──────────► services ──────────► caendaq ──► boards
mobile                 (11 blueprints)          (state, threads)      (C++)      .caendat
script                                              │
                                                    ├──► picoammeter / Graphite metric
                                                    ├──► Carbon (rates, current)
                                                    └──► SQLite (run metadata)
```

The layering is conventional — routes validate and translate, services hold state and run threads, `app/utils/` talks to hardware and to other servers — with one consequence worth stating: **a service is a process-wide singleton reached through a `get_*()` function**, because there is exactly one set of boards and one run. `get_daq_manager()`, `get_caen_acquisition()`, `get_spy_manager()`, `get_alert_manager()`, `get_alert_log()`, `get_histogram_config()`, `get_grafana_client()`, `get_elog_client()`, `get_zulip_notifier()`, `get_board_scanner()`, `get_conversion_manager()` all behave this way. Constructing a second one is a bug, not an option.

**There is no acquisition process, no container and no socket between the boards and the file.** `caendaq` is a C++/pybind11 library (`server/native/caendaq`) imported into this process; it opens the boards, reads them, writes `.caendat` and accumulates the online spectra in C++. Earlier releases ran XDAQ in Docker with a TCP "spy" socket; the vocabulary survives in module names (`spy.py`, `spy_manager.py`, `/spy/status`) and nowhere else.

**Every relative path is relative to the process's working directory.** `conf/`, `calib/`, `data/`, `cache/` and `app.db` belong to the experiment the server was started in, not to `server/`. This is the single most common source of "my configuration disappeared".

---

## 2. Starting up: what `main.py` guarantees

`main.py` is short but almost none of it is optional, because each piece prevents a specific failure that was seen in a control room.

| Step | Why it is there |
|---|---|
| `ensure_sole_instance()` **above the imports** | Creating the app opens the CAEN boards over USB and the picoammeter socket. If the guard ran in `__main__`, a second launch would already have reached into a running acquisition before waitress discovered the port was taken — and its error path calls `cleanup_on_shutdown()`, which would stop the *first* server's acquisition and close its handles. A leftover backend from a crash is killed and the launch proceeds; a run in progress, or a port held by something that is not ours, stops it. |
| `ensure_schema_current(app)` | Runs the Alembic migrations from the directory next to `main.py` against whichever `app.db` the working directory holds. If the upgrade fails but the tables already match the models, it stamps the revision and carries on; if columns are genuinely missing it logs a loud block and **still serves**, because refusing to start mid-shift is worse than losing metadata. `WEBDAQ_SKIP_DB_UPGRADE=1` opts out. |
| Signal handlers | SIGINT and SIGTERM run `cleanup_on_shutdown()`: stop the acquisition, drop the run state, close the digitizers, stop the alert watcher, disconnect the picoammeter, remove the pid file, `os._exit(0)`. |
| `_write_pid_file()` | `cache/daq-server.pid`, so `scripts/kill-server.sh` and the single-instance guard can find a dangling backend. Removal is ownership-checked. |
| `_launcher_watchdog()` thread | Polls `LUNA_LAUNCHER_PID` (the npm/Next.js process that spawned the backend) every two seconds, with reparenting to init as a fallback, and shuts down when the launcher is gone. Killing npm therefore always takes the backend with it, even on SIGKILL. |
| `get_alert_manager().start()` | Starts the alert watcher here rather than in `create_app()`, so importing the app — for a test or a `flask` command — measures nothing and notifies nobody. |
| `serve(app, host='0.0.0.0', port=5001, threads=10)` | Waitress. Ten threads, every interface. |

`ensure_schema_current` is deliberately *not* called at import time: `flask --app main.py db ...` imports this module, and upgrading there would fire in the middle of the very commands meant to manage the database.

`server.py` is a separate Flask CLI app object for management commands such as `flask --app server create-user`. It does not serve anything.

---

## 3. The application factory

`app/__init__.py` is `create_app()`: config, SQLAlchemy, Flask-Migrate, JWT, CORS, eleven blueprints, one `after_request` hook, and `experiment.set_flask_app(app)`.

That last line matters. Background threads — the auto-restart, the run-state listeners, the charge persistence — touch the database from outside a request, so they need an app to open a context against. The reference is handed to `app/routes/experiment.py`, and `main.py` sets it again for the case where the app is created there.

**The `after_request` hook gzips large JSON and text responses.** One energy spectrum is 32768 bins of JSON, a PSD map is the same again, and the dashboard fetches that for every channel on display every couple of seconds. The payload is mostly zeros and short repeated numbers, so it compresses by one to two orders of magnitude — the difference between a usable and an unusable connection over the VPN. Responses under 4 kB are left alone, compression level is 5 rather than 9 because this runs on the machine that is also taking the data, and `Vary: Accept-Encoding` is added so caches behave.

Sessions do not expire (`JWT_ACCESS_TOKEN_EXPIRES = False`). A control-room browser is logged in once and left open for a campaign, and an expiry mid-run logged the operator out with no warning. The trade-off is explicit: there is no token blocklist, so rotating `JWT_SECRET_KEY` is the only revocation there is. Acceptable for an instrument on a controlled network.

---

## 4. The HTTP surface

Blueprints carry no URL prefix; each route spells its own path. There are 187 reachable endpoints.

| Blueprint | Paths | What it serves |
|---|---|---|
| `auth` | `/register`, `/login`, `/protected` | Issues and checks the JWT. |
| `experiment` | `/experiment/*` | Run start and stop, run metadata, notes and flags, adding and removing boards, data-saving settings, board status and diagnostics, auto-restart, and the superseded Telegram settings routes. |
| `digitizer` | `/digitizer/*` | Register reads and writes, polarity and channel enables, the board scan, online tuning, board info. |
| `histograms` | `/histograms/*`, `/roi/*`, `/waveforms/*`, `/psd/*`, `/spy/status` | Spectra and PSD maps, waveform traces and their per-board switch, the dashboard and ROI configuration, batch ROI integrals. |
| `current` | `/current/*` | The beam-current module: type, settings, connection, readings, history, accumulated and lifetime charge. |
| `stats` | `/stats/*` | The Graphite server and metric tree, the monitored metric list, the per-run `stats.csv`, and board-rate queries. |
| `data` | `/data/runs/*` | Completed runs: summary list, detail, current log, `stats.csv`, and the ROOT conversion. |
| `elog` | `/elog/*` | ELOG settings, entries, attributes and fields, attachments, and the run draft. |
| `grafana` | `/grafana/*` | Grafana settings and alert rules. |
| `notifications` | `/notifications/*`, `/recovery/*` | Transports and their tests, alert rules, the event log, the watcher, and the recovery actions. |
| `calib` | `/calib/get/...`, `/calib/set/...` | Per-channel energy calibration. |

**`app/routes/faraday.py` is dead code.** It defines a blueprint with `/faraday/open` and `/faraday/close`, and `create_app()` does not register it, so both return 404. Nothing calls them.

Older paths are kept working on purpose where the frontend has moved on — the Telegram settings under `/experiment/` are the clearest case. A bookmark or a shift script pointing at them does not have to be rewritten.

Conventions across the surface: everything but `/register` and `/login` carries `@jwt_required_custom` (just `flask_jwt_extended`'s `jwt_required()`, re-exported from `app/utils/jwt_utils.py` so the identity casting lives in one place), bodies and replies are JSON, and the identity in the token is the user id as a string, cast back by `get_current_user()`.

The status codes and the message strings are part of the contract, not incidental: the frontend decides what to show from them, and `tests/test_routes.py` exists to pin exactly that. A route that changes a 404 into a 400, or rewords a message the UI matches on, will break a page without breaking anything that looks like an API. Several routes also return *why* something did not happen rather than a bare failure — online tuning's `{saved, written, via, reason}` is the pattern to copy, because the browser has to tell the operator whether the change reached the board or only the configuration file.

---

## 5. The database

Two models, in `app/models/`.

`User` is id, username, email and password hash. `RunMetadata` is the run record: run number, start and end time, notes, accumulated charge, target name, terminal and probe voltage, run type, a `flag` of `good`/`unknown`/`bad`, the owning user, and three provenance columns — `board_info` (the per-board snapshot from `CaenAcquisition.board_info_all`), `software_versions` (WebDAQ, caendaq, Python, platform) and `sync_mode` (`daisy-chain` or `independent`).

SQLite is the live source of truth. `app/services/run_metadata_snapshot.py` mirrors each row into `data/run<N>/metadata.json` after every commit, which is what makes a copied or archived run directory self-describing — the database stays behind on the acquisition machine, the run directory travels. Anything that mutates run metadata calls `sync_run_metadata_file()` after its commit, and there are several such places (run start and stop, notes, flags, the charge, the auto-restart), so adding another one means remembering this.

The snapshot is versioned (`METADATA_SCHEMA_VERSION`) and carries more than the row. It walks the run directory and records every file with its size and a **role** — `raw-data`, `root`, `beam-current`, `statistics`, `board-configuration` — grouped by role as well as listed, so a reader a year later does not have to infer what `run_7_0000.caendat` is from its extension. It is written to a temporary file in the same directory and moved into place, so a half-written `metadata.json` is never observable.

Schema changes go through Flask-Migrate (`server/migrations/`), and `ensure_schema_current` applies them at every start.

---

## 6. Acquisition: who owns the boards

Three modules, and the hand-off between them is the part to understand.

| Module | Owns |
|---|---|
| `services/daq_manager.py` | The DAQ state — run number, saving, size limits, the board list, the run-state listeners, board-failure monitoring and auto-restart. Persists to `conf/settings.json`. |
| `services/digitizer_container.py` | The persistent *probe* connections, through the ctypes wrapper in `utils/dgtz.py`, so the UI can read board info and registers between runs without opening and closing a board per request. |
| `services/caen_acquisition.py` | The single in-process `caendaq.DAQ`: configure, start, stop, register access, rates, board diagnostics and the histogram arrays. |

**A board can only be open once, so starting a run moves it.** `start_run` calls `daq_mgr.release_digitizers()` to close the probe connections, then `caen_acq.configure(...)` and `.start()`. Stopping does the reverse with `reacquire_digitizers()`, which retries three times a second apart — a CAEN link that was closed a moment ago is not always ready to reopen — and logs exactly which boards stayed shut, because those are the ones that will read "Disconnected" on the dashboard until *Reset acquisition* is used.

`write_board_register()` hides the hand-off from its callers: during a run the write goes through caendaq, between runs through the probe connection, and the caller never asks which.

`conf/settings.json` is written to a temporary file and moved into place under a lock. It is written from request threads and from background threads, and two interleaved writes once left invalid JSON — which the next start read as "no boards configured" and replaced with an empty board list.

Two more services sit beside these. `services/board_scanner.py` probes USB, optical and VME links in a background thread (a full optical sweep is 32 probes and a VME range can be hundreds, far too long for one request) and deliberately bypasses the container's retry-three-times open, which is right for a board you know is there and ruinous for a sweep where most probes are expected to miss. `services/sync_chain.py` reads back what each board in a daisy chain actually needs — the master's software trigger on TRG-OUT, the followers' TRG-IN to TRG-OUT propagation, the start mode — and reports the differences rather than assuming them.

---

## 7. Board failures, auto-restart and diagnostics

**No board is polled while a run is in progress.** caendaq owns the digitizers then, so asking a board a question directly would conflict with the readout. What the monitoring thread in `daq_manager.py` watches instead is caendaq's own board-FAIL signal: bit 26 of the aggregate header, counted per board as the data is decoded. The thread wakes once a second and acts only on a board's *first* transition to failed, once per board per run.

The count of failing aggregates is all there is to report, and the code says so. There is no failure register behind the flag — typically it means a full internal buffer or a lost link — so the message reads "Board FAIL flag (37 data blocks)". It used to be decoded as if it were register bits, producing labels like "Board Error (0x2)" that meant nothing to anyone.

A first failure sends the board-failure notification and, when auto-restart is enabled, schedules the restart after the configured delay (minimum five seconds, stored in `conf/settings.json` so it survives a restart). The delay is interruptible: stopping the monitoring cancels it.

`perform_auto_restart()` in `app/routes/experiment.py` is registered as the DAQ manager's restart callback, and it does by hand what the Stop and Start buttons do together — which is why it is long. It notes which side channels were live, flags the failed run `bad` with an explanatory note, closes its current recording and its `stats.csv`, increments the run number, waits, then points both side channels at the new run *before* the acquisition starts, configures and starts caendaq, re-enables the spy and the monitoring, and records the new run with the failed one's parameters carried over. If the new acquisition fails to start it closes the recordings it just opened, because no run follows them.

`/experiment/board_diagnostics` and `/experiment/get_board_status` expose the counters caendaq keeps per board for the run — blocks read, bytes read and written, blocks the write queue refused, CAEN read errors, events decoded, aggregates with the FAIL flag — which is what the dashboard's Board Health tab shows and what the stall rule in section 13 watches. They are cumulative for the run and empty outside one, and a counter that the installed caendaq build does not provide reads `None` rather than failing the whole request.

---

## 8. Online spectra: what "spy" means now

`caendaq` accumulates per-channel spectra, PSD maps and waveform traces continuously in C++ while it decodes. `app/utils/spy.py` builds a ROOT object from the current snapshot **on demand**: no socket, no background collection thread, no second copy of the data stream, and no global channel numbering to get wrong. A spectrum request is addressed by `(board index, channel)`, where the board index is the one caendaq handed out when the run was configured.

A request travels like this:

```
GET /histograms/<board>/<channel>[/<type>]
  → spy_manager.get_histogram()      pick the type from the board's DPP if not given
      → ru_spy.histogram()           numpy array from caendaq → ROOT TH1F (TH2F for PSD)
  ← apply calib/<name>_<id>.cal to the x-axis, then Rebin
  → TBufferJSON.ConvertToJSON()
  ← rendered in the browser by JSROOT
```

`ReadoutUnitSpy.start()` and `.stop()` only flip a flag — there is nothing left to spawn. What they do is make `/spy/status` honest about whether a run is live.

Two details exist to keep the operator informed rather than puzzled. **There is always a histogram to draw, and its title says why it is empty**: "No data yet — start a run", "This board is not part of the current run", "No waveform — switch waveforms on for this board". A blank canvas or a stale plot tells you nothing, and an empty plot labelled "Default Histogram" tells you less. And the statistics box is switched off everywhere, because it covers the part of the spectrum people look at and its mean and RMS over raw ADC bin indices mean nothing.

The calibration is cached by file mtime, so editing a `.cal` file takes effect without a restart and without re-parsing it on every poll. 1-D spectra are rebinned by `SpyManager`; the 2-D PSD map is rebinned by the route.

`BuilderUnitSpy` in the same module is a placeholder: the single-process DAQ does not produce coincidence histograms yet, and it returns an empty one that says so.

---

## 9. Online tuning

Online tuning is not a service. It is one route plus an allowlist.

```
POST /digitizer/<id>/setting/<setting>     {"value": 1234, "online": true}
GET  /digitizer/<id>/online_registers
```

`POST` without `online` is the plain configuration edit: the value lands in `conf/<name>_<id>.json` and applies at the next run. With `online` it is *also* written to the board, so the effect shows up in the trace and the spectrum immediately. **The configuration is updated either way, even when the board write is refused or fails** — so what the tuner shows and what the next run will apply can never drift apart. The response says what happened: `saved`, `written`, `via` (`run` or `probe`), and a `reason` when the write did not go through.

`app/utils/safe_registers.py` decides what may be written. It is an **allowlist, not a denylist**: per-channel DPP parameters — thresholds, gates, shaping and trapezoid times, DC offset, fine gain, the algorithm-control registers that select the probe — are listed by their channel-0 address (`0x10??`, with the live address normalised to that form), and anything unrecognised is left to the configuration file. A denylist would mean that a register added to a dump later quietly became writable mid-run.

The registers kept out are the ones that describe the *shape* of the readout: record length, pre-trigger, input dynamic range, events per aggregate, aggregate and board configuration, the channel enable mask, acquisition control. Changing one of those under a live acquisition produces buffers the decoder does not expect — a corrupted run at best, a stopped board at worst. They are named in the module anyway, so a refusal can say why rather than "not in the list".

`GET /digitizer/<id>/online_registers` returns the board's firmware and the safe register names, so the tuner can mark which fields are tunable before anything is changed instead of discovering it one write at a time.

---

## 10. The histogram dashboard and the ROIs

`services/histogram_config.py` owns `conf/histograms.json`: which histograms exist, their names, their ROIs, their zooms and the dashboard settings.

This used to live in the browser and be persisted to the *web* server's `frontend/cache/`, which put it in the one process that knows nothing about boards, runs or the run directory. Three things followed, and moving it fixed all three: the DAQ server could not record a run's ROIs because it could not see them, every browser kept its own dashboard, and the definitions were declared three times in TypeScript and drifted. On first start the store seeds itself once from `frontend/cache/histogram-configs.json` and friends if they are still there; `WEBDAQ_FRONTEND_CACHE` pointed at an empty directory switches that off. Writes are atomic and serialised, because the dashboard saves on every ROI edit and every zoom.

`services/roi_analysis.py` does two jobs with that configuration. `compute_integrals()` answers the whole dashboard in one call behind `GET /histograms/roi_integrals`: the spectrum is read once per board and channel and every ROI on it is integrated from that one copy. The browser used to ask for one integral per ROI per tick, so sixteen histograms with three ROIs each meant forty-eight round trips and forty-eight spectrum reads every few seconds. Results are `{gross, background, net}` rather than a bare number.

`write_run_snapshot()` drops `roi.json` into the run directory when a run ends. It is wired in through `register_run_hook()`, called at import of `app/routes/histograms.py`, which registers a listener on the DAQ manager's run state — so it happens whether or not a browser is still open. `POST /histograms/run/<n>/roi_snapshot` writes one on demand.

---

## 11. Beam current and charge

Four interchangeable modules present the same interface to `app/routes/current.py`: `utils/tetramm.py` (TCP), `utils/rbd9103.py` (serial), `utils/graphite_current.py` (a monitored accelerator metric, scaled into µA) and `utils/mock_current.py` (test mode). Nothing downstream can tell which is in use, which is the point — the per-run `current.txt`, the readout and the accumulated charge all work the same way.

**The charge integration follows the DAQ's own run state, not the client.** `_on_run_state_changed()` in `current.py` is registered with `daq_mgr.add_run_state_listener()`, so a closed browser, a run stopped by the auto-restart and a run that saves no data all leave the figure correct. It also decides *which* run the charge belongs to, at the moment the run starts: leaving that to `/current/start` — which the dashboard calls only when data is being saved — once let a run started with saving off keep the previous run's number and overwrite that run's charge on stop. A 12-hour run was left reading 100 µC. A run that saves nothing now claims no run number and stores nothing. The lifetime total keeps counting either way, because it answers how much beam the target has seen.

On stop the run's charge is written into its metadata row from the same listener, and the log is closed — a stop issued while the monitor was unreachable used to leave `current.txt` open, and later readings were appended to a finished run.

If the server is restarted mid-run, the module picks the integration back up at import rather than sitting there switched off.

---

## 12. Graphite: two endpoints, two directions

The one thing to get right here: **the ingest and the read API are different servers on different ports, configured in different files.**

| | Configured in | Used for |
|---|---|---|
| Carbon plaintext ingest, port 2003 | `conf/current.json` (`graphite_host`/`graphite_port`) | What the picoammeter controllers and caendaq **push**. Nothing can be read back from it. |
| Graphite render API, HTTP | `conf/stats.json` (`graphite_host`/`graphite_port`) | What the Stats page, the current history and the alert rules **read**. |

`utils/carbon.py` owns the push side, and it is guarded rather than plain: one connection per push for all metrics (Carbon's protocol takes any number of newline-terminated lines, so a four-channel picoammeter costs one handshake instead of four), a one-second handshake deadline, and a circuit breaker that opens after three consecutive failures and stays open for a minute. The loops that call it also own the buffers the web layer reads and the charge integration the run metadata depends on, so a dead collector must never hold anything up — and the breaker is the part that matters. A host refusing connections fails in microseconds, but a host that is powered off or behind a firewall dropping SYNs never answers at all, and then every push waits out the connect timeout. At a 0.5 s sampling interval that is not a hiccup, it is a permanent stall. Board rates are pushed by caendaq itself, configured through `CaenAcquisition.set_graphite()` from `conf/stats.json`.

`utils/graphite.py` is the render-API client. `services/graphite_reader.py` wraps it for everything that plots history and rebuilds the client whenever `conf/stats.json` changes, so editing the server in the UI takes effect without a restart. Taking the address from the file the Stats page configures means an operator sets it once; the current plot used to query port 2003 and report "no data". `services/stats_manager.py` holds the monitored metric list and the loop that samples them into `data/run<N>/stats.csv`, with the column set frozen at run start.

---

## 13. Alerts, notifications and recovery

`services/alerting.py` holds the rules in `conf/alerts.json` and one watcher thread that evaluates them on a two-second tick. A rule is a type (`board_failure`, `stalled_buffers`, `beam_current`, `graphite_metric`), a threshold, how long the condition must hold, and which transports carry it.

Two properties keep the alerts worth reading:

- **One message per episode.** A rule fires when its condition becomes true and stays quiet until it clears. A beam current sitting just below its threshold is one message, not one per tick.
- **Unknown is not false.** A Graphite server that cannot be reached, or a picoammeter whose samples have gone stale, yields no value at all — and a gap in the monitoring path must neither invent an alert nor clear a real one.

Every measurement is taken through a small set of callables (`AlertSources`), so the whole engine is testable without hardware, without Graphite and without a run. The watching itself is deliberately dull: one thread, one pass per tick, and Graphite rules throttle themselves further with their own `poll_seconds`.

Rules are normalised and validated on the way in, and a bad one is rejected with `AlertConfigError` rather than stored and silently never fired. Each type carries its own defaults and the parameters the UI needs to render it, which is where to add a new kind of alert: a `RULE_DEFAULTS` entry, a source callable, and an `_evaluate_*` branch. Most types also take `during_run_only`, because a beam current below threshold means nothing when nobody is measuring.

`services/alert_log.py` writes every alert and every recovery to `conf/alert_log.json`, capped at the most recent 500 events. A Telegram message is gone once it has been read, and a shift arriving at 08:00 needs to be able to ask what the DAQ did at 03:00 — including across the restart that is often part of the story. Nothing in this module may raise into its caller: failing to *record* an alert must never stop it being sent.

`services/telegram_notifier.py` and `services/zulip_notifier.py` are the two transports. Their credentials live in `conf/telegram_settings.json` and `conf/zulip_settings.json` and are returned to the browser masked.

`services/recovery.py` names the handful of things that actually recover a session — reopen the board connections, reset the acquisition, reconnect the current monitor, restart the statistics collection, re-check Graphite — reports for each whether it currently looks needed, and runs one on request. **Nothing in it runs by itself.** The operator presses it, so a recovery never happens behind their back mid-measurement; the one exception in WebDAQ is auto-restart, which is opt-in and says so in the logbook entry it writes.

The watcher is normally started by `main.py`. `POST /notifications/watcher` exists because a backend launched another way — a bare `flask run`, some other WSGI server — would leave the rules configured and never evaluated, and the settings page that reports this has to be able to fix it.

---

## 14. Grafana, ELOG and the run report

`services/grafana_client.py` exposes only Grafana's alert-rule API: list, read, update, silence, activate. The address and the service-account token stay in `conf/grafana_settings.json` and never reach the browser, and the narrow surface is deliberate because the token may carry far more rights than the Alerts page needs. Which rules are auto-managed is remembered in the frontend, which silences them on stop and activates them on start.

`services/elog_client.py` reads and writes a PSI ELOG logbook through py_elog, imported lazily so a server without the package still starts and reports a clear reason. Authentication is one shared service account in `conf/elog_settings.json`; attribution is separate, with ELOG's `Author` attribute filled from the WebDAQ user who is posting, so entries still carry a real name.

`services/run_report.py` turns a finished run into a draft entry — the database row, `metadata.json`, the logged current, the accelerator readings and the ROIs, assembled into body text and attributes. The result is a *draft* the operator edits before posting; nothing here is authoritative. Attributes are matched by keyword rather than exact name, because every LUNA logbook names its fields slightly differently and the composer learns the real field list from the logbook itself.

---

## 15. Completed runs and conversion

`services/run_data.py` is the read side: it turns `data/run<N>/` into a file inventory, the current as a time series, an integrated charge, and a RUReader conversion to ROOT. It only reads, and writes ROOT output; the acquisition path is untouched.

`ConversionManager` runs RUReader as a subprocess, one conversion per run at a time, writing `run<N>.root` next to the data it was made from. A large run takes minutes, so the request only starts the job and the dashboard polls `status`.

Two details are there because of the binary rather than the data. **The installed RUReader is not necessarily built from the pinned submodule**, and an older one exits with "Unknown option" instead of converting, so `capabilities()` asks it once with `--help` and only sends the flags it advertises — which also lets the UI offer exactly those options. And a RUReader built against a different ROOT fails with a linker error that says nothing about the real cause, so `_annotate_log()` prepends the explanation and the fix to the log the dashboard shows. `RUREADER_BIN` and `RUREADER_ENV_PREFIX` override the binary and the environment it is run in.

`app/routes/data.py` joins all that with what the database knows, so a run list can show what is actually on disk — whether there is data, whether there is a current log, whether it has been converted, how many files and how many bytes — rather than only what was intended.

---

## 16. A run, start to finish

Starting a run is partly orchestrated by the client, and it is worth knowing which parts.

The browser (`components/run-control-buttons.tsx`) pushes the acquisition settings, then starts the side channels — `/current/start/<run>` and `/stats/run/<run>/start`, only when data is being saved — then calls `/experiment/start_run`, then writes the run metadata and activates the auto-managed Grafana alerts. **The side channels may not stop the run.** They were once awaited bare, so a picoammeter that was connected but not sampling answered 4xx, threw, and the DAQ was never started at all: the operator saw "Failed to start the run" and lost beam time to a monitor. They are now caught, and the toast says which one did not start.

`POST /experiment/start_run` then does this, in order:

1. Refuse if a run is already in progress or no boards are configured.
2. `prepare_run_start()` — create `data/`, and when saving, `data/run<N>/`, and copy each board's `conf/<name>_<id>.json` into it. **Only the board configurations are copied. Calibration files are not** — `calib/*.cal` is read live from the working directory, so a run directory carries the settings it was taken with but not the calibration it was displayed with.
3. `release_digitizers()`, then `caen_acq.configure(boards, run, out_dir, max_file_bytes, write=save)` and `caen_acq.start()`. A failure at either step reacquires the probe connections before returning, so a failed start does not leave the boards closed.
4. `set_running_state(True)` — which stamps a timezone-aware ISO 8601 start time (without the offset the browser parsed it ambiguously and the run timer could start negative) and **notifies the run-state listeners**.
5. Enable the on-demand spy and start board-failure monitoring.
6. Record the run in the database, if saving.

`set_save_data(false)` is a real mode: `configure(write=False)` runs decode-only, so spectra, rates and charge all work and nothing is written.

`POST /experiment/stop_run` unwinds it — stop monitoring, stop the spy, stop the acquisition, reacquire the digitizers, write the end time, increment the run number if data was saved, and `set_running_state(False)`. The listeners do the rest: the charge is persisted and the current log closed by `current.py`, `roi.json` is written by `roi_analysis.py`. Metadata failures are logged and never fail the stop, but they *are* logged — a silent `pass` there once hid a missing migration.

**The run-state listeners are the extension point for anything that must follow a run.** Register with `daq_mgr.add_run_state_listener(fn)` rather than adding a step to the route: a listener fires for a run stopped by the auto-restart and for a run whose browser has gone away, and a route step does not.

---

## 17. Configuration files

All of them are JSON in `conf/`, relative to the working directory, written by the server and safe to read or edit by hand when it is stopped.

| File | Owner | Holds |
|---|---|---|
| `settings.json` | `daq_manager.py` | Run number, saving, size limits, the board list, auto-restart and its delay. |
| `<name>_<id>.json` | `digitizer.py`, `dgtz.py`, `board_defaults.py` | One board's full register dump. The single source of truth for the board: the CAEN dashboard edits it, caendaq applies it, and Acquisition Control (0x8100) in it decides how a run starts. |
| `histograms.json` | `histogram_config.py` | Histograms, ROIs, zooms, dashboard settings. |
| `current.json` | `routes/current.py` | The current module in use, the Carbon ingest address, the lifetime charge. |
| `tetram.json`, `rbd9103.json` | `tetramm.py`, `rbd9103.py` | Per-device settings for the two picoammeters. |
| `stats.json` | `stats_manager.py` | The Graphite render API, the metric subtree, the monitored metrics and their units, the sampling cadence. |
| `alerts.json` | `alerting.py` | The alert rules. |
| `alert_log.json` | `alert_log.py` | The last 500 alert and recovery events. |
| `telegram_settings.json`, `zulip_settings.json` | the two notifiers | Bot credentials. |
| `grafana_settings.json`, `elog_settings.json` | `grafana_client.py`, `elog_client.py` | Addresses and service tokens. |

A missing file is not an error: each owner writes a sensible default on first use. An *unreadable* `conf/settings.json` is moved aside with a timestamp rather than replaced, so the board configuration in it can be repaired instead of lost.

---

## 18. Test mode and the test suite

`TEST_FLAG=True` substitutes the simulated digitizer and the simulated picoammeter. It is not a stub layer bolted on the side: `utils/board_defaults.py` fabricates a register dump with the same register set, the same JSON shape and plausible values, so the CAEN dashboard, the synchronisation controls and online tuning all have something real to act on; `utils/mock_current.py` writes exactly the same `current.txt` format and produces a deliberately beam-like signal — a slow decay with ripple, drift and the occasional dip — so plots and charge integrals look like something an operator would recognise. Database and metadata paths are unchanged.

`server/tests/` is plain `unittest`, no extra packages, no hardware, no Graphite and no ELOG; HTTP responses are faked where a server would be needed. `tests/run_tests.sh` runs the suite from a scratch working directory so a real setup's `conf/` and `data/` are never touched — the exception is `test_routes.py`, which drives the app the way the frontend does and therefore reads the directory it is started from.

The convention for new tests is to test the rule rather than the implementation: "a structural register is refused mid-run" survives a refactor, "the structural list has 16 entries" does not.

---

## 19. The frontend as a client

The web interface has no privileged path into the DAQ. It is one API client among several, which is why a browser crash cannot take a run with it, and it is worth knowing the three places where it does more than draw.

**`src/lib/api.ts`** is the single Axios instance, with `NEXT_PUBLIC_API_URL` as its base and two interceptors. The request interceptor attaches the JWT from the auth store. The response interceptor catches a dead session centrally — 401 from flask-jwt-extended for missing or expired, 422 for malformed — clears the token and redirects to the login page with the current path as `next`. Without it, every polling component would start getting 401s and, because most of them swallow errors to survive a brief server hiccup, the page would simply stop updating and look as though the DAQ had died. Calls to `/login` and `/register` are exempt, since a 401 there is the login form's business.

**`src/app/api/server-control/route.ts`** runs in the Next.js process, not the browser, and is how *Start an Experiment* works: it resolves the conda environment's prefix (asking conda rather than trusting `conda run -n luna python`, which on some versions resolves `python` from the inherited PATH), runs `scripts/check_db.sh` against the chosen working directory's `app.db`, creates the default user if there is none, and spawns `server/main.py` with that directory as its cwd and its own pid as `LUNA_LAUNCHER_PID`. Every step has a hard timeout so a hung conda or sqlite call cannot wedge the request, and a graceful exit of the launcher takes the backend with it — a SIGKILL is covered from the other side by the watchdog in section 2.

Two things in that preflight are worth knowing when a start behaves oddly. It copies migration revisions the repository has and the measurement directory does not, adding only — anything already there wins, so a project whose history diverged keeps it. And it probes the database with plain sqlite3 reads first, skipping both the conda-wrapped `flask db upgrade` and the create-user script when there is nothing to do, because importing the app is the single most expensive step of a start and on a warm boot neither is needed.

**`src/app/api/cache/route.ts`** keeps the state that genuinely belongs to a browser rather than to the DAQ: the visualisation channel selection, the waveform view configuration, the list of recent working directories. The histogram dashboard used to live here too, and section 10 explains why it does not any more.

Everything else is conventional: Zustand stores for client state, React Query for polling, and JSROOT for drawing the `TBufferJSON` payloads the histogram endpoints return.

---

## 20. Working in this codebase

A short list of things that are easy to get wrong here.

| Doing this | Do it this way |
|---|---|
| Adding an endpoint | Put it in the blueprint that owns the subject, decorate with `@jwt_required_custom`, and add the call to `frontend/src/lib/api.ts`. A new blueprint also needs registering in `create_app()`. |
| Needing a service | Call its `get_*()`. Never construct a second instance. |
| Needing to react to a run | Register a run-state listener, not a step in the start or stop route. |
| Touching the database off a request | Open a context on the app reference handed to `app/routes/experiment.py` by `set_flask_app()`. |
| Opening a file | Relative paths are relative to the working directory. Anything that must follow the *installation* has to be anchored to `__file__`, as `main.py` does for `migrations/`. |
| Writing a config file | Temporary file plus `os.replace`, under a lock. Background threads write these too. |
| A side effect at run start | It must not be able to fail the run. Catch it, let the run proceed, and say which part did not start. |
| Adding an alert | A `RULE_DEFAULTS` entry, a source callable in `AlertSources`, an `_evaluate_*` branch — and decide whether it only applies during a run. |
| Reporting a failure | Say what broke and what to press. The alert log, the recovery actions and the empty-histogram titles all exist because "something went wrong" is not a message anyone can act on at 03:00. |
| Changing the schema | `flask db migrate` in `server/`; `ensure_schema_current` applies it at the next start, in whichever working directory the server runs. |
| Changing C++ | `pip install server/native/caendaq` after a submodule bump or a source change. |
