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
            current[1]['time']=np.array([1,5,9])
            with self.assertRaisesRegex(a.AnalysisError,'does not cover'): execute('yield_time',{'time_series':rate,'current':current})
