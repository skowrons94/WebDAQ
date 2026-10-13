'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getRunDetail, getRuns, type RunSummary } from '@/lib/api'
import {
  channelValues, deletePreset, diffValues, loadPresets, savePreset, valuesFromDump,
  type ControlDiff, type HistoryEntry, type Preset,
} from '@/lib/tuner-history'
import { formatControl, type BoardTiming } from '@/components/tuner/units'
import type { BoardSettings } from '@/components/tuner/controls-panel'

function DiffTable({ diffs, timing, aLabel, bLabel }: { diffs: ControlDiff[]; timing: BoardTiming; aLabel: string; bLabel: string }) {
  if (!diffs.length) return <p className="text-sm text-muted-foreground">No differences in the Tuner&apos;s settings.</p>
  return (
    <table className="w-full text-sm">
      <thead><tr className="text-left text-xs text-muted-foreground"><th className="font-normal">Setting</th><th className="font-normal">{aLabel}</th><th className="font-normal">{bLabel}</th></tr></thead>
      <tbody>
        {diffs.map((d) => (
          <tr key={d.spec.id} className="border-t border-border/40">
            <td className="py-1 pr-2">{d.spec.label}</td>
            <td className="py-1 pr-2 font-mono text-xs">{formatControl(d.spec, d.a, timing)}</td>
            <td className="py-1 font-mono text-xs">{formatControl(d.spec, d.b, timing)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * P7: what was changed (with the resolution at the time) and a way back —
 * undo, named presets per firmware, and the difference from the settings a
 * past run used. Loading a preset or a run's values only fills the unsaved
 * changes: "Save all" applies them under the usual rules.
 */
export default function HistoryPanel({
  boardId, boardName, channel, dpp, timing, settings, pending, entries, currentFwhm,
  onUndo, onLoadValues, onClearHistory, onPresetSaved,
}: {
  boardId: string
  boardName: string
  channel: number
  dpp: string
  timing: BoardTiming
  settings: BoardSettings
  pending: Record<string, number>
  entries: HistoryEntry[]
  currentFwhm: { fwhm: number; unit: string } | null
  onUndo: (e: HistoryEntry) => void
  onLoadValues: (values: Record<string, number>, source: string) => void
  onClearHistory: () => void
  onPresetSaved?: () => void
}) {
  const [presets, setPresets] = useState<Preset[]>([])
  const [presetName, setPresetName] = useState('')
  const [compare, setCompare] = useState<string | null>(null)
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [run, setRun] = useState<string>('')
  const [runValues, setRunValues] = useState<Record<string, number> | null>(null)
  const [runNote, setRunNote] = useState<string | null>(null)

  useEffect(() => { setPresets(loadPresets(dpp)) }, [dpp])
  useEffect(() => {
    let alive = true
    getRuns().then((r) => { if (alive) setRuns((r.runs ?? []).filter((x) => x.has_data).sort((a, b) => b.run_number - a.run_number).slice(0, 50)) }).catch(() => {})
    return () => { alive = false }
  }, [])

  const now = useMemo(() => channelValues(dpp, settings, pending, channel), [dpp, settings, pending, channel])

  useEffect(() => {
    setRunValues(null); setRunNote(null)
    if (!run) return
    let alive = true
    getRunDetail(Number(run)).then((d) => {
      if (!alive) return
      const dumps = d.board_configs ?? []
      const mine = dumps.find((c) => c.file.includes(`${boardName}_${boardId}`))
        ?? dumps.find((c) => String(c.board?.id ?? c.board?.board_id ?? '') === String(boardId))
        ?? (dumps.length === 1 ? dumps[0] : undefined)
      if (!mine) { setRunNote(`Run ${run} has no register file for this board.`); return }
      const v = valuesFromDump(dpp, mine.registers, channel)
      if (!v) setRunNote(`Run ${run}'s register file has no channel ${channel} settings.`)
      setRunValues(v)
    }).catch(() => { if (alive) setRunNote(`Could not read run ${run}.`) })
    return () => { alive = false }
  }, [run, boardId, boardName, channel, dpp])

  const list = entries.slice().reverse()
  // One FWHM reading per Save all: entries saved together share a group, and
  // the change is shown once, on the group's last entry, against the next
  // group's "before" (or the fit now for the latest).
  const key = (e: HistoryEntry) => e.group ?? e.id
  const fwhmFor = (i: number): { before: number; after: number | null; n: number } | null => {
    const idx = entries.length - 1 - i
    const e = entries[idx]
    if (entries[idx + 1] && key(entries[idx + 1]) === key(e)) return null // not the group's last entry
    if (!e.written || e.fwhmBefore == null) return null
    let j = idx + 1
    while (j < entries.length && key(entries[j]) === key(e)) j++
    let n = 0
    for (let k = idx; k >= 0 && key(entries[k]) === key(e); k--) n++
    const next = entries[j]
    return { before: e.fwhmBefore, after: next ? next.fwhmBefore : (currentFwhm?.fwhm ?? null), n }
  }
  const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const cmpPreset = presets.find((p) => p.id === compare)

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3" data-testid="history-panel">
      <section aria-labelledby="hist-log" className="space-y-2 lg:col-span-1">
        <div className="flex items-center justify-between">
          <h3 id="hist-log" className="text-sm font-semibold">Changes</h3>
          {entries.length > 0 && <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onClearHistory}>Clear list</Button>}
        </div>
        {list.length === 0 ? (
          <p className="text-sm text-muted-foreground">Changes saved from the Tuner for this channel are listed here, with the resolution at the time when they reached the board. Undo stages the old value.</p>
        ) : (
          <ol className="max-h-72 space-y-1.5 overflow-auto pr-1">
            {list.map((e, i) => {
              const f = fwhmFor(i)
              return (
                <li key={e.id} className="flex items-start gap-2 rounded-md border px-2 py-1.5 text-sm">
                  <span className="mt-0.5 font-mono text-xs text-muted-foreground">{time(e.at)}</span>
                  <span className="flex-1">
                    {e.label}
                    <span className="block text-xs text-muted-foreground">
                      {e.written ? 'on the board' : 'from the next run · not applied yet'}
                      {f && ` · FWHM ${f.before.toFixed(2)}${f.after != null ? ` → ${f.after.toFixed(2)}` : ''} ${e.unit ?? ''}${f.n > 1 ? ` (all ${f.n} changes of this save together)` : ''}`}
                    </span>
                  </span>
                  <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => onUndo(e)}>Undo</Button>
                </li>
              )
            })}
          </ol>
        )}
      </section>

      <section aria-labelledby="hist-presets" className="space-y-2">
        <h3 id="hist-presets" className="text-sm font-semibold">Presets <span className="font-normal text-muted-foreground">({dpp}, this browser)</span></h3>
        <div className="flex items-end gap-2">
          <div className="flex flex-1 flex-col gap-1">
            <Label htmlFor="preset-name" className="text-xs">Name</Label>
            <Input id="preset-name" className="h-8" placeholder="e.g. HPGe-coax 4 µs" value={presetName} onChange={(e) => setPresetName(e.target.value)} />
          </div>
          <Button size="sm" disabled={!presetName.trim()} onClick={() => { savePreset(presetName.trim(), dpp, now); setPresets(loadPresets(dpp)); setPresetName(''); onPresetSaved?.() }}>Save current</Button>
        </div>
        {presets.length === 0 ? <p className="text-xs text-muted-foreground">No presets yet for {dpp}.</p> : (
          <ul className="space-y-1">
            {presets.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-1.5 text-sm">
                <span className="flex-1 truncate">{p.name}</span>
                <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => onLoadValues(p.values, `preset ${p.name}`)}>Load</Button>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setCompare(compare === p.id ? null : p.id)}>{compare === p.id ? 'Hide' : 'Compare'}</Button>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => { deletePreset(p.id); setPresets(loadPresets(dpp)); if (compare === p.id) setCompare(null) }}>Delete</Button>
              </li>
            ))}
          </ul>
        )}
        {cmpPreset && <DiffTable diffs={diffValues(dpp, now, cmpPreset.values)} timing={timing} aLabel="Now" bLabel={cmpPreset.name} />}
        <p className="text-xs text-muted-foreground">Loading fills the unsaved changes; &quot;Save all&quot; applies them.</p>
      </section>

      <section aria-labelledby="hist-run" className="space-y-2">
        <h3 id="hist-run" className="text-sm font-semibold">Compare with a past run</h3>
        <Select value={run} onValueChange={setRun}>
          <SelectTrigger className="h-8 w-full" aria-label="Past run"><SelectValue placeholder={runs.length ? 'Choose a run…' : 'No runs with data'} /></SelectTrigger>
          <SelectContent>
            {runs.map((r) => (
              <SelectItem key={r.run_number} value={String(r.run_number)}>
                Run {r.run_number}{r.start_time ? ` · ${r.start_time.slice(0, 16).replace('T', ' ')}` : ''}{r.run_type ? ` · ${r.run_type}` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {runNote && <p className="text-xs text-muted-foreground">{runNote}</p>}
        {runValues && (
          <>
            <DiffTable diffs={diffValues(dpp, now, runValues)} timing={timing} aLabel="Now" bLabel={`Run ${run}`} />
            {diffValues(dpp, now, runValues).length > 0 && (
              <Button size="sm" variant="outline" onClick={() => onLoadValues(runValues, `run ${run}`)}>Load run {run}&apos;s values</Button>
            )}
            <p className="text-xs text-muted-foreground">From the register file stored with the run (what was configured, not read back from the board).</p>
          </>
        )}
      </section>
    </div>
  )
}
