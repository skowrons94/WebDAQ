'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Check, AlertTriangle, Circle, ChevronLeft, ChevronRight } from 'lucide-react'

/** What the page measures about the channel, for the step checks. */
export interface GuideStatus {
  running: boolean
  /** Trace 1 shows the input / the trapezoid. */
  showsInput: boolean
  showsTrapezoid: boolean
  headroomPct: number | null
  clippedTraces: number | null
  pzResidualPct: number | null
  /** The trapezoid shows a flat top (null: not measured). */
  flatTopOk: boolean | null
  trapezoidFits: boolean | null
  samplingInFlatTop: boolean | null
  shortBelowLong: boolean | null
  saturatedPct: number | null
  pileupPct: number | null
  expectedPileupPct: number | null
  lostPerS: number | null
  fitReliable: boolean
  fitText: string | null
  /** FWTM/FWHM of the fitted peak (1.82 for a pure Gaussian). */
  fwtmRatio: number | null
  /** The threshold was changed or confirmed on this channel in this session. */
  thresholdSet: boolean
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
  /** A button that confirms the present setting for this step. */
  confirm?: string
  check: (s: GuideStatus) => { v: Verdict; text: string }
}

const unknown = (text: string) => ({ v: 'unknown' as const, text })

const polarity: Step = {
  id: 'dc', title: 'Polarity and DC offset', target: 'tuner-dc', trace: { code: 0, name: 'Input' },
  what: 'With trace 1 on Input, set "Negative input" to the pulse direction and move the DC offset so the baseline leaves room for the largest pulses and nothing clips.',
  check: (s) => {
    if (!s.showsInput || s.headroomPct === null) return unknown('Needs the Input trace with waveforms on.')
    if ((s.clippedTraces ?? 0) > 0) return { v: 'warn', text: 'Some traces clip: more headroom.' }
    if ((s.saturatedPct ?? 0) > 1) return { v: 'warn', text: `${s.saturatedPct!.toFixed(1)} % of pulses saturate: more headroom.` }
    if (s.headroomPct < 15) return { v: 'warn', text: `Headroom ${s.headroomPct.toFixed(0)} %: move the DC offset.` }
    return { v: 'ok', text: `Headroom ${s.headroomPct.toFixed(0)} %, no clipping.` }
  },
}
const threshold: Step = {
  id: 'thr', title: 'Threshold', target: 'tuner-thr',
  what: 'Lower the threshold until the rate starts to climb steeply (noise triggers), then raise it again by about a third. Watch rate, pile-up and losses in the strip above.',
  confirm: 'This threshold is right',
  check: (s) => {
    if (!s.running || s.pileupPct === null) return unknown('Needs a run.')
    if ((s.lostPerS ?? 0) > 0) return { v: 'warn', text: 'Events are being lost: raise the threshold.' }
    if (s.expectedPileupPct !== null && s.pileupPct > 1 && s.pileupPct > 2 * s.expectedPileupPct) {
      return { v: 'warn', text: `Pile-up ${s.pileupPct.toFixed(1)} % against ${s.expectedPileupPct.toFixed(1)} % expected: noise triggers?` }
    }
    if (!s.thresholdSet) return unknown('No excess pile-up, nothing lost. Change the threshold, or confirm it, to tick this step.')
    return { v: 'ok', text: 'Threshold set; no excess pile-up, nothing lost.' }
  },
}

