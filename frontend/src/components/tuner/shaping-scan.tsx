'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { useToast } from '@/components/ui/use-toast'
import { getExperimentStats, getHistogram } from '@/lib/api'
import { binCenters, findPeaks, fitPeak } from '@/lib/peak-fit'
import { findRegKey, type BoardSettings } from '@/components/tuner/controls-panel'
import { linearSteps, runScan, ScanAborted, sleep, withDeadline, type ScanStep } from '@/components/tuner/scan-engine'
import { bestResolution } from '@/components/tuner/scan-analysis'
import { ScanPlot } from '@/components/tuner/scan-plot'
import { readRoi, spectrumOf, spectrumSince, type SpectrumData } from '@/components/tuner/spectrum-panel'
import { pickChannel } from '@/components/tuner/use-channel-rates'
import type { BoardTiming } from '@/components/tuner/units'

export interface PeakStep {
  /** FWHM scaled to the region's position (gain changes with the rise time cancel out). */
  fwhm: number
  fwhmErr: number
  centroid: number
  net: number
  pileupPct: number
  seconds: number
  note: string | null
}

async function fetchSpectrum(boardId: string, channel: number): Promise<SpectrumData | null> {
  const data = await withDeadline(getHistogram(boardId, String(channel)))
  if (!data || !window.JSROOT) return null
  try { return spectrumOf(window.JSROOT.parse(data)) } catch { return null }
}

/**
 * Dwell on one setting until the chosen peak has `target` counts (or
 * `maxS` seconds pass), counting only what arrived after the setting
 * changed, then fit it.
 */
export async function measurePeak(opts: {
  boardId: string; channel: number; center: number; half: number; expectedScale: number
  target: number; maxS: number; signal: AbortSignal
}): Promise<PeakStep> {
  const t0 = Date.now()
  let snap = await fetchSpectrum(opts.boardId, opts.channel)
  let pu = 0, ev = 0
  let last: PeakStep | null = null
  for (;;) {
    await sleep(2000, opts.signal)
    const [cur, stats] = await Promise.all([fetchSpectrum(opts.boardId, opts.channel), withDeadline(getExperimentStats())])
    const r = pickChannel(stats, opts.boardId, opts.channel)
    if (r) { pu += r.pileup; ev += r.event }
    if (!cur) continue
    const d = spectrumSince(cur, snap)
    if (!d) { snap = cur; continue }
    const x = binCenters(cur.nbins, cur.xmin, cur.xmax)
    // The peak may move with the setting (trapezoid gain): look where it was
    // and where a gain ∝ setting would put it; take the stronger.
    const near = (c: number) => findPeaks(x, d.y, 12).filter((p) => Math.abs(p.x - c) <= Math.max(opts.half, 0.1 * c))
    const cands = [...near(opts.center), ...near(opts.center * opts.expectedScale)].sort((a, b) => b.net - a.net)
    const c = cands[0]?.x ?? opts.center
    const half = opts.half * (c / opts.center)
    const f = fitPeak(x, d.y, c - half, c + half, { variance: d.variance })
    const seconds = (Date.now() - t0) / 1000
    if (f) {
      const k = opts.center / f.centroid
      last = { fwhm: f.fwhm * k, fwhmErr: f.fwhmErr * k, centroid: f.centroid, net: f.net, pileupPct: ev > 0 ? (100 * pu) / ev : 0, seconds, note: f.warning }
      if (f.net >= opts.target) return last
    }
    if (seconds >= opts.maxS) {
      return last ? { ...last, note: `Only ${Math.round(last.net)} counts in ${Math.round(seconds)} s.` }
        : { fwhm: NaN, fwhmErr: NaN, centroid: NaN, net: 0, pileupPct: 0, seconds, note: 'No peak found in time.' }
    }
  }
}

/**
 * P6 (PHA): trapezoid rise time against resolution. Each step dwells until
 * the chosen peak has enough counts since the change, fits it, and records
 * pile-up; the curve's minimum is the suggestion. Starting value restored.
 */
