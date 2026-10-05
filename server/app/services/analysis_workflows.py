"""Atomic, experiment-local named workflow storage. No run data is modified."""
import json
import math
import os
import threading
import uuid
from datetime import datetime, timezone

from .analysis import AnalysisError, CATALOG

lock = threading.RLock()


def validate_draft(graph):
    if not isinstance(graph, dict) or graph.get('version') != 1:
        raise AnalysisError('Expected a version 1 workflow.')
    nodes, edges = graph.get('nodes'), graph.get('edges')
    if not isinstance(nodes, list) or not isinstance(edges, list) or len(nodes) > 50 or len(edges) > 150:
        raise AnalysisError('Workflow exceeds node/connection limits or is malformed.')
    ids = set()
    for node in nodes:
        if not isinstance(node, dict) or not isinstance(node.get('id'), str) or not node['id'] or node['id'] in ids:
            raise AnalysisError('Invalid or duplicate workflow node.')
        kind = node.get('kind')
        if not isinstance(kind, str) or kind not in CATALOG or not isinstance(node.get('params'), dict):
            raise AnalysisError('Unknown node or invalid parameters.')
        if set(node['params']) - set(CATALOG[kind]['params']):
            raise AnalysisError('Unknown workflow parameters.')
        position = node.get('position')
        if not isinstance(position, dict) or any(isinstance(position.get(k), bool) or not isinstance(position.get(k), (int, float)) or not math.isfinite(position[k]) for k in ('x', 'y')):
            raise AnalysisError('Invalid node position.')
        for key, value in node['params'].items():
            spec = CATALOG[kind]['params'][key]
            if spec['type'] == 'number':
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                    raise AnalysisError('Numeric parameters must be finite numbers.')
            elif not isinstance(value, str) or len(value) > 1000:
                raise AnalysisError('Text parameters must contain at most 1000 characters.')
        ids.add(node['id'])
    edge_ids = set()
    by_id = {node['id']: node for node in nodes}
    for edge in edges:
        if not isinstance(edge, dict) or not isinstance(edge.get('source'), str) or not isinstance(edge.get('target'), str) or edge['source'] not in ids or edge['target'] not in ids:
            raise AnalysisError('Connection refers to a missing node.')
        if not isinstance(edge.get('id'), str) or edge['id'] in edge_ids or not isinstance(edge.get('sourceHandle'), str) or not isinstance(edge.get('targetHandle'), str):
            raise AnalysisError('Invalid connection ID or port.')
        edge_ids.add(edge['id'])
        output = CATALOG[by_id[edge['source']]['kind']]['outputs'].get(edge['sourceHandle'])
        target = CATALOG[by_id[edge['target']]['kind']]['inputs'].get(edge['targetHandle'])
        if not output or output != target:
            raise AnalysisError('Incompatible workflow ports.')
    try:
        json.dumps(graph, allow_nan=False)
    except (ValueError, TypeError) as exc:
        raise AnalysisError('Workflow contains invalid values.') from exc


def read(path):
    if not path.exists():
        legacy = path.with_name('analysis-workflow.json')
        if legacy.exists():
            try:
                graph = json.loads(legacy.read_text())
                validate_draft(graph)
            except (OSError, ValueError) as exc:
                raise AnalysisError('The previous workflow could not be read. Restore a backup before saving.') from exc
            return {'active_id': 'legacy', 'workflows': [{'id': 'legacy', 'name': 'Previous workflow',
                    'description': 'Workflow saved before the named library was introduced.', 'graph': graph,
                    'updated_at': datetime.fromtimestamp(legacy.stat().st_mtime, timezone.utc).isoformat()}]}
        return {'active_id': None, 'workflows': []}
    try:
        data = json.loads(path.read_text())
        if not isinstance(data, dict) or not isinstance(data.get('workflows'), list):
            raise ValueError()
        ids = set()
        for row in data['workflows']:
            if not isinstance(row, dict) or not isinstance(row.get('id'), str) or row['id'] in ids or not all(isinstance(row.get(key), str) for key in ('name', 'description', 'updated_at')):
                raise ValueError()
            ids.add(row['id'])
            validate_draft(row.get('graph'))
        return data
    except (OSError, ValueError) as exc:
        raise AnalysisError('The workflow library could not be read. Restore its backup before saving.') from exc


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f'.{uuid.uuid4().hex}.tmp')
    try:
        temporary.write_text(json.dumps(data, allow_nan=False, indent=2))
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def save(path, body, ident=None):
    name, description, graph = body.get('name'), body.get('description', ''), body.get('graph')
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 100:
        raise AnalysisError('Give the workflow a name (1–100 characters).')
    if not isinstance(description, str) or len(description) > 2000:
        raise AnalysisError('Description must be text of at most 2000 characters.')
    validate_draft(graph)
    with lock:
        data = read(path)
        existing = next((w for w in data['workflows'] if w['id'] == ident), None)
        if ident and existing is None:
            raise AnalysisError('Workflow no longer exists. Save a copy instead.')
        if not existing and len(data['workflows']) >= 50:
            raise AnalysisError('This experiment already has 50 saved workflows.')
        row = {'id': ident or uuid.uuid4().hex, 'name': name.strip(), 'description': description.strip(),
               'graph': graph, 'updated_at': datetime.now(timezone.utc).isoformat()}
        if existing:
            data['workflows'][data['workflows'].index(existing)] = row
        else:
            data['workflows'].append(row)
        data['active_id'] = row['id']
        write(path, data)
        return row
