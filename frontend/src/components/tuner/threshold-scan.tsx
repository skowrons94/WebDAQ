'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { useToast } from '@/components/ui/use-toast'
import { findRegKey, type BoardSettings } from '@/components/tuner/controls-panel'
import { geometricSteps, measureRates, runScan, ScanAborted, type ScanStep } from '@/components/tuner/scan-engine'
import { noiseKnee, type KneeResult } from '@/components/tuner/scan-analysis'
import { ScanPlot } from '@/components/tuner/scan-plot'
import { getBits, setBits } from '@/components/tuner/units'
import { formatRate } from '@/components/tuner/format'
import type { ChannelRates } from '@/components/tuner/use-channel-rates'

const THR_BITS: [number, number] = [0, 13]

/**
 * P5: lower the trigger threshold step by step on the live board, watch the
 * rate, find where noise takes over and suggest 1.3 × that. The starting
 * threshold is always put back; "Apply" then sets the suggestion as a normal
 * change.
 */
export default function ThresholdScan({
  boardId, channel, psd, settings, isLive, onBusy, onApply,
}: {
  boardId: string
  channel: number
  psd: boolean
  settings: BoardSettings
  /** True while the run is the Tuner's own (scans write to the board). */
  isLive: () => boolean
  onBusy: (busy: boolean) => void
  onApply: (regKey: string, raw: number, label: string) => Promise<void>
}) {
  const { toast } = useToast()
  const regKey = findRegKey(settings, channel, psd ? 0x1060 : 0x106c)
  const raw = regKey ? settings[regKey].value_dec : null
  const current = raw !== null ? getBits(raw, THR_BITS) : null

  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [nSteps, setNSteps] = useState('8')
  const [dwell, setDwell] = useState('3')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [points, setPoints] = useState<ScanStep<number, ChannelRates>[]>([])
  const [result, setResult] = useState<(KneeResult & { stoppedEarly: string | null; original: number }) | null>(null)
  const abort = useRef<AbortController | null>(null)

  // Defaults follow the channel's threshold.
  useEffect(() => {
    if (current === null) return
    setFrom(String(Math.min(16383, Math.max(10, current * 2))))
    setTo(String(Math.max(3, Math.round(current / 4))))
    setPoints([]); setResult(null)
  }, [boardId, channel, current === null]) // eslint-disable-line react-hooks/exhaustive-deps

  // Leaving the page cancels the scan; the engine still restores the value.
  useEffect(() => () => abort.current?.abort(), [])

  const steps = (() => {
    const a = Number(from), b = Number(to), n = Math.round(Number(nSteps))
    if (!(a > 0 && b > 0 && n >= 3 && n <= 20)) return []
    return geometricSteps(Math.max(a, b), Math.min(a, b), n).filter((v) => v <= 16383)
  })()
  const dwellS = Math.min(30, Math.max(1, Number(dwell) || 3))
  const etaS = Math.round(steps.length * (dwellS + 2))

  const start = async () => {
    if (!regKey || raw === null || current === null || running || !steps.length) return
    if (!isLive()) { toast({ title: 'Scan not started', description: 'Scans run only in a run started from the Tuner.', variant: 'destructive' }); return }
    const ctl = new AbortController()
    abort.current = ctl
    setRunning(true); onBusy(true)
    setPoints([]); setResult(null)
    setProgress({ done: 0, total: steps.length })
    let firstRate = 0
    try {
      const out = await runScan<number, ChannelRates>({
        name: 'Threshold scan',
        boardId,
        original: { [regKey]: raw },
        steps: steps.map((t) => ({ value: t, values: { [regKey]: setBits(raw, THR_BITS, t) } })),
        settleMs: 1500,
        measure: (signal) => measureRates(boardId, channel, dwellS * 1000, signal),
        signal: ctl.signal,
        isLive,
        onStep: (done, next) => { setPoints(done); setProgress({ done: next, total: steps.length }) },
        stopAfter: (step, done) => {
          if (done.length === 1) firstRate = step.result.event
          if (step.result.lost > 0) return `Stopped at ${step.value} LSB: events are being lost.`
          if (firstRate > 0 && step.result.event > 20 * firstRate) return `Stopped at ${step.value} LSB: the rate is over 20 × the first step's.`
          return null
        },
      })
      const knee = noiseKnee(out.steps.map((s) => ({ threshold: s.value, rate: s.result.event, lost: s.result.lost })), !!out.stoppedEarly)
      setPoints(out.steps)
      setResult({ ...knee, stoppedEarly: out.stoppedEarly, original: current })
      if (!out.restored) toast({ title: 'Threshold not restored', description: `Set it back to ${current} LSB by hand.`, variant: 'destructive' })
    } catch (e) {
      const why = e instanceof ScanAborted ? e.message : 'The scan failed.'
      toast({ title: 'Threshold scan stopped', description: `${why} The threshold is back at ${current} LSB.` })
    } finally {
      setRunning(false); onBusy(false); setProgress(null)
      abort.current = null
    }
  }

  if (!regKey || current === null) {
    return <p className="text-sm text-muted-foreground">This board has no trigger threshold register in its configuration.</p>
  }

  return (
    <div className="space-y-3" data-testid="threshold-scan">
      <p className="text-sm text-muted-foreground">
        Lowers the threshold step by step and watches the rate. Where noise takes over, the rate shoots up: the
        suggestion is 1.3 × that point. The threshold goes back to {current} LSB when the scan ends or is cancelled.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="thr-from" className="text-xs">From (LSB)</Label>
          <Input id="thr-from" type="number" min={1} className="h-8 w-24" value={from} onChange={(e) => setFrom(e.target.value)} disabled={running} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="thr-to" className="text-xs">To (LSB)</Label>
          <Input id="thr-to" type="number" min={1} className="h-8 w-24" value={to} onChange={(e) => setTo(e.target.value)} disabled={running} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="thr-steps" className="text-xs">Steps</Label>
          <Input id="thr-steps" type="number" min={3} max={20} className="h-8 w-20" value={nSteps} onChange={(e) => setNSteps(e.target.value)} disabled={running} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="thr-dwell" className="text-xs">Seconds per step</Label>
          <Input id="thr-dwell" type="number" min={1} max={30} className="h-8 w-20" value={dwell} onChange={(e) => setDwell(e.target.value)} disabled={running} />
        </div>
        {running ? (
          <Button variant="outline" onClick={() => abort.current?.abort()}>Cancel scan</Button>
        ) : (
          <Button onClick={start} disabled={!steps.length}>Run threshold scan</Button>
        )}
        <span className="text-xs text-muted-foreground">
          {steps.length ? `${steps.join(', ')} LSB · about ${etaS} s` : 'Check the range (3–20 steps).'}
        </span>
      </div>
      {progress && (
        <div className="space-y-1" aria-live="polite">
          <Progress value={(100 * progress.done) / progress.total} className="h-2" />
          <p className="text-xs text-muted-foreground">
            Step {Math.min(progress.done + 1, progress.total)} of {progress.total}
            {progress.done < steps.length ? `: ${steps[progress.done]} LSB` : ''}
          </p>
        </div>
      )}
      {points.length > 0 && (
        <div className="max-w-xl"><ScanPlot
          ariaLabel="Rate against threshold"
          points={points.map((s) => ({ x: s.value, y: Math.max(s.result.event, 0.1) }))}
          xLabel="Threshold (LSB)"
          yLabel="Rate (/s)"
          logY
          reverseX
          marker={result?.recommended ?? null}
        /></div>
      )}
      {points.length > 0 && (
        <table className="w-full text-xs tabular-nums">
          <thead><tr className="text-left text-muted-foreground"><th className="font-normal">Threshold</th><th className="font-normal">Rate</th><th className="font-normal">Pile-up</th><th className="font-normal">Lost</th></tr></thead>
          <tbody>
            {points.map((s) => (
              <tr key={s.value}>
                <td>{s.value} LSB</td>
                <td>{formatRate(s.result.event)}</td>
                <td>{s.result.event > 0 ? ((100 * s.result.pileup) / s.result.event).toFixed(1) : '0.0'} %</td>
                <td className={s.result.lost > 0 ? 'text-destructive' : ''}>{formatRate(s.result.lost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {result && (
        <div className="rounded-md border bg-muted/40 p-3 text-sm" role="status" data-testid="threshold-result">
          {result.stoppedEarly && <p className="mb-1 text-warning">{result.stoppedEarly}</p>}
          <p>{result.text}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {result.recommended !== null && result.recommended !== result.original && (
              <Button size="sm" onClick={() => onApply(regKey, setBits(raw!, THR_BITS, result.recommended!), `Trigger threshold ${result.original} → ${result.recommended} LSB`)}>
                Apply {result.recommended} LSB
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => setResult(null)}>Keep {result.original} LSB</Button>
          </div>
        </div>
      )}
    </div>
  )
}
