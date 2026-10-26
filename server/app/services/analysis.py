"""Offline, typed analysis graphs. No acquisition/controller imports.

Event data stays on the server and is streamed in bounded chunks. Intermediate
spectrum nodes are read plans, not copies of entire event trees.
"""
from dataclasses import dataclass, replace
import math
from pathlib import Path
import re
import time

import numpy as np

from . import run_data


class AnalysisError(ValueError):
    pass


def field(label, default, kind='number', options=None):
    return {'label': label, 'default': default, 'type': kind, **({'options': options} if options else {})}


CATALOG = {
    'load_runs': {'label': 'Load Run(s)', 'group': 'Inputs', 'description': 'Converted ROOT events from completed runs in this experiment.',
                  'inputs': {}, 'outputs': {'events': 'events'}, 'params': {
                      'runs': field('Runs (blank: use target/type query)', '', 'text'),
                      'target': field('Target (exact match, optional)', '', 'text'),
                      'run_type': field('Run type (exact match, optional)', '', 'text'),
                      'file': field('ROOT filename (blank: all files)', '', 'text'),
                      'tree': field('Tree (blank: Data / DataR)', '', 'text'),
                      'timestamp': field('Timestamp branch', 'Timestamp', 'text'),
                      'time_scale': field('Timestamp to seconds (ps = 1e-12)', 1e-12),
                      'time_offset': field('Time offset from run start (s)', 0),
                      'flag': field('Run flag', '', 'text', ['', 'good', 'bad', 'unknown']),
                      'exclude': field('Exclude runs', '', 'text'),
                      'date_from': field('Start date from (ISO)', '', 'text'),
                      'date_to': field('Start date through (ISO)', '', 'text'),
                      'voltage_min': field('Minimum terminal voltage (kV)', '', 'text'),
                      'voltage_max': field('Maximum terminal voltage (kV)', '', 'text'),
                      'energy': field('Energy branch', 'Energy', 'text')}},
    'database': {'label': 'Run Database', 'group': 'Inputs', 'description': 'Read metadata from the active experiment database.',
                 'inputs': {}, 'outputs': {'metadata': 'metadata'}, 'params': {}},
    'calibrate': {'label': 'Calibrate Energy', 'group': 'Transform', 'description': 'E = slope × ADC + intercept; applies to every selected run.',
                  'inputs': {'events': 'events'}, 'outputs': {'events': 'events'}, 'params': {
                      'slope': field('Slope (keV/ADC)', 1), 'intercept': field('Intercept (keV)', 0)}},
    'channel': {'label': 'Channel Energy', 'group': 'Selection', 'description': 'Select a board and detector channel before counting.',
                'inputs': {'events': 'events'}, 'outputs': {'events': 'events'}, 'params': {
                    'board': field('Board ID', 0), 'channel': field('Channel', 0)}},
    'roi': {'label': 'ROI Counts', 'group': 'Counting', 'description': 'Count events strictly inside the energy bounds, separately per run.',
            'inputs': {'events': 'events'}, 'outputs': {'counts': 'counts'}, 'params': {
                'min': field('ROI minimum (keV)', 3800), 'max': field('ROI maximum (keV)', 4500)}},
    'yield': {'label': 'Yield', 'group': 'Counting', 'description': 'Normalise counts or extracted peak area by saved charge, propagating the input error.',
              'inputs': {'counts': 'counts', 'metadata': 'metadata'}, 'outputs': {'values': 'series'}, 'params': {}},
    'beam_energy': {'label': 'Beam Energy', 'group': 'Transform', 'description': 'Editable scan formula: scale × (terminal + probe in kV) + offset.',
                    'inputs': {'events': 'events', 'metadata': 'metadata'}, 'outputs': {'values': 'series'}, 'params': {
                        'scale': field('Voltage scale', 0.9933), 'offset': field('Offset (keV)', -0.41)}},
    'histogram': {'label': 'Histogram', 'group': 'Plots', 'description': 'Overlay calibrated spectra for the selected runs.',
                  'inputs': {'events': 'events'}, 'outputs': {'spectrum': 'spectrum'}, 'params': {
                      'bins': field('Bins', 200), 'min': field('Minimum (keV)', 0), 'max': field('Maximum (keV)', 8192),
                      'title': field('Title', 'Calibrated spectrum', 'text')}},
    'plot': {'label': 'Plot Series', 'group': 'Plots', 'description': 'Join X and Y by run number; plot statistical error bars.',
             'inputs': {'x': 'series', 'y': 'series'}, 'outputs': {}, 'params': {
                 'title': field('Title', 'Yield scan', 'text'), 'x_label': field('X label', 'Beam energy (keV)', 'text'),
                 'y_label': field('Y label', 'Yield (counts/µC)', 'text')}},
}


