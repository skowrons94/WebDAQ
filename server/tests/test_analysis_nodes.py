"""Analytic fixtures for uncertainty propagation, fits, queries and timestamps."""
from datetime import datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
import json
import time
import unittest
from unittest.mock import patch
import numpy as np
from app.services import analysis as a, run_data
from app.services.analysis_nodes import run_node, CATALOG, duration
from app.services.analysis_examples import examples


def execute(kind, args, **params):
    p = {k:v['default'] for k,v in CATALOG[kind]['params'].items()}
    return run_node(kind, {**p,**params}, args, kind, {}, time.monotonic()+60, {})[0]


def spectrum(counts, run=1):
    return {'edges':list(range(len(counts)+1)), 'series':[{'run':run,'counts':counts,'variance':counts}]}


class SpectrumNodesTests(unittest.TestCase):
    def test_rebin_and_integral(self):
        source=spectrum([1,2,3,4,5,6])
        rebinned=execute('rebin',{'spectrum':source},factor=2)['spectrum']
        self.assertEqual(rebinned['edges'],[0,2,4,6])
        self.assertEqual(rebinned['series'][0]['counts'],[3,7,11])
        out=execute('spectrum_roi',{'spectrum':rebinned},min=0,max=6)['counts'][1]
        self.assertEqual(out['value'],21); self.assertAlmostEqual(out['error']**2,21)
        with self.assertRaises(a.AnalysisError): execute('rebin',{'spectrum':source},factor=4)

    def test_background_exposure_and_variance(self):
        meta={1:dict(start_time='2026-01-01T00:00:00',end_time='2026-01-01T00:00:20',charge_uC=12),2:dict(start_time='2026-01-01T00:00:00',end_time='2026-01-01T00:00:10',charge_uC=3)}
        args={'signal':spectrum([20,30]),'background':spectrum([4,5],2),'metadata':meta}
        for norm,scale in [('time',2),('charge',4),('manual',.5)]:
            out=execute('background',args,normalisation=norm,scale=.5)['spectrum']['series'][0]
            np.testing.assert_allclose(out['counts'],[20-scale*4,30-scale*5])
            np.testing.assert_allclose(out['variance'],[20+scale**2*4,30+scale**2*5])
        args['background']=spectrum([4,5],1)
        with self.assertRaisesRegex(a.AnalysisError,'independent'): execute('background',args)

    def test_sidebands(self):
        out=execute('sideband',{'spectrum':spectrum([10,10,50,50,10,10])},min=2,max=4,left_min=0,left_max=2,right_min=4,right_max=6)['counts'][1]
        self.assertEqual(out['value'],80); self.assertAlmostEqual(out['error']**2,110)
        with self.assertRaises(a.AnalysisError): execute('sideband',{'spectrum':spectrum([1]*6)},min=2,max=4,left_min=1,left_max=3,right_min=4,right_max=6)

    def test_peak_fit_area_and_covariance(self):
        from scipy.special import ndtr
        edges=np.linspace(0,10,101); low,high=edges[:-1],edges[1:]
        counts=1200*(ndtr((high-5)/.35)-ndtr((low-5)/.35))+30*(high-low)
        source=dict(edges=edges.tolist(),series=[dict(run=1,counts=counts.tolist(),variance=counts.tolist())])
        out=execute('peak_fit',{'spectrum':source},min=3,max=7,centroid=4.9,sigma=.4)
        self.assertAlmostEqual(out['counts'][1]['value'],1200,places=3)
        self.assertGreater(out['counts'][1]['error'],0)
        self.assertAlmostEqual(out['diagnostics'][1]['centroid'],5,places=4)
        self.assertLess(out['diagnostics'][1]['reduced_chi_square'],1e-8)
        with self.assertRaises(a.AnalysisError): execute('peak_fit',{'spectrum':source},min=4.9,max=5.1,centroid=5,sigma=.4)

    def test_calibration_efficiency_arithmetic(self):
        fit=execute('calibration_fit',{},points='[[100, 51], [200, 101], [300, 151]]')['calibration']
        self.assertAlmostEqual(fit['slope'],.5); self.assertAlmostEqual(fit['intercept'],1)
        corrected=execute('efficiency',{'values':{1:dict(value=10,error=2)}},curve='[[1, 0.5], [10, 0.5]]',energy=5,relative_error=.1)['values'][1]
        self.assertEqual(corrected['value'],20); self.assertAlmostEqual(corrected['error']**2,20)
        args={'a':{1:dict(value=10,error=2)},'b':{1:dict(value=5,error=1)}}
        ratio=execute('arithmetic',args)['values'][1]
        self.assertEqual(ratio['value'],2); self.assertAlmostEqual(ratio['error']**2,.32)
        self.assertAlmostEqual(execute('arithmetic',args,correlation=1)['values'][1]['error'],0)
        args['b'][1]['value']=0
        with self.assertRaises(a.AnalysisError): execute('arithmetic',args)
        with self.assertRaises(a.AnalysisError): execute('efficiency',{'values':{}},energy=6000)

    def test_richer_queries(self):
        meta={1:dict(complete=True,flag='good',start_time='2026-01-01T10:00:00',terminal_voltage=100),2:dict(complete=True,flag='bad',start_time='2026-01-02T10:00:00',terminal_voltage=200)}
        self.assertEqual(a.resolve_runs(dict(flag='good'),meta),[1])
        self.assertEqual(a.resolve_runs(dict(date_from='2026-01-02',date_to='2026-01-02'),meta),[2])
        self.assertEqual(a.resolve_runs(dict(voltage_min='150',voltage_max='250'),meta),[2])
        self.assertEqual(a.resolve_runs(dict(exclude='2'),meta),[1])
        for params in [dict(date_from='nonsense'),dict(voltage_min='nan'),dict(voltage_min='300',voltage_max='100')]:
            with self.assertRaises(a.AnalysisError): a.resolve_runs(params,meta)

    def test_examples_validate(self):
        for example in examples():
            from app.services.analysis_workflows import validate_draft
            with self.subTest(example=example['id']): validate_draft(example['graph'])


