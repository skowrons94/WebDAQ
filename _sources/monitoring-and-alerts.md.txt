# Monitoring: Graphite, Grafana, alerts and notifications

Four different things watch the experiment, and they are easy to confuse. In
short:

| Tool | What it is | What it does here |
|------|------------|-------------------|
| **Graphite** | A time-series database with an HTTP API | Stores every number anyone measures: beam current, terminal voltage, board rates. WebDAQ writes to it and reads from it. |
| **Grafana** | A dashboard and alerting server | Draws those numbers as plots on the wall screen, and raises alerts when one leaves its range. |
| **WebDAQ Stats page** | Part of this application | Shows the current value of the metrics *you* selected, and copies them into each run's `stats.csv`. |
| **Telegram / ELOG** | Messaging and the logbook | Tell a person that something happened. |

---

## 1. Why a time-series database at all

The accelerator, the target, the picoammeter and the digitizers each produce
numbers continuously. Storing them inside the DAQ would mean every consumer —
plots, alerts, run files, shift reports — reading a different file in a different
format, and nothing at all being available from another machine.

Graphite solves exactly that. A metric is a dotted name with a value and a
timestamp:

```
accelerator.terminal_voltage   3.412   1785191160
daq.rate1                      12874   1785191160
```

Anything can write one (`carbon`, the ingestion side, listens on TCP 2003), and
anything can read it back over HTTP. The DAQ does not have to know who wants the
number, and the analysis does not have to know which program produced it.

At LUNA the server is `lunaserver`. Its metric tree looks like this:

```
accelerator.charge              ancillary.rates
accelerator.column_current      daq.rate1 … rate3
accelerator.extraction_voltage  Germanium…
accelerator.terminal_voltage    12c12c.tetram…
```

### What WebDAQ pushes

* **Board rates** — events, pile-up, saturation, lost counts and file write rate
  per board and channel, pushed by the acquisition every second during a run.
* **Beam current** — every sample from the TetrAMM or the RBD 9103.

Both go to Carbon on port 2003 of the host configured in Settings; the Stats page
and Grafana read them back over HTTP (port 80 or 8080, depending on the install).

### Graphite time syntax

Ranges are relative: `-10s`, `-30min`, `-6h`, `-1d`. **The minute unit is `min`**
— `-30m` is rejected with *"Invalid offset unit 'm'"*. It is the mistake everyone
makes once.

---

## 2. The Stats page

Settings a shift crew actually needs: which numbers to watch, what to call them,
and what they are measured in.

**The light** next to the title is the state of the Graphite server. Green means
it answered a query for its metric tree; red means it did not, and every metric
on the page will read `N/A` until it does. Grey is the check in flight. The light
distinguishes a dead server from metrics that simply have no data — without it
they look identical.

**Adding a metric.** Press *Add metric* and browse the tree: open `accelerator`,
pick `terminal_voltage`. Or type a word in the search box to find it anywhere in
the tree. Then give it:

* a **name** — what the card and the CSV column will be called ("Terminal
  Voltage"), and
* a **unit** — kV, uA, counts/s. Optional, but it is what makes a column
  readable a year later.

Both can be changed afterwards with the pencil on the card.

**On each card**: the latest value with its unit, the time of that reading, and a
30-minute trend line so you can see whether it is rising, falling or flat. The
eye hides a metric without deleting it; the bin removes it.

---

## 3. The run's stats file

While a run with data saving is in progress, every enabled metric is sampled once
a second and written to `data/run<N>/stats.csv`:

```csv
# LUNA DAQ statistics
# Run number: 1276
# Start time: 2026-07-28T01:09:00
# Format: CSV. The first column is the elapsed acquisition time in seconds;
# the rest are the metrics below, in this order. Missing samples are 0.
#
# Metric: Terminal Voltage | unit: kV | source: accelerator.terminal_voltage
# Metric: Board 0 rate | unit: counts/s | source: daq.rate1
#
Time [s],Terminal Voltage [kV],Board 0 rate [counts/s]
0.001,3.412,12874
1.005,3.411,12903
```

Points worth knowing:

* It is plain CSV. The metadata is in `#` comment lines that every reader can
  skip: `pandas.read_csv('stats.csv', comment='#')` gives you the table directly.
* Each column heading carries the name and unit you chose, and every metric is
  listed above with its Graphite path, so a column can always be traced back to
  its source.
* The set of columns is frozen when the run starts. Adding a metric mid-run does
  not shift the columns under the rows already written; it appears in the next
  run.
* A missing sample is written as `0`. Graphite has ingestion lag, so a gap does
  not mean the instrument failed.

---

## 4. Grafana

Grafana reads the same Graphite data and does two things WebDAQ deliberately does
not: long-term plots on the control-room screen, and alerting.

Use Grafana for: "how did the terminal voltage behave over the last three days",
"is the board rate drifting", "email/notify me when the current drops below X".
Use the WebDAQ Stats page for: "what is the beam current *right now*, and put it
in this run's file".

### Alerts tied to the run

The **Alerts** page lists the alert rules from Grafana and lets you mark rules as
*auto-managed*. An auto-managed rule is:

* **activated** when a run starts, and
* **silenced** when the run stops.

That solves the standard annoyance: a "beam current too low" rule that is right
during a run and pure noise while you are setting up. Mark the rules that only
make sense during data taking; leave the rest under Grafana's own control.

Grafana is reached through a proxy inside the frontend (`/api/grafana/...`),
which points at `http://lunaserver:3000` by default. Change the host — and add a
service-account token if your Grafana requires authentication — in
`frontend/src/app/api/grafana/[...path]/route.ts`, then rebuild the frontend.

---

## 5. Telegram notifications

Settings → Notifications. WebDAQ sends a Telegram message when a **board fails
during a run** — the acquisition sees the board-fail flag in the data stream and
reports it once per run:

```
⚠️ LUNA DAQ Board Failure Alert

Run Number: 1276
Board ID: 0
Failure Type: board fail flag
Time: 2026-07-28 01:31:07

🔄 Auto-restart is enabled. Run will restart in 30 seconds.
```

Setting it up:

1. Talk to `@BotFather` in Telegram, create a bot, copy the token.
2. Add the bot to the group that should receive the alerts, or message it
   directly.
3. Get the chat ID (`https://api.telegram.org/bot<token>/getUpdates` shows it
   after one message).
4. Enter both in Settings → Notifications and press *Test* — a test message
   arrives immediately if the token and the chat ID are right.

The token is stored in `conf/telegram_settings.json` on the DAQ machine. Anyone
holding it can post as the bot, so use a bot created for this purpose.

Auto-restart, configured on the same page, is what the message refers to: when a
board fails, the run is stopped and started again after the delay, so a night
shift does not lose hours to a board that hiccupped.

---

## 6. What to check when a number is missing

| Symptom | Look at |
|---------|---------|
| Every metric reads `N/A`, light is red | Graphite host and port in Settings; `curl http://<host>/metrics/find?query=*` from the DAQ machine. |
| One metric reads `N/A`, others fine | Its path. Re-add it with the browser — a renamed metric keeps the old path in your configuration. |
| Light is green but the card is empty | Nothing is writing that metric. Check the source instrument, not WebDAQ. |
| `stats.csv` has all-zero columns | Same as above: the metrics were unreachable *during that run*. The header still tells you which they were. |
| Grafana plots but WebDAQ does not | Different port. Grafana often reads Graphite on 80 while the Stats page is configured for 8080, or the other way round. |
