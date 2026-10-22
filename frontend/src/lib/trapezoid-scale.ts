/**
 * The DPP-PHA energy scale: what Trapezoid Rescaling (0x1n80 bits 5:0) and
 * Fine Gain (0x1nC4) must be for the pulses to land on the 15-bit energy scale.
 *
 * Measured on the V1725S (DPP-PHA, 14-bit, 250 MS/s) with a pulser of height
 * A = 1932 ADC LSB on channel 0:
 *
 *   SHF  FG      rise  decay   energy
 *   18   0x1000  200   5000    1124.5
 *   18   0x2000  200   5000    2249.5
 *   17   0x1000  200   5000    2249.6
 *   18   0x1000  100   5000     523.9
 *   18   0x1000  200   2500     672.9   (decay off the pulser's own)
 *   18   0x1000  200  10000    2028.1   (decay off the pulser's own)
 *
 * The energy is exactly proportional to FG / 65536 and to 2^-SHF, and close to
 * proportional to the rise time k and the decay time M, both counted in ADC
 * samples (a register unit is 4 samples on the x725 and x730):
 *
 *   E ≈ C · A · k · M · (FG / 65536) / 2^SHF,   C ≈ 0.153
 *
 * The k · M part is a model, good to about 10 % when the decay matches the
 * preamplifier (pole-zero) and the flat top covers the rise of the signal; the
 * FG and SHF parts are exact, which is why a measured peak gives exact values.
 * Pure functions only, so they can be tested without a board.
 */

/** Largest energy the board reports (15 bits); anything above wraps or reads 0. */
export const ENERGY_FULL_SCALE = 32767

/** Fine Gain is a 16-bit register whose value is the gain × 65536. */
export const FINE_GAIN_UNITY = 65536
export const FINE_GAIN_MAX = 0xffff

/** Trapezoid Rescaling is 6 bits wide. */
export const SHF_MAX = 63

/**
 * The constant C of the energy formula, taken from the reference point of the
 * table above (SHF 18, FG 0x1000, rise 200, decay 5000 → 1124.5 for A = 1932;
 * 0.1526). The other rows scatter around it by up to ±15 % when the decay is
 * deliberately set off the pulser's, which is the size of the model error.
 */
export const TRAPEZOID_GAIN_C = (1124.5 * 2 ** 18 * FINE_GAIN_UNITY) / (1932 * 800 * 20000 * 0x1000)

/** Fraction of the scale the largest pulse is put at by default: room for the model error. */
export const DEFAULT_TARGET_FRACTION = 0.75

/** What the energy filter is set to, as the registers hold it. */
export interface Shaping {
  /** Trapezoid Rise Time (0x1n5C), register units. */
  riseUnits: number
  /** Decay Time (0x1n68), register units. */
  decayUnits: number
  /** ADC samples per register time unit: 4 on the V1725 and V1730. */
  samplesPerUnit: number
  /** Decimation (0x1n80 bits 9:8): the filter runs on one sample in 2^dec. */
  decimation?: number
  /** Decimation gain (0x1n80 bits 11:10): the decimated samples are ×2^gain. */
  decimationGain?: number
}

export interface Scale {
  /** Trapezoid Rescaling, 0..63. */
  shf: number
  /** Fine Gain register value, 1..0xFFFF. */
  fg: number
}

/** Rise time k and decay M in the samples the filter counts. */
export function filterSamples(s: Shaping): { k: number; m: number } {
  // With decimation the filter only sees every 2^dec-th sample, so the same
  // register value spans fewer of its samples. Not checked on a board yet.
  const div = 2 ** (s.decimation ?? 0)
  return { k: (s.riseUnits * s.samplesPerUnit) / div, m: (s.decayUnits * s.samplesPerUnit) / div }
}

/**
 * Energy per ADC LSB of pulse height before Fine Gain and Trapezoid
 * Rescaling: C · k · M (× the decimation gain, which is not checked on a board).
 */