@unittest.skipUnless(__import__('importlib.util').util.find_spec('uproot'), 'Install uproot for ROOT tests')
class TimeNodesTests(unittest.TestCase):
    def test_timestamp_scaling_current_and_yield(self):
        import uproot
        with TemporaryDirectory() as tmp, patch.object(run_data,'DATA_DIR',tmp):
            path=Path(tmp)/'run1'; path.mkdir()
            with uproot.recreate(path/'events.root') as f:
                f.mktree('Data',{'Energy':'float64','Timestamp':'uint64','Channel':'uint16','Board':'uint16'})
                f['Data'].extend(dict(Energy=np.array([4.,4.,4.,4.]),Timestamp=np.array([1,2,3,9],dtype='uint64')*10**12,Channel=np.zeros(4,dtype='uint16'),Board=np.zeros(4,dtype='uint16')))
            (path/'current.txt').write_text('# Time(s)\tCh0(uA)\tCh1(uA)\n0 2 4\n5 2 4\n10 2 4\n')
            ev=a.Events((1,),((1,(path/'events.root',)),),'Data','Energy',board=0,channel=0)
            rate=execute('rate_time',{'events':ev,'metadata':{}},min=3,max=5,width=5,start=0,stop=10)['time_series']
            self.assertEqual(rate['rows'][1]['counts'],[3,1]); self.assertEqual(rate['rows'][1]['values'],[.6,.2])
            p={k:v['default'] for k,v in CATALOG['load_current']['params'].items()}; p['column']='Ch1(uA)'
            current=run_node('load_current',p,{'events':ev},'c',{},time.monotonic()+60,{'1':{'files':[]}})[0]['current']
            result=execute('yield_time',{'time_series':rate,'current':current})['time_series']['rows'][1]
            self.assertEqual(result['charge_uC'],[20,20]); self.assertEqual(result['values'],[.15,.05])
            self.assertAlmostEqual(result['errors'][0],np.sqrt(3)/20)
            # No reading for more than 10 s: that time carries no charge, and a
            # bin left without any is left out rather than divided by zero.
            current[1].update(time=np.array([0.,1.,12.]),current=np.array([4.,4.,4.]),window=(0,10))
            job=a.Job(time.monotonic()+60)
            result=run_node('yield_time',{},{'time_series':rate,'current':current},'y',{},job,{})[0]['time_series']['rows'][1]
            self.assertEqual(result['charge_uC'],[4,0]); self.assertEqual(result['values'],[.75,None])
            self.assertTrue(any('without charge' in w for w in job.warnings))


def gaussian_counts(area, mean, sigma, background, edges):
    from scipy.special import ndtr
    low, high = edges[:-1], edges[1:]
    return area*(ndtr((high-mean)/sigma)-ndtr((low-mean)/sigma)) + background*(high-low)


