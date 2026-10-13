'use client'

import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import {
  activateWaveformBoard,
  getProbe1,
  getProbe2,
  getWaveform1,
  getWaveform2,
  getWaveformStatusPerBoard,
} from '@/lib/api'
import { getFieldOptions, type RegisterOption } from '@/lib/caen-registers'
import { inputMetrics, median, trapezoidMetrics, traceSamples, type InputMetrics, type TrapezoidMetrics } from '@/lib/trace-metrics'
import { formatNs } from '@/components/tuner/format'
import { getBits, setBits, type BoardTiming } from '@/components/tuner/units'

/** Board Configuration (0x8000) fields that pick the traces, per firmware (UM5678/UM4380). */
/** Selectable probe options: no "Reserved" codes and no repeated labels (the
 *  docs list e.g. PHA "Peaking" twice), unless the board is set to one. */
function probeChoices(opts: RegisterOption[], current: number | null): RegisterOption[] {
  const seen = new Set<string>()
  // Sentence case ("Long gate", "Pile up"), acronyms kept ("Shaped TRG").
  const sentence = (l: string) => l.split(' ').map((w, i) => (i > 0 && /^[A-Z][a-z]+$/.test(w) ? w.toLowerCase() : w)).join(' ')
  return opts.map((o) => ({ ...o, label: sentence(o.label) })).filter((o) => {
    if (o.value === current) { seen.add(o.label); return true }
    if (/^reserved$/i.test(o.label) || seen.has(o.label)) return false
    seen.add(o.label)
    return true
  })
}

const PROBE_BITS = {
  dual: [11, 11] as [number, number],
  pha: { ap1: [12, 13] as [number, number], ap2: [14, 15] as [number, number], dp1: [20, 23] as [number, number] },
  psd: { ap: [12, 13] as [number, number], dp1: [23, 25] as [number, number], dp2: [26, 28] as [number, number] },
}

interface Props {
  boardId: string
  dpp: string
  channel: number
  timing: BoardTiming
  jsrootLoaded: boolean
  refreshTick: number
  running: boolean
  online: boolean
  /** Board Configuration register (0x8000) value, or null when unknown. */
  boardConfig: number | null
  onBoardConfigChange: (newValue: number, label: string) => void
  /** Pre-trigger and record length, in samples (from the channel's registers). */
  preSamples: number | null
  recordSamples: number | null
  /** Trapezoid shape (PHA), ns. */
  riseNs: number | null
  flatNs: number | null
  negative: boolean
  onBaseline?: (baseline: number | null) => void
  /** The trace readout, for the guided flow. */
  onMetrics?: (m: TraceReadout | null) => void
}

export interface TraceReadout { input: InputMetrics | null; trap: TrapezoidMetrics | null; n: number; clipped: number }

/**
 * The trace, with what it says in numbers (P4): baseline, clipping and
 * headroom on the input; flat top and pole-zero residual on the trapezoid;
 * whether the trapezoid fits in the record. Also the board's waveform switch
 * and the probe choice for the firmware.
 */