export default function ShapingScan({
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
  const key = findRegKey(settings, channel, 0x105c)
  const raw = key ? settings[key].value_dec : null
  const flatKey = findRegKey(settings, channel, 0x1060)
  const recKey = findRegKey(settings, channel, 0x1020)
  const preKey = findRegKey(settings, channel, 0x1038)
  const step = timing.phaStepNs
  const riseUs = raw !== null ? (raw * step) / 1000 : null

  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [n, setN] = useState('5')
  const [target, setTarget] = useState('1000')
  const [maxS, setMaxS] = useState('60')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [points, setPoints] = useState<ScanStep<number, PeakStep>[]>([])
  const [best, setBest] = useState<number | null>(null)
  const abort = useRef<AbortController | null>(null)
  const roi = readRoi(boardId, channel)

  // The trapezoid (pre-trigger + 2 rise + flat top) must fit in the record.
  const recordNs = recKey ? settings[recKey].value_dec * 8 * timing.sampleNs : Infinity
  const preNs = preKey ? settings[preKey].value_dec * 4 * timing.sampleNs : 0
  const flatNs = flatKey ? settings[flatKey].value_dec * step : 0
  useEffect(() => {
    if (riseUs === null) return
    // 1 to 8 µs (germanium) where the record allows, and the current value in range.
    const maxFitUs = (recordNs - preNs - flatNs) / 2000
    const hi = Math.max(riseUs, Math.min(8, Number.isFinite(maxFitUs) ? Math.floor(maxFitUs * 10) / 10 : 8))
    setFrom(String(+Math.min(1, riseUs).toFixed(2)))
    setTo(String(+hi.toFixed(2)))
    setPoints([]); setBest(null)
  }, [boardId, channel, riseUs === null]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => abort.current?.abort(), [])

  const fits = (us: number) => preNs + 2 * us * 1000 + flatNs <= recordNs
  const all = (() => {
    const a = Number(from), b = Number(to), k = Math.round(Number(n))
    if (!(a > 0 && b > a && k >= 2 && k <= 12)) return []
    return linearSteps(a * 1000, b * 1000, k, step).map((ns) => ns / 1000)
  })()
  const steps = all.filter(fits)
  const dropped = all.filter((u) => !fits(u))

  const start = async () => {
    if (!key || raw === null || running || !steps.length || !roi) return
    if (!isLive()) { toast({ title: 'Scan not started', description: 'Scans run only in a run started from the Tuner.', variant: 'destructive' }); return }
    const ctl = new AbortController(); abort.current = ctl
    setRunning(true); onBusy(true); setPoints([]); setBest(null)
    setProgress({ done: 0, total: steps.length })
    let scale = 1
    try {
      const out = await runScan<number, PeakStep>({
        name: 'Rise-time scan', boardId, original: { [key]: raw },
        steps: steps.map((us) => ({ value: us, values: { [key]: Math.round((us * 1000) / step) } })),
        settleMs: 1500,
        measure: (signal) => measurePeak({
          boardId, channel, center: roi.center, half: roi.half, expectedScale: scale,
          target: Math.max(100, Number(target) || 1000), maxS: Math.max(10, Number(maxS) || 60), signal,
        }),
        signal: ctl.signal, isLive,
        onStep: (done, next) => { setPoints(done); setProgress({ done: next, total: steps.length }); if (next < steps.length) scale = steps[next] / (riseUs || 1) },
      })
      setPoints(out.steps)
      const b = bestResolution(out.steps.map((s) => ({ x: s.value, fwhm: s.result.fwhm, fwhmErr: s.result.fwhmErr, pileupPct: s.result.pileupPct })))
      setBest(b ? b.x : null)
      if (!out.restored) toast({ title: 'Rise time not restored', description: `Set it back to ${riseUs} µs by hand.`, variant: 'destructive' })
    } catch (e) {
      toast({ title: 'Rise-time scan stopped', description: `${e instanceof ScanAborted ? e.message : 'The scan failed.'} The rise time is back at ${riseUs} µs.` })
    } finally {
      setRunning(false); onBusy(false); setProgress(null); abort.current = null
    }
  }

  if (!key || riseUs === null) return <p className="text-sm text-muted-foreground">No trapezoid rise time register for this channel.</p>
  const bestStep = points.find((p) => p.value === best)

  return (
    <div className="space-y-3" data-testid="shaping-scan">
      <p className="text-sm text-muted-foreground">
        Tries each rise time, waits until the peak you picked on the spectrum has enough counts since the change, and
        fits it. Short times: electronic noise; long times: pile-up and drift. The rise time goes back to {riseUs} µs
        afterwards.
      </p>
      {!roi && <p className="text-sm text-warning">Pick a peak on the spectrum first (Peak at / ±).</p>}
      {roi && <p className="text-xs text-muted-foreground">Peak: {roi.center.toFixed(1)} ± {roi.half.toFixed(1)} (from the spectrum). Widths are scaled to that position, so a gain change with the rise time does not count.</p>}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1"><Label htmlFor="rs-from" className="text-xs">From (µs)</Label>
          <Input id="rs-from" type="number" step={step / 1000} className="h-8 w-24" value={from} onChange={(e) => setFrom(e.target.value)} disabled={running} /></div>
        <div className="flex flex-col gap-1"><Label htmlFor="rs-to" className="text-xs">To (µs)</Label>
          <Input id="rs-to" type="number" step={step / 1000} className="h-8 w-24" value={to} onChange={(e) => setTo(e.target.value)} disabled={running} /></div>
        <div className="flex flex-col gap-1"><Label htmlFor="rs-n" className="text-xs">Steps</Label>
          <Input id="rs-n" type="number" min={2} max={12} className="h-8 w-20" value={n} onChange={(e) => setN(e.target.value)} disabled={running} /></div>
        <div className="flex flex-col gap-1"><Label htmlFor="rs-target" className="text-xs">Counts per step</Label>
          <Input id="rs-target" type="number" min={100} className="h-8 w-24" value={target} onChange={(e) => setTarget(e.target.value)} disabled={running} /></div>
        <div className="flex flex-col gap-1"><Label htmlFor="rs-max" className="text-xs">Max s per step</Label>
          <Input id="rs-max" type="number" min={10} className="h-8 w-20" value={maxS} onChange={(e) => setMaxS(e.target.value)} disabled={running} /></div>
        {running
          ? <Button variant="outline" onClick={() => abort.current?.abort()}>Cancel scan</Button>
          : <Button onClick={start} disabled={!steps.length || !roi}>Run rise-time scan</Button>}
        <span className="text-xs text-muted-foreground">
          {steps.length ? `${steps.join(', ')} µs · up to ${Math.round(steps.length * ((Number(maxS) || 60) + 2))} s` : 'Check the range.'}
        </span>
      </div>
      {dropped.length > 0 && (
        <p className="text-xs text-warning">Left out (the trapezoid would not fit the record): {dropped.join(', ')} µs. Raise Record Length for longer times (next run).</p>
      )}
      {progress && (
        <div className="space-y-1" aria-live="polite">
          <Progress value={(100 * progress.done) / progress.total} className="h-2" />
          <p className="text-xs text-muted-foreground">Step {Math.min(progress.done + 1, progress.total)} of {progress.total}{progress.done < steps.length ? `: ${steps[progress.done]} µs` : ''}</p>
        </div>
      )}
      {points.length > 0 && (
        <div className="max-w-xl">
          <ScanPlot ariaLabel="FWHM against rise time" points={points.map((s) => ({ x: s.value, y: s.result.fwhm, err: s.result.fwhmErr }))}
            xLabel="Rise time (µs)" yLabel="FWHM" marker={best} />
        </div>
      )}
      {points.length > 0 && (
        <table className="w-full text-xs tabular-nums">
          <thead><tr className="text-left text-muted-foreground"><th className="font-normal">Rise</th><th className="font-normal">FWHM</th><th className="font-normal">Counts</th><th className="font-normal">Pile-up</th><th className="font-normal">Time</th><th className="font-normal" /></tr></thead>
          <tbody>
            {points.map((s) => (
              <tr key={s.value}>
                <td>{s.value} µs</td>
                <td>{Number.isFinite(s.result.fwhm) ? `${s.result.fwhm.toFixed(2)}${Number.isFinite(s.result.fwhmErr) ? ` ± ${s.result.fwhmErr.toFixed(2)}` : ''}` : '–'}</td>
                <td>{Math.round(s.result.net)}</td>
                <td>{s.result.pileupPct.toFixed(1)} %</td>
                <td>{Math.round(s.result.seconds)} s</td>
                <td className="text-warning">{s.result.note ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!running && points.length > 0 && (
        <div className="rounded-md border bg-muted/40 p-3 text-sm" role="status" data-testid="shaping-result">
          {bestStep ? (
            <p>Best: <strong>{bestStep.value} µs</strong>, FWHM {bestStep.result.fwhm.toFixed(2)} (pile-up {bestStep.result.pileupPct.toFixed(1)} %). Within errors, the shorter time is preferred.</p>
          ) : <p>No step gave a usable fit: more counts per step, or check the peak region.</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            {bestStep && bestStep.value !== riseUs && (
              <Button size="sm" onClick={() => onApply(key, Math.round((bestStep.value * 1000) / step), `Trapezoid rise time ${riseUs} → ${bestStep.value} µs`)}>Apply {bestStep.value} µs</Button>
            )}
            <Button size="sm" variant="outline" onClick={() => { setPoints([]); setBest(null) }}>Keep {riseUs} µs</Button>
          </div>
        </div>
      )}
    </div>
  )
}
