'use client'

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ScatterChart, Scatter, ErrorBar, ReferenceArea } from 'recharts'
import { AnalysisResult, AnalysisPlot } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { download } from './graph'
import { HelpTooltip } from '@/components/ui/tooltip'

type ROI = { id: string; label: string; min: number; max: number }
type ROIProps = { roiNodes: ROI[]; onROI: (id: string, min: number, max: number) => void }
const colors = ['#0d9488', '#d97706', '#6366f1', '#e11d48', '#0284c7', '#65a30d']
function csv(plot: AnalysisPlot) {
  if (plot.kind !== 'histogram') return 'run,x,y,error\n' + plot.points.map(p => [p.run, p.x, p.y, p.error].join(',')).join('\n')
  return 'run,bin_low_keV,bin_high_keV,counts,error\n' + plot.series.flatMap(s => s.counts.map((n, i) => [s.run, plot.edges[i], plot.edges[i + 1], n, Math.sqrt(s.variance?.[i] ?? Math.max(0,n))].join(','))).join('\n')
}

const Plot = memo(function Plot({ plot, roiNodes, onROI }: { plot: AnalysisPlot } & ROIProps) {
  const element = useRef<HTMLElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: '200px' })
    if (element.current) observer.observe(element.current)
    return () => observer.disconnect()
  }, [])
  const [target, setTarget] = useState('')
  const [selection, setSelection] = useState<[number,number] | null>(null)
  const [dragging, setDragging] = useState(false)
  const roi = roiNodes.find(n => n.id === target)
  const updateDrag = (event: { activeLabel?: string | number } | null, start = false) => {
    if (!roi || !event || event.activeLabel === undefined) return
    const x = Number(event.activeLabel)
    if (!Number.isFinite(x)) return
    if (start) { setDragging(true); setSelection([x,x]) }
    else if (dragging) setSelection(prev => prev ? [prev[0],x] : null)
  }
  const finish = () => {
    if (dragging && selection && selection[0] !== selection[1]) onROI(target, Math.min(...selection), Math.max(...selection))
    setDragging(false); setSelection(null)
  }
  const data = useMemo(() => !visible ? [] : plot.kind === 'histogram' ? plot.edges.slice(0, -1).map((edge, i) => ({
    energy: (edge + plot.edges[i + 1]) / 2, fit: plot.fit?.[i],
    ...Object.fromEntries(plot.series.map(s => [`Run ${s.run}`, s.counts[i]])),
  })) : plot.points, [plot, visible])
  return <article ref={element} className="rounded-lg border bg-background p-3 space-y-2">
    <div className="flex items-center justify-between gap-2"><h3 className="font-medium text-sm">{plot.title}</h3>
      <Button size="sm" variant="ghost" onClick={() => download(`${plot.node}.csv`, csv(plot), 'text/csv')}>CSV</Button></div>
    {plot.kind === 'histogram' && roiNodes.length > 0 && <div className="space-y-1"><select aria-label={`ROI destination for ${plot.title}`} className="w-full text-xs rounded border bg-background p-1.5" value={target} onChange={e => setTarget(e.target.value)}><option value="">Select ROI node to edit…</option>{roiNodes.map(n => <option key={n.id} value={n.id}>{n.label} · {n.id}</option>)}</select>{roi && <div className="flex items-center gap-2 text-xs"><input aria-label={`ROI minimum for ${plot.title}`} className="min-w-0 w-1/2 border rounded bg-background p-1" type="number" value={roi.min} onChange={e => { const n=Number(e.target.value); if(e.target.value && n < roi.max) onROI(roi.id,n,roi.max) }} /><span>–</span><input aria-label={`ROI maximum for ${plot.title}`} className="min-w-0 w-1/2 border rounded bg-background p-1" type="number" value={roi.max} onChange={e => {const n=Number(e.target.value); if(e.target.value && n > roi.min) onROI(roi.id,roi.min,n)}} /><HelpTooltip content="Drag across the spectrum or enter bounds. Run pipeline to recalculate."><button type="button" aria-label="ROI selection help" className="text-muted-foreground underline decoration-dotted underline-offset-4">keV</button></HelpTooltip></div>}</div>}
    <div className={`h-64 w-full text-xs ${roi ? 'cursor-crosshair select-none' : ''}`}>
      {visible && <ResponsiveContainer width="100%" height="100%">
        {plot.kind === 'histogram' ? <LineChart data={data} margin={{ top: 8, right: 16, bottom: 20, left: 0 }} onMouseDown={e => updateDrag(e,true)} onMouseMove={e => updateDrag(e)} onMouseUp={finish} onMouseLeave={() => {setDragging(false);setSelection(null)}}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
          <XAxis dataKey="energy" type="number" domain={['dataMin', 'dataMax']} label={{ value: 'Energy (keV)', position: 'bottom', offset: 0 }} tickFormatter={n => Number(n).toPrecision(3)} />
          <YAxis width={42} /><Tooltip /><Legend verticalAlign="top" />
          {plot.series.map((s, i) => <Line key={s.run} dataKey={`Run ${s.run}`} type="step" stroke={colors[i % colors.length]} dot={false} isAnimationActive={false} />)}
          {plot.fit && <Line dataKey="fit" name="Fit" stroke="#e11d48" dot={false} isAnimationActive={false} />}
          {roi && <ReferenceArea x1={selection ? Math.min(...selection) : roi.min} x2={selection ? Math.max(...selection) : roi.max} fill="#0d9488" fillOpacity={0.16} />}
        </LineChart> : plot.kind === 'time' ? <TimeChart plot={plot} /> : <ScatterChart margin={{ top: 8, right: 16, bottom: 20, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
          <XAxis dataKey="x" type="number" name={plot.x_label} domain={['auto', 'auto']} label={{ value: plot.x_label, position: 'bottom', offset: 0 }} tickFormatter={n => Number(n).toPrecision(3)} />
          <YAxis dataKey="y" type="number" name={plot.y_label} width={48} tickFormatter={n => Number(n).toPrecision(2)} />
          <Tooltip content={({ active, payload }) => { const p = payload?.[0]?.payload; return active && p ? <div className="border rounded bg-background p-2">Run {p.run}<br />{plot.x_label}: {p.x.toPrecision(6)}<br />{plot.y_label}: {p.y.toPrecision(6)} ± {p.error.toPrecision(3)}</div> : null }} />
          <Scatter data={data} fill={colors[0]} isAnimationActive={false}><ErrorBar dataKey="error" direction="y" width={4} stroke={colors[0]} /></Scatter>
        </ScatterChart>}
      </ResponsiveContainer>}
    </div>
  </article>
}, (a,b) => a.plot === b.plot && a.onROI === b.onROI && JSON.stringify(a.roiNodes) === JSON.stringify(b.roiNodes))

