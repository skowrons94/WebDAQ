import { describe, expect, it } from 'vitest'
import { changedSince, fieldChanges, undoTarget } from '@/lib/tuner-history'
import { spectrumSince } from '@/components/tuner/spectrum-panel'
import { binCenters, fitPeak, groupFor } from '@/lib/peak-fit'
import { trapezoidMetrics } from '@/lib/trace-metrics'
import { expectedPileup, pileupWindow } from '@/components/tuner/health-strip'
import { getBits, setBits } from '@/components/tuner/units'

// ── M1: undo is field-level ──
describe('history: one entry per field of a shared register (M1)', () => {
  const ALGO = '0x1080' // DPP-PHA algorithm control: invert [16], baseline mean [20:22], ...
  it('logs baseline mean and polarity as two separate fields', () => {
    const from = setBits(setBits(0, [20, 22], 3), [16, 16], 0)
    const to = setBits(setBits(0, [20, 22], 5), [16, 16], 1)
    const c = fieldChanges('DPP-PHA', ALGO, from, to)
    expect(c.map((x) => x.spec?.id).sort()).toEqual(['blmean', 'invert'])
  })
  it('undoing baseline mean keeps the polarity that was switched on later', () => {
    const before = setBits(0, [20, 22], 3)
    const afterBl = setBits(before, [20, 22], 5)
    const entry = fieldChanges('DPP-PHA', ALGO, before, afterBl).map((c) => ({ bits: c.spec!.bits!, from: c.from, to: c.to }))[0]
    const nowInverted = setBits(afterBl, [16, 16], 1)
    const target = undoTarget(entry, nowInverted)
    expect(getBits(target, [20, 22])).toBe(3)
    expect(getBits(target, [16, 16])).toBe(1)
    expect(changedSince(entry, nowInverted)).toBe(false)
    expect(changedSince(entry, setBits(nowInverted, [20, 22], 6))).toBe(true)
  })
  it('a whole register without fields undoes as a whole', () => {
    const c = fieldChanges('DPP-PHA', '0x106C', 100, 120)
    expect(c).toHaveLength(1)
    expect(undoTarget({ bits: c[0].spec?.bits, from: c[0].from }, 120)).toBe(100)
  })
})

// ── M2: variance of the since-last-change spectrum ──
describe('spectrumSince variance (M2)', () => {
  it('is the new counts, at least 1', () => {
    const snap = { y: Float64Array.from([10, 100, 5]), nbins: 3, xmin: 0, xmax: 3 }
    const cur = { y: Float64Array.from([10, 140, 9]), nbins: 3, xmin: 0, xmax: 3 }
    const d = spectrumSince(cur, snap)!
    expect(Array.from(d.y)).toEqual([0, 40, 4])
    expect(Array.from(d.variance)).toEqual([1, 40, 4])
  })
})

// ── M3: fit grouping follows the peak width ──
describe('fit grouping (M3)', () => {
  const gaussSpec = (n: number, mu: number, sigma: number, area: number, bg: number, w: number) => {
    const x = binCenters(n, 0, n * w)
    const y = Float64Array.from(x, (xx) => Math.round(bg + (area * w) / (sigma * Math.sqrt(2 * Math.PI)) * Math.exp(-((xx - mu) ** 2) / (2 * sigma * sigma))))
    return { x, y }
  }
  it('keeps at least 6 fit bins per FWHM of a narrow peak in a wide region', () => {
    // 1.6 keV FWHM HPGe line in a ±52 keV region of 0.09 keV bins
    const { x, y } = gaussSpec(32768, 1332, 1.6 / 2.3548, 20000, 2, 0.09)
    const lo = 1280, hi = 1384
    const idx = Array.from(x).map((v, i) => [v, i]).filter(([v]) => v >= lo && v <= hi).map(([, i]) => i)
    const k = groupFor(Float64Array.from(idx, (i) => y[i]), idx.length)
    expect(1.6 / (k * 0.09)).toBeGreaterThanOrEqual(5.5)
    const f = fitPeak(x, y, lo, hi)!
    expect(f.fwhm).toBeGreaterThan(1.45)
    expect(f.fwhm).toBeLessThan(1.75)
    expect(f.warning ?? '').not.toMatch(/fewer than two/)
  })
  it('flags a continuum instead of calling it a peak (H4)', () => {
    const x = binCenters(400, 0, 400)
    const y = Float64Array.from(x, (v) => (v < 200 ? 50 : 50 * Math.exp(-(v - 200) / 20)))
    const f = fitPeak(x, y, 150, 260)
    expect(!f || /continuum/.test(f.warning ?? '')).toBe(true)
  })
})

