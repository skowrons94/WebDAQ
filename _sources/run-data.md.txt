# Run data and conversion

What a run leaves on disk, what each file is for, and how to turn it into
something an analysis can read. The run directory is the unit of data: a copy of
`data/run1276/` is a complete, self-describing measurement, with the board
configuration it was taken with and a record of the beam that produced it.

---

## 1. The run directory

Everything a run writes goes into `data/run<N>/`, relative to the working
directory the server was started from. The directory is created when the run
starts, and only when **Save data** is on — a run with saving off still decodes,
fills spectra and publishes rates, it just writes nothing.

| File | Written | What it is |
|---|---|---|
| `run_<N>_0000.caendat` | during | The data. One unified binary stream for every board, with the same header layout the XDAQ-era files had, so the same converter reads old and new runs. |
| `run_<N>_0001.caendat`, … | during | The next parts, when a size limit is set. The header is written once, in the first file. |
| `<model>_<id>.json` | at start | The board's complete register dump, copied out of `conf/`. This is what makes the run reproducible: thresholds, gates, trapezoid parameters, start mode, as they were. |
| `current.txt` | during | The beam current, one row per sample, with the time relative to the start of the log. The first two lines name the start time and the columns. |
| `stats.csv` | during | The accelerator readings you selected on the Stats page, one row per sampling tick. |
| `stats.csv.part1`, … | during | Earlier rows of the same run, kept aside when the statistics were restarted mid-run (see [Troubleshooting](troubleshooting.md)). |
| `metadata.json` | at every change | The run's record — times, target, voltages, charge, flag, notes, the boards and the software versions — written again whenever anything changes. |
| `roi.json` | at stop | Every region of interest defined at the time, with its counts. |
| `run<N>.root` | on request | The converted file, produced by RUReader from every `.caendat` in the directory. |

**The database is the live record; `metadata.json` is the copy that travels.**
SQLite (`app.db`) is what the Logbook reads and writes. After every change the
same information is written into the run directory, so a directory copied to
another machine still knows its target, its charge and the firmware that took it.

---

## 2. The data file

`.caendat` is the raw CAEN aggregate stream with a small header in front of it.
The header names the boards — sampling period, time-tag period, DPP version,
channel count and register id for each — and then the aggregates follow as the
boards produced them. There is no trailer, which is deliberate: a run killed by a
power cut is still readable up to the point where it stopped.

Two consequences worth knowing on shift:

* **One file holds every board.** The boards are interleaved in one stream rather
  than written side by side, which is what makes a synchronised run a single
  object with one time origin.
* **Nothing is ever overwritten.** Starting a run in a directory that already has
  data writes `_1`, `_2`, … rather than replacing what is there, and the dashboard
  asks before reusing a run number at all.

---

## 3. Converting to ROOT

Conversion is offline and does not touch the run: it reads the `.caendat` files
and writes `run<N>.root` next to them, using RUReader.

Open **Logbook → the run → Convert**. The tab shows what the installed RUReader
can do, because the options are read from the converter itself rather than
assumed; a build that does not offer a flag does not show it. Start the
conversion and leave the page if you like — it runs on the server, in the
background, and the tab reports progress and the last lines of the converter's
log when it finishes.

A conversion that fails leaves the `.caendat` files untouched. The log tail is
the first thing to read; a truncated final aggregate from an interrupted run is
the usual cause, and `--ignore-fail` (passed automatically when the installed
converter supports it) is what gets the rest of the data out.

---

## 4. Checking a run that was interrupted

```bash
cd server
python scripts/check_run_integrity.py data/run1276
```

The script walks the file structure without converting anything and says whether
the header, the board definitions and the aggregate chain are consistent. Use it
after a crash, a full disk or a power cut, before deciding whether a run is worth
converting.

---

## 5. Reading the run back in the Logbook

**Logbook → the run** opens the run's own page, which reads the directory rather
than only the database:

* **Overview** — times, duration, target, voltages, run type, accumulated charge,
  the flag, and the file inventory with sizes.
* **Notes** — the free-text record, editable after the fact.
* **Beam Current** — `current.txt` plotted, with the charge integrated over the
  whole series rather than over the drawn points.
* **Stats** — one plot per metric from `stats.csv`, each labelled with the alias
  and unit you gave it on the Stats page. A final row still being written is
  dropped rather than plotted, because half a number drawn as a value looks like
  a cliff that never happened.
* **Boards** — the register dumps copied in at run start, so you can see what the
  run was taken with without opening the files.
* **Convert** — section 3 above.

---

## 6. Housekeeping

**Run numbers** live in `conf/settings.json` and advance on Stop, only when
saving. Set the number by hand on the dashboard when a campaign needs to continue
an older series — the dashboard warns before reusing a directory that already
holds data.

**Disk.** A rate of a few MB/s is normal for a busy chain; the dashboard shows
the current write rate, and **Board Health** shows the bytes each board has
handed to the writer. If the write queue cannot keep up, the blocks it refuses
are counted as *Dropped* on Board Health — that counter is lost data, and it is
the one number on that page that should always be zero.
