"""Every shipped template can be configured without demo data or channel zero."""
from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch
import numpy as np
import uproot
from app.services import analysis as a, run_data
from app.services.analysis_examples import examples
from app.services.analysis_workflows import validate_draft


class ExamplePortabilityTests(TestCase):
    def test_templates_are_unbound_drafts(self):
        for template in examples():
            with self.subTest(template=template['id']):
                validate_draft(template['graph'])
                self.assertTrue(template['setup'])
                for node in template['graph']['nodes']:
                    p = node['params']
                    if node['kind'] == 'load_runs':
                        for key in ('runs', 'target', 'run_type', 'file', 'tree', 'flag', 'exclude', 'date_from', 'date_to', 'voltage_min', 'voltage_max'):
                            self.assertEqual(p[key], '')
                    if node['kind'] == 'load_current': self.assertEqual(p['column'], '')
                    if node['kind'] == 'calibration_fit': self.assertEqual(p['points'], '')
                    if node['kind'] == 'efficiency': self.assertEqual(p['curve'], '')
                    if node['kind'] == 'rate_time': self.assertEqual(p['stop'], 0)
                    if node['kind'] == 'beam_energy': self.assertEqual((p['scale'], p['offset']), (1, 0))
                with self.assertRaisesRegex(a.AnalysisError, 'Select at least one run'):
                    a.validate_graph(template['graph'])

    def test_all_templates_execute_with_non_demo_inputs(self):
        rng = np.random.default_rng(2026)
        with TemporaryDirectory() as tmp, patch.object(run_data, 'DATA_DIR', tmp):
            metadata = {}
            for run, seconds in ((7, 30), (42, 60)):
                path = Path(tmp) / f'run{run}'; path.mkdir()
                energy = rng.uniform(0, 2000, 3000)
                if run == 7:
                    energy = np.concatenate([energy, rng.normal(500, 10, 15000), rng.normal(1000, 10, 8000)])
                count = len(energy)
                with uproot.recreate(path / 'spectra.root') as root:
                    root.mktree('EventsPSD', {'EnergyLong': 'float64', 'Ticks': 'uint64', 'Board': 'uint16', 'Channel': 'uint16'})
                    root['EventsPSD'].extend(dict(EnergyLong=(energy-10)/.5,
                        Ticks=(np.linspace(.1, seconds-.1, count)*1e9).astype('uint64'),
                        Board=np.full(count, 2, dtype='uint16'), Channel=np.full(count, 3, dtype='uint16')))
                (path / 'current.txt').write_text(f'# Time(s)\tCh2(uA)\n0 2\n{seconds} 2\n')
                metadata[run] = dict(complete=True, charge_uC=seconds*2, terminal_voltage=200, probe_voltage=1,
                                     start_time='2026-01-01T00:00:00', end_time=f'2026-01-01T00:{seconds//60:02}:{seconds%60:02}')
            for template in examples():
                with self.subTest(template=template['id']):
                    graph = deepcopy(template['graph'])
                    for node in graph['nodes']:
                        p, kind = node['params'], node['kind']
                        if kind == 'load_runs': p.update(runs='42' if node['id'] == 'background_runs' else '7', tree='EventsPSD', energy='EnergyLong', timestamp='Ticks', time_scale=1e-9)
                        if kind == 'channel': p.update(board=2, channel=3)
                        if kind == 'calibrate': p.update(slope=.5, intercept=10)
                        if kind == 'calibration_fit': p['points'] = '[[100,60],[200,110],[400,210]]'
                        if kind == 'load_current': p['column'] = 'Ch2(uA)'
                        if kind == 'efficiency': p['curve'] = '[[100,0.2],[2000,0.1]]'
                    meta = deepcopy(metadata)
                    if template['id'] in ('spectrum', 'background', 'calibration', 'rate', 'time', 'corrections'):
                        for row in meta.values(): row.update(charge_uC=None, terminal_voltage=None, probe_voltage=None)
                    result = a.execute(graph, meta)
                    self.assertTrue(result['plots'])
                    self.assertEqual(set(result['provenance']), {'7','42'} if template['id'] in ('background','complete') else {'7'})
                    if template['id'] == 'calibration': self.assertAlmostEqual(result['nodes']['references']['calibration']['slope'], .5)
                    if template['id'] == 'complete': self.assertGreater(result['nodes']['fit']['counts'][7]['value'], 10000)
                    if template['id'] in ('rate','time'): self.assertEqual(result['nodes']['rate']['time_series']['rows'][7]['edges'][-1], 30)
                    if template['id'] == 'time': self.assertEqual(result['nodes']['current']['runs'][7]['column'], 'Ch2(uA)')
                    if template['id'] == 'corrections': self.assertGreater(result['nodes']['ratio']['values'][7]['value'], 0)