// ── M4: pole-zero on the tail, flat top required ──
describe('trapezoid metrics (M4)', () => {
  // Trapezoid with a slow fall (rise + collection time) and a residual level after it.
  const trap = (opts: { n: number; pre: number; rise: number; flat: number; fallExtra: number; residual: number; round?: boolean }) => {
    const out = new Float64Array(opts.n)
    const H = 1000
    for (let i = 0; i < opts.n; i++) {
      const t = i - opts.pre
      let v = 0
      if (t < 0) v = 0
      else if (t < opts.rise) v = (H * t) / opts.rise
      else if (t < opts.rise + opts.flat) v = opts.round ? H * (1 - 0.15 * Math.abs((t - opts.rise - opts.flat / 2) / (opts.flat / 2))) : H
      else if (t < 2 * opts.rise + opts.flat + opts.fallExtra) v = H - ((H - opts.residual * H) * (t - opts.rise - opts.flat)) / (opts.rise + opts.fallExtra)
      else v = opts.residual * H
      out[i] = 100 + v
    }
    return out
  }
  it('reads ≈ 0 % when the trace is back at baseline, even with a slow fall', () => {
    const x = trap({ n: 2000, pre: 200, rise: 250, flat: 60, fallExtra: 120, residual: 0 })
    const m = trapezoidMetrics(x, { preSamples: 200, sampleNs: 8, riseNs: 2000, flatNs: 480 })!
    expect(m.pzResidualPct).not.toBeNull()
    expect(Math.abs(m.pzResidualPct!)).toBeLessThan(0.5)
  })
  it('reads an overshoot from the record tail', () => {
    const x = trap({ n: 2000, pre: 200, rise: 250, flat: 60, fallExtra: 0, residual: 0.06 })
    const m = trapezoidMetrics(x, { preSamples: 200, sampleNs: 8, riseNs: 2000, flatNs: 480 })!
    expect(m.pzResidualPct!).toBeGreaterThan(4)
  })
  it('gives nothing when the trapezoid does not finish in the record', () => {
    const x = trap({ n: 700, pre: 200, rise: 250, flat: 60, fallExtra: 0, residual: 0 })
    const m = trapezoidMetrics(x, { preSamples: 200, sampleNs: 8, riseNs: 2000, flatNs: 480 })!
    expect(m.pzResidualPct).toBeNull()
  })
  it('does not pass a rounded top as a flat top', () => {
    const x = trap({ n: 2000, pre: 200, rise: 250, flat: 60, fallExtra: 0, residual: 0, round: true })
    const m = trapezoidMetrics(x, { preSamples: 200, sampleNs: 8, riseNs: 2000, flatNs: 480 })!
    expect(m.flatTopOk).toBe(false)
    const ok = trapezoidMetrics(trap({ n: 2000, pre: 200, rise: 250, flat: 60, fallExtra: 0, residual: 0 }), { preSamples: 200, sampleNs: 8, riseNs: 2000, flatNs: 480 })!
    expect(ok.flatTopOk).toBe(true)
  })
})

// ── H2: pile-up expectation ──
describe('expected pile-up (H2)', () => {
  it('is 1 − exp(−2RT)', () => {
    expect(expectedPileup(1000, 5000)).toBeCloseTo(1 - Math.exp(-2 * 1000 * 5e-6), 10)
    expect(expectedPileup(0, 5000)).toBe(0)
  })
  it('uses rise + sampling delay + peak hold-off (PHA) and offset + long gate (PSD)', () => {
    expect(pileupWindow(false, { riseNs: 4000, samplingDelayNs: 800, peakHoldNs: 1000, longGateNs: 0, gateOffsetNs: 0 })).toBe(5800)
    expect(pileupWindow(true, { riseNs: 0, samplingDelayNs: 0, peakHoldNs: 0, longGateNs: 400, gateOffsetNs: 40 })).toBe(440)
  })
})
