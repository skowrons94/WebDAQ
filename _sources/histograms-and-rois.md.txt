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

## 2. Adding a spectrum

**Add Histogram** → pick a board and a channel.

| Field | Meaning |
|---|---|
| Board / Channel | Which spectrum to show. The board list comes from what you have added on the Board page. |
| Label | A name of your own — *"Ge clover"*, *"BGO 3"*. Leave it empty for `Board 0 - Channel 1`. |
| Size | Card height: small, medium, large. |
| Visible | Hide a card without losing its ROIs. Hidden spectra are not fetched, so hiding is also how you make a crowded dashboard lighter. |

Cards can be dragged into whatever order you want; the order is stored with
everything else.

---

## 3. Regions of interest

An ROI is a named energy window on one spectrum. Add one with the **+** on a
card, or click an existing one in the card's legend to edit it.

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

**Bounds follow the calibration.** If you calibrate a channel after defining its
ROIs, the ROIs stay where they were put in axis units — which is what you want if
you entered them in keV, and not if you entered them in channels. Check them
after a calibration change.

---

## 4. Zoom, rebinning and display

**Zoom** is per histogram and is remembered. Zoom into a peak, go to the logbook,
come back, and the spectrum is still zoomed the way you left it — including after
a server restart. It is deliberately *not* pushed to other people's screens: a
colleague zooming during your measurement will not move your view. **Reset Zoom**
clears them all.

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

Two related pages, with the same idea and separate controls:

- **Waveforms** show the digitised trace for a channel, which is what you look at
  when setting a trigger threshold or a trapezoid rise time. Traces have to be
  enabled per board, because transporting them costs bandwidth that would
  otherwise go to data.
- **PSD** shows the two-dimensional charge-comparison plot for pulse-shape
  discrimination, used to separate neutrons from gammas in organic scintillators.

Both select boards and channels independently of the histogram dashboard.

---

## 7. When something looks wrong

| Symptom | Usual cause |
|---|---|
| A spectrum is empty | The channel is not enabled on the board, or its threshold is above the signal. Check the trace first. |
| Counts do not move | Auto-update is off, or the run is not running, or the ROI is disabled. |
| ROI counts look far too high | Rebinning changed, or the ROI is in channels while the axis is now in keV. |
| The dashboard is empty after an upgrade | The server was started in a different working directory — the dashboard lives in `conf/histograms.json` under it. |
| The page is slow | Too many visible cards, or too short an update interval. Hide what you are not watching; hidden cards are not fetched. |
