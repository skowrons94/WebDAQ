"""Offline graph calculations exercised with tiny real ROOT fixtures."""
from datetime import datetime
import importlib.util
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
import numpy as np
from app.services import analysis as a, run_data


def workflow(runs='1,2'):
    kinds = [('load', 'load_runs'), ('cal', 'calibrate'), ('channel', 'channel'), ('roi', 'roi'),
             ('db', 'database'), ('yield', 'yield'), ('beam', 'beam_energy'), ('hist', 'histogram'), ('plot', 'plot')]
    nodes = [dict(id=i, kind=k, params={}, position={'x': 0, 'y': 0}) for i, k in kinds]
    nodes[0]['params'] = {'runs': runs}
    nodes[1]['params'] = {'slope': 2, 'intercept': 1}
    nodes[2]['params'] = {'board': 1, 'channel': 2}
    nodes[3]['params'] = {'min': 3, 'max': 9}
    nodes[7]['params'] = {'bins': 5, 'min': 0, 'max': 10}
    connections = [('load', 'cal', 'events', 'events'), ('cal', 'channel', 'events', 'events'),
                   ('channel', 'roi', 'events', 'events'), ('roi', 'yield', 'counts', 'counts'),
                   ('db', 'yield', 'metadata', 'metadata'), ('db', 'beam', 'metadata', 'metadata'),
                   ('load', 'beam', 'events', 'events'), ('channel', 'hist', 'events', 'events'),
                   ('beam', 'plot', 'values', 'x'), ('yield', 'plot', 'values', 'y')]
    return {'version': 1, 'nodes': nodes, 'edges': [dict(zip(
        ('source', 'target', 'sourceHandle', 'targetHandle'), c), id=str(i)) for i, c in enumerate(connections)]}


class ValidationTests(unittest.TestCase):
    def test_ranges(self):
        self.assertEqual(a.parse_runs('1, 2-4 2'), [1, 2, 3, 4])
        for value in ('', '4-2', '1-100000000', '-1', '1.2', '1;2', [], None):
            with self.subTest(value=value), self.assertRaises(a.AnalysisError): a.parse_runs(value)

    def test_run_queries(self):
        metadata = {1: {'complete': True, 'target_name': 'TiN', 'run_type': 'scan'},
                    2: {'complete': True, 'target_name': 'TiN', 'run_type': 'background'},
                    3: {'complete': False, 'target_name': 'TiN', 'run_type': 'scan'},
                    4: {'complete': True, 'target_name': 'Other', 'run_type': 'scan'}}
        self.assertEqual(a.resolve_runs({'target': ' tin '}, metadata), [1, 2])
        self.assertEqual(a.resolve_runs({'run_type': 'SCAN'}, metadata), [1, 4])
        self.assertEqual(a.resolve_runs({'target': 'tin', 'run_type': 'scan'}, metadata), [1])
        self.assertEqual(a.resolve_runs({'target': 'tin', 'runs': '2-4'}, metadata), [2])
        for params in ({'target': 'missing'}, {'target': 'Ti'}, {'target': 'tin', 'runs': '3'}):
            with self.assertRaisesRegex(a.AnalysisError, 'No completed runs'):
                a.resolve_runs(params, metadata)
        with self.assertRaisesRegex(a.AnalysisError, 'more than 100'):
            a.resolve_runs({'target': 'tin'}, {n: metadata[1] for n in range(101)})
        graph = workflow(''); graph['nodes'][0]['params']['target'] = 'tin'
        a.validate_graph(graph)

    def test_bad_graphs(self):
        for change in (
            lambda g: g['nodes'].append(g['nodes'][0]),
            lambda g: g['nodes'][1]['params'].update(slope=float('nan')),
            lambda g: g['nodes'][7]['params'].update(bins=2.5),
            lambda g: g['nodes'][3]['params'].update(min=10, max=2),
            lambda g: g['nodes'][0]['params'].update(file='../outside.root'),
            lambda g: g['edges'][0].update(source='cal'),
            lambda g: g['edges'][0].update(sourceHandle='missing'),
            lambda g: g['edges'].append(g['edges'][0]),
            lambda g: g['edges'].pop(),
        ):
            graph = workflow(); change(graph)
            with self.assertRaises(a.AnalysisError): a.validate_graph(graph)


