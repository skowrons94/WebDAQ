'use client'

import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ReactFlow, Background, Controls, MiniMap, Handle, Position, addEdge, useNodesState, useEdgesState, type Node, type NodeProps, type Edge, type Connection, type ReactFlowInstance } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { AlertTriangle, Play, Plus, Save, Upload, Download, RefreshCw, Trash2, Loader2, X, GripVertical, GripHorizontal, Info } from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { AnalysisContext, AnalysisNodeSpec, AnalysisGraph, AnalysisResult, AnalysisBatch, AnalysisSchema, RunSummary, getAnalysisContext, getRuns, getAnalysisBatch, startAnalysisBatch, getAnalysisSchema, executeAnalysis, getAnalysisJob, SavedAnalysisWorkflow, getAnalysisWorkflows, storeAnalysisWorkflow, loadAnalysisWorkflow, queryAnalysisRuns, getAnalysisRunFormats, type AnalysisRunFormat } from '@/lib/api'
import { PageHeader } from '@/components/page-header'
import { useRunStatus } from '@/hooks/use-run-status'
import { useIsPhone } from '@/hooks/use-is-phone'
import { download, graphKey, readGraph, starterGraph } from './graph'
import { Results } from './results'
import { RunQuery, emptyQuery } from './run-query'
import { HelpTooltip, TooltipProvider } from '@/components/ui/tooltip'
import './workspace.css'

// Browser storage can be unavailable (private window, blocked site data): the
// page then simply does not remember its panel sizes or a running job.
function stored(storage: 'local' | 'session', key: string): string | null {
  try { return (storage === 'local' ? localStorage : sessionStorage).getItem(key) } catch { return null }
}
function store(storage: 'local' | 'session', key: string, value: string | null) {
  try {
    const s = storage === 'local' ? localStorage : sessionStorage
    if (value === null) s.removeItem(key); else s.setItem(key, value)
  } catch { /* not kept */ }
}

type FlowNode = Node<{ kind: string; params: Record<string, string | number>; spec: AnalysisNodeSpec }, 'analysis'>
const message = (error: unknown) => (error as { response?: { data?: { message?: string } }; message?: string })?.response?.data?.message || (error as Error)?.message || 'Request failed.'

const AnalysisNode = memo(function AnalysisNode({ data, selected }: NodeProps<FlowNode>) {
  const ports = Math.max(Object.keys(data.spec.inputs).length, Object.keys(data.spec.outputs).length)
  return <div className={`analysis-node rounded-xl border bg-card shadow-sm w-[220px] ${selected ? 'ring-2 ring-primary border-primary' : ''}`}>
    <div className="px-4 pt-3 pb-2 border-b"><p className="text-[10px] tracking-widest uppercase text-primary">{data.spec.group}</p><strong className="text-sm">{data.spec.label}</strong></div>
    <div className="relative text-[11px] text-muted-foreground py-2" style={{ height: 22 + ports * 22 }}>
      {(['inputs', 'outputs'] as const).map(side => Object.keys(data.spec[side]).map((port, index) => <div key={`${side}-${port}`} className={`absolute ${side === 'inputs' ? 'left-3' : 'right-3 text-right'}`} style={{ top: 10 + index * 22 }}>{port}</div>))}
      {(['inputs', 'outputs'] as const).map(side => Object.keys(data.spec[side]).map((port, index) => <Handle key={`${side}-${port}`} type={side === 'inputs' ? 'target' : 'source'} position={side === 'inputs' ? Position.Left : Position.Right} id={port} style={{ top: 17 + index * 22, background: 'hsl(var(--primary))', width: 10, height: 10 }} />))}
      {ports === 0 && <span className="px-3">Active experiment</span>}
    </div>
    {Object.keys(data.params).length > 0 && <div className="px-4 pb-3 text-[11px] text-muted-foreground truncate">{Object.entries(data.params).filter(([, value]) => value !== '').slice(0, 2).map(([key, value]) => `${key}: ${value}`).join(' · ')}</div>}
  </div>
})
const calculationKey = (graph: AnalysisGraph) => graphKey({ ...graph, nodes: graph.nodes.map(n => ({ ...n, position: { x: 0, y: 0 } })) })
// MiniMap uses these dimensions for both its SVG and pointer coordinate mapping.
const minimapStyle = { width: 130, height: 90 }
const edgeDefaults = { style: { stroke: 'hsl(var(--primary))', strokeWidth: 1.8 } }
const nodeTypes = { analysis: AnalysisNode }