export function filterGain(s: Shaping): number {
  const { k, m } = filterSamples(s)
  return TRAPEZOID_GAIN_C * k * m * 2 ** (s.decimationGain ?? 0)
}

/** The multiplier Fine Gain and Trapezoid Rescaling apply together. */
export function scaleFactor(sc: Scale): number {
  return sc.fg / FINE_GAIN_UNITY / 2 ** sc.shf
}

/** Predicted energy (in channels, unclamped) of a pulse of height A ADC LSB. */
export function predictEnergy(amplitude: number, s: Shaping, sc: Scale): number {
  return amplitude * filterGain(s) * scaleFactor(sc)
}

/**
 * A scale the registers can hold. `limit` is set when the wanted scale is out
 * of their reach and this is the nearest end: 'max-gain' when even SHF 0 with
 * FG 0xFFFF gives too little energy, 'min-gain' when even SHF 63 with FG 1
 * gives too much.
 */
export interface ScaleResult extends Scale {
  limit?: 'max-gain' | 'min-gain'
}

/** How far a scale may miss the wanted one before it counts as out of reach. */
const REACH_TOLERANCE = 0.01

/**
 * Trapezoid Rescaling and Fine Gain that divide by `divisor` (the filter
 * output over the wanted energy). FG is kept in [0x8000, 0xFFFF], half to all
 * of its range, for the finest steps: SHF is the largest shift that still
 * leaves the fine gain under 1. Beyond 2^64 the shift is at its 63 and the
 * fine gain goes down from 0x8000 instead. Null when there is no answer (a
 * divisor that is not a positive number, which means an input is missing).
 */
export function scaleForDivisor(divisor: number): ScaleResult | null {
  if (Number.isNaN(divisor) || !(divisor > 0)) return null
  let shf: number
  let fg: number
  if (divisor === Infinity) {
    shf = SHF_MAX
    fg = 1
  } else {
    shf = Math.floor(Math.log2(divisor))
    if (shf > SHF_MAX) shf = SHF_MAX
    if (shf < 0) shf = 0
    fg = Math.round((FINE_GAIN_UNITY * 2 ** shf) / divisor)
    // A divisor of exactly 2^n would ask for FG = 65536, one more than the
    // register holds: the same scale is one shift less with FG = 0x8000.
    if (fg > FINE_GAIN_MAX && shf > 0) {
      shf -= 1
      fg = Math.round(fg / 2)
    }
    fg = Math.max(1, Math.min(FINE_GAIN_MAX, fg))
  }
  const sc: ScaleResult = { shf, fg }
  // Out of reach: the nearest end of the registers misses the wanted scale.
  const miss = scaleFactor(sc) * divisor - 1
  if (miss < -REACH_TOLERANCE) sc.limit = 'max-gain'
  else if (miss > REACH_TOLERANCE) sc.limit = 'min-gain'
  return sc
}

/**
 * From the shaping times: the scale that puts a pulse of `amplitude` ADC LSB
 * at `targetEnergy` channels. Good to the ~10 % of the model.
 */
export function scaleFromShaping(amplitude: number, s: Shaping, targetEnergy: number): ScaleResult | null {
  return scaleForDivisor((amplitude * filterGain(s)) / targetEnergy)
}

/**
 * How much a measured line has to move: `energyWanted / energyNow`, and, when
 * the shaping changes too (`before` → `after`), the k · M model's correction
 * for it, approximately.
 */
export function peakRatio(energyNow: number, energyWanted: number, before?: Shaping, after?: Shaping): number {
  let ratio = energyWanted / energyNow
  if (before && after) ratio *= filterGain(before) / filterGain(after)
  return ratio
}

/** The scale that multiplies the energy given by `current` by `ratio`. */
export function scaleTimes(current: Scale, ratio: number): ScaleResult | null {
  return scaleForDivisor(1 / (scaleFactor(current) * ratio))
}

