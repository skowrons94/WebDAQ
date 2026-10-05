# Offline Analysis

The **Analysis** page builds graph workflows against the active experiment's
run database and converted ROOT event trees. It does not issue acquisition
commands. Start with the supplied spectrum/yield graph, or add nodes from the
library. Click a node to edit its parameters in the inspector. Drag between
compatible ports to connect nodes; select a node or edge and press Delete to
remove it. Zoom, pan, fit view, and the minimap work in the graph canvas.

## Prepare runs

1. Open **Runs**, filter by run number, target or type, and select completed runs.
2. Use **Batch convert to ROOT** for runs with `.caendat` data. It uses the same
   RUReader conversion manager as the logbook and processes runs serially.
   Existing ROOT output is preserved. Per-run status and the conversion log
   remain visible in the batch panel. For advanced converter options or retrying
   failed conversions, open the run's logbook conversion tab.
3. **Inspect ROOT** shows filenames, tree names, event counts and branch names.
4. **Use selected runs** fills the selected Load Run(s) node, or the first one
   if another kind of node is selected. Run lists also accept `10,12-15`.

The Runs panel has exact, case-insensitive **Target** and **Run type** filters,
combined with AND. **Use query in Load Run(s)** stores those criteria in the node,
so each execution queries the current database snapshot for completed runs.
The inspector also allows combining the filters with an explicit run list/range
(intersection). A query with no matches or more than 100 matches reports an error;
it never silently truncates. **Use selected runs** instead saves a fixed list and
clears the node's query. ROOT conversion is still required for all matching runs.
The text search only filters the displayed list, not the saved target/type query.

ROOT files are read from `data/run<N>/` in the current experiment. A blank ROOT
filename loads **every `.root` file in that run directory**: useful for split
output, but do not put alternative conversions or duplicate files there. Enter
a filename to read only that file. The default tree is `Data`, falling back to
legacy `DataR`. Set an explicit tree name if needed. Choose `Energy` for PHA or
`EnergyLong` (or `EnergyShort`) for PSD. Energy branches must contain scalar
values, not waveform arrays. A legacy tree without `Board` is treated as board
0. ROOT histograms alone are not event-tree inputs in this first version.

## Nodes and scientific conventions

Every node supports one run or a list of runs; results retain run-number keys.
There is no separate list-only node family. Drag library items onto the canvas to add them.

| Node | Operation |
| --- | --- |
| Load Run(s) | Select completed runs and ROOT event trees. |
| Run Database | Read the active experiment's metadata; no external DB path. |
| Calibrate Energy | `E_keV = slope × ADC + intercept`. Defaults are identity; enter your measured calibration. |
| Channel Energy | Select **both** board ID and detector channel. Required before ROI/histogram nodes. |
| ROI Counts | Count events strictly inside `minimum < E < maximum`, matching the reference node editor. |
| Yield | `Y = N / Q`, `σY = sqrt(N) / Q`, using the saved database charge in µC. Missing/nonpositive charge is an error. |
| Beam Energy | `scale × (terminal_voltage + probe_voltage) + offset`, in keV with voltages in kV. Defaults `0.9933` and `−0.41` reproduce the reference app; verify them for your accelerator. Missing voltages are an error. |
| Histogram | One spectrum per run, on shared, explicit bins and energy range. NumPy bin convention: left-inclusive/right-exclusive, final upper edge inclusive. |
| Plot Series | Match X and Y by run number, sort by X, and show Y error bars. Different run sets are rejected. |

Raw ROI uncertainty is Poisson counting statistics. Extracted areas carry their
subtraction or fit variance into Yield. Charge uncertainty, dead time, pile-up,
and calibration-coefficient uncertainty are not propagated. Efficiencies can
include an explicit relative systematic uncertainty.

## Spectrum analysis

Histogram provides a **spectrum** output containing bin edges, counts and
variances, while still drawing a chart. Connect it to:

- **Rebin**: merge adjacent bins; the integer factor must divide the bin count.
  Counts and variances are summed.
- **Background subtraction**: identical bins and independent runs are required.
  Background runs are summed. Scale by signal elapsed measurement time / summed
  background time, signal charge / summed background charge, or a manual factor.
  Net counts are `S − aB`; variance is `Var(S) + a² Var(B)`. Negative net bins are
  retained. Time is wall-clock run duration, not live time. Exposure errors are
  not included. A shared background correlates different signal runs.