class ReviewFixesTests(unittest.TestCase):
    """Units, calibrations and statistics read from the run, not assumed."""

    def setUp(self):
        import importlib.util
        if not importlib.util.find_spec('uproot'): self.skipTest('Install uproot for ROOT tests')
        import uproot
        self.uproot = uproot
        self.tmp = TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        p = patch.object(run_data, 'DATA_DIR', self.tmp.name); p.start(); self.addCleanup(p.stop)
        self.dir = Path(self.tmp.name)/'run5'; self.dir.mkdir()

    def write(self, unit=None, energy=(100, 100, 200, 300), stamps=None, boards=None):
        with self.uproot.recreate(self.dir/'run5.root') as f:
            if unit is not None: f['TimestampUnit'] = unit   # a TObjString: read like RUReader's TNamed title
            n = len(energy)
            stamps = stamps if stamps is not None else np.arange(1, n + 1)
            f.mktree('Data', {'Energy': 'uint16', 'Timestamp': 'uint64', 'Channel': 'uint16', 'Board': 'uint16'})
            f['Data'].extend(dict(Energy=np.array(energy, dtype='uint16'), Timestamp=np.array(stamps, dtype='uint64'),
                                  Channel=np.full(n, 3, dtype='uint16'), Board=np.array(boards or [1]*n, dtype='uint16')))
        return a.Events((5,), ((5, (self.dir/'run5.root',)),), 'Data', 'Energy', board=1, channel=3)

    def times(self, ev, job=None):
        return np.concatenate([t for _, _, t in a.chunks(ev, job or a.Job(time.monotonic()+60), with_time=True)])

    def test_timestamp_unit_from_the_file(self):
        np.testing.assert_allclose(self.times(self.write('ns', stamps=(10**9, 2*10**9, 3*10**9, 4*10**9))), [1, 2, 3, 4])
        np.testing.assert_allclose(self.times(self.write('s')), [1, 2, 3, 4])
        job = a.Job(time.monotonic()+60)
        np.testing.assert_allclose(self.times(self.write(None, stamps=(10**12, 0, 0, 0)), job), [1, 0, 0, 0])
        self.assertTrue(any('no TimestampUnit' in w for w in job.warnings))
        # A scale typed in Load Run(s) still wins, with a warning saying so.
        ev = self.write('ns'); job = a.Job(time.monotonic()+60)
        from dataclasses import replace
        np.testing.assert_allclose(self.times(replace(ev, time_scale=1.0), job), [1, 2, 3, 4])
        self.assertTrue(any('stores timestamps in ns' in w for w in job.warnings))

    def test_root_tnamed_written_by_rureader(self):
        try:
            import ROOT
        except ImportError:
            self.skipTest('PyROOT not available')
        self.write(None, stamps=(5, 10, 15, 20))
        f = ROOT.TFile.Open(str(self.dir/'run5.root'), 'UPDATE')
        f.WriteTObject(ROOT.TNamed('TimestampUnit', 'raw'))
        f.WriteTObject(ROOT.TNamed('Boards', '1:V1725:PHA:16:4000ps;'))
        f.Close()
        np.testing.assert_allclose(self.times(a.Events((5,), ((5, (self.dir/'run5.root',)),), 'Data', 'Energy', board=1, channel=3)), [2e-8, 4e-8, 6e-8, 8e-8])

    def test_run_calibration_and_dither(self):
        from dataclasses import replace
        ev = self.write('ps', energy=[1000]*4000)
        # The run's own copy: channel 3 of board 1 is E = 5 + 0.5 x.
        lines = ['0 1']*16; lines[3] = '5 0.5'
        (self.dir/'V1725_1.cal').write_text('\n'.join(lines) + '\n')
        job = a.Job(time.monotonic()+60)
        energy = np.concatenate([e for _, e in a.chunks(replace(ev, calibration='run'), job)])
        # Spread over the channel: 505 ± 0.25, uniformly.
        self.assertTrue(np.all(np.abs(energy - 505) <= .25)); self.assertGreater(energy.std(), .1)
        self.assertEqual(job.warnings, [])
        again = np.concatenate([e for _, e in a.chunks(replace(ev, calibration='run'), job)])
        np.testing.assert_array_equal(energy, again)
        manual = np.concatenate([e for _, e in a.chunks(replace(ev, calibration=('linear', 2, 0)), job)])
        self.assertTrue(np.all(np.abs(manual - 2000) <= 1))
        raw = np.concatenate([e for _, e in a.chunks(ev, job)])
        np.testing.assert_array_equal(raw, 1000)
        # No picket fence: a slope of 0.7 keV per channel into 1 keV bins.
        ev = self.write('ps', energy=np.repeat(np.arange(1000, 1100), 200).tolist())
        lines[3] = '0 0.7'; (self.dir/'V1725_1.cal').write_text('\n'.join(lines) + '\n')
        energy = np.concatenate([e for _, e in a.chunks(replace(ev, calibration='run'), a.Job(time.monotonic()+60))])
        counts = np.histogram(energy, bins=np.arange(705, 765))[0]
        self.assertLess(counts.std() / counts.mean(), .1)
        # Missing calibration: identity, and the result says so.
        (self.dir/'V1725_1.cal').unlink(); job = a.Job(time.monotonic()+60)
        list(a.chunks(replace(ev, calibration='run'), job))
        self.assertTrue(any('no calibration file' in w for w in job.warnings))

    def test_poisson_fit_for_low_counts_and_zero_counts(self):
        edges = np.linspace(0, 10, 101)
        rng = np.random.default_rng(7)
        counts = rng.poisson(gaussian_counts(60, 5, .4, 2, edges)).astype(float)
        source = dict(edges=edges.tolist(), series=[dict(run=1, counts=counts.tolist(), variance=counts.tolist())])
        out = execute('peak_fit', {'spectrum': source}, min=2, max=8, centroid=5, sigma=.5)
        d = out['diagnostics'][1]
        self.assertEqual(d['method'], 'Poisson likelihood (Cash)')
        self.assertAlmostEqual(out['counts'][1]['value'], 60, delta=3*out['counts'][1]['error'])
        # No peak at all: the area sits at zero with a real error.
        flat = rng.poisson(np.full(100, .5)).astype(float)
        source = dict(edges=edges.tolist(), series=[dict(run=1, counts=flat.tolist(), variance=flat.tolist())])
        out = execute('peak_fit', {'spectrum': source}, min=2, max=8, centroid=5, sigma=.5)
        self.assertGreater(out['counts'][1]['error'], 0)
        # An empty window and an empty ROI count are not exact zeros either.
        empty = execute('spectrum_roi', {'spectrum': spectrum([0]*6)}, min=0, max=6)['counts'][1]
        self.assertEqual(empty['value'], 0); self.assertAlmostEqual(empty['error'], a.ZERO_COUNT_ERROR)
        self.assertAlmostEqual(a.count_error(0), 1.841); self.assertEqual(a.count_error(4), 2)

    def test_current_aligned_with_the_run(self):
        # The current log began 30 s before the run (its Start time line).
        (self.dir/'metadata.json').write_text(json.dumps({'Start Time': '2026-01-01T10:00:30', 'Stop Time': '2026-01-01T10:00:50'}))
        lines = ['### Start time: 2026-01-01 10:00:00.000000 ###', '# Time(s)\tCh0(uA)'] + [f'{t} {1 if t < 30 else 3}' for t in range(0, 61, 2)]
        (self.dir/'current.txt').write_text('\n'.join(lines) + '\n')
        ev = self.write('s')
        p = {k: v['default'] for k, v in CATALOG['load_current']['params'].items()}; p['column'] = 'Ch0(uA)'
        job = a.Job(time.monotonic()+60)
        current = run_node('load_current', p, {'events': ev}, 'c', {}, job, {'5': {'files': []}})[0]['current'][5]
        self.assertEqual(current['window'], (0.0, 20.0)); self.assertEqual(current['time'][0], -30)
        rate = {'rows': {5: dict(edges=[0, 10, 20], counts=[3, 6])}, 'unit': 'Counts/s'}
        rows = run_node('yield_time', {}, {'time_series': rate, 'current': {5: current}}, 'y', {}, job, {})[0]['time_series']['rows'][5]
        np.testing.assert_allclose(rows['charge_uC'], [30, 30]); np.testing.assert_allclose(rows['values'], [.1, .2])
        self.assertEqual(job.warnings, [])

    def test_sis3316_run_is_not_analysable(self):
        (self.dir/'SIS3316_1.h5').write_bytes(b'')
        graph = {'version': 1, 'nodes': [dict(id='load', kind='load_runs', params={'runs': '5'}, position={'x': 0, 'y': 0})], 'edges': []}
        with self.assertRaisesRegex(a.AnalysisError, 'RUReader converts .caendat only'):
            a.execute(graph, {5: {'complete': True}})
