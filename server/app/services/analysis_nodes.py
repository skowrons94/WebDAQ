"""Numerical spectrum and time nodes; all data stays experiment-local."""
from dataclasses import replace
from datetime import datetime
from pathlib import Path
import math
import json
import time
import warnings
import numpy as np
from .analysis import AnalysisError, field


def spec(label, inputs, outputs, params, description, group='Analysis'):
    return dict(label=label, inputs=inputs, outputs=outputs, params=params, description=description, group=group)


RANGE = {'min': field('Minimum', 3800), 'max': field('Maximum', 4500)}
CATALOG = {
    'rebin': spec('Rebin', {'spectrum': 'spectrum'}, {'spectrum': 'spectrum'}, {'factor': field('Merge bins', 2)}, 'Merge adjacent bins, preserving counts and variances.'),
    'background': spec('Background subtraction', {'signal': 'spectrum', 'background': 'spectrum', 'metadata': 'metadata'}, {'spectrum': 'spectrum'}, {'normalisation': field('Normalisation', 'time', 'text', ['time', 'charge', 'manual']), 'scale': field('Manual scale', 1)}, 'Subtract an independent background, scaled by measurement time (wall-clock run duration, not live time) or by charge. Matching bins required.'),
    'spectrum_roi': spec('Peak area', {'spectrum': 'spectrum'}, {'counts': 'counts', 'values': 'series'}, RANGE, 'Integrate bins whose centres lie within the selected interval; retains propagated variance.'),
    'sideband': spec('Sideband subtraction', {'spectrum': 'spectrum'}, {'counts': 'counts', 'values': 'series'}, {**RANGE, 'left_min': field('Left sideband minimum', 3400), 'left_max': field('Left sideband maximum', 3700), 'right_min': field('Right sideband minimum', 4600), 'right_max': field('Right sideband maximum', 4900)}, 'Estimate a flat background from two non-overlapping sidebands. Includes sideband counting uncertainty.'),
    'peak_fit': spec('Peak fit', {'spectrum': 'spectrum'}, {'counts': 'counts', 'values': 'series'}, {**RANGE, 'centroid': field('Initial centroid', 4150), 'sigma': field('Initial sigma', 60)}, 'Bin-integrated Gaussian plus linear background. Poisson likelihood (Cash statistic) when any bin in the window holds fewer than 20 counts, weighted least squares otherwise; inspect the residuals.'),
    'calibration_fit': spec('Calibration fit', {}, {'calibration': 'calibration'}, {'points': field('Reference points: [[ADC, keV], …]', '[[1000, 1000], [2000, 2000], [4000, 4000]]', 'text')}, 'Linear fit to reference centroids and energies; reports residuals and coefficient covariance.', 'Calibration'),
    'apply_calibration': spec('Apply fitted calibration', {'events': 'events', 'calibration': 'calibration'}, {'events': 'events'}, {}, 'Apply the slope and intercept from Calibration fit.', 'Calibration'),
    'efficiency': spec('Efficiency correction', {'values': 'series'}, {'values': 'series'}, {'energy': field('Peak energy (keV)', 4150), 'curve': field('Efficiency points: [[keV, efficiency], …]', '[[1000, 0.1], [5000, 0.03]]', 'text'), 'relative_error': field('Relative efficiency uncertainty (0–1)', 0)}, 'Divide by linearly interpolated absolute efficiency. No extrapolation. Efficiency error is a shared systematic.'),
    'arithmetic': spec('Ratio / arithmetic', {'a': 'series', 'b': 'series'}, {'values': 'series'}, {'operation': field('Operation', 'divide', 'text', ['add', 'subtract', 'multiply', 'divide']), 'correlation': field('Error correlation (−1 to 1)', 0)}, 'Combine values with matching run IDs; propagate errors using an explicit correlation.'),
    'load_current': spec('Load current', {'events': 'events'}, {'current': 'current'}, {'column': field('Current column (e.g. Ch0(uA))', '', 'text')}, 'Read current.txt for the selected runs, in seconds from the run start (the time base of the events). Choose the actual recorded current column; units are µA.', 'Inputs'),
    'rate_time': spec('Counting rate over time', {'events': 'events', 'metadata': 'metadata'}, {'time_series': 'time_series'}, {**RANGE, 'width': field('Time bin (s)', 10), 'start': field('Start (s)', 0), 'stop': field('Stop (s; 0 = run duration)', 0)}, 'Count ROI events per time bin and divide by its duration. Requires timestamps relative to run start.'),
    'yield_time': spec('Yield over time', {'time_series': 'time_series', 'current': 'current'}, {'time_series': 'time_series'}, {}, 'Divide time-bin counts by the charge in the same interval: the current log aligned with event time through the run start, integrated with the 10 s gap rule used everywhere in WebDAQ. Bins without charge are left out.'),
    'plot_time': spec('Plot time series', {'time_series': 'time_series'}, {}, {'title': field('Title', 'Rate over time', 'text')}, 'Plot one trace per run against elapsed time.', 'Plots'),
    'plot_current': spec('Plot current', {'current': 'current'}, {}, {'title': field('Title', 'Current over time', 'text')}, 'Plot recorded current versus elapsed seconds.', 'Plots'),
}


