'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Check, AlertTriangle, Circle, ChevronLeft, ChevronRight } from 'lucide-react'

/** What the page knows about the channel, for the step checks. */
export interface GuideStatus {
  tunerRun: boolean
  /** Trace 1 shows the input / the trapezoid. */
  showsInput: boolean
  showsTrapezoid: boolean
  headroomPct: number | null
  clippedTraces: number | null
  pzResidualPct: number | null
  trapezoidFits: boolean | null
  samplingInFlatTop: boolean | null
  shortBelowLong: boolean | null
  saturatedPct: number | null
  thresholdScanned: boolean
  riseScanned: boolean
  gatesScanned: boolean
  fitReliable: boolean
  presetSaved: boolean
}

type Verdict = 'ok' | 'warn' | 'unknown'

interface Step {
  id: string
  title: string
  what: string
  /** Element to scroll to and highlight. */
  target: string
  /** Analog probe code for trace 1 that this step reads, if any. */
  trace?: { code: number; name: string }
  scanTab?: 'threshold' | 'shaping' | 'psd'
  check: (s: GuideStatus) => { v: Verdict; text: string }
}

const unknown = (text: string) => ({ v: 'unknown' as const, text })

const polarity: Step = {
  id: 'dc', title: 'Polarity & DC offset', target: 'tuner-dc', trace: { code: 0, name: 'Input' },
  what: 'With trace 1 on Input, set "Negative input" to the pulse direction and move the DC offset so the baseline leaves room for the largest pulses (15 % or more of full scale) and nothing clips.',
  check: (s) => {
    if (!s.showsInput || s.headroomPct === null) return unknown('Needs the Input trace with waveforms on.')
    if ((s.clippedTraces ?? 0) > 0) return { v: 'warn', text: 'Some traces clip: more headroom.' }
    if (s.headroomPct < 15) return { v: 'warn', text: `Headroom ${s.headroomPct.toFixed(0)} %: move the DC offset.` }
    return { v: 'ok', text: `Headroom ${s.headroomPct.toFixed(0)} %, no clipping.` }
  },
}
const threshold: Step = {
  id: 'thr', title: 'Threshold', target: 'tuner-scans', scanTab: 'threshold',
  what: 'Run the threshold scan (in a Tuner run) to find where noise starts, and apply its suggestion.',
  check: (s) => (s.thresholdScanned ? { v: 'ok', text: 'Threshold scanned this session.' } : unknown(s.tunerRun ? 'Run the threshold scan.' : 'Start a Tuner run, then scan.')),
}

const PHA: Step[] = [
  polarity,
  threshold,
  {
    id: 'pz', title: 'Decay / pole-zero', target: 'tuner-decay', trace: { code: 3, name: 'Trapezoid' },
    what: 'With trace 1 on Trapezoid, set the decay time to the preamplifier\'s: the trapezoid must come back to the baseline (pole-zero residual near 0 %) with a flat top.',
    check: (s) => {
      if (!s.showsTrapezoid || s.pzResidualPct === null) return unknown('Needs the Trapezoid trace.')
      const r = Math.abs(s.pzResidualPct)
      return r <= 1 ? { v: 'ok', text: `Residual ${s.pzResidualPct.toFixed(1)} %.` } : { v: 'warn', text: `Residual ${s.pzResidualPct.toFixed(1)} %: adjust the decay time.` }
    },
  },
  {
    id: 'rise', title: 'Rise & flat top', target: 'tuner-scans', scanTab: 'shaping',
    what: 'Pick a peak on the spectrum, run the rise-time scan and apply the minimum. The flat top must cover the slowest pulses (no ballistic deficit: a longer flat top does not move the peak).',
    check: (s) => {
      if (s.trapezoidFits === false) return { v: 'warn', text: 'The trapezoid does not fit the record.' }
      return s.riseScanned ? { v: 'ok', text: 'Rise time scanned this session.' } : unknown('Run the rise-time scan.')
    },
  },
  {
    id: 'peaking', title: 'Sampling delay & peak mean', target: 'tuner-peaking',
    what: 'The energy is sampled inside the flat top: the sampling delay must be shorter than the flat top; peak mean averages a few samples there.',
    check: (s) => (s.samplingInFlatTop === null ? unknown('—') : s.samplingInFlatTop ? { v: 'ok', text: 'Sampled inside the flat top.' } : { v: 'warn', text: 'Sampling delay beyond the flat top.' }),
  },
  {
    id: 'gain', title: 'Gain / range', target: 'tuner-finegain',
    what: 'Fine gain and rescaling place the energy range on the spectrum; the highest line of interest must stay on scale and nothing saturates.',
    check: (s) => (s.saturatedPct === null ? unknown('Needs a run.') : s.saturatedPct > 1 ? { v: 'warn', text: `${s.saturatedPct.toFixed(1)} % saturated.` } : { v: 'ok', text: 'No saturation.' }),
  },
]