from .analysis_nodes import CATALOG as EXTRA_CATALOG
CATALOG.update(EXTRA_CATALOG)

def parse_runs(value):
    if not isinstance(value, (str, list)):
        raise AnalysisError('Runs must be a list or comma-separated numbers/ranges.')
    tokens = re.split(r'[,\s]+', value.strip()) if isinstance(value, str) else value
    runs = []
    for token in tokens:
        if token == '':
            continue
        if not re.fullmatch(r'\d+(?:-\d+)?', str(token)):
            raise AnalysisError(f'Invalid run selection: {token}')
        ends = str(token).split('-')
        lo, hi = int(ends[0]), int(ends[-1])
        if hi < lo or hi - lo >= 100:
            raise AnalysisError('Run ranges must be ascending and contain at most 100 runs.')
        runs.extend(range(lo, hi + 1))
        if len(runs) > 100:
            raise AnalysisError('Select at most 100 runs per Load Run(s) node.')
    if not runs:
        raise AnalysisError('Select at least one run.')
    return list(dict.fromkeys(runs))


def resolve_runs(params, metadata):
    """Resolve a source against the execution's frozen database snapshot.

    Target/type are case-insensitive exact matches, combined with AND and any
    explicit run list. A query never includes an unfinished acquisition.
    """
    from datetime import datetime, timedelta
    filters = {key: params.get(param, '').strip().casefold()
               for param, key in (('target', 'target_name'), ('run_type', 'run_type'), ('flag', 'flag'))
               if params.get(param, '').strip()}
    def date(key):
        text = params.get(key, '').strip()
        if not text: return None
        try: return datetime.fromisoformat(text.replace('Z', '+00:00')).replace(tzinfo=None)
        except ValueError as exc: raise AnalysisError(f'{key}: use an ISO date/time.') from exc
    lo, hi = date('date_from'), date('date_to')
    if hi and len(params['date_to']) == 10: hi += timedelta(days=1)
    if lo and hi and lo >= hi: raise AnalysisError('Date range must be ascending.')
    def number(key):
        text = params.get(key, '').strip()
        if not text: return None
        try:
            value = float(text)
            if not math.isfinite(value): raise ValueError()
            return value
        except ValueError as exc: raise AnalysisError(f'{key}: enter a finite voltage.') from exc
    vmin, vmax = number('voltage_min'), number('voltage_max')
    if vmin is not None and vmax is not None and vmin > vmax: raise AnalysisError('Voltage range must be ascending.')
    excluded = set(parse_runs(params['exclude'])) if params.get('exclude', '').strip() else set()
    queried = filters or lo or hi or vmin is not None or vmax is not None or excluded
    if not queried: return parse_runs(params.get('runs', ''))
    candidates = parse_runs(params['runs']) if params.get('runs', '').strip() else sorted(metadata)
    runs = []
    for run in candidates:
        row = metadata.get(run, {})
        if run in excluded or not row.get('complete') or not all(str(row.get(k) or '').strip().casefold() == v for k,v in filters.items()): continue
        if lo or hi:
            try: start = datetime.fromisoformat(row['start_time'].replace('Z', '+00:00')).replace(tzinfo=None)
            except (KeyError, TypeError, ValueError): continue
            if (lo and start < lo) or (hi and start >= hi): continue
        voltage = row.get('terminal_voltage')
        if vmin is not None and (voltage is None or voltage < vmin): continue
        if vmax is not None and (voltage is None or voltage > vmax): continue
        runs.append(run)
    if not runs: raise AnalysisError('No completed runs match this query.')
    if len(runs) > 100: raise AnalysisError('Query matches more than 100 runs. Narrow it with a run list or range.')
    return runs