/**
 * From a measured peak: the scale that moves a line now at `energyNow` to
 * `energyWanted`. Exact when only FG and SHF change, since the energy is
 * linear in both; if the shaping changes too (`before` → `after`), the k · M
 * model corrects for it, approximately.
 */
export function scaleFromPeak(
  current: Scale,
  energyNow: number,
  energyWanted: number,
  before?: Shaping,
  after?: Shaping,
): ScaleResult | null {
  return scaleTimes(current, peakRatio(energyNow, energyWanted, before, after))
}

/** Whether the shaping changes enough between two settings to make a peak-based result approximate. */
export function shapingChanged(a: Shaping, b: Shaping): boolean {
  return Math.abs(filterGain(a) / filterGain(b) - 1) > 1e-9
}

/** Pulse height in ADC LSB for a height in mV, given the input range (mV peak-to-peak) and ADC bits. */
export function mvToLsb(mv: number, rangeMv: number, adcBits: number): number {
  return (mv * 2 ** adcBits) / rangeMv
}

export function lsbToMv(lsb: number, rangeMv: number, adcBits: number): number {
  return (lsb * rangeMv) / 2 ** adcBits
}

/** How an energy sits on the scale, for one line of text. */
export type ScaleVerdict = "overflow" | "above" | "squeezed" | "low" | "good"

export function verdict(energy: number): ScaleVerdict {
  const f = energy / ENERGY_FULL_SCALE
  // Far above the 15-bit scale the trapezoid word overflows and the board
  // reports energy 0 for everything (SHF 0 with FG 0xFFFF gives ~10^9);
  // just above, the top of the spectrum is lost.
  if (f > 16) return "overflow"
  if (f > 1) return "above"
  if (f < 0.05) return "squeezed"
  if (f < 0.3) return "low"
  return "good"
}

/**
 * The digitizer family of a CAEN model name: "725" for V1725, V1725S, VX1725,
 * DT5725 and N6725 alike (the first digit is the form factor: 1 VME, 5
 * desktop, 6 NIM). Null when the name carries no model number.
 */
export function caenFamily(boardName: string): string | null {
  return boardName.match(/(?:^|[^0-9])[156](7\d\d)(?![0-9])/)?.[1] ?? null
}

/** ADC resolution of a CAEN digitizer, from its name (14 bits unless known otherwise). */
export function adcBitsFor(boardName: string): number {
  const f = caenFamily(boardName)
  if (f === '720' || f === '740' || f === '742') return 12
  if (f === '751') return 10
  return 14
}

/**
 * The DPP-PHA time register unit in ns: 16 on the x725 (four 4 ns samples), 8
 * on the x730 (four 2 ns samples), 10 on the x724 (its one 10 ns sample).
 * Null for a model not known here.
 */
export function nsPerUnitFor(boardName: string): number | null {
  const f = caenFamily(boardName)
  if (f === '730') return 8
  if (f === '725') return 16
  if (f === '724') return 10
  return null
}

/**
 * ADC samples per register time unit. 4 on the x725 (16 ns, 4 ns samples)
 * and the x730 (8 ns, 2 ns samples); 1 on the x724, whose unit is its 10 ns
 * sample (not checked on a board), and on the x781/x782.
 */
export function samplesPerUnitFor(boardName: string): number {
  const f = caenFamily(boardName)
  if (f === '724' || f === '781' || f === '782') return 1
  return 4
}

/** Whether the energy constant was measured on this family (only the x725: a V1725S). */
export function measuredOn(boardName: string): boolean {
  return caenFamily(boardName) === '725'
}

/** Trapezoid Rise Time (0x1n5C) is 12 bits wide, Decay Time (0x1n68) 16 (UM5678). */
export const RISE_UNITS_MAX = 0xfff
export const DECAY_UNITS_MAX = 0xffff

/** Input range in mV peak-to-peak from the Input Dynamic Range register (0 = 2 Vpp, 1 = 0.5 Vpp). */
export function inputRangeMv(dynamicRangeReg: number | undefined): number {
  return dynamicRangeReg === 1 ? 500 : 2000
}