export const Results = memo(function Results({ result, stale, ...roiProps }: { result: AnalysisResult | null; stale: boolean } & ROIProps) {
  const [tab, setTab] = useState('charts')
  return <div className="space-y-4">
    <div className="flex items-center justify-between"><h2 className="font-semibold">Results</h2>
      {result && <Button variant="outline" size="sm" onClick={() => download('analysis-results.json', JSON.stringify(result, null, 2))}>Export</Button>}</div>
    {stale && result && <p className="text-xs text-amber-600">Changed — run again.</p>}
    <div className="flex gap-1">{['charts', 'summary', 'raw'].map(t => <Button key={t} size="sm" variant={tab === t ? 'secondary' : 'ghost'} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</Button>)}</div>
    {!result ? <p className="text-sm text-muted-foreground py-4">No results yet.</p> : <>
      {tab === 'charts' && (result.plots.length ? result.plots.slice().reverse().map(p => <Plot key={p.node} plot={p} {...roiProps} />) : <p className="text-sm text-muted-foreground">Add a plot node.</p>)}
      {tab === 'summary' && <>{Object.entries(result.nodes).map(([id, values]) => <NodeSummary key={id} id={id} values={values} />)}<ul className="text-xs text-muted-foreground space-y-2">{result.notes.map(note => <li key={note}>{note}</li>)}</ul></>}
      {tab === 'raw' && <JsonPreview value={result} />}
    </>}
  </div>
}, (a,b) => a.result === b.result && a.stale === b.stale && a.onROI === b.onROI && JSON.stringify(a.roiNodes) === JSON.stringify(b.roiNodes))

