# Spectra, ROIs and the histogram dashboard

The Histograms page is where you watch what the detectors are doing during a run:
one card per board and channel, each with its own regions of interest and their
live counts.

---

## 1. The dashboard belongs to the experiment, not to your browser

Everything on this page — which spectra are shown, what they are called, their
ROIs, their zooms, the layout, the rebinning — is stored **on the DAQ server**,
in `conf/histograms.json` in the working directory.

That has three consequences worth knowing:

- **It survives a restart.** Restart the server, or the machine, and the
  dashboard comes back as you left it.
- **Everyone sees the same dashboard.** Open it from the control room PC and
  from a laptop and you are looking at one configuration, not two. Add an ROI on
  one and it is there on the other after its next refresh.
- **The server knows your ROIs**, which is what lets it record them with the run
  (§5) and integrate them without the browser asking region by region.

The file is written every time you change something — atomically, so an
interrupted write cannot corrupt it — and read once when the page loads. Simply
watching the spectra does not write to it.

```{note}
Before v4.0 this configuration lived in the web server's `cache/` folder and in
each browser's local storage. If you are upgrading, your existing histograms and
ROIs are imported automatically the first time the DAQ server starts, and the old
files are left untouched.
```

---

## 2. Choosing the spectra

**Channels** opens the channel list: every board with all its channels. Click a
channel to show or hide its spectrum; **All** and **None** do a whole board.
During a run each channel carries its event rate, and a green dot marks the
channels that are counting, so a dead input is visible before it is opened.

Each card shows, above its spectrum, what the channel is doing during a run:
**Rate** (events recorded per second), **Pile-up** and **Lost** (per second,
amber when they become a large share), **Saturated** when the board reports it,
**Triggers** for an SIS3316 (all its internal triggers, recorded or not), and
the spectrum's total **Counts**.

**Custom** adds a spectrum with your own label and size, the dialog the edit
button on a card also opens:

| Field | Meaning |
|---|---|
| Board / Channel | Which spectrum to show. The board list comes from what you have added on the Board page. |
| Label | A name of your own — *"Ge clover"*, *"BGO 3"*. Leave it empty for `Board 0 - Channel 1`. |
| Size | Card height: small, medium, large. |
| Visible | Hide a card without losing its ROIs. Hidden spectra are not fetched, so hiding is also how you make a crowded dashboard lighter. |

Cards can be dragged into whatever order you want; the order is stored with
everything else. The eye on a card hides it (its ROIs are kept). The arrows
**enlarge** a card to the full width, with the table of its ROIs underneath;
press them again to return to the grid.

---

## 3. Regions of interest

An ROI is a named energy window on one spectrum. The quickest way, as in
Maestro: switch on **Mark ROIs** in the toolbar and drag across the peak — the
range is shaded while you drag and becomes an ROI when you let go, without
zooming. Switch it off to zoom by dragging again. Or zoom on the peak and click
the target button on the card: the ROI covers exactly the visible range. Either
way it gets the next free colour. Rename or adjust it
by clicking it in the card's legend. An enlarged card also lists its ROIs, where
each can be zoomed to, switched off or edited, and new ones added by typing the
range (**By range**).

| Field | Meaning |
|---|---|
| Name | What it is — *"511 keV"*, *"1332 keV"*. This is what appears in the legend and in `roi.json`. |
| Low / High | The window, **in the units of the x axis**. If the channel is calibrated, these are keV; if not, they are ADC channels. |
| Colour | Chosen from the ROOT palette, so the shaded overlay on the spectrum matches the legend exactly. |
| Enabled | Switches the region off without deleting it — no overlay, no counts, no cost. |

The counts next to each ROI in the legend are the integral over the window,
refreshed on the dashboard's update interval. The overlay on the spectrum is the
same bins, filled in the ROI's colour, so what you see shaded is exactly what is
being counted.

**Bounds follow the calibration.** ROIs are stored in axis units. When a
channel's calibration changes from its card (below), its ROIs and saved zoom are
moved to the new axis, so they stay on the same peaks. A calibration edited by
hand in `calib/` does not move them.

### Energy calibration

Each card says whether its channel is calibrated: **keV**, or **channels** for the
raw axis. Click it, or the ruler button, to calibrate the channel
(E = offset + slope × channel):

* **From peaks** — the spectrum in channels. Drag across a peak to zoom on it and
  click **Fit peak in view**: a Gaussian on a straight background gives its
  centroid, width and area. Type its energy, or pick it from the list of usual
  lines (⁴⁰K, ²⁰⁸Tl, ¹³⁷Cs, ⁶⁰Co, ²²Na, ¹⁵²Eu…), and **Add**. Two peaks or more
  give the line through them with the residual of each; one peak gives a line
  through zero. Peaks are fitted on the live spectrum, so a run must be going.
* **Numbers** — type the offset and the slope.