def duration(row):
    try:
        value = (datetime.fromisoformat(row['end_time']) - datetime.fromisoformat(row['start_time'])).total_seconds()
    except (KeyError, TypeError, ValueError) as exc:
        raise AnalysisError('Valid run start/end times are required.') from exc
    if value <= 0:
        raise AnalysisError('Measurement duration must be positive.')
    return value


def pairs(text):
    try:
        data = np.asarray(json.loads(text), dtype=float)
        if data.ndim != 2 or data.shape[1] != 2 or not 2 <= len(data) <= 100 or not np.isfinite(data).all():
            raise ValueError()
    except (ValueError, TypeError) as exc:
        raise AnalysisError('Enter 2–100 finite [x, y] pairs as JSON.') from exc
    data = data[np.argsort(data[:, 0])]
    if np.any(np.diff(data[:, 0]) <= 0):
        raise AnalysisError('Reference x values must be distinct.')
    return data


def spectrum_plot(ident, spectrum, title):
    return dict(node=ident, kind='histogram', title=title, edges=spectrum['edges'], series=spectrum['series'])


def area(value, variance, **extra):
    if not math.isfinite(value) or not math.isfinite(variance) or variance < 0:
        raise AnalysisError('Non-finite result or invalid variance.')
    return dict(value=float(value), error=math.sqrt(variance), **extra)


def window(edges, low, high):
    if low >= high or low < edges[0] or high > edges[-1]:
        raise AnalysisError('Window must lie within the spectrum and have positive width.')
    centres = (edges[:-1] + edges[1:]) / 2
    mask = (centres > low) & (centres < high)
    if not mask.any():
        raise AnalysisError('Window contains no bins; use finer binning.')
    return mask


# Below this many counts in any bin of the window, the peak fit maximises the
# Poisson likelihood instead of minimising chi-square.
POISSON_BELOW = 20


