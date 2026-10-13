/**
 * Numbers read off a digitizer trace (Tuner P4): baseline, pulse, clipping and
 * headroom on the input; flat-top flatness and pole-zero residual on the
 * trapezoid. Pure functions on sample arrays, so they can be tested and reused
 * by the guided checklist.
 */

export interface InputMetrics {
  baseline: number
  baselineSd: number
  /** Pulse height from the baseline, in the pulse's own direction (LSB). */
  amplitude: number
  /** Samples at 0 or at full scale. */
  clipped: number
  /** LSB from the baseline to the rail the pulses move towards. */
  headroom: number
}

export interface TrapezoidMetrics {
  /** Flat-top height above the pre-trigger level (LSB). */
  height: number
  /** Slope over the flat top, % of the height per µs (≈ 0 when the pole-zero is right). */
  flatSlopePctPerUs: number
  /** Level after the trapezoid has fallen, % of the height (≈ 0 when the pole-zero is right). */
  pzResidualPct: number | null
  /** The falling edge does not end inside the record. */
  cutOff: boolean
  /** Samples of the top within 2 % of its height. */
  flatSamples: number
  /** The top is flat for at least half the flat-top setting (no rounded, ballistic-deficit top). */
  flatTopOk: boolean
}

const mean = (a: ArrayLike<number>, i0: number, i1: number) => {
  let s = 0
  const n = Math.max(0, i1 - i0)
  for (let i = i0; i < i1; i++) s += a[i]
  return n ? s / n : NaN
}
const sd = (a: ArrayLike<number>, i0: number, i1: number, m: number) => {
  let s = 0
  const n = Math.max(0, i1 - i0)
  for (let i = i0; i < i1; i++) s += (a[i] - m) ** 2
  return n > 1 ? Math.sqrt(s / (n - 1)) : 0
}

/** Samples of a TH1 trace as the server sends it (fArray minus under/overflow). */
export function traceSamples(th1: { fArray?: ArrayLike<number>; fXaxis?: { fNbins?: number } } | null | undefined): Float64Array | null {
  const arr = th1?.fArray
  if (!arr || arr.length < 4) return null
  const n = th1?.fXaxis?.fNbins ?? arr.length - 2
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) out[i] = Number(arr[i + 1]) || 0
  return out
}

/** Index range treated as baseline: the pre-trigger part, or the first 10 %. */
function preRange(n: number, preSamples: number | null): [number, number] {
  const end = preSamples && preSamples > 4 && preSamples < n ? Math.floor(preSamples * 0.8) : Math.max(4, Math.floor(n * 0.1))
  return [0, Math.min(n, end)]
}

export function inputMetrics(x: ArrayLike<number>, opts: { preSamples: number | null; adcMax: number; negative: boolean }): InputMetrics | null {
  const n = x.length
  if (n < 8) return null
  const [a, b] = preRange(n, opts.preSamples)
  const base = mean(x, a, b)
  const s = sd(x, a, b, base)
  let amp = 0
  let clipped = 0
  for (let i = 0; i < n; i++) {
    const d = opts.negative ? base - x[i] : x[i] - base
    if (d > amp) amp = d
    if (x[i] <= 0 || x[i] >= opts.adcMax) clipped++
  }
  return {
    baseline: base,
    baselineSd: s,
    amplitude: amp,
    clipped,
    headroom: opts.negative ? base : opts.adcMax - base,
  }
}

export function trapezoidMetrics(x: ArrayLike<number>, opts: { preSamples: number | null; sampleNs: number; riseNs: number; flatNs?: number | null }): TrapezoidMetrics | null {
  const n = x.length
  if (n < 16) return null
  const [a, b] = preRange(n, opts.preSamples)
  const base = mean(x, a, b)
  // The trapezoid may come out either way up: take the larger excursion.
  let hi = -Infinity, lo = Infinity, iHi = 0, iLo = 0
  for (let i = 0; i < n; i++) {
    if (x[i] > hi) { hi = x[i]; iHi = i }
    if (x[i] < lo) { lo = x[i]; iLo = i }
  }
  const up = hi - base >= base - lo
  const sign = up ? 1 : -1
  const iPk = up ? iHi : iLo
  const height = sign * ((up ? hi : lo) - base)
  if (!(height > 0)) return null
  // Top: the contiguous run around the peak above 90 % of the height (edges
  // included), and the part of it within 2 % of the height (the flat top).
  const above = (i: number) => sign * (x[i] - base) >= 0.9 * height
  let p0 = iPk, p1 = iPk
  while (p0 > 0 && above(p0 - 1)) p0--
  while (p1 < n - 1 && above(p1 + 1)) p1++
  let flatSamples = 0
  for (let i = p0; i <= p1; i++) if (sign * (x[i] - base) >= 0.98 * height) flatSamples++
  const setFlat = opts.flatNs && opts.flatNs > 0 ? opts.flatNs / opts.sampleNs : null
  const flatTopOk = setFlat !== null ? flatSamples >= Math.max(3, 0.5 * setFlat) : flatSamples >= 3
  // Slope over the middle 80 % of the top (least squares); only on a real flat top.
  const len = p1 - p0 + 1
  let slopePctPerUs = 0
  if (flatTopOk && len >= 5) {
    const q0 = p0 + Math.floor(len * 0.1), q1 = p1 - Math.floor(len * 0.1)
    let sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0
    for (let i = q0; i <= q1; i++) {
      const t = i; const y = sign * (x[i] - base)
      sx += t; sy += y; sxx += t * t; sxy += t * y; m++
    }
    const slopePerSample = (m * sxy - sx * sy) / Math.max(1e-9, m * sxx - sx * sx)
    slopePctPerUs = (slopePerSample / height) * 100 * (1000 / opts.sampleNs)
  }
  // Pole-zero residual: on the tail once the trapezoid has fallen, not on the
  // falling edge (which lasts rise + charge-collection time). Start where the
  // trace first drops below 3 % of the height; if it never does (an
  // overshoot), use the last part of the record, at least two rise times
  // after the top. Nothing when neither is in the record.
  const riseSamples = Math.ceil(opts.riseNs / opts.sampleNs)
  const tailLen = Math.max(8, Math.floor(n * 0.1))
  let t0 = -1
  for (let i = p1 + 1; i < n; i++) if (sign * (x[i] - base) < 0.03 * height) { t0 = i + Math.max(2, Math.floor(riseSamples * 0.1)); break }
  if (t0 < 0 && n - tailLen >= p1 + 2 * riseSamples) t0 = n - tailLen
  const cutOff = t0 < 0 || t0 + 4 > n
  let pz: number | null = null
  if (!cutOff) {
    const t1 = Math.min(n, t0 + tailLen)
    pz = ((sign * (mean(x, t0, t1) - base)) / height) * 100
  }
  return { height, flatSlopePctPerUs: slopePctPerUs, pzResidualPct: pz, cutOff, flatSamples, flatTopOk }
}

/** The median of the finite values (robust against the odd pile-up trace). */
export function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}