def validate_graph(graph):
    if not isinstance(graph, dict) or graph.get('version') != 1:
        raise AnalysisError('Expected a LUNAdaq analysis workflow, version 1.')
    nodes, edges = graph.get('nodes'), graph.get('edges')
    if not isinstance(nodes, list) or not 1 <= len(nodes) <= 50 or not isinstance(edges, list) or len(edges) > 150:
        raise AnalysisError('A workflow needs 1–50 nodes and at most 150 connections.')
    by_id, incoming = {}, {}
    for node in nodes:
        if not isinstance(node, dict) or not isinstance(node.get('id'), str) or not 1 <= len(node['id']) <= 80:
            raise AnalysisError('Every node needs a valid ID.')
        ident, kind = node['id'], node.get('kind')
        if ident in by_id or not isinstance(kind, str) or kind not in CATALOG:
            raise AnalysisError(f'Duplicate ID or unknown node: {ident}')
        spec = CATALOG[kind]
        params = node.get('params', {})
        if not isinstance(params, dict) or set(params) - set(spec['params']):
            raise AnalysisError(f'{ident}: unknown parameters.')
        params = {key: params.get(key, definition['default']) for key, definition in spec['params'].items()}
        for key, value in params.items():
            if spec['params'][key]['type'] == 'number':
                if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value):
                    raise AnalysisError(f'{ident}: {key} must be a finite number.')
            elif not isinstance(value, str) or len(value) > 1000:
                raise AnalysisError(f'{ident}: {key} must be text (up to 1000 characters).')
        for key, definition in spec['params'].items():
            if definition.get('options') and params[key] not in definition['options']:
                raise AnalysisError(f'{ident}: invalid {key}.')
        if kind in ('histogram', 'roi') and params['min'] >= params['max']:
            raise AnalysisError(f'{ident}: minimum must be less than maximum.')
        if kind == 'histogram' and (params['bins'] != int(params['bins']) or not 1 <= params['bins'] <= 4096):
            raise AnalysisError(f'{ident}: bins must be an integer from 1 to 4096.')
        if kind == 'channel' and any(params[k] != int(params[k]) or params[k] < 0 for k in ('board', 'channel')):
            raise AnalysisError(f'{ident}: board and channel must be non-negative integers.')
        if kind == 'load_runs':
            if params['runs'].strip() or not any(params.get(k, '').strip() for k in ('target', 'run_type', 'flag', 'exclude', 'date_from', 'date_to', 'voltage_min', 'voltage_max')):
                parse_runs(params['runs'])
            if params['time_scale'] <= 0: raise AnalysisError('Timestamp scale must be positive.')
            if params['file'] and (Path(params['file']).name != params['file'] or not params['file'].endswith('.root')):
                raise AnalysisError(f'{ident}: choose a ROOT filename inside the run directory.')
        by_id[ident] = {**node, 'params': params}
        incoming[ident] = {}
    for edge in edges:
        if not isinstance(edge, dict):
            raise AnalysisError('Invalid connection.')
        source, target, output, port = (edge.get(k) for k in ('source', 'target', 'sourceHandle', 'targetHandle'))
        if not all(isinstance(v, str) for v in (source, target, output, port)) or source not in by_id or target not in by_id:
            raise AnalysisError('Connection refers to a missing node or port.')
        out_type = CATALOG[by_id[source]['kind']]['outputs'].get(output)
        in_type = CATALOG[by_id[target]['kind']]['inputs'].get(port)
        if not out_type or out_type != in_type or port in incoming[target]:
            raise AnalysisError(f'{target}: incompatible or duplicate connection to {port}.')
        incoming[target][port] = (source, output)
    order, visiting, visited = [], set(), set()
    def visit(ident):
        if ident in visiting:
            raise AnalysisError('Workflow contains a cycle.')
        if ident in visited:
            return
        if set(incoming[ident]) != set(CATALOG[by_id[ident]['kind']]['inputs']):
            raise AnalysisError(f'{ident}: connect all input ports before running.')
        visiting.add(ident)
        for source, _ in incoming[ident].values():
            visit(source)
        visiting.remove(ident)
        visited.add(ident)
        order.append(ident)
    for ident in by_id:
        visit(ident)
    return by_id, incoming, order