// Dense current traces use paths, avoiding one SVG marker and error bar per sample.
// Nonzero uncertainties are still drawn for binned rate/yield data.
const TimeChart = memo(function TimeChart({ plot, ...size }: { plot: Exclude<AnalysisPlot, {kind: 'histogram'}>; width?: number; height?: number }) {
  const { data, runs, errors } = useMemo(() => {
    const rows = new Map<number, Record<string, number>>()
    const runs = Array.from(new Set(plot.points.map(p => p.run)))
    const errors = new Set<number>()
    for (const p of plot.points) {
      const row = rows.get(p.x) || { x: p.x }
      row[`run${p.run}`] = p.y; row[`error${p.run}`] = p.error
      if (p.error > 0) errors.add(p.run)
      rows.set(p.x, row)
    }
    return { data: Array.from(rows.values()).sort((a,b) => a.x-b.x), runs, errors }
  }, [plot])
  return <LineChart {...size} data={data} margin={{top:8,right:16,bottom:20,left:0}}>
    <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
    <XAxis dataKey="x" type="number" domain={['dataMin','dataMax']} label={{value:plot.x_label,position:'bottom',offset:0}} tickFormatter={n => Number(n).toPrecision(3)} />
    <YAxis width={48} tickFormatter={n => Number(n).toPrecision(2)} />
    <Tooltip content={({active,payload,label}) => active && payload?.length ? <div className="rounded-lg border bg-popover p-2 text-popover-foreground shadow-md"><p>{plot.x_label}: {Number(label).toPrecision(6)}</p>{payload.map(p => <p key={String(p.dataKey)} style={{color:p.color}}>{p.name}: {Number(p.value).toPrecision(6)} ± {Number(p.payload[String(p.dataKey).replace('run','error')]).toPrecision(3)}</p>)}</div> : null} />
    <Legend verticalAlign="top" />
    {runs.map((run,i) => <Line key={run} dataKey={`run${run}`} name={`Run ${run}`} stroke={colors[i%colors.length]} dot={false} connectNulls isAnimationActive={false}>{errors.has(run) && <ErrorBar dataKey={`error${run}`} direction="y" width={2} />}</Line>)}
  </LineChart>
})

const JsonPreview = memo(function JsonPreview({value}: {value: unknown}) {
  const preview = useMemo(() => {
    let truncated = false
    const text = JSON.stringify(value, (_key, v) => {
      if (Array.isArray(v) && v.length > 200) { truncated = true; return v.slice(0,200) }
      return v
    }, 2)
    return {text: text.slice(0,100_000), truncated: truncated || text.length > 100_000}
  }, [value])
  return <>{preview.truncated && <p className="text-xs text-muted-foreground">Preview shortened. Export includes all data.</p>}<pre className="text-xs overflow-auto max-h-96 rounded border p-3">{preview.text}</pre></>
})
function NodeSummary({id,values}: {id: string; values: unknown}) {
  const [open,setOpen] = useState(false)
  return <details className="rounded border p-3" onToggle={e => setOpen(e.currentTarget.open)}><summary className="cursor-pointer text-sm font-medium">{id}</summary>{open && <div className="mt-2"><JsonPreview value={values} /></div>}</details>
}
