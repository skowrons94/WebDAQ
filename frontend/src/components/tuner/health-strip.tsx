'use client'

import { AlertTriangle } from 'lucide-react'
import { formatRate } from '@/components/tuner/format'
import type { ChannelRates } from '@/components/tuner/use-channel-rates'

/**
 * Expected flagged pile-up fraction for a Poisson rate R and a pile-up
 * window T: a pulse is flagged when another arrives within T before or
 * after it (both are flagged), so 1 − e^(−2·R·T).
 */
export function expectedPileup(ratePerS: number, windowNs: number): number {
  if (!(ratePerS > 0) || !(windowNs > 0)) return 0
  return 1 - Math.exp(-2 * ratePerS * windowNs * 1e-9)
}

export interface HealthWarning { text: string; severity: 'warn' | 'error' }

/** The warnings the strip raises for a reading (exported for tests). */
export function healthWarnings(r: ChannelRates, windowNs: number, psd: boolean): HealthWarning[] {
  const out: HealthWarning[] = []
  if (r.event <= 0) return out
  const satFrac = r.satu / r.event
  const puFrac = r.pileup / r.event
  const exp = expectedPileup(r.event, windowNs)
  if (satFrac > 0.01) {
    out.push({
      severity: satFrac > 0.1 ? 'error' : 'warn',
      text: `${Math.round(satFrac * 100)} % of pulses clip the ADC (saturated events are not in the spectrum): move the DC offset for more headroom, or use the 2 Vpp input range (DAQ page, next run).`,
    })
  }
  if (puFrac > 0.01 && puFrac > 2 * exp) {
    out.push({
      severity: 'warn',
      text: psd
        ? `Pile-up ${(puFrac * 100).toFixed(1)} % is more than twice the ${(exp * 100).toFixed(1)} % expected for this rate and long gate: noise triggers, or a gate longer than needed.`
        : `Pile-up ${(puFrac * 100).toFixed(1)} % is more than twice the ${(exp * 100).toFixed(1)} % expected for this rate and trapezoid: noise triggers, or a pole-zero (decay time) mismatch.`,
    })
  }
  if (r.lost > 0) {
    out.push({
      severity: 'error',
      text: `${formatRate(r.lost)} of events are lost: the board cannot keep up. Raise the threshold or lower the rate.`,
    })
  }
  return out
}

/**
 * One line of rates for the channel being tuned (P2): what the knobs do to
 * the count rate, pile-up, saturation and losses, where the knobs are.
 */
export function HealthStrip({
  rates, windowNs, psd, running,
}: {
  rates: ChannelRates | null
  /** Pile-up window from the registers: rise + sampling delay + peak hold-off for PHA, gate offset + long gate for PSD. */
  windowNs: number
  psd: boolean
  running: boolean
}) {
  if (!running) {
    return (
      <div className="rounded-lg border bg-card px-4 py-3 text-sm text-muted-foreground" role="status">
        Rates appear here while a run is on: start one from here (Tuner run, not saved) or from the Dashboard.
      </div>
    )
  }
  if (!rates) {
    return (
      <div className="rounded-lg border bg-card px-4 py-3 text-sm text-muted-foreground" role="status">
        Waiting for the first rates of this channel…
      </div>
    )
  }
  const sat = rates.event > 0 ? rates.satu / rates.event : 0
  const pu = rates.event > 0 ? rates.pileup / rates.event : 0
  const exp = expectedPileup(rates.event, windowNs)
  const warnings = healthWarnings(rates, windowNs, psd)
  const cell = 'flex flex-col'
  const k = 'text-xs text-muted-foreground'
  const v = 'font-mono text-sm font-semibold tabular-nums'
  return (
    <div className="rounded-lg border bg-card px-4 py-3" role="region" aria-label="Channel health">
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <div className={cell}><span className={k}>Rate</span><span className={v}>{formatRate(rates.event)}</span></div>
        <div className={cell}>
          <span className={k}>Pile-up</span>
          <span className={v}>{(pu * 100).toFixed(1)} %<span className="ml-1 font-sans text-xs font-normal text-muted-foreground" title={psd ? 'Approximate for DPP-PSD: 1 − e^(−R·(offset + long gate)), to be verified on hardware' : '1 − e^(−2·R·T), T = rise + sampling delay + peak hold-off'}>({psd ? '≈ ' : ''}exp. {(exp * 100).toFixed(1)} %{psd ? ', approximate' : ''})</span></span>
        </div>
        <div className={cell}>
          <span className={k}>Saturated</span>
          <span className={`${v} ${sat > 0.01 ? 'text-destructive' : ''}`}>{(sat * 100).toFixed(1)} %</span>
        </div>
        <div className={cell}>
          <span className={k}>Lost</span>
          <span className={`${v} ${rates.lost > 0 ? 'text-destructive' : ''}`}>{formatRate(rates.lost)}</span>
        </div>
        <div className={cell}>
          <span className={k}>Dead time</span>
          <span className="text-xs text-muted-foreground" title="Not available from the server">not reported</span>
        </div>
      </div>
      {warnings.length > 0 && (
        <ul className="mt-2 space-y-1" aria-live="polite">
          {warnings.map((w, i) => (
            <li key={i} className={`flex items-start gap-1.5 text-sm ${w.severity === 'error' ? 'font-semibold text-destructive' : 'text-warning'}`}>
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {w.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * The pile-up window T from the channel's settings, for expectedPileup's
 * 1 − e^(−2·R·T):
 *  - DPP-PHA: the trapezoid's rise, the energy sampling delay and the peak
 *    hold-off after the trigger; both pulses are tagged, hence the factor 2.
 *  - DPP-PSD: APPROXIMATE, to be verified on hardware. A pulse is tagged when
 *    another falls inside its gate (offset before the trigger, long gate −
 *    offset after), so about 1 − e^(−R·(offset + long gate)): the lower, more
 *    sensitive form. Returned as half the gate so the shared formula gives it.
 */
export function pileupWindow(psd: boolean, v: { riseNs: number; samplingDelayNs: number; peakHoldNs: number; longGateNs: number; gateOffsetNs: number }): number {
  return psd ? (v.gateOffsetNs + v.longGateNs) / 2 : v.riseNs + v.samplingDelayNs + v.peakHoldNs
}