export default function AnalysisWorkspace() {
  const [context, setContext] = useState<AnalysisContext | null>(null)
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [selectedRuns, setSelectedRuns] = useState<number[]>([])
  const [filter, setFilter] = useState('')
  const [libraryFilter, setLibraryFilter] = useState('')
  const [leftTab, setLeftTab] = useState('nodes')
  const [targetFilter, setTargetFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [extraQuery, setExtraQuery] = useState<Record<string,string>>(emptyQuery)
  const [queryNumbers, setQueryNumbers] = useState<number[] | null>(null)
  const [queryError, setQueryError] = useState('')
  const [queryPending, setQueryPending] = useState(false)
  const queryParams = useMemo(() => ({...extraQuery, target: targetFilter, run_type: typeFilter}), [extraQuery,targetFilter,typeFilter])
  const hasQuery = Object.values(queryParams).some(v => v.trim())
  useEffect(() => {
    let active = true
    if (!hasQuery) { setQueryNumbers(null); setQueryError(''); setQueryPending(false); return }
    setQueryPending(true)
    const timer = setTimeout(() => queryAnalysisRuns(queryParams).then(data => { if (active) { setQueryNumbers(data.runs); setQueryError('') } }).catch(e => { if (active) { setQueryNumbers([]); setQueryError(message(e)) } }).finally(() => { if (active) setQueryPending(false) }), 300)
    return () => { active = false; clearTimeout(timer) }
  }, [queryParams, hasQuery, runs])
  const [workflows, setWorkflows] = useState<SavedAnalysisWorkflow[]>([])
  const [activeWorkflow, setActiveWorkflow] = useState<SavedAnalysisWorkflow | null>(null)
  const [workflowFilter, setWorkflowFilter] = useState('')
  const [saveOpen, setSaveOpen] = useState(false)
  const [workflowName, setWorkflowName] = useState('')
  const [workflowDescription, setWorkflowDescription] = useState('')
  const [panelWidth, setPanelWidth] = useState(300)
  const [resultsWidth, setResultsWidth] = useState(340)
  const [resultsHeight, setResultsHeight] = useState(650)
  const [stackedResults, setStackedResults] = useState(false)
  const resultsElement = useRef<HTMLElement>(null)
  const resultsResizeStart = useRef<{ coordinate: number; size: number } | null>(null)
  const setResultsSize = (size: number) => {
    const maximum = stackedResults ? 1200 : Math.min(640, Math.max(280, (gridElement.current?.clientWidth || 1200) - panelWidth - 436))
    const next = Math.round(Math.max(stackedResults ? 260 : 280, Math.min(maximum, size)))
    if (stackedResults) setResultsHeight(next)
    else setResultsWidth(next)
    store('local', stackedResults ? 'analysis-results-height' : 'analysis-results-width', String(next))
  }
  useEffect(() => {
    const width = Number(stored('local', 'analysis-results-width'))
    const height = Number(stored('local', 'analysis-results-height'))
    if (width >= 280 && width <= 640) setResultsWidth(width)
    if (height >= 260 && height <= 1200) setResultsHeight(height)
    const media = window.matchMedia('(max-width: 1279px)')
    const update = () => { setStackedResults(media.matches); resultsResizeStart.current = null }
    update(); media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const gridElement = useRef<HTMLDivElement>(null)
  const resizeStart = useRef<{ x: number; width: number } | null>(null)
  const setWidth = (width: number) => {
    const available = gridElement.current?.clientWidth || 1000
    const maximum = Math.min(520, Math.max(260, available - (window.innerWidth >= 1280 ? resultsWidth + 436 : 400)))
    const next = Math.round(Math.max(260, Math.min(maximum, width)))
    setPanelWidth(next)
    store('local', 'analysis-panel-width', String(next))
  }
  useEffect(() => {
    const saved = Number(stored('local', 'analysis-panel-width'))
    if (saved >= 260 && saved <= 520) setPanelWidth(saved)
  }, [])
  const [selected, setSelected] = useState<string | null>(null)
  // Nothing here competes with a run: Run and Batch convert wait for it to end
  // (the server refuses them too, and stops a job when a run starts).
  const runActive = useRunStatus(s => s.isRunning)
  // On a phone the canvas is for looking and tapping a node to edit it: a
  // drag scrolls the page instead of panning, and nodes stay where they are.
  const phone = useIsPhone()
  const [stopped, setStopped] = useState('')
  const [formats, setFormats] = useState<Record<string, AnalysisRunFormat>>({})
  const [batch, setBatch] = useState<AnalysisBatch>({ state: 'idle', runs: [] })
  const [converter, setConverter] = useState(false)
  const [schema, setSchema] = useState<AnalysisSchema | null>(null)
  const [schemaRun, setSchemaRun] = useState<number | null>(null)
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [progress, setProgress] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [savedGraph, setSavedGraph] = useState('')
  const [resultGraph, setResultGraph] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const flow = useRef<ReactFlowInstance<FlowNode> | null>(null)
  const schemaRequest = useRef(0)
  const applyGraph = useCallback((graph: AnalysisGraph, catalog: AnalysisContext['catalog']) => {
    setNodes(graph.nodes.map(n => ({ id: n.id, type: 'analysis', position: n.position, data: { kind: n.kind, params: n.params, spec: catalog[n.kind] } })))
    setEdges(graph.edges)
    setSelected(null)
    setTimeout(() => flow.current?.fitView({ padding: 0.15 }), 100)
  }, [setNodes, setEdges])
  const refreshRuns = useCallback(async () => {
    const [data, kinds] = await Promise.all([getRuns(), getAnalysisRunFormats()])
    setRuns(data.runs); setConverter(data.rureader_available); setFormats(kinds.runs)
  }, [])
  useEffect(() => {
    let active = true
    Promise.all([getAnalysisContext(), getRuns(), getAnalysisBatch(), getAnalysisWorkflows(), getAnalysisRunFormats()]).then(([ctx, data, status, library, kinds]) => {
      if (!active) return
      setWorkflows(library.workflows); setActiveWorkflow(ctx.active_workflow); setContext(ctx); setRuns(data.runs); setConverter(data.rureader_available); setBatch(status); setFormats(kinds.runs)
      let graph = ctx.examples?.find(w => w.id === 'spectrum')?.graph || starterGraph(ctx.catalog)
      if (ctx.workflow) {
        try { graph = readGraph(ctx.workflow, ctx.catalog) } catch (e) { setError(message(e)) }
      }
      applyGraph(graph, ctx.catalog)
      setSavedGraph(graphKey(graph))
      if (ctx.warning) setError(ctx.warning)
      const pending = stored('session', `analysis-job-${ctx.project_id}`)
      if (pending) setJobId(pending)
    }).catch(e => { if (active) setError(message(e)) })
    return () => { active = false }
  }, [applyGraph])
  const graph: AnalysisGraph = useMemo(() => ({ version: 1,
    nodes: nodes.map(n => ({ id: n.id, kind: n.data.kind, params: n.data.params, position: n.position })),
    edges: edges.map(e => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle!, targetHandle: e.targetHandle! })),
  }), [nodes, edges])
  const graphString = useMemo(() => graphKey(graph), [graph])
  const calculationString = useMemo(() => calculationKey(graph), [graph])
  const dirty = !!context && graphString !== savedGraph
  useEffect(() => {
    if (!dirty) return
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])
  useEffect(() => {
    if (!jobId || !context) return
    let active = true, timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const job = await getAnalysisJob(jobId)
        if (!active) return
        setProgress(job.node ? `Processing ${job.node}…` : 'Starting analysis…')
        if (job.state === 'running') { timer = setTimeout(poll, 1000); return }
        if (job.result) { setResult(job.result); setResultGraph(calculationKey(job.result.workflow)); setNotice('Analysis completed.'); setSelected(null) }
        if (job.state === 'failed') setError(job.message || 'Analysis failed.')
        if (job.state === 'stopped') setStopped(job.message || 'Stopped: a run started.')
        store('session', `analysis-job-${context.project_id}`, null)
        setJobId(null); setProgress('')
      } catch (e) {
        if (!active) return
        setError(message(e)); setJobId(null)
        store('session', `analysis-job-${context.project_id}`, null)
      }
    }
    poll()
    return () => { active = false; clearTimeout(timer) }
  }, [jobId, context])
  useEffect(() => {
    if (batch.state !== 'running') return
    let active = true, timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const state = await getAnalysisBatch()
        if (!active) return
        setBatch(state)
        if (state.state !== 'running') await refreshRuns()
      } catch (e) { if (active) setError(message(e)) }
      if (active) timer = setTimeout(poll, 1500)
    }
    timer = setTimeout(poll, 1000)
    return () => { active = false; clearTimeout(timer) }
  }, [batch.state, refreshRuns])
  const onNodeClick = useCallback((_: React.MouseEvent, node: FlowNode) => setSelected(node.id), [])
  const onPaneClick = useCallback(() => setSelected(null), [])
  const onFlowInit = useCallback((instance: ReactFlowInstance<FlowNode>) => { flow.current = instance }, [])
  const onConnect = useCallback((connection: Connection) => {
    setEdges(current => addEdge({ ...connection, id: crypto.randomUUID() }, current))
  }, [setEdges])
  const isValidConnection = useCallback((connection: Edge | Connection) => {
    const source = nodes.find(n => n.id === connection.source), target = nodes.find(n => n.id === connection.target)
    if (!source || !target || source.id === target.id || !connection.sourceHandle || !connection.targetHandle) return false
    if (source.data.spec.outputs[connection.sourceHandle] !== target.data.spec.inputs[connection.targetHandle]) return false
    if (edges.some(e => e.target === target.id && e.targetHandle === connection.targetHandle)) return false
    const visited = new Set<string>()
    const reachesSource = (id: string): boolean => {
      if (id === source.id) return true
      if (visited.has(id)) return false
      visited.add(id)
      return edges.filter(e => e.source === id).some(e => reachesSource(e.target))
    }
    return !reachesSource(target.id)
  }, [nodes, edges])
  const action = async (fn: () => Promise<void>) => {
    setError(''); setNotice(''); setStopped(''); setBusy(true)
    try { await fn() } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  const addNode = (kind: string, drop?: { x: number; y: number }) => {
    if (!context || !context.catalog[kind] || nodes.length >= 50) return
    const spec = context.catalog[kind], id = `${kind}-${crypto.randomUUID().slice(0, 8)}`
    const position = flow.current?.screenToFlowPosition(drop || { x: window.innerWidth / 2, y: window.innerHeight / 2 }) || { x: 100, y: 100 }
    setNodes(current => [...current, { id, type: 'analysis', position, data: { kind, spec, params: Object.fromEntries(Object.entries(spec.params).map(([key, p]) => [key, p.default])) } }])
    setSelected(id)
  }
  const current = nodes.find(n => n.id === selected)
  const updateParam = (key: string, value: number | string) => setNodes(all => all.map(n => n.id === selected ? { ...n, data: { ...n.data, params: { ...n.data.params, [key]: value } } } : n))
  const matchesQuery = (r: RunSummary) => queryNumbers === null || queryNumbers.includes(r.run_number)
  const queryRuns = runs.filter(r => r.complete && matchesQuery(r))
  const visibleRuns = runs.filter(r => matchesQuery(r) && `${r.run_number} ${r.target_name || ''} ${r.run_type || ''}`.toLowerCase().includes(filter.toLowerCase()))
  const targets = Array.from(new Set(runs.map(r => r.target_name).filter((v): v is string => !!v))).sort()
  const runTypes = Array.from(new Set(runs.map(r => r.run_type).filter((v): v is string => !!v))).sort()
  const running = !!jobId || batch.state === 'running'
  const useRuns = (query = false) => {
    const target = current?.data.kind === 'load_runs' ? current : nodes.find(n => n.data.kind === 'load_runs')
    if (!target) { setError('Add a Load Run(s) node first.'); return }
    setNodes(all => all.map(n => n.id === target.id ? { ...n, data: { ...n.data, params: { ...n.data.params, ...(query ? queryParams : { ...emptyQuery, runs: [...selectedRuns].sort((a,b) => a-b).join(', '), target: '', run_type: '' }) } } } : n))
    setSelected(target.id); setNotice(query ? `Run query applied to ${target.id}. It refreshes when the pipeline runs.` : `Selected runs applied to ${target.id}.`)
  }
  const inspect = async (run: number) => {
    const requestId = ++schemaRequest.current
    setSchemaRun(run); setSchema(null)
    try { const data = await getAnalysisSchema(run); if (schemaRequest.current === requestId) setSchema(data) }
    catch (e) { if (schemaRequest.current === requestId) setError(message(e)) }
  }
  const saveNamed = (copy: boolean) => action(async () => {
    const row = await storeAnalysisWorkflow({ name: workflowName, description: workflowDescription, graph }, copy ? undefined : activeWorkflow?.id)
    setActiveWorkflow(row); setSavedGraph(graphString); setSaveOpen(false)
    setWorkflows(all => [...all.filter(w => w.id !== row.id), row])
    setNotice(`Saved “${row.name}” in this experiment.`)
  })
  const loadNamed = (workflow: SavedAnalysisWorkflow) => {
    if (dirty && !window.confirm('Replace unsaved changes with this saved workflow?')) return
    action(async () => {
      const row = await loadAnalysisWorkflow(workflow.id)
      const next = readGraph(row.graph, context!.catalog)
      applyGraph(next, context!.catalog); setActiveWorkflow(row); setSavedGraph(graphKey(next))
      setResult(null); setResultGraph(''); setNotice(`Loaded “${row.name}”.`)
    })
  }
  const onROI = useCallback((id: string, min: number, max: number) => {
    setNodes(all => all.map(n => n.id === id ? {...n,data:{...n.data,params:{...n.data.params,min,max}}} : n))
    setSelected(id); setNotice('ROI updated. Run pipeline to recalculate.')
  }, [setNodes])
  if (!context) return <div className="p-8">{error ? <p role="alert" className="text-destructive">{error}</p> : 'Connecting to the experiment…'}</div>
  return <TooltipProvider delayDuration={150} skipDelayDuration={300}><div className="analysis-workspace">
    <PageHeader className="mb-0" title="Analysis"
      description={<>{activeWorkflow?.name || workflowName || 'Workflows over the converted runs'} · <span className="break-all">{context.project_name}</span></>}
      actions={<>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => { setWorkflowName(activeWorkflow?.name || workflowName || 'Spectrum & yield'); setWorkflowDescription(activeWorkflow?.description || workflowDescription); setSaveOpen(true) }}><Save size={14} className="mr-2" />{dirty ? 'Save workflow •' : 'Save workflow'}</Button>
        <Button variant="outline" size="sm" onClick={() => download('lunadaq-workflow.json', JSON.stringify(graph, null, 2))}><Download size={14} className="mr-2" />Export</Button>
        <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}><Upload size={14} className="mr-2" />Import</Button>
        <input ref={fileInput} className="hidden" type="file" accept=".json,application/json" aria-label="Import workflow" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; action(async () => { if (file.size > 1_000_000) throw new Error('Workflow exceeds 1 MB.'); const next = readGraph(JSON.parse(await file.text()), context.catalog); applyGraph(next, context.catalog); setActiveWorkflow(null); setNotice('Workflow imported. Save to keep it in this experiment.') }) }} />
        <Button size="sm" disabled={busy || running || runActive || !nodes.length || !!context.uproot_missing} title={runActive ? 'A run is in progress' : undefined} onClick={() => action(async () => { const job = await executeAnalysis(graph); store('session', `analysis-job-${context.project_id}`, job.id); setJobId(job.id); setProgress('Starting analysis…') })}>{jobId ? <Loader2 size={14} className="mr-2 animate-spin" /> : <Play size={14} className="mr-2" />}Run pipeline</Button>
      </>} />
    {runActive && <div role="status" className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning"><AlertTriangle size={16} className="mt-0.5 shrink-0" /><span>A run is in progress. Analysis and batch conversion wait until it stops, so they never compete with the acquisition{jobId ? '; the running job stops at its next chunk of events' : ''}.</span></div>}
    {context.uproot_missing && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{context.uproot_missing} Workflows can still be edited and saved.</div>}
    {stopped && <div role="status" className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">{stopped}</div>}
    {error && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{error}</div>}
    {(notice || progress) && <p role="status" className="text-sm text-success">{progress || notice}</p>}
    <Dialog open={saveOpen} onOpenChange={setSaveOpen}><DialogContent><DialogHeader><DialogTitle>Save workflow</DialogTitle><DialogDescription>Keep a named workflow in {context.project_name}. Save a copy to create a separate variant.</DialogDescription></DialogHeader>
      <label className="text-sm space-y-1">Name<Input aria-label="Workflow name" maxLength={100} value={workflowName} onChange={e => setWorkflowName(e.target.value)} /></label>
      <label className="text-sm space-y-1">Description<Textarea aria-label="Workflow description" maxLength={2000} value={workflowDescription} onChange={e => setWorkflowDescription(e.target.value)} placeholder="What does this workflow analyse?" /></label>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter>{activeWorkflow && <Button variant="outline" disabled={busy || !workflowName.trim()} onClick={() => saveNamed(true)}>Save a copy</Button>}<Button disabled={busy || !workflowName.trim()} onClick={() => saveNamed(false)}>{activeWorkflow ? 'Update workflow' : 'Save workflow'}</Button></DialogFooter>
    </DialogContent></Dialog>
    <div className="analysis-grid" ref={gridElement} style={{ '--analysis-panel-width': `${panelWidth}px`, '--analysis-results-width': `${resultsWidth}px`, '--analysis-results-height': `${resultsHeight}px` } as CSSProperties}>
      <aside className="rounded-xl border bg-card overflow-hidden flex flex-col min-h-0">
        <div className="flex border-b p-2 gap-1 flex-wrap" role="tablist" aria-label="Analysis library">{[['nodes', 'Node library'], ['runs', `Runs (${runs.length})`], ['workflows', 'Workflows']].map(([tab, label]) => <Button key={tab} size="sm" className="px-2 text-xs" role="tab" aria-selected={leftTab === tab} tabIndex={leftTab === tab ? 0 : -1} onKeyDown={e => {
          const tabs = ['nodes', 'runs', 'workflows']; const index = tabs.indexOf(tab)
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
            e.preventDefault(); const next = e.key === 'Home' ? 0 : e.key === 'End' ? 2 : (index + (e.key === 'ArrowRight' ? 1 : 2)) % 3
            setLeftTab(tabs[next]); (e.currentTarget.parentElement?.children[next] as HTMLElement)?.focus()
          }
        }} variant={leftTab === tab ? 'secondary' : 'ghost'} onClick={() => setLeftTab(tab)}>{label}</Button>)}</div>
        <div className="overflow-auto p-3 space-y-3 flex-1">
          {leftTab === 'nodes' ? <>
            <Input placeholder="Search nodes…" aria-label="Search nodes" value={libraryFilter} onChange={e => setLibraryFilter(e.target.value)} />
            {Object.entries(context.catalog).filter(([, spec]) => `${spec.label} ${spec.group}`.toLowerCase().includes(libraryFilter.toLowerCase())).map(([kind, spec]) => <HelpTooltip key={kind} content={spec.description}><button draggable onDragStart={e => { e.dataTransfer.setData('application/lunadaq-node', kind); e.dataTransfer.effectAllowed = 'copy' }} onClick={() => addNode(kind)} className="w-full rounded-lg border p-3 text-left hover:border-primary hover:bg-primary/5 transition-colors"><div className="flex items-center justify-between"><span className="font-medium text-sm">{spec.label}</span><Plus size={14} className="text-primary shrink-0" /></div><p className="mt-1 text-xs leading-relaxed text-muted-foreground line-clamp-2">{spec.description}</p></button></HelpTooltip>)}
            <p className="text-xs text-muted-foreground">Drag a node onto the canvas.</p>
          </> : leftTab === 'workflows' ? <>
            <Input aria-label="Search workflows" placeholder="Search workflows…" value={workflowFilter} onChange={e => setWorkflowFilter(e.target.value)} />

            {!workflows.length && <p className="text-sm text-muted-foreground py-4">No saved workflows.</p>}
            {workflows.filter(w => `${w.name} ${w.description}`.toLowerCase().includes(workflowFilter.toLowerCase())).map(w => <article key={w.id} className={`rounded-lg border p-3 space-y-2 ${activeWorkflow?.id === w.id ? 'border-primary bg-primary/5' : ''}`}><h3 className="font-medium text-sm break-words">{w.name}{activeWorkflow?.id === w.id && <span className="ml-2 text-xs text-primary">Current</span>}</h3><p className="text-xs text-muted-foreground whitespace-pre-wrap break-words">{w.description}</p><Button variant="outline" size="sm" disabled={busy || running} onClick={() => loadNamed(w)}>Load workflow</Button></article>)}
            <h3 className="text-xs font-semibold pt-3">Examples</h3>
            {(context.examples || []).filter(w => `${w.name} ${w.description}`.toLowerCase().includes(workflowFilter.toLowerCase())).map(w => <article key={w.id} className="rounded-lg border p-3 space-y-2"><div className="flex justify-between gap-2"><h4 className="text-sm font-medium">{w.name}</h4><HelpTooltip content={w.description}><button type="button" aria-label={`About ${w.name}`} className="text-muted-foreground hover:text-foreground"><Info size={14} /></button></HelpTooltip></div><Button size="sm" variant="outline" disabled={busy || running} onClick={() => { if (dirty && !window.confirm('Replace unsaved changes with this example?')) return; applyGraph(readGraph(w.graph,context.catalog),context.catalog); setActiveWorkflow(null); setResult(null); setWorkflowName(w.name); setWorkflowDescription([w.description, '', 'Setup:', ...(w.setup || []).map(step => `• ${step}`)].join('\n')); setNotice('Template loaded. Choose runs and configure the analysis settings.'); }}>Load template</Button><details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Setup requirements</summary><ul className="mt-2 list-disc space-y-2 pl-4">{(w.setup || []).map(step => <li key={step}>{step}</li>)}</ul></details></article>)}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => action(async () => setWorkflows((await getAnalysisWorkflows()).workflows))}><RefreshCw size={14} className="mr-2" />Refresh workflows</Button>
          </> : <>
            <RunQuery target={targetFilter} runType={typeFilter} targets={targets} runTypes={runTypes} fields={extraQuery}
              onTarget={setTargetFilter} onType={setTypeFilter} onField={(key,value) => setExtraQuery(q => ({...q,[key]:value}))}
              onReset={() => { setTargetFilter(''); setTypeFilter(''); setExtraQuery(emptyQuery) }} onApply={() => useRuns(true)}
              count={queryRuns.length} pending={queryPending} error={queryError} active={!!hasQuery} />
            <div className="flex gap-2"><Input placeholder="Run, target or type…" aria-label="Filter runs" value={filter} onChange={e => setFilter(e.target.value)} /><Button variant="ghost" size="icon" aria-label="Refresh runs" onClick={() => action(refreshRuns)}><RefreshCw size={15} /></Button></div>
            <div className="flex justify-between text-xs"><button className="text-primary pointer-coarse:min-h-11" onClick={() => setSelectedRuns(visibleRuns.filter(r => r.complete).slice(0, 100).map(r => r.run_number))}>Select visible (up to 100)</button><button className="pointer-coarse:min-h-11" onClick={() => setSelectedRuns([])}>Clear</button></div>
            <Button size="sm" className="w-full" disabled={!selectedRuns.length} onClick={() => useRuns()}>Use {selectedRuns.length} selected runs</Button>
            <Button size="sm" variant="outline" className="w-full" disabled={busy || running || runActive || !converter || !selectedRuns.length} onClick={() => action(async () => { await startAnalysisBatch(selectedRuns); setBatch(await getAnalysisBatch()) })}>Batch convert to ROOT</Button>
            <p className="text-xs text-muted-foreground">{!converter ? 'ROOT converter unavailable.' : runActive ? 'Batch conversion waits for the run to end.' : 'SIS3316 runs (HDF5) are skipped: RUReader converts .caendat only.'}</p>
            {batch.state !== 'idle' && <details open={batch.state === 'running'} className="rounded border p-2 text-xs"><summary className="cursor-pointer">Batch: {batch.state}</summary>{batch.runs.map(row => <details key={row.run} className="mt-2"><summary>Run {row.run}: {row.state}</summary><pre className="whitespace-pre-wrap break-words max-h-48 overflow-auto mt-1">{row.message}</pre></details>)}</details>}
            {!runs.length && <p className="text-sm text-muted-foreground py-6">No runs in this experiment yet.</p>}
            {visibleRuns.map(run => { const kind = formats[String(run.run_number)]; const blocked = kind && !kind.analysable; return <div key={run.run_number} className="rounded-lg border p-3 space-y-2"><label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 h-4 w-4 accent-primary" checked={selectedRuns.includes(run.run_number)} disabled={!run.complete || !!blocked} onChange={e => setSelectedRuns(all => e.target.checked ? [...all, run.run_number] : all.filter(n => n !== run.run_number))} /><span className="min-w-0"><strong>Run {run.run_number}</strong><span className="block text-xs text-muted-foreground break-words">{run.target_name || 'No target'} · {run.run_type || 'No type'} · {blocked ? <span className="text-warning">Not analysable: {kind.reason}</span> : run.complete ? run.converted ? 'ROOT ready' : run.has_data ? 'Needs conversion' : 'No raw data' : 'In progress'}</span></span></label><div className="flex justify-between text-xs"><Link href={`/logbook/${run.run_number}`} className="text-muted-foreground hover:underline">Logbook ↗</Link>{run.converted && run.complete && <button className="text-primary" onClick={() => inspect(run.run_number)}>Inspect ROOT</button>}</div></div> })}
          </>}
        </div>
      </aside>
      <div className="analysis-resize-handle" role="separator" aria-label="Resize analysis library" aria-orientation="vertical" aria-valuemin={260} aria-valuemax={520} aria-valuenow={panelWidth} tabIndex={0}
        onPointerDown={e => { resizeStart.current = { x: e.clientX, width: panelWidth }; e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault() }}
        onPointerMove={e => { if (resizeStart.current) setWidth(resizeStart.current.width + e.clientX - resizeStart.current.x) }}
        onPointerUp={e => { resizeStart.current = null; e.currentTarget.releasePointerCapture(e.pointerId) }} onPointerCancel={() => { resizeStart.current = null }}
        onKeyDown={e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); setWidth(e.key === 'Home' ? 260 : e.key === 'End' ? 520 : panelWidth + (e.key === 'ArrowRight' ? 20 : -20)) } }}><GripVertical size={16} /></div>
      <section className="flex flex-col min-w-0 rounded-xl border overflow-hidden bg-muted/20">
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b bg-card text-xs"><span className="text-muted-foreground">{nodes.length} nodes · {edges.length} connections</span><span className="text-muted-foreground">Click a node to edit</span></div>
        <div className="flex-1 min-h-0" onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }} onDrop={e => { e.preventDefault(); addNode(e.dataTransfer.getData('application/lunadaq-node'), {x:e.clientX,y:e.clientY}) }}>
          <ReactFlow<FlowNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} isValidConnection={isValidConnection} onNodeClick={onNodeClick} onPaneClick={onPaneClick} onInit={onFlowInit} fitView panOnDrag={!phone} nodesDraggable={!phone} preventScrolling={!phone} minZoom={0.2} maxZoom={2} defaultEdgeOptions={edgeDefaults} deleteKeyCode={['Backspace', 'Delete']}>
            <Background gap={20} size={1} /><Controls /><MiniMap style={minimapStyle} pannable zoomable maskStrokeColor="hsl(var(--primary))" maskStrokeWidth={1} nodeColor="hsl(var(--primary) / 0.45)" maskColor="hsl(var(--muted-foreground) / 0.12)" />
          </ReactFlow>
        </div>

      </section>
      <div className="analysis-resize-handle analysis-results-resize" role="separator" aria-label="Resize analysis results" aria-orientation={stackedResults ? 'horizontal' : 'vertical'} aria-valuemin={stackedResults ? 260 : 280} aria-valuemax={stackedResults ? 1200 : 640} aria-valuenow={stackedResults ? resultsHeight : resultsWidth} tabIndex={0}
        onPointerDown={e => { const rect = resultsElement.current?.getBoundingClientRect(); resultsResizeStart.current = { coordinate: stackedResults ? e.clientY : e.clientX, size: (stackedResults ? rect?.height : rect?.width) || (stackedResults ? resultsHeight : resultsWidth) }; e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault() }}
        onPointerMove={e => { const start = resultsResizeStart.current; if (start) setResultsSize(start.size + (stackedResults ? e.clientY - start.coordinate : start.coordinate - e.clientX)) }}
        onPointerUp={e => { resultsResizeStart.current = null; e.currentTarget.releasePointerCapture(e.pointerId) }} onPointerCancel={() => { resultsResizeStart.current = null }}
        onKeyDown={e => { const decrease = stackedResults ? 'ArrowUp' : 'ArrowRight'; const increase = stackedResults ? 'ArrowDown' : 'ArrowLeft'; if ([decrease, increase, 'Home', 'End'].includes(e.key)) { e.preventDefault(); setResultsSize(e.key === 'Home' ? (stackedResults ? 260 : 280) : e.key === 'End' ? (stackedResults ? 1200 : 640) : (stackedResults ? resultsHeight : resultsWidth) + (e.key === increase ? 20 : -20)) } }}>{stackedResults ? <GripHorizontal size={16} /> : <GripVertical size={16} />}</div>
      <aside ref={resultsElement} className="analysis-results-panel rounded-xl border bg-card p-4 overflow-auto space-y-5">
        {current && <section className="space-y-3 border-b pb-5"><div className="flex items-center justify-between"><h2 className="font-semibold">{current.data.spec.label}</h2><div className="flex"><Button size="icon" variant="ghost" aria-label="Delete selected node" onClick={() => { setNodes(all => all.filter(n => n.id !== current.id)); setEdges(all => all.filter(e => e.source !== current.id && e.target !== current.id)); setSelected(null) }}><Trash2 size={15} /></Button><Button size="icon" variant="ghost" aria-label="Close inspector" onClick={() => setSelected(null)}><X size={15} /></Button></div></div><HelpTooltip content={current.data.spec.description}><button type="button" aria-label="About this node" className="text-muted-foreground hover:text-foreground"><Info size={14} /></button></HelpTooltip>
          {Object.entries(current.data.spec.params).map(([key, spec]) => <label key={`${current.id}-${key}`} className="block text-xs space-y-1"><span>{spec.label}</span>{spec.options ? <select className="w-full rounded border bg-background p-2" value={current.data.params[key] ?? spec.default} onChange={e => updateParam(key,e.target.value)}>{spec.options.map(o => <option key={o} value={o}>{o || 'Any'}</option>)}</select> : <Input type={spec.type === 'number' ? 'number' : 'text'} step="any" value={current.data.params[key] ?? spec.default} onChange={e => updateParam(key, spec.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)} />}</label>)}
          {current.data.kind === 'load_runs' && <Button variant="outline" size="sm" onClick={() => setLeftTab('runs')}>Choose runs & convert</Button>}
          <p className="text-[10px] text-muted-foreground">Node: {current.id}</p>
        </section>}
        {schemaRun !== null && <section className="border-b pb-4 text-xs space-y-2"><div className="flex justify-between"><h2 className="font-semibold">Run {schemaRun} · ROOT schema</h2><button aria-label="Close ROOT schema" onClick={() => { schemaRequest.current++; setSchemaRun(null) }}>×</button></div>{schema ? schema.files.map(file => <div key={file.name} className="space-y-2"><strong className="break-all">{file.name}</strong>{file.trees.map(tree => <div key={tree.name}><p>{tree.name} · {tree.entries.toLocaleString()} events</p><Button size="sm" variant="outline" onClick={() => { const source = current?.data.kind === 'load_runs' ? current : nodes.find(n => n.data.kind === 'load_runs'); if (!source) {setError('Add a Load Run(s) node first.'); return} setNodes(all => all.map(n => n.id === source.id ? {...n,data:{...n.data,params:{...n.data.params,tree:tree.name,file:file.name,energy:tree.branches.includes(String(source.data.params.energy || 'Energy')) ? String(source.data.params.energy || 'Energy') : tree.branches.includes('EnergyLong') ? 'EnergyLong' : 'Energy',...emptyQuery,target:'',run_type:'',runs:String(schemaRun)}}} : n)); setSelected(source.id); setNotice(`Loaded ${tree.name} from run ${schemaRun}.`); }}>Use tree</Button><p className="text-muted-foreground break-words">{tree.branches.join(', ')}</p></div>)}</div>) : <p>Reading schema…</p>}</section>}
        <Results result={result} stale={!!result && calculationString !== resultGraph} roiNodes={nodes.filter(n => ['roi','spectrum_roi','sideband','peak_fit','rate_time'].includes(n.data.kind)).map(n => ({id:n.id,label:n.data.spec.label,min:Number(n.data.params.min ?? n.data.spec.params.min.default),max:Number(n.data.params.max ?? n.data.spec.params.max.default)}))} onROI={onROI} />
      </aside>
    </div>
  </div></TooltipProvider>
}