const PSD: Step[] = [
  polarity,
  threshold,
  {
    id: 'goff', title: 'Gate offset', target: 'tuner-goff',
    what: 'The gates open "gate offset" before the trigger: the whole pulse rise must be inside. Check on the Input trace (the Long Gate digital probe shows the gate where the board provides it).',
    check: () => unknown('Judged on the trace.'),
  },
  {
    id: 'lgate', title: 'Long gate', target: 'tuner-lgate',
    what: 'Long enough to collect the slow component (best Q-long resolution on the fitted peak), short enough to keep pile-up low.',
    check: (s) => (s.shortBelowLong === false ? { v: 'warn', text: 'Short gate ≥ long gate.' } : s.fitReliable ? { v: 'ok', text: 'Peak fitted.' } : unknown('Pick a peak on the spectrum.')),
  },
  {
    id: 'sgate', title: 'Short gate (FoM)', target: 'tuner-scans', scanTab: 'psd',
    what: 'Run the PSD gate scan with a neutron source and apply the best figure of merit.',
    check: (s) => (s.gatesScanned ? { v: 'ok', text: 'Gates scanned this session.' } : unknown('Run the PSD gate scan.')),
  },
  {
    id: 'csens', title: 'Charge sensitivity', target: 'tuner-csens',
    what: 'Choose the charge sensitivity so the largest pulses of interest stay on scale without saturating.',
    check: (s) => (s.saturatedPct === null ? unknown('Needs a run.') : s.saturatedPct > 1 ? { v: 'warn', text: `${s.saturatedPct.toFixed(1)} % saturated.` } : { v: 'ok', text: 'No saturation.' }),
  },
]

const SAVE: Step = {
  id: 'save', title: 'Save preset', target: 'tuner-history',
  what: 'Save all changes, then keep the result as a preset so it can be loaded again.',
  check: (s) => (s.presetSaved ? { v: 'ok', text: 'Preset saved.' } : unknown('Save a preset.')),
}

function Mark({ v }: { v: Verdict }) {
  if (v === 'ok') return <Check className="h-3.5 w-3.5 text-success" aria-label="done" />
  if (v === 'warn') return <AlertTriangle className="h-3.5 w-3.5 text-warning" aria-label="needs attention" />
  return <Circle className="h-3 w-3 text-muted-foreground" aria-label="not checked" />
}

/**
 * P8: "Tune this channel" — a fixed order of steps, each with what to do,
 * where on the page, and a check from what the page measures. Steps can be
 * skipped; nothing is written by the flow itself except the trace choice when
 * asked (a configuration change, as with the trace menu).
 */
export default function GuidedFlow({
  psd, status, storageKey, onSelectTrace, onScanTab,
}: {
  psd: boolean
  status: GuideStatus
  storageKey: string
  onSelectTrace: (code: number, name: string) => void
  onScanTab: (tab: 'threshold' | 'shaping' | 'psd') => void
}) {
  const steps = [...(psd ? PSD : PHA), SAVE]
  const [i, setI] = useState(0)
  useEffect(() => {
    try { const v = Number(window.sessionStorage.getItem(storageKey)); setI(Number.isFinite(v) && v >= 0 && v < steps.length ? v : 0) } catch { setI(0) }
  }, [storageKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const go = (n: number) => {
    const k = Math.max(0, Math.min(steps.length - 1, n))
    setI(k)
    try { window.sessionStorage.setItem(storageKey, String(k)) } catch { /* tab only */ }
  }
  const step = steps[i]
  const res = step.check(status)

  const show = () => {
    if (step.scanTab) onScanTab(step.scanTab)
    const el = document.getElementById(step.target)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('ring-2', 'ring-primary', 'ring-offset-2')
    setTimeout(() => el.classList.remove('ring-2', 'ring-primary', 'ring-offset-2'), 2500)
    if (el instanceof HTMLInputElement || el instanceof HTMLButtonElement) el.focus({ preventScroll: true })
  }

  return (
    <div className="space-y-3" data-testid="guided-flow">
      <ol className="flex flex-wrap gap-1.5" aria-label="Tuning steps">
        {steps.map((s, k) => {
          const r = s.check(status)
          return (
            <li key={s.id}>
              <button type="button" onClick={() => go(k)} aria-current={k === i ? 'step' : undefined}
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${k === i ? 'border-primary bg-primary/10 font-semibold' : 'hover:bg-muted'}`}>
                <span className="tabular-nums">{k + 1}</span> {s.title} <Mark v={r.v} />
              </button>
            </li>
          )
        })}
      </ol>
      <div className="rounded-md border p-3">
        <p className="text-sm font-semibold">{i + 1}. {step.title}</p>
        <p className="mt-1 text-sm">{step.what}</p>
        <p className={`mt-2 flex items-center gap-1.5 text-sm ${res.v === 'ok' ? 'text-success' : res.v === 'warn' ? 'text-warning' : 'text-muted-foreground'}`} aria-live="polite">
          <Mark v={res.v} /> {res.text}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={show}>Show me</Button>
          {step.trace && !(step.trace.code === 0 ? status.showsInput : status.showsTrapezoid) && (
            <Button size="sm" variant="outline" onClick={() => onSelectTrace(step.trace!.code, step.trace!.name)}>
              Trace 1: {step.trace.name} (next run)
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => go(i - 1)} disabled={i === 0}><ChevronLeft className="mr-1 h-4 w-4" aria-hidden="true" />Back</Button>
            <Button size="sm" onClick={() => go(i + 1)} disabled={i === steps.length - 1}>
              {res.v === 'ok' ? 'Next' : 'Skip'}<ChevronRight className="ml-1 h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
