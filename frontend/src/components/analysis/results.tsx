'use client'

import { useState } from 'react'
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ScatterChart, Scatter, ErrorBar } from 'recharts'
import { AnalysisResult, AnalysisPlot } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { download } from './graph'

const colors = ['#0d9488', '#d97706', '#6366f1', '#e11d48', '#0284c7', '#65a30d']
function csv(plot: AnalysisPlot) {
  if (plot.kind === 'series') return 'run,x,y,statistical_error\n' + plot.points.map(p => [p.run, p.x, p.y, p.error].join(',')).join('\n')
  return 'run,bin_low_keV,bin_high_keV,counts\n' + plot.series.flatMap(s => s.counts.map((n, i) => [s.run, plot.edges[i], plot.edges[i + 1], n].join(','))).join('\n')
}

function Plot({ plot }: { plot: AnalysisPlot }) {
  const data = plot.kind === 'histogram' ? plot.edges.slice(0, -1).map((edge, i) => ({
    energy: (edge + plot.edges[i + 1]) / 2,
    ...Object.fromEntries(plot.series.map(s => [`Run ${s.run}`, s.counts[i]])),
  })) : plot.points
  return <article className="rounded-lg border bg-background p-3 space-y-3">
    <div className="flex items-center justify-between gap-2"><h3 className="font-medium text-sm">{plot.title}</h3>
      <Button size="sm" variant="ghost" onClick={() => download(`${plot.node}.csv`, csv(plot), 'text/csv')}>CSV</Button></div>
    <div className="h-64 w-full text-xs">
      <ResponsiveContainer width="100%" height="100%">
        {plot.kind === 'histogram' ? <LineChart data={data} margin={{ top: 8, right: 16, bottom: 20, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
          <XAxis dataKey="energy" type="number" domain={['dataMin', 'dataMax']} label={{ value: 'Energy (keV)', position: 'bottom', offset: 0 }} tickFormatter={n => Number(n).toPrecision(3)} />
          <YAxis width={42} /><Tooltip /><Legend verticalAlign="top" />
          {plot.series.map((s, i) => <Line key={s.run} dataKey={`Run ${s.run}`} type="step" stroke={colors[i % colors.length]} dot={false} isAnimationActive={false} />)}
        </LineChart> : <ScatterChart margin={{ top: 8, right: 16, bottom: 20, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
          <XAxis dataKey="x" type="number" name={plot.x_label} domain={['auto', 'auto']} label={{ value: plot.x_label, position: 'bottom', offset: 0 }} tickFormatter={n => Number(n).toPrecision(3)} />
          <YAxis dataKey="y" type="number" name={plot.y_label} width={48} tickFormatter={n => Number(n).toPrecision(2)} />
          <Tooltip content={({ active, payload }) => { const p = payload?.[0]?.payload; return active && p ? <div className="border rounded bg-background p-2">Run {p.run}<br />{plot.x_label}: {p.x.toPrecision(6)}<br />{plot.y_label}: {p.y.toPrecision(6)} ± {p.error.toPrecision(3)}</div> : null }} />
          <Scatter data={data} fill={colors[0]} isAnimationActive={false}><ErrorBar dataKey="error" direction="y" width={4} stroke={colors[0]} /></Scatter>
        </ScatterChart>}
      </ResponsiveContainer>
    </div>
    <p className="text-xs text-muted-foreground">{plot.kind === 'histogram' ? 'Counts per bin • each run shown separately' : `${plot.y_label} • error bars: counting statistics only`}</p>
  </article>
}

export function Results({ result, stale }: { result: AnalysisResult | null; stale: boolean }) {
  const [tab, setTab] = useState('charts')
  return <div className="space-y-4">
    <div className="flex items-center justify-between"><h2 className="font-semibold">Results</h2>
      {result && <Button variant="outline" size="sm" onClick={() => download('analysis-results.json', JSON.stringify(result, null, 2))}>Export results</Button>}</div>
    {stale && result && <p className="text-xs text-amber-600">Workflow changed. Run again to update these results.</p>}
    <div className="flex gap-1">{['charts', 'summary', 'raw'].map(t => <Button key={t} size="sm" variant={tab === t ? 'secondary' : 'ghost'} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</Button>)}</div>
    {!result ? <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground leading-relaxed">Run your workflow to see calibrated spectra and yield scans here. Results include the workflow, source filenames, and saved run metadata.</div> : <>
      {tab === 'charts' && (result.plots.length ? result.plots.map(p => <Plot key={p.node} plot={p} />) : <p className="text-sm text-muted-foreground">Add a Histogram or Plot Series node to produce charts.</p>)}
      {tab === 'summary' && <>{Object.entries(result.nodes).map(([id, values]) => <div key={id} className="rounded border p-3"><h3 className="text-sm font-medium mb-2">{id}</h3><pre className="text-xs overflow-auto max-h-60">{JSON.stringify(values, null, 2)}</pre></div>)}<ul className="text-xs text-muted-foreground space-y-2">{result.notes.map(note => <li key={note}>{note}</li>)}</ul></>}
      {tab === 'raw' && <pre className="text-xs overflow-auto max-h-[600px] border rounded p-3">{JSON.stringify(result, null, 2)}</pre>}
    </>}
  </div>
}
