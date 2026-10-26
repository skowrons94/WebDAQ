import type { AnalysisGraph, AnalysisNodeSpec } from '@/lib/api'

export function starterGraph(catalog: Record<string, AnalysisNodeSpec>, runs = ''): AnalysisGraph {
  const layout: [string, string, number, number][] = [
    ['load', 'load_runs', 30, 30], ['calibration', 'calibrate', 330, 30],
    ['channel', 'channel', 630, 30], ['db', 'database', 30, 270],
    ['beam', 'beam_energy', 330, 270], ['roi', 'roi', 630, 270],
    ['plot', 'plot', 30, 530], ['yield', 'yield', 330, 530], ['histogram', 'histogram', 630, 530],
  ]
  const connections = [
    ['load', 'calibration', 'events', 'events'], ['calibration', 'channel', 'events', 'events'],
    ['channel', 'roi', 'events', 'events'], ['channel', 'histogram', 'events', 'events'],
    ['load', 'beam', 'events', 'events'], ['db', 'beam', 'metadata', 'metadata'],
    ['roi', 'yield', 'counts', 'counts'], ['db', 'yield', 'metadata', 'metadata'],
    ['beam', 'plot', 'values', 'x'], ['yield', 'plot', 'values', 'y'],
  ]
  return {
    version: 1,
    nodes: layout.map(([id, kind, x, y]) => ({ id, kind, position: { x, y }, params: {
      ...Object.fromEntries(Object.entries(catalog[kind].params).map(([k, v]) => [k, v.default])),
      ...(kind === 'load_runs' ? { runs } : {}),
    } })),
    edges: connections.map(([source, target, sourceHandle, targetHandle], i) => ({
      id: `edge-${i}`, source, target, sourceHandle, targetHandle,
    })),
  }
}

export function readGraph(value: unknown, catalog: Record<string, AnalysisNodeSpec>): AnalysisGraph {
  const graph = value as AnalysisGraph
  if (!graph || graph.version !== 1 || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || graph.nodes.length > 50 || graph.edges.length > 150) {
    throw new Error('Import a LUNAdaq version 1 workflow (up to 50 nodes).')
  }
  const ids = new Set<string>()
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== 'string' || !node.id || ids.has(node.id) || !catalog[node.kind] ||
        !node.position || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y) ||
        !node.params || typeof node.params !== 'object' || Array.isArray(node.params)) throw new Error('Invalid or duplicate workflow node.')
    ids.add(node.id)
    for (const [key, value] of Object.entries(node.params)) {
      const spec = catalog[node.kind].params[key]
      if (!spec || (spec.type === 'number' ? typeof value !== 'number' || !Number.isFinite(value) : typeof value !== 'string')) throw new Error(`Invalid parameter: ${key}`)
    }
  }
  const edgeIds = new Set<string>()
  for (const edge of graph.edges) {
    if (!edge || typeof edge.id !== 'string' || edgeIds.has(edge.id) || !ids.has(edge.source) || !ids.has(edge.target)) throw new Error('Invalid workflow connection.')
    edgeIds.add(edge.id)
    const source = graph.nodes.find(n => n.id === edge.source)!
    const target = graph.nodes.find(n => n.id === edge.target)!
    const output = catalog[source.kind].outputs[edge.sourceHandle]
    if (!output || output !== catalog[target.kind].inputs[edge.targetHandle]) throw new Error('Incompatible workflow ports.')
  }
  // Only the documented fields enter React Flow; imported UI properties are ignored.
  return { version: 1, nodes: graph.nodes.map(({ id, kind, params, position }) => ({ id, kind, params, position })),
    edges: graph.edges.map(({ id, source, target, sourceHandle, targetHandle }) => ({ id, source, target, sourceHandle, targetHandle })) }
}

export function download(name: string, value: string, mime = 'application/json') {
  const url = URL.createObjectURL(new Blob([value], { type: mime }))
  const link = document.createElement('a')
  link.href = url; link.download = name; link.hidden = true
  document.body.appendChild(link)
  link.click(); link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** Stable comparisons across Flask's key-sorted JSON and browser object order. */
export function graphKey(graph: AnalysisGraph): string {
  return JSON.stringify(graph, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)
}