def root_module():
    try:
        import uproot
        return uproot
    except ImportError as exc:
        raise AnalysisError('ROOT analysis requires uproot. Update the luna environment from environment.yml.') from exc


def root_paths(run, filename=''):
    base = Path(run_data.run_dir(run)).resolve()
    if base.parent != Path(run_data.DATA_DIR).resolve():
        raise AnalysisError('Run directories must be inside the experiment data directory (no external symlinks).')
    names = [f['name'] for f in run_data.list_files(run)['root']]
    if filename:
        names = [name for name in names if name == filename]
    if not names:
        raise AnalysisError(f'Run {run}: no matching ROOT file. Convert this run first.')
    paths = [base / name for name in names]
    if any(path.resolve().parent != base for path in paths):
        raise AnalysisError('ROOT files must be inside their run directory (no external symlinks).')
    return paths


def inspect_run(run):
    out = []
    for path in root_paths(run):
        with root_module().open(path) as root:
            trees = []
            for name, obj in root.items(cycle=False):
                if hasattr(obj, 'iterate') and hasattr(obj, 'num_entries'):
                    trees.append({'name': name, 'entries': int(obj.num_entries), 'branches': list(obj.keys())})
            out.append({'name': path.name, 'trees': trees})
    return out


@dataclass(frozen=True)
class Events:
    runs: tuple
    files: tuple  # (run number, tuple of paths)
    tree: str
    energy: str
    slope: float = 1
    intercept: float = 0
    board: int | None = None
    channel: int | None = None
    timestamp: str = 'Timestamp'
    time_scale: float = 1e-12
    time_offset: float = 0


def chunks(events, deadline, with_time=False):
    uproot = root_module()
    for run, paths in events.files:
        for path in paths:
            with uproot.open(path) as root:
                tree_name = events.tree or next((name for name in ('Data', 'DataR') if name in root), None)
                if not tree_name or tree_name not in root:
                    raise AnalysisError(f'Run {run}, {path.name}: select an existing event tree.')
                tree = root[tree_name]
                branches = [events.energy, 'Channel']
                if not all(name in tree.keys() for name in branches):
                    raise AnalysisError(f'Run {run}, {path.name}: missing {events.energy} or Channel. Inspect the ROOT schema; PSD normally uses EnergyLong.')
                if with_time:
                    if events.timestamp not in tree.keys(): raise AnalysisError(f'Run {run}: missing timestamp branch {events.timestamp}.')
                    branches.append(events.timestamp)
                has_board = 'Board' in tree.keys()
                if has_board:
                    branches.append('Board')
                elif events.board not in (None, 0):
                    raise AnalysisError(f'Run {run}: legacy tree has no Board branch; only board 0 is supported.')
                for arrays in tree.iterate(branches, step_size=100_000, library='np'):
                    if time.monotonic() > deadline:
                        raise AnalysisError('Analysis exceeded 5 minutes. Select fewer runs or split the workflow.')
                    energy = np.asarray(arrays[events.energy], dtype=np.float64)
                    mask = np.ones(len(energy), dtype=bool)
                    if events.channel is not None:
                        mask &= arrays['Channel'] == events.channel
                    if events.board is not None and has_board:
                        mask &= arrays['Board'] == events.board
                    energy = energy[mask] * events.slope + events.intercept
                    if not np.all(np.isfinite(energy)):
                        raise AnalysisError(f'Run {run}: non-finite energy values or calibration overflow.')
                    if energy.ndim != 1: raise AnalysisError('Select a scalar energy branch.')
                    if with_time:
                        times = np.asarray(arrays[events.timestamp], dtype=float)[mask] * events.time_scale + events.time_offset
                        if times.ndim != 1 or not np.isfinite(times).all() or np.any(times < 0): raise AnalysisError('Timestamps must be finite non-negative seconds relative to run start.')
                        yield run, energy, times
                    else:
                        yield run, energy