- **Peak area**: integrate bins whose centres are strictly inside the bounds.
- **Sideband subtraction**: subtract a flat continuum from two non-overlapping
  flanking sidebands, weighted by actual included bin widths. Propagates sideband
  counting variance; assumes locally flat background.
- **Peak fit**: bin-integrated Gaussian plus linear background, using weighted
  least squares and `sqrt(max(variance, 1))` bin errors. Output is the **total
  Gaussian area**, not just its part inside the fit window. Summary diagnostics
  include centroid, sigma, covariance, residuals and reduced chi-square. Inspect
  them, especially for sparse spectra: this is not a Poisson-likelihood fit.
- **Calibration fit**: a straight line through supplied `[ADC, energy_keV]`
  reference points, with residual plots. Covariance uses residual scatter for
  more than two points; two-point covariance is unavailable. Reference-point
  errors are not modelled. Connect to **Apply fitted calibration** with events.
- **Efficiency correction**: divide by a piecewise-linear absolute efficiency
  curve at the specified peak energy. Rejects extrapolation and nonpositive
  efficiencies. Relative efficiency uncertainty adds a shared systematic,
  separately recorded in output.
- **Ratio / arithmetic**: add, subtract, multiply or divide matching run-keyed
  series. Errors use an explicit correlation coefficient (default independent).
  Division by zero is rejected. A full cross-run covariance matrix is not
  propagated for shared backgrounds or efficiency curves.

Peak area, Sideband subtraction and Peak fit provide **counts** for Yield and
**values** for arithmetic/efficiency. Existing unbinned ROI workflows still work.

In a spectrum chart, select the destination ROI/fit node, then **drag across the
chart** or edit its two bounds. This updates the node and marks results stale;
**Run pipeline** recalculates. Choose a spectrum in the same calibrated energy
coordinates as the destination. Sideband bounds remain inspector parameters.

## Time analysis and ROOT trees

**Inspect ROOT → Use tree** sets filename, tree and run on the selected source
(or the first source). Energy/timestamp branches remain editable. RUReader's
default Timestamp unit is ps (`1e-12` seconds per tick). Set the scale to match
your conversion and an explicit offset to align timestamps to run start; clock
origins are not inferred.

**Counting rate over time** bins detector-selected ROI events and divides by
actual bin duration, including the final short bin. Zero stop uses run duration.
**Load current** reads the same runs' current.txt with an explicit recorded column
such as `Ch0(uA)` or `Current(uA)`; no physical channel is assumed. **Yield over
time** divides each bin's counts by trapezoidally integrated current over the
same interval, using full-resolution samples and interpolated endpoints. Missing
coverage, non-monotonic times, and nonpositive charge are errors. Interpolation
assumes linear current between samples: inspect gaps. Current uncertainty is not
included. Plot nodes retain run IDs. This analyses recorded runs, not live DAQ.

Richer run queries support ranges, exclusions, flags, start-date bounds and
terminal-voltage ranges, combined with AND. Date-only upper bounds include the
whole date; timestamp upper bounds are exclusive. Preview matches before applying.

## Example workflows

**Workflows → Examples** contains eight experiment-independent draft templates.
A fresh experiment with no saved workflow starts with **Spectrum & ROI counts**.

| Template | Required inputs beyond converted detector events |
| --- | --- |
| Spectrum & ROI counts | Measured calibration and chosen energy/ROI ranges; no charge or beam metadata. |
| Time-normalised background | Independent background runs, matching spectrum bins, valid start/end times. Uses elapsed time, not live time. |
| Background → peak yield | Independent background, positive signal/background charge, signal terminal/probe voltages, fit settings. |
| Sideband yield scan | Positive charge, terminal/probe voltages, two sidebands around a locally flat continuum. |
| Fit energy calibration | At least two measured ADC-centroid / known-energy pairs from the same detector settings. |
| Counting rate over time | Event timestamps with known unit/origin and valid run start/end times; no current log needed. |
| Rate, current & yield over time | Rate inputs plus a recorded current column in µA, overlapping time coverage and positive time-bin charge. |
| Efficiency & peak ratios | Two disjoint peak windows, peak energies and measured absolute-efficiency curves; no charge or beam metadata. Gross areas and their ratio appear in Summary. |

All run selections and queries start blank, so no template assumes demo run IDs
or automatically analyses existing data. Loading and saving a draft works on an
empty installation; executing it requires choosing actual completed runs first.
For workflows with two sources, select the intended Load Run(s) node before
applying a run selection/query. No acquisition or sample data is created by
loading a template.