const PHA: Step[] = [
  polarity,
  threshold,
  {
    id: 'pz', title: 'Decay / pole-zero', target: 'tuner-decay', trace: { code: 3, name: 'Trapezoid' },
    what: 'With trace 1 on Trapezoid, set the decay time to the preamplifier\'s: after the trapezoid the trace must come back to the baseline (pole-zero residual near 0 %), with a flat top. Judge it at the rise time you will use: with short rise times the residual is small for any decay time.',
    check: (s) => {
      if (!s.showsTrapezoid || s.pzResidualPct === null) return unknown('Needs the Trapezoid trace, with its tail in the record.')
      if (s.flatTopOk === false) return { v: 'warn', text: 'No flat top on the trapezoid: lengthen the flat top first.' }
      const r = Math.abs(s.pzResidualPct)
      return r <= 1 ? { v: 'ok', text: `Residual ${s.pzResidualPct.toFixed(1)} %.` } : { v: 'warn', text: `Residual ${s.pzResidualPct.toFixed(1)} %: adjust the decay time.` }
    },
  },
  {
    id: 'rise', title: 'Rise and flat top', target: 'tuner-rise',
    what: 'Pick a peak on the spectrum and try a few rise times, comparing the FWHM "since last change" for each. The flat top must cover the slowest pulses: a longer flat top must not move the peak.',
    check: (s) => {
      if (s.trapezoidFits === false) return { v: 'warn', text: 'The trapezoid does not fit the record.' }
      if (s.flatTopOk === false) return { v: 'warn', text: 'The trapezoid has no flat top: lengthen it, or check the pole-zero.' }
      if (!s.fitReliable) return unknown('Pick a peak on the spectrum.')
      // Earned: a near-Gaussian peak (no long tail) with the pole-zero right.
      const pzOk = s.pzResidualPct !== null && Math.abs(s.pzResidualPct) <= 1 && s.flatTopOk === true
      if (s.fwtmRatio !== null && s.fwtmRatio > 2.5) return { v: 'warn', text: `${s.fitText ?? ''} FWTM/FWHM ${s.fwtmRatio.toFixed(2)}: a tail (pole-zero, ballistic deficit or charge trapping).` }
      return pzOk ? { v: 'ok', text: s.fitText ?? 'Peak fitted.' } : unknown(`${s.fitText ?? 'Peak fitted.'} Check the pole-zero on the trapezoid trace to tick this step.`)
    },
  },
  {
    id: 'peaking', title: 'Sampling delay and peak mean', target: 'tuner-peaking',
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
    what: 'The gates open "gate offset" before the trigger: the whole pulse rise must be inside. Check on the Input trace (the Long gate digital probe shows the gate where the board provides it).',
    check: () => unknown('Judged on the trace.'),
  },
  {
    id: 'lgate', title: 'Long gate', target: 'tuner-lgate',
    what: 'Long enough to collect the slow component (best Q-long resolution on the fitted peak), short enough to keep pile-up low.',
    check: (s) => (s.shortBelowLong === false ? { v: 'warn', text: 'Short gate ≥ long gate.' } : s.fitReliable ? unknown(`${s.fitText ?? 'Peak fitted.'} Compare it for a few long gates.`) : unknown('Pick a peak on the spectrum.')),
  },
  {
    id: 'sgate', title: 'Short gate', target: 'tuner-sgate',
    what: 'With a neutron source, change the short gate in small steps and compare the neutron/gamma separation on the PSD plot (Histograms).',
    check: (s) => (s.shortBelowLong === null ? unknown('—') : s.shortBelowLong ? unknown('Judged on the PSD plot.') : { v: 'warn', text: 'Short gate ≥ long gate.' }),
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
 * P8: "Tune this channel" — a checklist of manual steps in a fixed order,
 * each with what to do, where on the page, and a check from what the page
 * measures. A step shows its verdict once it has been visited. Nothing is
 * written by the checklist itself except the trace choice when asked (a
 * configuration change, as with the trace menu).
 */
export default function GuidedFlow({
  psd, status, storageKey, onSelectTrace, onConfirm,
}: {
  psd: boolean
  status: GuideStatus
  storageKey: string
  onSelectTrace: (code: number, name: string) => void
  /** The operator confirms the present setting of a step (by step id). */
  onConfirm?: (stepId: string) => void
}) {
  const steps = [...(psd ? PSD : PHA), SAVE]
  const [i, setI] = useState(0)
  // Steps visited so far: only those show a verdict in the list.
  const [visited, setVisited] = useState<Set<number>>(new Set([0]))
  useEffect(() => {
    let k = 0
    let seen: number[] = []
    try {
      const v = Number(window.sessionStorage.getItem(storageKey))
      k = Number.isFinite(v) && v >= 0 && v < steps.length ? v : 0
      seen = JSON.parse(window.sessionStorage.getItem(`${storageKey}:seen`) ?? '[]')
    } catch { /* tab only */ }
    setI(k)
    setVisited(new Set([...seen, k]))
  }, [storageKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const go = (n: number) => {
    const k = Math.max(0, Math.min(steps.length - 1, n))
    setI(k)
    setVisited((v) => {
      const next = new Set(v).add(k)
      try {
        window.sessionStorage.setItem(storageKey, String(k))
        window.sessionStorage.setItem(`${storageKey}:seen`, JSON.stringify(Array.from(next)))
      } catch { /* tab only */ }
      return next
    })
  }
  const step = steps[i]
  const res = step.check(status)

  const show = () => {
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
          const r = visited.has(k) ? s.check(status) : { v: 'unknown' as const }
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
          {step.confirm && onConfirm && res.v !== 'ok' && (
            <Button size="sm" variant="outline" onClick={() => onConfirm(step.id)}>{step.confirm}</Button>
          )}
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