export function WaveformPanel(p: Props) {
  const { toast } = useToast()
  const psd = p.dpp.toUpperCase().includes('PSD')
  const ref = useRef<HTMLDivElement>(null)
  const [waveformNum, setWaveformNum] = useState<1 | 2>(1)
  const [recording, setRecording] = useState<boolean | null>(null)
  const [switching, setSwitching] = useState(false)
  const [emptyReason, setEmptyReason] = useState<string | null>(null)
  const inputHist = useRef<InputMetrics[]>([])
  const trapHist = useRef<TrapezoidMetrics[]>([])
  const [metrics, setMetrics] = useState<TraceReadout | null>(null)
  useEffect(() => { p.onMetrics?.(metrics) }, [metrics]) // eslint-disable-line react-hooks/exhaustive-deps

  const cfg = p.boardConfig ?? 0
  const dual = p.boardConfig !== null && getBits(cfg, PROBE_BITS.dual) === 1
  const ap1 = psd ? getBits(cfg, PROBE_BITS.psd.ap) : getBits(cfg, PROBE_BITS.pha.ap1)
  const ap2 = psd ? null : getBits(cfg, PROBE_BITS.pha.ap2)
  const dp1 = psd ? getBits(cfg, PROBE_BITS.psd.dp1) : getBits(cfg, PROBE_BITS.pha.dp1)

  const ap1Options: RegisterOption[] = (psd ? getFieldOptions('Analog Probe', p.dpp) : getFieldOptions('Analog Probe 1', p.dpp)) ?? []
  const ap2Options: RegisterOption[] = psd ? [] : getFieldOptions('Analog Probe 2', p.dpp) ?? []
  const dp1Options: RegisterOption[] = getFieldOptions('Digital Virtual Probe 1', p.dpp) ?? []

  // What trace 1 is, for the diagnostics.
  const showsInput = psd ? ap1 === 0 : ap1 === 0
  const showsTrapezoid = !psd && ap1 === 3
  // Dual trace interleaves the two traces: each has every other sample.
  const sampleNs = p.timing.sampleNs * (dual ? 2 : 1)

  // Waveform recording for this board (the dashboard's board-card switch).
  useEffect(() => {
    let alive = true
    const check = () => getWaveformStatusPerBoard()
      .then((m) => { if (alive) setRecording(Boolean(m?.[p.boardId])) })
      .catch(() => { if (alive) setRecording(null) })
    void check()
    const id = setInterval(check, 10000)
    return () => { alive = false; clearInterval(id) }
  }, [p.boardId])

  useEffect(() => {
    inputHist.current = []
    trapHist.current = []
    setMetrics(null)
  }, [p.boardId, p.channel, cfg, p.riseNs])

  useEffect(() => {
    if (!p.jsrootLoaded || !p.boardId) return
    const el = ref.current
    if (!el || !window.JSROOT) return
    let alive = true
    const ch = String(p.channel)
    const run = async () => {
      try {
        const [waveData, p1Data, p2Data] = await Promise.all([
          waveformNum === 1 ? getWaveform1(p.boardId, ch) : getWaveform2(p.boardId, ch),
          getProbe1(p.boardId, ch).catch(() => null),
          getProbe2(p.boardId, ch).catch(() => null),
        ])
        if (!alive) return
        const parsed = window.JSROOT.parse(waveData)
        const samples = traceSamples(parsed)
        const hasData = !!samples && samples.some((v) => v !== 0)
        setEmptyReason(hasData ? null : (parsed?.fTitle || 'No trace yet'))
        if (samples && hasData) {
          // Axes in physical units: time in ns, amplitude in ADC codes.
          const n = samples.length
          parsed.fXaxis.fXmin = 0
          parsed.fXaxis.fXmax = n * sampleNs
          parsed.fXaxis.fTitle = p.timing.sampleNs > 1 ? 'Time (ns)' : 'Time (samples)'
          parsed.fYaxis.fTitle = 'ADC (LSB)'
          if (waveformNum === 1) {
            if (showsInput) {
              const m = inputMetrics(samples, { preSamples: p.preSamples, adcMax: p.timing.adcMax, negative: p.negative })
              if (m) inputHist.current = [...inputHist.current, m].slice(-10)
            } else if (showsTrapezoid && p.riseNs) {
              const m = trapezoidMetrics(samples, { preSamples: p.preSamples, sampleNs, riseNs: p.riseNs, flatNs: p.flatNs })
              if (m) trapHist.current = [...trapHist.current, m].slice(-10)
            }
            const ih = inputHist.current, th = trapHist.current
            setMetrics({
              n: Math.max(ih.length, th.length),
              clipped: ih.reduce((s, m) => s + (m.clipped > 0 ? 1 : 0), 0),
              input: ih.length ? {
                baseline: median(ih.map((m) => m.baseline)) ?? 0,
                baselineSd: median(ih.map((m) => m.baselineSd)) ?? 0,
                amplitude: Math.max(...ih.map((m) => m.amplitude)),
                clipped: ih.reduce((s, m) => s + m.clipped, 0),
                headroom: median(ih.map((m) => m.headroom)) ?? 0,
              } : null,
              trap: th.length ? {
                height: median(th.map((m) => m.height)) ?? 0,
                flatSlopePctPerUs: median(th.map((m) => m.flatSlopePctPerUs)) ?? 0,
                pzResidualPct: median(th.map((m) => m.pzResidualPct ?? NaN)),
                cutOff: th.some((m) => m.cutOff),
                flatSamples: median(th.map((m) => m.flatSamples)) ?? 0,
                flatTopOk: th.filter((m) => m.flatTopOk).length * 2 >= th.length,
              } : null,
            })
            if (ih.length) p.onBaseline?.(median(ih.map((m) => m.baseline)))
          }
        }
        const canvas = window.JSROOT.create('TCanvas')
        canvas.fName = `tuner_wave_${p.boardId}_${p.channel}_${waveformNum}`
        canvas.fPrimitives.Add(parsed, 'hist')
        if (p1Data) {
          const d1 = window.JSROOT.parse(p1Data)
          d1.fLineColor = 3
          canvas.fPrimitives.Add(d1, 'hist same')
        }
        if (p2Data) {
          const d2 = window.JSROOT.parse(p2Data)
          d2.fLineColor = 2
          canvas.fPrimitives.Add(d2, 'hist same')
        }
        if (alive) await window.JSROOT.redraw(el, canvas)
      } catch { /* the next tick tries again */ }
    }
    void run()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.jsrootLoaded, p.refreshTick, p.boardId, p.channel, waveformNum, sampleNs])

  const setField = (bits: [number, number], v: number, label: string) => {
    if (p.boardConfig === null) return
    p.onBoardConfigChange(setBits(cfg, bits, v), label)
  }

  const recordWaveforms = async () => {
    setSwitching(true)
    try {
      await activateWaveformBoard(p.boardId)
      setRecording(true)
      toast({ title: 'Waveforms on', description: 'This board records traces from the next run on.' })
    } catch (e) {
      toast({ title: 'Waveforms not switched on', description: (e as Error)?.message ?? 'The server refused.', variant: 'destructive' })
    } finally {
      setSwitching(false)
    }
  }

  // Does the trapezoid fit the record? (pre-trigger + 2·rise + flat)
  const fit = (() => {
    if (psd || !p.riseNs || p.flatNs === null || !p.recordSamples || p.preSamples === null) return null
    const needNs = p.preSamples * p.timing.sampleNs + 2 * p.riseNs + p.flatNs
    const haveNs = p.recordSamples * p.timing.sampleNs
    return { needNs, haveNs, ok: needNs <= haveNs }
  })()

  return (
    <Card>
      <CardHeader className="space-y-3">
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          <span>Waveform</span>
          {dual && (
            <div className="flex items-center gap-2">
              <Button size="sm" variant={waveformNum === 1 ? 'default' : 'outline'} onClick={() => setWaveformNum(1)}>Trace 1</Button>
              <Button size="sm" variant={waveformNum === 2 ? 'default' : 'outline'} onClick={() => setWaveformNum(2)}>Trace 2</Button>
            </div>
          )}
        </CardTitle>
        {recording === false && (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-dashed p-3" role="status">
            <Switch
              id="tuner-record-waveforms"
              checked={false}
              disabled={p.running || switching}
              onCheckedChange={(c) => { if (c) void recordWaveforms() }}
            />
            <Label htmlFor="tuner-record-waveforms" className="text-sm">Record waveforms for this board</Label>
            <p className="w-full text-xs text-muted-foreground">
              {p.running
                ? 'Waveforms are off, so there is no trace to show. They can be switched on between runs: stop the run, switch on, start again.'
                : 'Waveforms are off, so there is no trace to show. Switch on, then start a run (applies at the start).'}
            </p>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-2">
            <Switch id="dual-trace-switch" checked={dual} onCheckedChange={(c) => setField(PROBE_BITS.dual, c ? 1 : 0, 'Dual trace')} />
            <Label htmlFor="dual-trace-switch" className="text-sm">Dual trace</Label>
          </div>
          <div className="flex items-center gap-2">
            <Label className="text-sm">{psd ? 'Analog probe' : 'Trace 1'}</Label>
            <Select value={String(ap1)} onValueChange={(v) => setField(psd ? PROBE_BITS.psd.ap : PROBE_BITS.pha.ap1, Number(v), psd ? 'Analog probe' : 'Trace 1')}>
              <SelectTrigger className="h-8 w-48 text-xs" aria-label={psd ? 'Analog probe' : 'Trace 1'}><SelectValue /></SelectTrigger>
              <SelectContent>
                {probeChoices(ap1Options, ap1).map((o) => <SelectItem key={o.value} value={String(o.value)}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {!psd && dual && ap2 !== null && (
            <div className="flex items-center gap-2">
              <Label className="text-sm">Trace 2</Label>
              <Select value={String(ap2)} onValueChange={(v) => setField(PROBE_BITS.pha.ap2, Number(v), 'Trace 2')}>
                <SelectTrigger className="h-8 w-48 text-xs" aria-label="Trace 2"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {probeChoices(ap2Options, ap2).map((o) => <SelectItem key={o.value} value={String(o.value)}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Label className="text-sm">Digital probe</Label>
            <Select value={String(dp1)} onValueChange={(v) => setField(psd ? PROBE_BITS.psd.dp1 : PROBE_BITS.pha.dp1, Number(v), 'Digital probe')}>
              <SelectTrigger className="h-8 w-48 text-xs" aria-label="Digital probe"><SelectValue /></SelectTrigger>
              <SelectContent>
                {probeChoices(dp1Options, dp1).map((o) => <SelectItem key={o.value} value={String(o.value)}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          The trace and probe choice belong to the board configuration: {p.online ? 'even in Online mode they ' : 'they '}
          take effect at the next run.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="relative">
          <div ref={ref} className="h-80 w-full rounded-lg border shadow-sm max-md:aspect-[4/3] max-md:h-auto" />
          {emptyReason && (
            <p className="pointer-events-none absolute inset-x-4 top-1/2 -translate-y-1/2 rounded-md bg-background/90 p-2 text-center text-sm text-muted-foreground">
              {emptyReason}
            </p>
          )}
        </div>
        <TraceReadout
          psd={psd}
          showsInput={showsInput}
          showsTrapezoid={showsTrapezoid}
          metrics={metrics}
          fit={fit}
          timing={p.timing}
          onShowTrapezoid={!psd && !showsTrapezoid ? () => setField(PROBE_BITS.pha.ap1, 3, 'Trace 1') : undefined}
        />
      </CardContent>
    </Card>
  )
}

function Ok({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 ${ok ? '' : 'font-medium text-warning'}`}>
      {ok ? <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden="true" /> : <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />}
      {children}
    </span>
  )
}

function TraceReadout({
  psd, showsInput, showsTrapezoid, metrics, fit, timing, onShowTrapezoid,
}: {
  psd: boolean
  showsInput: boolean
  showsTrapezoid: boolean
  metrics: { input: InputMetrics | null; trap: TrapezoidMetrics | null; n: number; clipped: number } | null
  fit: { needNs: number; haveNs: number; ok: boolean } | null
  timing: BoardTiming
  onShowTrapezoid?: () => void
}) {
  const rows: React.ReactNode[] = []
  if (fit) {
    rows.push(
      <Ok key="fit" ok={fit.ok}>
        {fit.ok
          ? `Trapezoid fits the record: ${formatNs(fit.needNs)} of ${formatNs(fit.haveNs)}`
          : `Pre-trigger + trapezoid = ${formatNs(fit.needNs)} > record ${formatNs(fit.haveNs)}: raise Record Length (next run), or the falling edge and the pole-zero cannot be judged.`}
      </Ok>,
    )
  }
  const i = metrics?.input
  if (showsInput && i) {
    const pct = Math.round((i.headroom / timing.adcMax) * 100)
    rows.push(
      <span key="bl">Baseline {Math.round(i.baseline)} ± {i.baselineSd.toFixed(1)} LSB · largest pulse {Math.round(i.amplitude)} LSB</span>,
      <Ok key="hr" ok={pct >= 15 && i.amplitude < i.headroom * 0.95}>
        Headroom {Math.round(i.headroom)} LSB ({pct} % of full scale)
      </Ok>,
      <Ok key="clip" ok={(metrics?.clipped ?? 0) === 0}>
        {(metrics?.clipped ?? 0) === 0
          ? `No clipped samples in the last ${metrics?.n ?? 0} traces`
          : `${metrics?.clipped} of the last ${metrics?.n} traces clip the ADC: move the DC offset`}
      </Ok>,
    )
  }
  const t = metrics?.trap
  if (showsTrapezoid && t) {
    rows.push(
      !t.flatTopOk
        ? <Ok key="flat" ok={false}>No flat top: the top is rounded (ballistic deficit). Lengthen the flat top.</Ok>
        : <Ok key="flat" ok={Math.abs(t.flatSlopePctPerUs) < 1}>
        Flat-top slope {t.flatSlopePctPerUs >= 0 ? '+' : ''}{t.flatSlopePctPerUs.toFixed(2)} %/µs
      </Ok>,
      t.pzResidualPct === null || t.cutOff
        ? <Ok key="pz" ok={false}>The trapezoid does not return to the baseline inside the record: pole-zero not measurable</Ok>
        : <Ok key="pz" ok={Math.abs(t.pzResidualPct) < 1}>
            Pole-zero residual {t.pzResidualPct >= 0 ? '+' : ''}{t.pzResidualPct.toFixed(1)} % {Math.abs(t.pzResidualPct) >= 1 ? '(adjust the decay time towards the preamplifier fall time)' : ''}
          </Ok>,
    )
  }
  if (!psd && !showsTrapezoid && onShowTrapezoid) {
    rows.push(
      <span key="sel" className="inline-flex flex-wrap items-center gap-2 text-muted-foreground">
        Pole-zero and flat top are read from the trapezoid trace.
        <Button size="sm" variant="outline" className="h-7" onClick={onShowTrapezoid}>Show the trapezoid (next run)</Button>
      </span>,
    )
  }
  if (!rows.length) return null
  return (
    <div className="flex flex-col gap-1 text-sm" aria-label="Trace diagnostics">
      {rows}
      {metrics && metrics.n > 0 && <span className="text-xs text-muted-foreground">Median of the last {metrics.n} traces.</span>}
    </div>
  )
}