def poisson_fit(model, counts, start, lower, upper, run):
    """Maximum-likelihood fit of Poisson counts (Cash 1979, ApJ 228, 939).

    Minimises C = 2 Σ (μ − n + n ln(n/μ)), from the least-squares solution.
    The covariance is the inverse of the Fisher information Jᵀ diag(1/μ) J at
    the minimum, which stays finite when the area sits at its bound of zero:
    an absent peak gets an error, not an exact zero. Returns (coefficients,
    covariance, C)."""
    from scipy.optimize import minimize
    start = np.clip(np.asarray(start, dtype=float), lower, upper)
    scale = np.maximum(np.abs(start), 1.0); scale[1] = scale[2] = max(start[2], 1e-9)

    def unpack(z):
        return start + z * scale

    def cash(z):
        mu = np.maximum(model(*unpack(z)), 1e-12)
        return 2 * float(np.sum(mu - counts * np.log(mu)))

    bounds = [((lo - s0) / sc if np.isfinite(lo) else None, (hi - s0) / sc if np.isfinite(hi) else None)
              for lo, hi, s0, sc in zip(lower, upper, start, scale)]
    best = minimize(cash, np.zeros(len(start)), method='L-BFGS-B', bounds=bounds)
    if not np.isfinite(best.fun):
        raise AnalysisError(f'Run {run}: Poisson peak fit failed: {best.message}')
    coeff = unpack(best.x)
    mu = np.maximum(model(*coeff), 1e-12)
    jacobian = np.empty((len(mu), len(coeff)))
    for i in range(len(coeff)):
        step = 1e-6 * max(abs(coeff[i]), scale[i])
        up, down = coeff.copy(), coeff.copy(); up[i] += step; down[i] -= step
        jacobian[:, i] = (model(*up) - model(*down)) / (2 * step)
    information = jacobian.T @ (jacobian / mu[:, None])
    # With no peak (area at its bound of zero) the centroid and width no longer
    # change the model, and the full matrix is singular: the area's error is
    # then that of the area with the centroid and width held where they are.
    free = list(range(len(coeff)))
    if np.linalg.cond(information) > 1e12:
        free = [0, 3, 4]
    covariance = np.zeros((len(coeff), len(coeff)))
    try:
        covariance[np.ix_(free, free)] = np.linalg.inv(information[np.ix_(free, free)])
    except np.linalg.LinAlgError as exc:
        raise AnalysisError('Peak fit is unconstrained; adjust the window or binning.') from exc
    statistic = 2 * float(np.sum(mu - counts + np.where(counts > 0, counts * np.log(np.maximum(counts, 1e-300) / mu), 0)))
    return coeff, covariance, statistic


def charge_per_bin(t, v, edges, lo, hi):
    """Charge (µC) and time with readings (s) in each [edges[i], edges[i+1]].

    The rule of run_data.integrate_current, which the live accumulators and
    RUReader also follow, cut at the bin edges instead of only at the run's
    start and stop: readings joined by straight lines; a step longer than
    MAX_GAP_S carries no charge (the monitor was silent); before the first
    reading the first one is held back to ``lo``, after the last the last one
    up to ``hi``, each only when that is at most MAX_GAP_S. Nothing counts
    outside [lo, hi]. The bins of a run therefore add up to the run's charge."""
    from .run_data import MAX_GAP_S
    t = np.asarray(t, dtype=float); v = np.asarray(v, dtype=float); edges = np.asarray(edges, dtype=float)
    dt = np.diff(t)
    keep = (dt > 0) & (dt <= MAX_GAP_S)
    start, end, level = t[:-1][keep], t[1:][keep], v[:-1][keep]
    slope = (np.diff(v)[keep] / dt[keep]) if keep.any() else np.zeros(0)
    pieces = [(start, end, level, slope)]
    if lo < t[0] and min(t[0], hi) - lo <= MAX_GAP_S:
        pieces.insert(0, (np.array([lo]), np.array([min(t[0], hi)]), v[:1], np.zeros(1)))
    if hi > t[-1] and hi - max(t[-1], lo) <= MAX_GAP_S:
        pieces.append((np.array([max(t[-1], lo)]), np.array([hi]), v[-1:], np.zeros(1)))
    a, b, level, slope = (np.concatenate(parts) for parts in zip(*pieces))
    origin = a.copy()
    a, b = np.maximum(a, lo), np.minimum(b, hi)
    inside = a < b
    a, b, level, slope, origin = a[inside], b[inside], level[inside], slope[inside], origin[inside]

    def cumulative(rate, gradient):
        # Integral of rate + gradient·(u − origin) from lo up to each edge:
        # the pieces wholly before it, plus the part of the one it falls in.
        if not len(a):
            return np.zeros(len(edges))
        whole = np.concatenate(([0.0], np.cumsum(rate * (b - a) + gradient / 2 * ((b - origin) ** 2 - (a - origin) ** 2))))
        done = np.searchsorted(b, edges, side='right')
        out = whole[done]
        cut = np.flatnonzero((done < len(a)) & (edges > a[np.minimum(done, len(a) - 1)]))
        i, x = done[cut], edges[cut]
        out[cut] += rate[i] * (x - a[i]) + gradient[i] / 2 * ((x - origin[i]) ** 2 - (a[i] - origin[i]) ** 2)
        return out

    charge = np.diff(cumulative(level, slope))
    covered = np.diff(cumulative(np.ones_like(level), np.zeros_like(slope)))
    return charge, covered


