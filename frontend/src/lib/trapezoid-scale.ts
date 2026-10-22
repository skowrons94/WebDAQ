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
 * samples (a register unit is 4 samples on the V1725 and V1730):
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
 * Trapezoid Rescaling and Fine Gain that divide by `divisor` (the filter
 * output over the wanted energy). FG is kept in [0x8000, 0xFFFF], half to all
 * of its range, for the finest steps: SHF is the largest shift that still
 * leaves the fine gain under 1.
 */
export function scaleForDivisor(divisor: number): Scale {
  if (!(divisor > 0) || !Number.isFinite(divisor)) return { shf: 0, fg: FINE_GAIN_MAX }
  let shf = Math.floor(Math.log2(divisor))
  if (shf > SHF_MAX) return { shf: SHF_MAX, fg: 1 }
  if (shf < 0) return { shf: 0, fg: FINE_GAIN_MAX } // more gain than the board has
  let fg = Math.round((FINE_GAIN_UNITY * 2 ** shf) / divisor)
  // A divisor of exactly 2^n would ask for FG = 65536, one more than the
  // register holds: the same scale is one shift less with FG = 0x8000.
  if (fg > FINE_GAIN_MAX) {
    if (shf === 0) return { shf: 0, fg: FINE_GAIN_MAX }
    shf -= 1
    fg = Math.round(fg / 2)
  }
  return { shf, fg: Math.max(1, Math.min(FINE_GAIN_MAX, fg)) }
}

/**
 * From the shaping times: the scale that puts a pulse of `amplitude` ADC LSB
 * at `targetEnergy` channels. Good to the ~10 % of the model.
 */
export function scaleFromShaping(amplitude: number, s: Shaping, targetEnergy: number): Scale {
  return scaleForDivisor((amplitude * filterGain(s)) / targetEnergy)
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
): Scale {
  let ratio = energyWanted / energyNow
  if (before && after) ratio *= filterGain(before) / filterGain(after)
  return scaleForDivisor(1 / (scaleFactor(current) * ratio))
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

/** ADC resolution of a CAEN digitizer, from its name (14 bits unless known otherwise). */
export function adcBitsFor(boardName: string): number {
  if (boardName.includes("1720")) return 12
  if (boardName.includes("1751")) return 10
  if (boardName.includes("1740") || boardName.includes("1742")) return 12
  return 14
}

/**
 * ADC samples per register time unit. 4 on the V1725 (16 ns, 4 ns samples)
 * and the V1730 (8 ns, 2 ns samples); 1 on the V1724, whose unit is its 10 ns
 * sample (not checked on a board).
 */
export function samplesPerUnitFor(boardName: string): number {
  if (boardName.includes("1724") || boardName.includes("1781") || boardName.includes("1782")) return 1
  return 4
}

/** Whether the energy constant was measured on this model (only the V1725). */
export function measuredOn(boardName: string): boolean {
  return boardName.includes("1725")
}

/** Input range in mV peak-to-peak from the Input Dynamic Range register (0 = 2 Vpp, 1 = 0.5 Vpp). */
export function inputRangeMv(dynamicRangeReg: number | undefined): number {
  return dynamicRangeReg === 1 ? 500 : 2000
}
