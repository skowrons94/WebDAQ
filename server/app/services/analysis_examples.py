"""Experiment-independent draft templates; never select or execute runs implicitly."""
from copy import deepcopy
from .analysis import CATALOG


def examples():
    def graph(nodes, links):
        return {
            'version': 1,
            'nodes': [dict(id=i, kind=k, position={'x': (n % 4)*300, 'y': (n//4)*230},
                           params={**{key: deepcopy(v['default']) for key, v in CATALOG[k]['params'].items()}, **p})
                      for n, (i, k, p) in enumerate(nodes)],
            'edges': [dict(id=f'e{n}', source=a, target=b, sourceHandle=c, targetHandle=d)
                      for n, (a, b, c, d) in enumerate(links)],
        }

    # Numeric energy settings are illustrative, not measured calibration data.
    window = {'min': 400, 'max': 600}
    spectrum = {'min': 0, 'max': 2000, 'bins': 400}
    base = [('runs', 'load_runs', {}), ('cal', 'calibrate', {}), ('detector', 'channel', {}),
            ('spectrum', 'histogram', spectrum)]
    links = [('runs', 'cal', 'events', 'events'), ('cal', 'detector', 'events', 'events'),
             ('detector', 'spectrum', 'events', 'events')]
    rebinned = base + [('rebin', 'rebin', {'factor': 2})]
    rebin_links = links + [('spectrum', 'rebin', 'spectrum', 'spectrum')]
    tail = [('db', 'database', {}), ('yield', 'yield', {}),
            ('beam', 'beam_energy', {'scale': 1, 'offset': 0}), ('plot', 'plot', {})]
    tail_links = [('db', 'yield', 'metadata', 'metadata'), ('runs', 'beam', 'events', 'events'),
                  ('db', 'beam', 'metadata', 'metadata'), ('beam', 'plot', 'values', 'x'),
                  ('yield', 'plot', 'values', 'y')]
    backgrounds = [('background_runs', 'load_runs', {}), ('bg_cal', 'calibrate', {}),
                   ('bg_detector', 'channel', {}), ('bg_spectrum', 'histogram', {**spectrum, 'title': 'Background spectrum'}),
                   ('bg_rebin', 'rebin', {'factor': 2})]
    background_links = [('background_runs', 'bg_cal', 'events', 'events'), ('bg_cal', 'bg_detector', 'events', 'events'),
                        ('bg_detector', 'bg_spectrum', 'events', 'events'), ('bg_spectrum', 'bg_rebin', 'spectrum', 'spectrum'),
                        ('rebin', 'subtract', 'spectrum', 'signal'), ('bg_rebin', 'subtract', 'spectrum', 'background'),
                        ('db', 'subtract', 'metadata', 'metadata')]
    simple = graph(base + [('area', 'roi', window)], links + [('detector', 'area', 'events', 'events')])
    background = graph(rebinned + backgrounds + [('db', 'database', {}), ('subtract', 'background', {'normalisation': 'time'}),
                       ('area', 'spectrum_roi', window)], rebin_links + background_links + [('subtract', 'area', 'spectrum', 'spectrum')])
    complete = graph(rebinned + backgrounds + [('subtract', 'background', {'normalisation': 'charge'}),
                     ('fit', 'peak_fit', {**window, 'centroid': 500, 'sigma': 10})] + tail,
                     rebin_links + background_links + [('subtract', 'fit', 'spectrum', 'spectrum'), ('fit', 'yield', 'counts', 'counts')] + tail_links)
    sideband = graph(rebinned + [('area', 'sideband', {**window, 'left_min': 300, 'left_max': 400, 'right_min': 600, 'right_max': 700})] + tail,
                     rebin_links + [('rebin', 'area', 'spectrum', 'spectrum'), ('area', 'yield', 'counts', 'counts')] + tail_links)
    calibration = graph([('references', 'calibration_fit', {'points': ''}), ('runs', 'load_runs', {}),
                         ('apply', 'apply_calibration', {}), ('detector', 'channel', {}), ('spectrum', 'histogram', spectrum)],
                        [('runs', 'apply', 'events', 'events'), ('references', 'apply', 'calibration', 'calibration'),
                         ('apply', 'detector', 'events', 'events'), ('detector', 'spectrum', 'events', 'events')])
    time_base = base[:3] + [('db', 'database', {}), ('rate', 'rate_time', {**window, 'start': 0, 'stop': 0, 'width': 10}),
                           ('plot_rate', 'plot_time', {'title': 'Counting rate'})]
    time_links = links[:2] + [('detector', 'rate', 'events', 'events'), ('db', 'rate', 'metadata', 'metadata'),
                             ('rate', 'plot_rate', 'time_series', 'time_series')]
    rate = graph(time_base, time_links)
    timed = graph(time_base + [('current', 'load_current', {'column': ''}), ('yield', 'yield_time', {}),
                              ('plot_yield', 'plot_time', {'title': 'Yield over time'}), ('plot_current', 'plot_current', {})],
                  time_links + [('runs', 'current', 'events', 'events'), ('rate', 'yield', 'time_series', 'time_series'),
                                ('current', 'yield', 'current', 'current'), ('yield', 'plot_yield', 'time_series', 'time_series'),
                                ('current', 'plot_current', 'current', 'current')])
    correction = graph(base + [('area_a', 'spectrum_roi', window), ('area_b', 'spectrum_roi', {'min': 900, 'max': 1100}),
                              ('eff_a', 'efficiency', {'energy': 500, 'curve': ''}), ('eff_b', 'efficiency', {'energy': 1000, 'curve': ''}),
                              ('ratio', 'arithmetic', {'operation': 'divide', 'correlation': 0})],
                       links + [('spectrum', 'area_a', 'spectrum', 'spectrum'), ('spectrum', 'area_b', 'spectrum', 'spectrum'),
                                ('area_a', 'eff_a', 'values', 'values'), ('area_b', 'eff_b', 'values', 'values'),
                                ('eff_a', 'ratio', 'values', 'a'), ('eff_b', 'ratio', 'values', 'b')])

    source = 'Choose completed runs in Runs, convert to ROOT, then select the intended Load Run(s) node before applying the selection. Inspect ROOT to check tree and energy branch (Energy for PHA; EnergyLong for PSD).'
    energy = 'Set your detector board/channel and measured calibration. Identity calibration and the 0–2000 keV spectrum / 400–600 keV ROI are illustrative; replace the ranges for your data.'
    bg = 'Assign independent signal and background runs to runs and background_runs. Check both detector/calibration paths and keep histogram ranges, bins and rebin factors identical.'
    scan = 'Requires positive saved charge and terminal/probe voltages for every signal run. Set Beam Energy for your accelerator and ion charge state; scale 1, offset 0 is only a placeholder.'
    timestamps = 'Requires ROOT event timestamps and valid run start/end times. Check Timestamp branch, scale (default ps) and offset relative to run start. Stop 0 uses each run duration; choose a suitable bin width.'

    rows = [
        ('spectrum', 'Spectrum & ROI counts', 'Inspect one or more spectra and count a peak; no charge or beam metadata needed.', simple, [source, energy, 'ROI counts are available in Summary.']),
        ('background', 'Time-normalised background', 'Subtract a separate background and integrate net peak counts.', background,
         [source, energy, bg, 'Requires valid start/end times for both datasets. Scaling uses elapsed time, not detector live time; use manual scaling if your exposure needs a different correction. Net counts appear in Summary.']),
        ('complete', 'Background → peak yield', 'Subtract background, fit a peak, normalise by charge and plot against beam energy.', complete,
         [source, energy, bg, scan, 'Background runs also need positive saved charge. Set fit bounds, initial centroid and width; inspect fit diagnostics before using the total Gaussian area.']),
        ('sidebands', 'Sideband yield scan', 'Estimate a local continuum and plot charge-normalised net peak yield.', sideband,
         [source, energy, scan, 'Choose two non-overlapping sidebands bracketing the peak within the spectrum. This template assumes a locally flat continuum.']),
        ('calibration', 'Fit energy calibration', 'Fit measured reference centroids and inspect the calibrated spectrum.', calibration,
         [source, 'Enter at least two measured [ADC centroid, known energy in keV] pairs in references. No reference measurements are supplied.', 'Choose detector board/channel and spectrum bounds. Use runs measured with the same detector settings as the references.']),
        ('rate', 'Counting rate over time', 'Monitor a detector ROI versus elapsed time without a current log.', rate, [source, energy, timestamps]),
        ('time', 'Rate, current & yield over time', 'Compare counting rate, recorded current and charge-normalised yield.', timed,
         [source, energy, timestamps, 'Set current.column to the recorded charge channel in current.txt (µA); no channel is preselected. Narrow rate.start/stop to the overlap of event timing and current-log coverage. Each time bin needs positive integrated charge.']),
        ('corrections', 'Efficiency & peak ratios', 'Compare two efficiency-corrected peak areas within each run.', correction,
         [source, energy, 'Set two disjoint peak windows (area_a and area_b), their energies and measured absolute-efficiency curves in eff_a/eff_b as [[keV, efficiency], ...]. No efficiency data are supplied.',
          'Inspect corrected areas and A/B ratios in Summary. These are gross areas; subtract continuum first if needed. Correlation 0 assumes independent peak errors; shared efficiency systematics require an appropriate covariance model. No charge or beam metadata needed.']),
    ]
    return [dict(id=i, name=name, description=desc, setup=setup, graph=g) for i, name, desc, g, setup in rows]