Expand **Setup requirements** on each template for its prerequisites. These
instructions are also copied into its description when saving a new workflow.
The identity energy calibration, board/channel 0, 0–2000 keV spectrum and
400–600 keV ROI are explicit starting settings, not measured values. Adjust
both paths of a background workflow consistently. Calibration reference points,
efficiency curves and the current-log column are deliberately blank. The default
Timestamp scale is ps; verify your ROOT conversion and time origin. Time stop 0
uses each run's duration; narrow it to current-log coverage for time yields.
Beam Energy uses neutral scale 1 and offset 0 in templates; configure your
accelerator's voltage calibration and ion charge state. Existing saved workflows
and their settings are not migrated or overwritten.

The peak-ratio template assumes independent errors by default. Common efficiency
systematics can correlate the two corrected areas; set an appropriate correlation
or use a fuller covariance treatment before interpreting ratio uncertainties.

## Workflows and results

Drag the grip between the library and graph to resize the left panel. Its width
is remembered in this browser. A second grip resizes Results: width on wide
screens, height when the panel is below the graph. Both sizes are remembered.
The focused grips also support arrow keys and Home/End.

**Workflows**, beside Node library and Runs, lists saved workflows with names
and descriptions. **Save workflow** creates a named entry or updates the current
one; **Save a copy** creates a variant. Loading another workflow asks before
replacing unsaved edits. The library is stored atomically in
`conf/analysis-workflows.json` (up to 50 workflows). The original
`conf/analysis-workflow.json` is retained and appears as **Previous workflow**.
Drafts may have disconnected nodes. Saving is shared by browsers using that
experiment (last save wins). Export workflow JSON for portable backups. **Import** accepts
LUNAdaq version 1 JSON; prototype NucleoFlow JSON is not directly compatible.
The source reference application is unchanged.

**Run pipeline** validates ports, required inputs, graph cycles, ranges and
parameters before starting a background job. The page remains responsive. It
resumes polling an active job after a reload in the same browser tab. Completed
results are held in memory (latest ten jobs), so export them before restarting
the server. Draft/result changes are indicated separately.

Charts have CSV export; **Export results** includes numeric results, workflow,
source filenames/sizes/modification times, and the run metadata snapshot used.
No raw event arrays are sent to the browser. If a source file changes during
analysis, the result is rejected. The metadata database is never modified.

Workflows are limited to 50 nodes, 150 edges, 100 runs per source node, 4096
histogram bins per spectrum (one million output bins total), and five minutes of event processing. ROOT input is streamed in
100,000-event chunks. Only one analysis job or batch conversion runs at once;
individual logbook conversions remain independent. Jobs/queues are not durable
across backend restarts. A failed batch preserves per-run failure information;
it does not pretend partially converted output is ready for analysis.

## Install and test

`environment.yml` includes `uproot>=5,<6` and `scipy>=1.11`; rerun the installer or update the
`luna` environment after pulling this feature. Frontend dependencies include
`@xyflow/react`. The offline reader does not require a working PyROOT import,
but RUReader still needs its compiled ROOT libraries for conversion.

```bash
cd server
TEST_FLAG=True ./tests/run_tests.sh analysis
```

The tests use temporary data directories, an in-memory metadata DB, and small
ROOT files written with uproot. They cover detector selection, calibration,
exclusive ROI boundaries, histogram counts, yields/errors, run alignment,
invalid graphs, input confinement, authentication and batch conversion orchestration.

Numerical references: [SciPy curve_fit](https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.curve_fit.html)
and [NumPy polyfit](https://numpy.org/doc/stable/reference/generated/numpy.polyfit.html).

## Editor rendering and layout

On wide screens the editor fills the space between the header and footer;
results scroll inside their own panel. At narrower widths the panels stack,
with a separately resizable results height. More results never increase that
panel's height. Library nodes show short descriptions and styled help opens
on hover after 150 ms or on keyboard focus.

Charts mount only near the visible results area and release their chart DOM
when scrolled away. Unchanged results and nodes are memoized so moving nodes
does not redraw plots or mark scientific results stale. Current traces render
as lines without per-sample markers; nonzero time-bin uncertainties still have
error bars. Numeric exports retain every sample. Summary sections render on
expansion; raw previews cap arrays at 200 entries and text at 100,000 characters,
with a truncation notice and a full-data export.
