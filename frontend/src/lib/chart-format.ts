/**
 * Shared formatting for the dashboard plots.
 *
 * Two problems this solves, both of which made the plots hard to read:
 *
 *  • Fixed units. A beam current fixed to µA reads "0.0004" when the beam is in
 *    the nanoamp range and "12000" when it is in milliamps — the axis becomes a
 *    column of zeroes or a wall of digits. Picking the unit from the data keeps
 *    the numbers short, which is also what stops the tick labels colliding.
 *
 *  • Layout. Recharts places the legend at the bottom by default, exactly where
 *    an "insideBottom" x-axis label goes, so the two overlap. The constants here
 *    put the legend above the plot and leave room for the axis titles.
 */

export interface UnitChoice {
  /** Multiply raw values by this to get the displayed number. */
  scale: number
  /** Unit to show on the axis. */
  unit: string
}

interface UnitStep {
  /** Applies when the largest magnitude is at least this, in base units. */
  min: number
  scale: number
  unit: string
}

function pick(maxAbs: number, ladder: UnitStep[]): UnitChoice {
  // Not finite, or all zero: keep the base unit rather than inventing a scale.
  if (!Number.isFinite(maxAbs) || maxAbs <= 0) {
    const base = ladder.find(s => s.scale === 1) ?? ladder[ladder.length - 1]
    return { scale: base.scale, unit: base.unit }
  }
  for (const step of ladder) {
    if (maxAbs >= step.min) return { scale: step.scale, unit: step.unit }
  }
  const last = ladder[ladder.length - 1]
  return { scale: last.scale, unit: last.unit }
}

/** Largest absolute value in a set of samples, ignoring nulls and NaNs. */
export function maxMagnitude(values: Array<number | null | undefined>): number {
  let max = 0
  for (const v of values) {
    if (v === null || v === undefined) continue
    const a = Math.abs(v)
    if (Number.isFinite(a) && a > max) max = a
  }
  return max
}

/**
 * Unit for a current whose samples are in microamps — the unit both the TetrAMM
 * and the RBD 9103 log in.
 *
 * The switch points sit a decade BELOW each unit (0.1 µA still reads in µA, not
 * 100 nA). On a live plot that matters: a beam decaying through 1 µA would
 * otherwise flip the axis between µA and nA while the operator is watching it,
 * and the unit they think in is the one the module is specified in.
 */
export function currentUnit(maxAbsMicroAmps: number): UnitChoice {
  return pick(maxAbsMicroAmps, [
    { min: 1e5, scale: 1e-6, unit: "A" },
    { min: 1e2, scale: 1e-3, unit: "mA" },
    { min: 1e-1, scale: 1, unit: "µA" },
    { min: 1e-4, scale: 1e3, unit: "nA" },
    { min: 0, scale: 1e6, unit: "pA" },
  ])
}

/** Unit for a charge whose samples are in microcoulombs. Same bias as above. */
export function chargeUnit(maxAbsMicroCoulombs: number): UnitChoice {
  return pick(maxAbsMicroCoulombs, [
    { min: 1e5, scale: 1e-6, unit: "C" },
    { min: 1e2, scale: 1e-3, unit: "mC" },
    { min: 1e-1, scale: 1, unit: "µC" },
    { min: 0, scale: 1e3, unit: "nC" },
  ])
}

/** Unit for a counting rate in counts per second. */
export function rateUnit(maxAbsPerSecond: number, noun = ""): UnitChoice {
  const choice = pick(maxAbsPerSecond, [
    { min: 1e6, scale: 1e-6, unit: "M/s" },
    { min: 1e3, scale: 1e-3, unit: "k/s" },
    { min: 0, scale: 1, unit: "/s" },
  ])
  return noun ? { ...choice, unit: `${noun}${choice.unit}` } : choice
}

/** Unit for a data rate in bytes per second. */
export function byteRateUnit(maxAbsBytesPerSecond: number): UnitChoice {
  return pick(maxAbsBytesPerSecond, [
    { min: 1024 ** 3, scale: 1 / 1024 ** 3, unit: "GB/s" },
    { min: 1024 ** 2, scale: 1 / 1024 ** 2, unit: "MB/s" },
    { min: 1024, scale: 1 / 1024, unit: "kB/s" },
    { min: 0, scale: 1, unit: "B/s" },
  ])
}

/**
 * Short tick label: enough significant figures to be useful, never so many that
 * neighbouring ticks run into each other.
 */
export function formatTick(value: number): string {
  if (!Number.isFinite(value)) return ""
  if (value === 0) return "0"
  const abs = Math.abs(value)
  // Beyond the scaled range a fixed notation would be unreadable anyway.
  if (abs >= 1e5 || abs < 1e-3) return value.toExponential(1)
  if (abs >= 100) return value.toFixed(0)
  if (abs >= 10) return value.toFixed(1)
  if (abs >= 1) return value.toFixed(2)
  return value.toFixed(3)
}

/** Fuller precision for tooltips, where there is room for it. */
export function formatValue(value: number, unit: string): string {
  if (!Number.isFinite(value)) return "—"
  const abs = Math.abs(value)
  const text = abs >= 1e5 || (abs < 1e-3 && abs > 0)
    ? value.toExponential(3)
    : value.toPrecision(4)
  return unit ? `${text} ${unit}` : text
}

/**
 * Chart geometry used across the dashboard.
 *
 * `left` leaves room for a rotated y-axis title beside the tick labels, and
 * `bottom` for an x-axis title beneath them; the legend sits on top (see
 * LEGEND_PROPS) so it cannot collide with either.
 */
export const CHART_MARGIN = { top: 8, right: 24, bottom: 28, left: 16 } as const

/** Legend above the plot area, horizontal, out of the axes' way. */
export const LEGEND_PROPS = {
  verticalAlign: "top",
  align: "right",
  height: 28,
  iconType: "plainline",
  iconSize: 14,
  wrapperStyle: { fontSize: 12, paddingBottom: 4 },
} as const

/** Axis title placed clear of the tick labels. */
export const yAxisLabel = (value: string) => ({
  value,
  angle: -90 as const,
  position: "insideLeft" as const,
  offset: 0,
  style: { textAnchor: "middle" as const, fontSize: 12 },
})

export const xAxisLabel = (value: string) => ({
  value,
  position: "insideBottom" as const,
  offset: -18,
  style: { fontSize: 12 },
})
