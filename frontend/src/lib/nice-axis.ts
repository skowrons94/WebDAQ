/**
 * Round y ticks (steps of 1, 2 or 5 × 10ⁿ) and one number of decimals for
 * the whole axis, set by the step: "12, 9, 6, 3, 0" rather than recharts'
 * own "12.0, 9.00, 6.00, 3.00, 0", where each label had its own precision.
 */
export function niceAxis(lo: number, hi: number, count = 5): { ticks: number[]; decimals: number } | null {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null
  if (hi === lo) { hi = lo + (Math.abs(lo) || 1); lo = Math.min(lo, 0) }
  const raw = (hi - lo) / Math.max(1, count - 1)
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 5, 10].map((m) => m * mag).find((v) => v >= raw) ?? 10 * mag
  const start = Math.floor(lo / step) * step
  // The last tick is the first one at or above the maximum, so the trace
  // never runs above the top of the axis.
  const ticks: number[] = []
  for (let v = start; ; v += step) {
    ticks.push(Number(v.toPrecision(12)))
    if ((v >= hi - step * 1e-9 && ticks.length >= 2) || ticks.length > 20) break
  }
  return { ticks, decimals: Math.max(0, -Math.floor(Math.log10(step) + 1e-9)) }
}
