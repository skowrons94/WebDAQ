'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { useToast } from '@/components/ui/use-toast'
import { getPsd } from '@/lib/api'
import { figureOfMerit, th2Of, th2Since, type FomResult, type Th2Data } from '@/lib/psd-fom'
import { findRegKey, type BoardSettings } from '@/components/tuner/controls-panel'
import { linearSteps, runScan, ScanAborted, sleep, withDeadline, type ScanStep } from '@/components/tuner/scan-engine'
import { ScanPlot } from '@/components/tuner/scan-plot'
import type { BoardTiming } from '@/components/tuner/units'

type Gates = { short: number; long: number }
type FomStep = FomResult & { seconds: number }

async function fetchTh2(boardId: string, channel: number): Promise<Th2Data | null> {
  const data = await withDeadline(getPsd(boardId, String(channel)))
  if (!data || !window.JSROOT) return null
  try { return th2Of(window.JSROOT.parse(data)) } catch { return null }
}

async function measureFom(boardId: string, channel: number, lo: number, hi: number, target: number, maxS: number, signal: AbortSignal): Promise<FomStep> {
  const t0 = Date.now()
  let snap = await fetchTh2(boardId, channel)
  let last: FomResult | null = null
  for (;;) {
    await sleep(2000, signal)
    const cur = await fetchTh2(boardId, channel)
    const seconds = (Date.now() - t0) / 1000
    if (cur) {
      const d = th2Since(cur, snap)
      if (!d) snap = cur
      else {
        last = figureOfMerit(d, lo, hi)
        if (last.counts >= target && last.fom !== null) return { ...last, seconds }
      }
    }
    if (seconds >= maxS) return { ...(last ?? { fom: null, gamma: null, neutron: null, counts: 0, reason: 'No data.' }), seconds }
  }
}

/**
 * P6 (PSD): short × long gate grid against the n/γ figure of merit on the
 * PSD projection of an energy band. Starting gates restored afterwards.
 */