@unittest.skipUnless(importlib.util.find_spec('uproot'), 'Install uproot for ROOT tests')
class RootAnalysisTests(unittest.TestCase):
    def setUp(self):
        import uproot
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        p = patch.object(run_data, 'DATA_DIR', self.tmp.name); p.start(); self.addCleanup(p.stop)
        self.metadata = {}
        for run in (1, 2):
            directory = Path(run_data.run_dir(run)); directory.mkdir()
            with uproot.recreate(directory / f'run{run}.root') as root:
                root.mktree('Data', {'Energy': 'uint16', 'EnergyLong': 'uint16', 'Board': 'uint16', 'Channel': 'uint16'})
                root['Data'].extend({k: np.array(v, dtype='uint16') for k, v in {
                    'Energy': [1, 2, 3, 4, 2, 2], 'EnergyLong': [1, 2, 3, 4, 2, 2],
                    'Board': [1, 1, 1, 1, 0, 1], 'Channel': [2, 2, 2, 2, 2, 3]}.items()})
            self.metadata[run] = {'complete': True, 'charge_uC': 2 * run, 'terminal_voltage': 100 * run, 'probe_voltage': 1}

    def test_real_root_pipeline_alignment_and_schema(self):
        result = a.execute(workflow('2,1'), self.metadata)
        self.assertEqual(result['nodes']['roi']['counts'], {2: 2, 1: 2})
        self.assertEqual(result['nodes']['yield']['values'][1]['value'], 1)
        self.assertAlmostEqual(result['nodes']['yield']['values'][1]['error'], np.sqrt(2) / 2)
        hist = next(p for p in result['plots'] if p['kind'] == 'histogram')
        self.assertEqual(hist['series'][0]['counts'], [0, 1, 1, 1, 1])
        plot = next(p for p in result['plots'] if p['kind'] == 'series')
        self.assertEqual([p['run'] for p in plot['points']], [1, 2])
        self.assertEqual([p['y'] for p in plot['points']], [1, .5])
        self.assertAlmostEqual(plot['points'][0]['x'], .9933 * 101 - .41)
        json.dumps(result, allow_nan=False)
        self.assertEqual(a.inspect_run(1)[0]['trees'][0]['entries'], 6)
        self.assertIn('files', result['provenance']['1'])

    def test_query_execution_and_provenance(self):
        self.metadata[1].update(target_name='TiN', run_type='scan')
        self.metadata[2].update(target_name='TiN', run_type='background')
        graph = workflow(''); graph['nodes'][0]['params'].update(target='tin', run_type='SCAN')
        result = a.execute(graph, self.metadata)
        self.assertEqual(set(result['provenance']), {'1'})
        self.assertEqual(result['nodes']['roi']['counts'], {1: 2})
        self.metadata[2]['run_type'] = 'scan'
        self.assertEqual(set(a.execute(graph, self.metadata)['provenance']), {'1', '2'})

    def test_psd_branch_and_multiple_files(self):
        import shutil
        shutil.copy(Path(run_data.run_dir(1)) / 'run1.root', Path(run_data.run_dir(1)) / 'split.root')
        graph = workflow('1'); graph['nodes'][0]['params']['energy'] = 'EnergyLong'
        self.assertEqual(a.execute(graph, self.metadata)['nodes']['roi']['counts'][1], 4)
        graph['nodes'][0]['params']['file'] = 'run1.root'
        self.assertEqual(a.execute(graph, self.metadata)['nodes']['roi']['counts'][1], 2)

    def test_invalid_charge_voltage_and_incomplete_run(self):
        for value in (None, 0, -1, float('nan')):
            self.metadata[1]['charge_uC'] = value
            with self.assertRaisesRegex(a.AnalysisError, 'charge must be positive'): a.execute(workflow('1'), self.metadata)
        self.metadata[1].update(charge_uC=2, probe_voltage=None)
        with self.assertRaisesRegex(a.AnalysisError, 'voltages are required'): a.execute(workflow('1'), self.metadata)
        self.metadata[1]['complete'] = False
        with self.assertRaisesRegex(a.AnalysisError, 'not completed'): a.execute(workflow('1'), self.metadata)

    def test_missing_branch_and_external_file(self):
        graph = workflow('1'); graph['nodes'][0]['params']['energy'] = 'Missing'
        with self.assertRaisesRegex(a.AnalysisError, 'missing Missing'): a.execute(graph, self.metadata)
        (Path(run_data.run_dir(1)) / 'outside.root').symlink_to(Path(run_data.run_dir(2)) / 'run2.root')
        with self.assertRaisesRegex(a.AnalysisError, 'symlinks'): a.root_paths(1)

    def test_legacy_tree_and_input_change(self):
        import uproot
        path = Path(run_data.run_dir(1)) / 'run1.root'
        with uproot.recreate(path) as root:
            root.mktree('DataR', {'Energy': 'uint16', 'Channel': 'uint16'})
            root['DataR'].extend({'Energy': np.array([2, 3], dtype='uint16'), 'Channel': np.array([2, 2], dtype='uint16')})
        graph = workflow('1'); graph['nodes'][2]['params']['board'] = 0
        self.assertEqual(a.execute(graph, self.metadata)['nodes']['roi']['counts'][1], 2)
        def mutate(node):
            if node == 'plot':
                path.touch()
        with self.assertRaisesRegex(a.AnalysisError, 'changed during analysis'):
            a.execute(graph, self.metadata, mutate)

    def test_conversion_in_progress_or_failed(self):
        for state in ('running', 'failed'):
            with patch.object(run_data.get_conversion_manager(), 'status', return_value={'state': state}):
                with self.assertRaisesRegex(a.AnalysisError, 'successful conversion'):
                    a.execute(workflow('1'), self.metadata)

    def test_series_run_mismatch(self):
        graph = workflow()
        graph['nodes'].append({'id': 'other', 'kind': 'load_runs', 'params': {'runs': '1'}})
        next(e for e in graph['edges'] if e['target'] == 'beam' and e['targetHandle'] == 'events')['source'] = 'other'
        with self.assertRaisesRegex(a.AnalysisError, 'exactly the same runs'): a.execute(graph, self.metadata)


class AnalysisRoutesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from app import create_app, db
        from config import Config
        from app.utils.jwt_utils import generate_token
        class MemoryConfig(Config):
            SQLALCHEMY_DATABASE_URI = 'sqlite://'
            TESTING = True
        cls.app = create_app(MemoryConfig)
        with cls.app.app_context():
            db.create_all(); cls.auth = {'Authorization': 'Bearer ' + generate_token(1)}
        cls.client = cls.app.test_client()

    @classmethod
    def tearDownClass(cls):
        from app import db
        with cls.app.app_context(): db.drop_all()

    def setUp(self):
        from app import db
        from app.models.run_metadata import RunMetadata
        from app.routes import analysis as routes
        self.routes = routes
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        for p in (patch.object(run_data, 'DATA_DIR', self.tmp.name),
                  patch.object(routes, 'workflow_path', return_value=Path(self.tmp.name) / 'workflow.json')):
            p.start(); self.addCleanup(p.stop)
        routes._jobs.clear(); routes._batch.update(state='idle', runs=[])
        with self.app.app_context():
            RunMetadata.query.delete()
            db.session.add(RunMetadata(run_number=1, end_time=datetime.utcnow(), accumulated_charge=2))
            db.session.add(RunMetadata(run_number=2)); db.session.commit()
        Path(run_data.run_dir(1)).mkdir(); (Path(run_data.run_dir(1)) / 'raw.caendat').write_bytes(b'fixture')

    def test_authentication_and_context(self):
        for path in ('/analysis/context', '/analysis/conversions', '/analysis/jobs/nope', '/analysis/runs/1/schema'):
            self.assertEqual(self.client.get(path).status_code, 401)
        for path in ('/analysis/execute', '/analysis/conversions'):
            self.assertEqual(self.client.post(path, json={}).status_code, 401)
        self.assertEqual(self.client.put('/analysis/workflow', json={}).status_code, 401)
        self.assertEqual(len(self.client.get('/analysis/context', headers=self.auth).get_json()['catalog']), 9)

    def test_save_draft_and_invalid_execution(self):
        graph = workflow('')
        self.assertEqual(self.client.put('/analysis/workflow', headers=self.auth, json=graph).status_code, 200)
        self.assertEqual(self.client.get('/analysis/context', headers=self.auth).get_json()['workflow'], graph)
        self.assertEqual(self.client.post('/analysis/execute', headers=self.auth, json=graph).status_code, 400)

    def test_named_workflow_library(self):
        url = '/analysis/workflows'
        self.assertEqual(self.client.get(url).status_code, 401)
        self.assertEqual(self.client.post(url, json={}).status_code, 401)
        body = {'name': 'Spectrum', 'description': 'Calibration for TiN', 'graph': workflow('')}
        first = self.client.post(url, headers=self.auth, json=body)
        self.assertEqual(first.status_code, 201)
        ident = first.get_json()['id']
        second = self.client.post(url, headers=self.auth, json={**body, 'name': 'Yield scan'}).get_json()
        rows = self.client.get(url, headers=self.auth).get_json()['workflows']
        self.assertEqual(len(rows), 2); self.assertNotIn('graph', rows[0])
        updated = self.client.put(url + '/' + ident, headers=self.auth, json={**body, 'description': 'Updated'})
        self.assertEqual(updated.status_code, 200)
        loaded = self.client.post(url + '/' + second['id'] + '/load', headers=self.auth)
        self.assertEqual(loaded.get_json()['name'], 'Yield scan')
        context = self.client.get('/analysis/context', headers=self.auth).get_json()
        self.assertEqual(context['active_workflow']['id'], second['id'])
        self.assertEqual(context['workflow'], body['graph'])
        self.assertEqual(self.client.post(url + '/missing/load', headers=self.auth).status_code, 404)
        self.assertEqual(self.client.put(url + '/missing', headers=self.auth, json=body).status_code, 400)
        for invalid in ({**body, 'name': ''}, {**body, 'description': 'x' * 2001}, {**body, 'graph': {}}):
            self.assertEqual(self.client.post(url, headers=self.auth, json=invalid).status_code, 400)
        self.assertEqual(len(self.client.get(url, headers=self.auth).get_json()['workflows']), 2)
        self.assertEqual(list(Path(self.tmp.name).glob('*.tmp')), [])
        with patch.object(self.routes, 'workflow_path', return_value=Path(self.tmp.name) / 'another' / 'workflow.json'):
            self.assertEqual(self.client.get(url, headers=self.auth).get_json()['workflows'], [])

    def test_legacy_library_and_corruption(self):
        from app.services import analysis_workflows as library
        path = Path(self.tmp.name) / 'analysis-workflows.json'
        legacy = path.with_name('analysis-workflow.json')
        legacy.write_text(json.dumps(workflow('1')))
        data = library.read(path)
        self.assertEqual(data['workflows'][0]['id'], 'legacy')
        library.save(path, {'name': 'New', 'description': '', 'graph': workflow('2')})
        self.assertEqual(len(library.read(path)['workflows']), 2)
        self.assertEqual(json.loads(legacy.read_text()), workflow('1'))
        path.write_text('broken')
        with self.assertRaises(a.AnalysisError):
            library.save(path, {'name': 'New', 'graph': workflow('2')})
        self.assertEqual(path.read_text(), 'broken')

    def test_job_failure(self):
        response = self.client.post('/analysis/execute', headers=self.auth, json=workflow('1'))
        self.assertEqual(response.status_code, 202)
        ident = response.get_json()['id']
        for _ in range(300):
            job = self.client.get('/analysis/jobs/' + ident, headers=self.auth).get_json()
            if job['state'] != 'running': break
            time.sleep(.01)
        self.assertEqual(job['state'], 'failed'); self.assertIn('Convert this run first', job['message'])
        self.assertEqual(self.client.get('/analysis/jobs/nope', headers=self.auth).status_code, 404)

    def test_serial_conversion_and_preserved_output(self):
        manager = Mock()
        manager.available.return_value = '/test/RUReader'; manager.start.return_value = (True, 'Started')
        manager.status.return_value = {'state': 'done', 'log': ['converted']}
        with patch.object(run_data, 'get_conversion_manager', return_value=manager):
            for existing in (False, True):
                if existing: (Path(run_data.run_dir(1)) / 'run1.root').write_bytes(b'keep')
                manager.start.reset_mock()
                response = self.client.post('/analysis/conversions', headers=self.auth, json={'runs': [1]})
                self.assertEqual(response.status_code, 202)
                for _ in range(300):
                    if self.routes._batch['state'] != 'running': break
                    time.sleep(.01)
                self.assertEqual(self.routes._batch['state'], 'done')
                self.assertEqual(manager.start.call_count, 0 if existing else 1)
            self.assertEqual(self.client.post('/analysis/conversions', headers=self.auth, json={'runs': [2]}).status_code, 400)

    def test_unavailable_converter_and_conflict(self):
        with patch.object(run_data.get_conversion_manager(), 'available', return_value=None):
            self.assertEqual(self.client.post('/analysis/conversions', headers=self.auth, json={'runs': [1]}).status_code, 409)
        self.routes._batch['state'] = 'running'
        self.assertEqual(self.client.post('/analysis/execute', headers=self.auth, json=workflow()).status_code, 409)
        self.routes._batch['state'] = 'idle'
