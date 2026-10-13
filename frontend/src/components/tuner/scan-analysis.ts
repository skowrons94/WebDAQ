/** Pure analysis of scan results (P5, P6), kept apart so it can be tested. */

export interface ThresholdPoint { threshold: number; rate: number; lost: number }

export interface KneeResult {
  /** First threshold (going down) where noise triggers show; null if none seen. */
  knee: number | null
  /** Suggested threshold: 1.3 × knee, never below the last clean step. */
  recommended: number | null
  /** Short explanation for the operator. */
  text: string
}

/**
 * The noise knee of a threshold scan. Above the noise, the rate grows slowly
 * and steadily as the threshold comes down (the physics spectrum); once the
 * threshold reaches the noise (rate ∝ exp(−Th²/2σ²)) it grows much faster.
 * The knee is the first step whose growth is far above the plateau's.
 */
export function noiseKnee(points: ThresholdPoint[]): KneeResult {
  const p = points.filter((q) => q.rate > 0).slice().sort((a, b) => b.threshold - a.threshold)
  if (p.length < 3) return { knee: null, recommended: null, text: 'Too few steps with counts to judge.' }
  // Growth of ln(rate) per LSB between neighbouring steps.
  const g: number[] = []
  for (let i = 0; i + 1 < p.length; i++) {
    const dth = p[i].threshold - p[i + 1].threshold
    g.push(dth > 0 ? (Math.log(p[i + 1].rate) - Math.log(p[i].rate)) / dth : 0)
  }
  const head = g.slice(0, Math.max(2, Math.floor(g.length / 2))).map((v) => Math.max(0, v)).sort((a, b) => a - b)
  const plateau = head[Math.floor(head.length / 2)]
  for (let i = 0; i < g.length; i++) {
    const dth = p[i].threshold - p[i + 1].threshold
    // Far faster than the plateau, and at least 50 % more counts in one step.
    const jump = p[i + 1].rate / p[i].rate
    if (g[i] > 3 * plateau + 1e-9 && jump > 1.5 * Math.exp(plateau * dth)) {
      const knee = p[i + 1].threshold
      const recommended = Math.max(p[i].threshold, Math.ceil(1.3 * knee))
      return { knee, recommended, text: `Noise starts at about ${knee} LSB: the rate jumps ×${jump.toFixed(1)} from ${p[i].threshold} to ${knee} LSB.` }
    }
    if (p[i + 1].lost > 0) {
      return { knee: p[i + 1].threshold, recommended: Math.max(p[i].threshold, Math.ceil(1.3 * p[i + 1].threshold)), text: `Events are lost at ${p[i + 1].threshold} LSB.` }
    }
  }
  const lowest = p[p.length - 1].threshold
  return { knee: null, recommended: null, text: `No noise knee down to ${lowest} LSB: any tested value is clean; scan lower to find the limit.` }
}

export interface ResolutionPoint { x: number; fwhm: number; fwhmErr: number; pileupPct: number }

/**
 * The best step of a resolution scan: the lowest FWHM, preferring the
 * shorter setting when two are within errors (less pile-up, less dead time).
 */
export function bestResolution(points: ResolutionPoint[]): ResolutionPoint | null {
  const ok = points.filter((q) => Number.isFinite(q.fwhm) && q.fwhm > 0)
  if (!ok.length) return null
  const min = ok.reduce((a, b) => (b.fwhm < a.fwhm ? b : a))
  const tol = Number.isFinite(min.fwhmErr) ? min.fwhmErr : 0
  return ok.filter((q) => q.fwhm <= min.fwhm + tol).sort((a, b) => a.x - b.x)[0]
}