export default function PsdFomScan({
  boardId, channel, settings, timing, isLive, onBusy, onApply,
}: {
  boardId: string
  channel: number
  settings: BoardSettings
  timing: BoardTiming
  isLive: () => boolean
  onBusy: (busy: boolean) => void
  onApply: (regKey: string, raw: number, label: string) => Promise<void>
}) {
  const { toast } = useToast()
  const sKey = findRegKey(settings, channel, 0x1054)
  const lKey = findRegKey(settings, channel, 0x1058)
  const ns = timing.sampleNs
  const s0 = sKey ? settings[sKey].value_dec : null
  const l0 = lKey ? settings[lKey].value_dec : null

  const [sFrom, setSFrom] = useState(''); const [sTo, setSTo] = useState(''); const [sN, setSN] = useState('3')
  const [lFrom, setLFrom] = useState(''); const [lTo, setLTo] = useState(''); const [lN, setLN] = useState('3')
  const [bandLo, setBandLo] = useState(''); const [bandHi, setBandHi] = useState('')
  const [target, setTarget] = useState('3000'); const [maxS, setMaxS] = useState('40')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [points, setPoints] = useState<ScanStep<Gates, FomStep>[]>([])
  const abort = useRef<AbortController | null>(null)

  useEffect(() => {
    if (s0 === null || l0 === null) return
    setSFrom(String(Math.max(ns, Math.round(s0 * 0.5) * ns))); setSTo(String(Math.round(s0 * 2) * ns))
    setLFrom(String(Math.round(l0 * 0.6) * ns)); setLTo(String(Math.round(l0 * 1.5) * ns))
    setPoints([])
    let alive = true
    void fetchTh2(boardId, channel).then((h) => {
      if (!alive || !h) return
      setBandLo(String(+(h.xmin + 0.1 * (h.xmax - h.xmin)).toPrecision(3))); setBandHi(String(+h.xmax.toPrecision(4)))
    })
    return () => { alive = false }
  }, [boardId, channel, s0 === null, l0 === null]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => abort.current?.abort(), [])

  const grid: Gates[] = (() => {
    const sv = linearSteps(Number(sFrom), Number(sTo), Math.round(Number(sN)), ns)
    const lv = linearSteps(Number(lFrom), Number(lTo), Math.round(Number(lN)), ns)
    if (!(Number(sFrom) > 0 && Number(lFrom) > 0) || sv.length * lv.length > 16) return []
    return lv.flatMap((l) => sv.filter((s) => s < l).map((s) => ({ short: s, long: l })))
  })()
  const lo = Number(bandLo), hi = Number(bandHi)

  const start = async () => {
    if (!sKey || !lKey || s0 === null || l0 === null || running || !grid.length || !(hi > lo)) return
    if (!isLive()) { toast({ title: 'Scan not started', description: 'Scans run only in a run started from the Tuner.', variant: 'destructive' }); return }
    const ctl = new AbortController(); abort.current = ctl
    setRunning(true); onBusy(true); setPoints([])
    setProgress({ done: 0, total: grid.length })
    try {
      const out = await runScan<Gates, FomStep>({
        name: 'PSD gate scan', boardId, original: { [lKey]: l0, [sKey]: s0 },
        // Write order keeps short < long on the board at every moment.
        steps: grid.map((g, i) => {
          const prevShort = i ? grid[i - 1].short : s0 * ns
          const L = Math.round(g.long / ns), S = Math.round(g.short / ns)
          return { value: g, values: g.long > prevShort ? { [lKey]: L, [sKey]: S } : { [sKey]: S, [lKey]: L } }
        }),
        settleMs: 1500,
        measure: (signal) => measureFom(boardId, channel, lo, hi, Math.max(200, Number(target) || 3000), Math.max(10, Number(maxS) || 40), signal),
        signal: ctl.signal, isLive,
        onStep: (done, next) => { setPoints(done); setProgress({ done: next, total: grid.length }) },
      })
      setPoints(out.steps)
      if (!out.restored) toast({ title: 'Gates not restored', description: `Set short ${s0 * ns} ns and long ${l0 * ns} ns by hand.`, variant: 'destructive' })
    } catch (e) {
      toast({ title: 'PSD gate scan stopped', description: `${e instanceof ScanAborted ? e.message : 'The scan failed.'} The gates are back at ${s0 * ns} / ${l0 * ns} ns.` })
    } finally {
      setRunning(false); onBusy(false); setProgress(null); abort.current = null
    }
  }

  if (!sKey || !lKey || s0 === null || l0 === null) return <p className="text-sm text-muted-foreground">No gate registers for this channel.</p>
  const ok = points.filter((p) => p.result.fom !== null)
  const best = ok.length ? ok.reduce((a, b) => (b.result.fom! > a.result.fom! ? b : a)) : null
  const longs = Array.from(new Set(points.map((p) => p.value.long)))

  return (
    <div className="space-y-3" data-testid="psd-scan">
      <p className="text-sm text-muted-foreground">
        Tries short × long gate pairs and measures how well neutrons and gammas separate (figure of merit,
        FoM = |μn − μγ| / (FWHMn + FWHMγ); above about 1.27 they are well apart) in the Q-long band below. The gates
        go back to {s0 * ns} / {l0 * ns} ns afterwards.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        {[['Short from (ns)', sFrom, setSFrom, 'ps-sf'], ['to', sTo, setSTo, 'ps-st'], ['steps', sN, setSN, 'ps-sn'],
          ['Long from (ns)', lFrom, setLFrom, 'ps-lf'], ['to', lTo, setLTo, 'ps-lt'], ['steps', lN, setLN, 'ps-ln'],
          ['Band from (Q-long)', bandLo, setBandLo, 'ps-bl'], ['to', bandHi, setBandHi, 'ps-bh'],
          ['Events per step', target, setTarget, 'ps-tg'], ['Max s per step', maxS, setMaxS, 'ps-mx']].map(([label, v, set, id]) => (
          <div key={id as string} className="flex flex-col gap-1">
            <Label htmlFor={id as string} className="text-xs">{label as string}</Label>
            <Input id={id as string} type="number" className="h-8 w-24" value={v as string} disabled={running}
              onChange={(e) => (set as (s: string) => void)(e.target.value)} />
          </div>
        ))}
        {running
          ? <Button variant="outline" onClick={() => abort.current?.abort()}>Cancel scan</Button>
          : <Button onClick={start} disabled={!grid.length || !(hi > lo)}>Run PSD gate scan</Button>}
        <span className="text-xs text-muted-foreground">{grid.length ? `${grid.length} pairs · up to ${Math.round(grid.length * ((Number(maxS) || 40) + 2))} s` : 'Check the ranges (at most 16 pairs).'}</span>
      </div>
      {progress && (
        <div className="space-y-1" aria-live="polite">
          <Progress value={(100 * progress.done) / progress.total} className="h-2" />
          <p className="text-xs text-muted-foreground">Pair {Math.min(progress.done + 1, progress.total)} of {progress.total}{progress.done < grid.length ? `: ${grid[progress.done].short} / ${grid[progress.done].long} ns` : ''}</p>
        </div>
      )}
      {ok.length > 0 && longs.map((l) => (
        <div key={l} className="max-w-xl">
          <ScanPlot ariaLabel={`FoM against short gate, long gate ${l} ns`}
            points={ok.filter((p) => p.value.long === l).map((p) => ({ x: p.value.short, y: p.result.fom! }))}
            xLabel={`Short gate (ns), long ${l} ns`} yLabel="FoM" marker={best && best.value.long === l ? best.value.short : null} height={150} />
        </div>
      ))}
      {points.length > 0 && (
        <table className="w-full text-xs tabular-nums">
          <thead><tr className="text-left text-muted-foreground"><th className="font-normal">Short / long</th><th className="font-normal">FoM</th><th className="font-normal">Events</th><th className="font-normal">Time</th><th className="font-normal" /></tr></thead>
          <tbody>
            {points.map((p) => (
              <tr key={`${p.value.short}-${p.value.long}`}>
                <td>{p.value.short} / {p.value.long} ns</td>
                <td>{p.result.fom !== null ? p.result.fom.toFixed(2) : '–'}</td>
                <td>{Math.round(p.result.counts)}</td>
                <td>{Math.round(p.result.seconds)} s</td>
                <td className="text-warning">{p.result.reason ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!running && points.length > 0 && (
        <div className="rounded-md border bg-muted/40 p-3 text-sm" role="status" data-testid="psd-result">
          {best ? <p>Best FoM <strong>{best.result.fom!.toFixed(2)}</strong> at short {best.value.short} ns, long {best.value.long} ns.</p>
            : <p>No pair separated two populations: is there a neutron source, and is the band right?</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            {best && (best.value.short !== s0 * ns || best.value.long !== l0 * ns) && (
              <Button size="sm" onClick={async () => {
                // Order keeps short < long on the way.
                const sRaw = Math.round(best.value.short / ns), lRaw = Math.round(best.value.long / ns)
                const label = `Gates ${s0 * ns}/${l0 * ns} → ${best.value.short}/${best.value.long} ns`
                if (lRaw >= l0) { await onApply(lKey, lRaw, label); await onApply(sKey, sRaw, label) }
                else { await onApply(sKey, sRaw, label); await onApply(lKey, lRaw, label) }
              }}>Apply {best.value.short} / {best.value.long} ns</Button>
            )}
            <Button size="sm" variant="outline" onClick={() => setPoints([])}>Keep {s0 * ns} / {l0 * ns} ns</Button>
          </div>
        </div>
      )}
    </div>
  )
}
