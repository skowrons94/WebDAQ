# Online coincidences

The Coincidences page (sidebar → Spectra → Coincidences) builds spectra of channels
gated by other channels, live, while the run is going. It is a view on the
data: the run files keep every hit, so a gate set up wrong costs nothing — fix
it and the gate starts over.

---

## 1. A gate is a sentence

Each gate reads as one sentence, filled in on its card:

> Spectrum of **[channels]** **[in coincidence with | with a veto from]**
> **[partner channels]** within ± **[window]** ns *(at least **n** of them)*

- **In coincidence with** keeps a hit of the channels when at least one partner
  (or *n* different partners, when there are several) fires within the window
  around it, before or after. Example: the HPGe spectrum in coincidence with a
  scintillator.
- **With a veto from** keeps a hit when *no* partner fires within the window —
  a Compton or cosmic-ray veto. The vetoed spectrum and the coincidence
  spectrum of the same gate add up to the singles spectrum.

Click **Channels** or **Partners** to pick them from a grid of every board's
channels. Then **Save**: the gate is built from the next hit on (or from the
next run).

Optional:

- **Energy–energy matrix**: the energy of the gated channel against the energy
  of its partner, for coincidence gates.
- **Δt plot range**: how far either side the Δt spectrum reaches (below).

## 2. What a gate shows

- **Counts and rates**: how many hits of the channels passed, the fraction of
  all their hits, and the rate over the last few seconds against the singles
  rate.
- **The gated (or vetoed) spectrum** of each channel of the gate, with the same
  energy calibration and rebinning as on the Histograms page.
- **The Δt spectrum**, t(partner) − t(channel), for all partners together or one
  by one. Real coincidences make a peak; the flat floor under it is chance. Set
  the window so it covers the peak, and not much more.
- **The matrix**, if switched on.

## 3. Aligning channels in time

Cables, detectors and shaping put each channel's signal at its own delay, so
the Δt peak of a real coincidence is rarely at 0. Once a gate has collected a
peak, **Align in time** shifts each partner's time offset so its peak sits at
0 against the gate's first channel. The gate then starts over with the new
offsets, and a narrow window is enough.

The offsets are listed, and can be edited, under **Timing settings**. They are
per channel and shared by every gate.

## 4. Only channels on one clock

Two hits can only be compared if they were timed by the same clock. That is
the case for the channels of one board, and for the CAEN boards of a
synchronised chain (see the CAEN settings) that also share one clock: every
board but the first takes its clock from CLK-IN (Acquisition Control 0x8100,
bit 6). Boards started together but each on its own oscillator are not on one
clock. Boards that run on their own
clocks — two independent CAEN boards, or a CAEN board and an SIS3316 — drift
apart by microseconds within seconds, so no gate can mix them. The channel
picker greys out the boards that do not share a clock with what is already
picked, and a saved gate that mixes them says so on its card.

## 5. Time between hits

At the bottom of the page, pick any channel to see the time between its
consecutive hits, on a log time axis from 1 ns to 10 s. A random source gives
one smooth bump at 1/rate. Look for:

- a cut on the left of the bump: the dead time;
- a spike at short times: double triggering, or ringing;
- sharp lines: a pulser, or periodic noise.

## 6. How it works, and what it costs

The boards involved in a gate export their hits (16 bytes each; boards not in
any gate export nothing). Every quarter of a second the server collects them,
sorts them in time per clock and evaluates the gates.

A board does not deliver its hits in time order: a channel's events wait in the
board until its buffer is read out, and a quiet channel waits longer. So a hit
is only evaluated once every active board of its clock has delivered data at
least **Wait for slower channels** later (Timing settings, default 2 s of data
time). A hit arriving after its time has already been evaluated is counted as
**late** in the page header and left out of the gates (it is still in the
singles spectra and the file). If late hits appear, raise that latency; it
costs only display delay and a little memory.

Memory stays bounded: the pending hits are shown in the header in MB, and are
capped (about 64 MB per clock) whatever the rate. Hits the online decoder had to
skip because it was behind are shown as **not seen**: the coincidence rates miss
them, the file does not.

The configuration is stored in `conf/coincidences.json` in the working
directory, like the other dashboards, so it is the same for everyone and
survives a restart.