def run_node(kind, p, args, ident, metadata, deadline, provenance):
    from .analysis import chunks, as_job, count_error, ZERO_COUNT_ERROR
    from . import run_data
    job = as_job(deadline)
    plots = []
    if kind == 'apply_calibration':
        # From the raw Energy value, like Calibrate Energy: the fitted line
        # replaces any calibration before it.
        ev, cal = args['events'], args['calibration']
        return {'events': replace(ev, calibration=('linear', cal['slope'], cal['intercept']))}, []
    if kind == 'calibration_fit':
        data = pairs(p['points']); x, y = data.T
        coef, residuals, rank, _, _ = np.polyfit(x, y, 1, full=True)
        if rank != 2 or coef[0] <= 0:
            raise AnalysisError('Calibration must have a positive slope and independent reference points.')
        predicted = np.polyval(coef, x); delta = y - predicted
        covariance = np.polyfit(x, y, 1, cov=True)[1].tolist() if len(x) > 2 else None
        cal = dict(slope=float(coef[0]), intercept=float(coef[1]), covariance=covariance, residuals_keV=delta.tolist(), rms_keV=float(np.sqrt(np.mean(delta**2))))
        plots.append(dict(node=ident, kind='series', title='Calibration residuals', x_label='ADC', y_label='Residual (keV)', points=[dict(run=i, x=float(a), y=float(b), error=0) for i, (a, b) in enumerate(zip(x, delta))]))
        return {'calibration': cal}, plots
    if kind == 'rebin':
        source = args['spectrum']; n = p['factor']
        if n != int(n) or n < 1:
            raise AnalysisError('Rebin factor must be a positive integer.')
        n = int(n); edges = source['edges']
        if (len(edges)-1) % n:
            raise AnalysisError('Rebin factor must divide the number of bins exactly.')
        rows = [{**row, 'counts': np.asarray(row['counts']).reshape(-1, n).sum(axis=1).tolist(), 'variance': np.asarray(row['variance']).reshape(-1, n).sum(axis=1).tolist()} for row in source['series']]
        out = dict(edges=edges[::n], series=rows)
        return {'spectrum': out}, [spectrum_plot(ident, out, 'Rebinned spectrum')]
    if kind == 'background':
        signal, bg = args['signal'], args['background']
        if signal['edges'] != bg['edges']:
            raise AnalysisError('Signal and background must have identical bin edges.')
        if set(r['run'] for r in signal['series']) & set(r['run'] for r in bg['series']):
            raise AnalysisError('Signal and background must be independent runs.')
        norm = p['normalisation']
        def exposure(run):
            row = args['metadata'][run]
            value = duration(row) if norm == 'time' else row.get('charge_uC')
            if value is None or not math.isfinite(value) or value <= 0:
                raise AnalysisError(f'Run {run}: positive {norm} exposure required.')
            return value
        counts = np.sum([r['counts'] for r in bg['series']], axis=0)
        variance = np.sum([r['variance'] for r in bg['series']], axis=0)
        total = sum(exposure(r['run']) for r in bg['series']) if norm != 'manual' else 1
        rows = []
        for row in signal['series']:
            scale = exposure(row['run']) / total if norm != 'manual' else p['scale']
            if scale < 0: raise AnalysisError('Background scale must be non-negative.')
            rows.append({**row, 'counts': (np.asarray(row['counts']) - scale * counts).tolist(), 'variance': (np.asarray(row['variance']) + scale**2 * variance).tolist(), 'background_scale': scale, 'background_runs': [r['run'] for r in bg['series']]})
        out = dict(edges=signal['edges'], series=rows)
        return {'spectrum': out}, [spectrum_plot(ident, out, 'Background-subtracted spectrum')]
    if kind in ('spectrum_roi', 'sideband', 'peak_fit'):
        source = args['spectrum']; edges = np.asarray(source['edges']); widths = np.diff(edges)
        mask = window(edges, p['min'], p['max']); values = {}; diagnostics = {}
        centres = (edges[:-1] + edges[1:]) / 2
        for row in source['series']:
            y, var = np.asarray(row['counts']), np.asarray(row['variance'])
            value, variance = float(y[mask].sum()), float(var[mask].sum())
            if kind == 'sideband':
                if not p['left_min'] < p['left_max'] <= p['min'] < p['max'] <= p['right_min'] < p['right_max']:
                    raise AnalysisError('Sidebands must bracket the ROI without overlap.')
                side = window(edges, p['left_min'], p['left_max']) | window(edges, p['right_min'], p['right_max'])
                scale = widths[mask].sum() / widths[side].sum()
                value -= float(scale * y[side].sum()); variance += float(scale**2 * var[side].sum())
            if kind == 'peak_fit':
                from scipy.optimize import curve_fit, OptimizeWarning
                from scipy.special import ndtr
                if mask.sum() <= 5 or p['sigma'] <= 0 or not p['min'] < p['centroid'] < p['max']:
                    raise AnalysisError('Fit needs >5 bins, positive sigma and an initial centroid inside the window.')
                low, high = edges[:-1][mask], edges[1:][mask]; origin = (p['min'] + p['max']) / 2
                def model(_, total, mean, sigma, baseline, slope):
                    return total * (ndtr((high-mean)/sigma)-ndtr((low-mean)/sigma)) + baseline*(high-low) + slope*((high-origin)**2-(low-origin)**2)/2
                err = np.sqrt(np.maximum(var[mask], 1)); baseline = float(np.median(y[mask] / widths[mask]))
                initial = [max(1, float(y[mask].sum() - baseline*widths[mask].sum())), p['centroid'], p['sigma'], baseline, 0]
                lower = [0, p['min'], min(widths)/10, -np.inf, -np.inf]; upper = [np.inf, p['max'], p['max']-p['min'], np.inf, np.inf]
                counts_in = y[mask]
                # Least squares weights every bin by its own count, which biases
                # the area low when bins are nearly empty; there the Poisson
                # likelihood is the right one. It needs plain counts: a
                # background-subtracted spectrum (variance != counts) stays
                # with least squares.
                plain = np.allclose(var, y) and np.all(y >= 0) and np.allclose(y, np.round(y))
                poisson = plain and counts_in.min() < POISSON_BELOW
                with warnings.catch_warnings():
                    warnings.simplefilter('error', OptimizeWarning)
                    try:
                        coeff, cov = curve_fit(model, centres[mask], counts_in, p0=initial, sigma=err, absolute_sigma=True,
                            bounds=(lower, upper), maxfev=10000, x_scale='jac')
                    except (RuntimeError, ValueError, OptimizeWarning) as exc:
                        if not poisson:
                            raise AnalysisError(f'Run {row["run"]}: peak fit failed: {exc}') from exc
                        coeff = np.asarray(initial, dtype=float)
                if poisson:
                    coeff, cov, cash = poisson_fit(lambda *theta: model(None, *theta), counts_in, coeff, lower, upper, row['run'])
                    if not np.isfinite(cov).all() or cov[0,0] <= 0:
                        raise AnalysisError('Peak fit is unconstrained; adjust the window or binning.')
                elif not np.isfinite(cov).all() or coeff[0] <= 0 or cov[0,0] <= 0:
                    raise AnalysisError('Peak fit is unconstrained; adjust the window or binning.')
                predicted = model(None, *coeff); residual = y[mask] - predicted
                value, variance = float(coeff[0]), float(cov[0,0])
                quality = dict(method='Poisson likelihood (Cash)', cash_per_dof=float(cash/(mask.sum()-5))) if poisson else dict(method='weighted least squares', reduced_chi_square=float(np.sum((residual/err)**2)/(mask.sum()-5)))
                diagnostics[row['run']] = dict(area=value, centroid=float(coeff[1]), sigma=float(coeff[2]), covariance=cov.tolist(), **quality, model='bin-integrated Gaussian + linear background; total Gaussian area', residuals=residual.tolist())
                plots.append(dict(node=f'{ident}-{row["run"]}', kind='histogram', title=f'Peak fit · run {row["run"]}', edges=edges.tolist(), series=[row], fit=[float(model_value) if included else None for included, model_value in zip(mask, np.interp(centres, centres[mask], predicted))]))
            if kind == 'spectrum_roi' and variance == 0 and value == 0:
                # An empty window: the Gehrels upper limit, not an exact zero.
                values[row['run']] = area(0.0, ZERO_COUNT_ERROR ** 2, upper_limit_84=ZERO_COUNT_ERROR)
            else:
                values[row['run']] = area(value, variance)
        return {'counts': values, 'values': values, 'diagnostics': diagnostics}, plots
    if kind in ('efficiency', 'arithmetic'):
        values = {}
        if kind == 'efficiency':
            curve = pairs(p['curve'])
            if np.any(curve[:,1] <= 0) or np.any(curve[:,1] > 1) or not curve[0,0] <= p['energy'] <= curve[-1,0] or not 0 <= p['relative_error'] <= 1:
                raise AnalysisError('Efficiency must be in (0,1], with energy inside the curve and relative error in [0,1].')
            eff = float(np.interp(p['energy'], curve[:,0], curve[:,1]))
            for run, v in args['values'].items():
                value = v['value']/eff
                values[run] = area(value, (v.get('error',0)/eff)**2 + (value*p['relative_error'])**2, efficiency=eff, statistical_error=v.get('error',0)/eff, systematic_error=abs(value*p['relative_error']))
        else:
            if set(args['a']) != set(args['b']): raise AnalysisError('Arithmetic inputs must have the same runs.')
            rho = p['correlation']
            if not -1 <= rho <= 1: raise AnalysisError('Correlation must lie in [−1,1].')
            for run, a in args['a'].items():
                b = args['b'][run]; x,y = a['value'],b['value']; sx,sy = a.get('error',0),b.get('error',0)
                op = p['operation']
                if op == 'add': value,dx,dy=x+y,1,1
                elif op == 'subtract': value,dx,dy=x-y,1,-1
                elif op == 'multiply': value,dx,dy=x*y,y,x
                else:
                    if y == 0: raise AnalysisError(f'Run {run}: division by zero.')
                    value,dx,dy=x/y,1/y,-x/y**2
                values[run] = area(value, max(0,(dx*sx)**2+(dy*sy)**2+2*rho*dx*dy*sx*sy))
        return {'values': values}, []
    if kind == 'load_current':
        if not p['column'].strip(): raise AnalysisError('Choose a recorded current column (for example Ch0(uA) or Current(uA)).')
        rows = {}
        for run in args['events'].runs:
            path = Path(run_data.run_dir(run)) / 'current.txt'
            if path.resolve().parent != Path(run_data.run_dir(run)).resolve() or not path.is_file():
                raise AnalysisError(f'Run {run}: missing or external current log.')
            if path.stat().st_size > 64_000_000: raise AnalysisError('Current log exceeds 64 MB.')
            stat = path.stat(); provenance[str(run)]['files'].append(dict(name='current.txt',bytes=stat.st_size,mtime_ns=stat.st_mtime_ns))
            data = run_data.read_current(run, max_points=10_000_000)
            if p['column'] not in data['columns'][1:]: raise AnalysisError(f'Run {run}: choose one of {data["columns"][1:]}')
            col = data['columns'].index(p['column']); samples = np.asarray(data['samples'])
            if len(samples)<2 or not np.isfinite(samples).all() or np.any(np.diff(samples[:,0])<=0): raise AnalysisError('Current log requires finite, strictly increasing samples.')
            # current.txt counts seconds from its own 'Start time' line, written
            # when the current recording began; the events count from the
            # acquisition start, which is the run's Start Time. run_window
            # gives the run's start and stop in the log's time, so shifting by
            # the start puts both on the run's clock.
            run_span = run_data.run_window(run, data['start_time'])
            if run_span:
                offset, span = run_span[0], (0.0, run_span[1] - run_span[0])
            else:
                offset = 0.0; span = (float(samples[0,0]), float(samples[-1,0]))
                job.warn(f'Run {run}: the current log could not be aligned with the run (no Start/Stop Time in metadata.json, or no Start time line in current.txt); its time 0 is taken as the run start.')
            rows[run] = dict(time=samples[:,0] - offset, current=samples[:,col], window=span)
        return {'current': rows}, []
    if kind == 'rate_time':
        ev = args['events']
        if ev.channel is None or p['width'] <= 0 or p['min'] >= p['max']: raise AnalysisError('Select a detector, positive time bin, and valid ROI.')
        bins = {}; counts = {}
        for run in ev.runs:
            stop = p['stop'] or duration(args['metadata'][run])
            if not 0 <= p['start'] < stop or math.ceil((stop-p['start'])/p['width']) > 4096: raise AnalysisError('Time range needs 1–4096 bins and a non-negative start.')
            bins[run] = np.append(np.arange(p['start'],stop,p['width']),stop); counts[run] = np.zeros(len(bins[run])-1)
        for run, energy, times in chunks(ev, job, with_time=True):
            mask = (energy>p['min']) & (energy<p['max'])
            counts[run] += np.histogram(times[mask],bins=bins[run])[0]
        rows = {run: dict(edges=bins[run].tolist(), counts=v.tolist(), values=(v/np.diff(bins[run])).tolist(), errors=(np.array([count_error(n) for n in v])/np.diff(bins[run])).tolist()) for run,v in counts.items()}
        return {'time_series': {'rows': rows, 'unit': 'Counts/s'}}, []
    if kind == 'yield_time':
        series = args['time_series']; rows = {}
        if set(series['rows']) != set(args['current']): raise AnalysisError('Current and rate runs must match.')
        for run, row in series['rows'].items():
            if 'counts' not in row: raise AnalysisError('Connect a counting-rate output.')
            samples = args['current'][run]
            charge, covered = charge_per_bin(samples['time'], samples['current'], row['edges'], *samples['window'])
            c = np.asarray(row['counts']); widths = np.diff(row['edges'])
            empty = int(np.count_nonzero(charge <= 0))
            gaps = int(np.count_nonzero((charge > 0) & (covered < widths - 1e-9)))
            if empty == len(charge): raise AnalysisError(f'Run {run}: no time bin has positive charge; check the current column and the time range.')
            if empty: job.warn(f'Run {run}: {empty} time bin(s) without charge (outside the run, no current, or a gap of more than 10 s in the log) are left out of the yield.')
            if gaps: job.warn(f'Run {run}: {gaps} time bin(s) are partly not covered by current readings; their charge leaves the silent time out, as the run charge does.')
            good = charge > 0
            values = [float(n / q) if ok else None for n, q, ok in zip(c, charge, good)]
            errors = [float(count_error(n) / q) if ok else None for n, q, ok in zip(c, charge, good)]
            rows[run]=dict(edges=row['edges'],values=values,errors=errors,charge_uC=charge.tolist(),covered_s=covered.tolist())
        return {'time_series': {'rows': rows,'unit':'Counts/µC'}}, []
    if kind in ('plot_time','plot_current'):
        points=[]
        if kind=='plot_current':
            for run,row in args['current'].items():
                stride=max(1,math.ceil(len(row['time'])/4096)); points.extend(dict(run=run,x=float(t),y=float(v),error=0) for t,v in zip(row['time'][::stride],row['current'][::stride]))
            unit='Current (µA)'
        else:
            for run,row in args['time_series']['rows'].items():
                centres=(np.asarray(row['edges'][:-1])+row['edges'][1:])/2
                points.extend(dict(run=run,x=float(t),y=float(v),error=float(e)) for t,v,e in zip(centres,row['values'],row['errors']) if v is not None)
            unit=args['time_series']['unit']
        plots.append(dict(node=ident,kind='time',title=p['title'],x_label='Elapsed time (s)',y_label=unit,points=points))
        return {'samples':len(points)}, plots
    raise AnalysisError(f'Unknown analysis node: {kind}')