def execute(graph, metadata, progress=lambda _: None):
    """Execute against a frozen metadata snapshot; never modify run records."""
    nodes, incoming, order = validate_graph(graph)
    deadline = time.monotonic() + 300
    outputs, summaries, plots, provenance = {}, {}, [], {}
    result_bins = 0
    for ident in order:
        node = nodes[ident]
        kind, p = node['kind'], node['params']
        progress(ident)
        args = {key: outputs[src][port] for key, (src, port) in incoming[ident].items()}
        try:
            result = {}
            if kind == 'load_runs':
                runs = resolve_runs(p, metadata)
                files = []
                for run in runs:
                    if run not in metadata or not metadata[run]['complete']:
                        raise AnalysisError(f'Run {run} is missing or not completed.')
                    state = run_data.get_conversion_manager().status(run)['state']
                    if state in ('running', 'failed'):
                        raise AnalysisError(f'Run {run}: conversion is {state}; finish a successful conversion first.')
                    paths = tuple(root_paths(run, p['file']))
                    files.append((run, paths))
                    source = provenance.setdefault(str(run), {'metadata': metadata[run], 'files': []})
                    for path in paths:
                        stat = path.stat()
                        entry = {'name': path.name, 'bytes': stat.st_size, 'mtime_ns': stat.st_mtime_ns}
                        previous = next((f for f in source['files'] if f['name'] == path.name), None)
                        if previous and previous != entry:
                            raise AnalysisError(f'Run {run}: ROOT input changed during analysis.')
                        if previous is None:
                            source['files'].append(entry)
                result = {'events': Events(tuple(runs), tuple(files), p['tree'], p['energy'], timestamp=p['timestamp'], time_scale=p['time_scale'], time_offset=p['time_offset'])}
            elif kind == 'database':
                result = {'metadata': metadata}
            elif kind == 'calibrate':
                data = args['events']
                result = {'events': replace(data, slope=data.slope * p['slope'], intercept=data.intercept * p['slope'] + p['intercept'])}
            elif kind == 'channel':
                result = {'events': replace(args['events'], board=int(p['board']), channel=int(p['channel']))}
            elif kind in ('roi', 'histogram'):
                data = args['events']
                if data.channel is None:
                    raise AnalysisError('Connect a Channel Energy node to select the detector first.')
                if kind == 'histogram':
                    result_bins += len(data.runs) * int(p['bins'])
                    if result_bins > 1_000_000:
                        raise AnalysisError('Workflow exceeds one million output bins. Reduce runs, histograms or bins.')
                values = {run: 0 if kind == 'roi' else np.zeros(int(p['bins']), dtype=np.int64) for run in data.runs}
                for run, energy in chunks(data, deadline):
                    if kind == 'roi':
                        values[run] += int(np.count_nonzero((energy > p['min']) & (energy < p['max'])))
                    else:
                        values[run] += np.histogram(energy, bins=int(p['bins']), range=(p['min'], p['max']))[0]
                if kind == 'roi':
                    result = {'counts': values}
                else:
                    edges = np.linspace(p['min'], p['max'], int(p['bins']) + 1).tolist()
                    plots.append({'node': ident, 'kind': 'histogram', 'title': p['title'], 'edges': edges,
                                  'series': [{'run': run, 'counts': counts.tolist()} for run, counts in values.items()]})
                    result = {'spectrum': {'edges': edges, 'series': [{'run': run, 'counts': counts.tolist(), 'variance': counts.tolist()} for run, counts in values.items()]}, 'entries_in_range': {run: int(counts.sum()) for run, counts in values.items()}}
            elif kind == 'yield':
                values = {}
                for run, counts in args['counts'].items():
                    charge = args['metadata'][run]['charge_uC']
                    if charge is None or not math.isfinite(charge) or charge <= 0:
                        raise AnalysisError(f'Run {run}: saved charge must be positive to calculate yield.')
                    value = counts['value'] if isinstance(counts, dict) else counts
                    error = counts['error'] if isinstance(counts, dict) else math.sqrt(counts)
                    values[run] = {'value': value / charge, 'error': error / charge, 'counts': value, 'charge_uC': charge}
                result = {'values': values}
            elif kind == 'beam_energy':
                values = {}
                for run in args['events'].runs:
                    row = args['metadata'][run]
                    if row['terminal_voltage'] is None or row['probe_voltage'] is None:
                        raise AnalysisError(f'Run {run}: terminal and probe voltages are required for beam energy.')
                    value = p['scale'] * (row['terminal_voltage'] + row['probe_voltage']) + p['offset']
                    if not math.isfinite(value):
                        raise AnalysisError(f'Run {run}: beam energy must be finite.')
                    values[run] = {'value': value}
                result = {'values': values}
            elif kind == 'plot':
                if set(args['x']) != set(args['y']):
                    raise AnalysisError('X and Y must contain exactly the same runs.')
                points = [{'run': run, 'x': args['x'][run]['value'], 'y': y['value'], 'error': y.get('error', 0)} for run, y in args['y'].items()]
                plots.append({'node': ident, 'kind': 'series', 'title': p['title'], 'x_label': p['x_label'], 'y_label': p['y_label'],
                              'points': sorted(points, key=lambda row: row['x'])})
                result = {'points': points}
            else:
                from .analysis_nodes import run_node
                result, extra_plots = run_node(kind, p, args, ident, metadata, deadline, provenance)
                result_bins += sum(sum(len(row['counts']) for row in plot['series']) if plot['kind'] == 'histogram' else len(plot['points']) for plot in extra_plots)
                if result_bins > 1_000_000: raise AnalysisError('Workflow exceeds one million output bins/points.')
                plots.extend(extra_plots)
            if time.monotonic() > deadline: raise AnalysisError('Analysis exceeded 5 minutes.')
            outputs[ident] = result
            if 'events' in result:
                ev = result['events']
                summaries[ident] = {'runs': list(ev.runs), 'energy_branch': ev.energy, 'slope': ev.slope, 'intercept': ev.intercept, 'board': ev.board, 'channel': ev.channel}
            elif 'current' in result:
                summaries[ident] = {'runs': {run: {'samples': len(row['time']), 'column': p['column']} for run,row in result['current'].items()}}
            elif kind == 'database':
                summaries[ident] = {'source': 'Active experiment database (read only)'}
            else:
                summaries[ident] = result
        except (AnalysisError, OSError, KeyError, ValueError, TypeError, RuntimeError, ImportError) as exc:
            raise AnalysisError(f'{ident} ({CATALOG[kind]["label"]}): {exc}') from exc
    for run, source in provenance.items():
        for file in source['files']:
            path = Path(run_data.run_dir(int(run))) / file['name']
            stat = path.stat()
            if stat.st_size != file['bytes'] or stat.st_mtime_ns != file['mtime_ns']:
                raise AnalysisError(f'Run {run}: ROOT input changed during analysis; run again when conversion finishes.')
    return {'nodes': summaries, 'plots': plots, 'provenance': provenance, 'workflow': graph,
            'notes': ['ROI bounds are exclusive; histogram bins follow NumPy conventions.',
                      'Errors propagate counting and fit variance; efficiency may add a shared systematic. Charge/calibration uncertainties are not propagated. Shared backgrounds correlate different runs.',
                      'Charge comes from the saved run database in µC; beam energy uses the workflow formula.']}
