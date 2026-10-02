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
There is no separate list-only node family.

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

Yield uncertainty is **counting statistics only**. There is no background
subtraction, dead-time, efficiency, pile-up, saturation, or charge/calibration
uncertainty correction in this first node set. ROOT events are counted as stored.
Charge is taken from LUNAdaq's saved per-run charge, which follows the selected
charge channel during acquisition; the old prototype's hard-coded timestamp
conversion/current-column assumptions are not used.

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

`environment.yml` includes `uproot>=5,<6`; rerun the installer or update the
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