**Save** applies it at once. The peaks it came from are kept with it
(`calib/<board>_<id>.points.json`) and come back the next time the window opens.
Every run copies the calibration in force at its start into its directory, and
a change made during a run is logged there, with its time, in
`calib_history.jsonl` — so the analysis knows which calibration applied when.
**Back to channels** removes the calibration.

The channel in E = offset + slope × channel is the integer **Energy** value
written in the run files (and in the ROOT tree), so the same two numbers
calibrate the offline analysis exactly. A line narrower than a channel (a
pulser) is placed at the mean of its counts, to within a third of a channel.

---

## 4. Zoom, rebinning and display

**Zoom** is per histogram and is remembered. Zoom into a peak, go to the logbook,
come back, and the spectrum is still zoomed the way you left it — including after
a server restart, and an enlarged card keeps it too. It is deliberately *not*
pushed to other people's screens: a colleague zooming during your measurement
will not move your view. **Fit to data** zooms every shown spectrum onto the bins
that have counts — the first thing to press when a peak is a sliver at the edge
of a 16K-channel axis. **Reset zoom** clears them all.

**Rebinning** applies to every spectrum on the page and is done on the server
before the spectrum is sent. It affects the ROI integrals too, which is the
point — what you count is what you see. Raise it when the statistics are thin and
the spectrum looks like noise.

**Log scale**, **labels**, **ROI overlays** and **integrals** are display
switches. **Update interval** is how often the page refreshes; **Auto-update**
turns refreshing off entirely, which is what you want if you are studying a
spectrum and do not want it moving under you.

**Grid columns** and the small/medium/large card sizes control the layout. On a
control-room screen, three columns of medium cards is usually the readable limit.

---

## 5. What is recorded with the run

When a run stops, WebDAQ writes **`data/run<N>/roi.json`** containing every
defined ROI and its final counts:

```json
{
  "run_number": 412,
  "written_at": "2026-08-03T18:22:41+02:00",
  "rebin_factor": 4,
  "histograms": [
    {
      "id": "hist_dc27c5376e17",
      "boardId": "0",
      "channel": 3,
      "label": "Ge clover",
      "rois": [
        {
          "id": "roi_fc7ddde2dbec",
          "name": "1332 keV",
          "low": 1300.0, "high": 1360.0,
          "color": "#00ff00", "enabled": true,
          "background": null,
          "gross": 18422.0, "net": 18422.0
        }
      ]
    }
  ]
}
```

Points worth noting:

- It records **every ROI you have defined**, including ones that were hidden or
  switched off in the browser. The file describes the setup, not somebody's view.
- `rebin_factor` is stored because the counts depend on it.
- `gross`, `background` and `net` are separate fields. There is no background
  estimation yet, so `background` is `null` and `net` equals `gross`. When an
  estimator is added, existing files stay readable and analysis code reading
  `net` keeps working.

Together with `metadata.json`, the board configurations and `current.txt`, this
makes the run folder self-describing: the counts, the regions they came from, the
settings, and the charge to normalise by.

---

## 6. Waveforms and PSD

Two further tabs on the Dashboard, with the same idea and separate controls:

- **Waveforms** show the digitised trace for a channel, which is what you look at
  when setting a trigger threshold or a trapezoid rise time. Traces have to be
  enabled per board, because transporting them costs bandwidth that would
  otherwise go to data.
- **PSD** shows the two-dimensional charge-comparison plot for pulse-shape
  discrimination, used to separate neutrons from gammas in organic scintillators.

On the Waveforms tab, **Show** picks which event's trace is drawn: the
**Latest** one, or the latest **Clean** one (no pile-up, not saturated),
**Pile-up** one or **Saturated** one — to look at what pile-up really looks
like, or at a clean pulse while the rate is high. **Freeze** keeps the traces on
screen to study them. Channels are picked with the same chips, showing their
rates, and each plot carries the channel's rate and pile-up. (The pile-up and
saturation filter needs the caendaq build that keeps a trace per kind; an older
build says so on the plot.)

Both select boards and channels independently of the histogram dashboard. The
Waveforms tab also carries the board-configuration controls that decide what the
board digitises into a trace — dual trace, what each trace carries, and the
digital probe. Those are written to the board as soon as you change them, so they
belong to setting a board up rather than to a measurement in progress.

---

## 7. When something looks wrong

| Symptom | Usual cause |
|---|---|
| A spectrum is empty | Read the histogram's own title, which says which case it is — no run, this board not in the run, no counts on that channel. Then check on **Board Health** whether the board is reading data blocks at all, and only then the channel enable and the threshold. |
| Counts do not move | Auto-update is off, or the run is not running, or the ROI is disabled. |
| ROI counts look far too high | Rebinning changed, or the ROI is in channels while the axis is now in keV. |
| The dashboard is empty after an upgrade | The server was started in a different working directory — the dashboard lives in `conf/histograms.json` under it. |
| The page is slow | Too many visible cards, or too short an update interval. Hide what you are not watching; hidden cards are not fetched. |
