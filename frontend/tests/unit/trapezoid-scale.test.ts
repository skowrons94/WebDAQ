import { describe, expect, it } from 'vitest'
import {
  ENERGY_FULL_SCALE, predictEnergy, scaleFactor, scaleForDivisor, scaleFromPeak,
  scaleFromShaping, verdict, mvToLsb, caenFamily, nsPerUnitFor, samplesPerUnitFor, measuredOn,
  adcBitsFor, scaleTimes, type Shaping,
} from '@/lib/trapezoid-scale'

// The measurement on the V1725S (pulser on channel 0, A = 1932 ADC LSB).
const A = 1932
const shaping = (rise: number, decay: number): Shaping => ({ riseUnits: rise, decayUnits: decay, samplesPerUnit: 4 })
const TABLE = [
  { shf: 18, fg: 0x1000, rise: 200, decay: 5000, e: 1124.5 },
  { shf: 18, fg: 0x2000, rise: 200, decay: 5000, e: 2249.5 },
  { shf: 17, fg: 0x1000, rise: 200, decay: 5000, e: 2249.6 },
  { shf: 18, fg: 0x1000, rise: 100, decay: 5000, e: 523.9 },
  { shf: 18, fg: 0x1000, rise: 200, decay: 2500, e: 672.9 },
  { shf: 18, fg: 0x1000, rise: 200, decay: 10000, e: 2028.1 },
]

describe('trapezoid energy scale: the V1725S measurement', () => {
  it('reproduces the rescaling, fine gain and rise-time rows within 10 %', () => {
    for (const r of TABLE.slice(0, 4)) {
      const e = predictEnergy(A, shaping(r.rise, r.decay), { shf: r.shf, fg: r.fg })
      expect(Math.abs(e / r.e - 1)).toBeLessThan(0.1)
    }
  })
  it('the decay rows, taken with the decay off the pulser\'s own, within 20 %', () => {
    // Pole-zero off-match: the k·M model is only ~10 % good when the decay matches.
    for (const r of TABLE.slice(4)) {
      const e = predictEnergy(A, shaping(r.rise, r.decay), { shf: r.shf, fg: r.fg })
      expect(Math.abs(e / r.e - 1)).toBeLessThan(0.2)
    }
  })
  it('is exactly linear in the fine gain and in 2^-SHF', () => {
    const s = shaping(200, 5000)
    const base = predictEnergy(A, s, { shf: 18, fg: 0x1000 })
    expect(predictEnergy(A, s, { shf: 18, fg: 0x2000 }) / base).toBe(2)
    expect(predictEnergy(A, s, { shf: 17, fg: 0x1000 }) / base).toBe(2)
    expect(predictEnergy(A, s, { shf: 21, fg: 0x8000 }) / base).toBe(1)
  })
  it('targeting 1124.5 for A = 1932 gives SHF 21, FG 0x8000 (the same as 18 / 0x1000)', () => {
    expect(scaleFromShaping(A, shaping(200, 5000), 1124.5)).toEqual({ shf: 21, fg: 0x8000 })
  })
})

describe('trapezoid energy scale: choosing values', () => {
  it('keeps the fine gain in its upper half', () => {
    for (const d of [3.7, 1000, 12345.6, 2 ** 20, 2 ** 20 * 1.999, 4.2e6]) {
      const sc = scaleForDivisor(d)!
      expect(sc.limit).toBeUndefined()
      expect(sc.fg).toBeGreaterThanOrEqual(0x8000)
      expect(sc.fg).toBeLessThan(0x10000)
      expect(Math.abs(1 / scaleFactor(sc) / d - 1)).toBeLessThan(1e-4)
    }
  })
  it('clamps to what the registers hold, and says the target is out of reach', () => {
    expect(scaleForDivisor(0.5)).toEqual({ shf: 0, fg: 0xffff, limit: 'max-gain' })
    expect(scaleForDivisor(2 ** 90)).toEqual({ shf: 63, fg: 1, limit: 'min-gain' })
    expect(scaleForDivisor(Infinity)).toEqual({ shf: 63, fg: 1, limit: 'min-gain' })
    expect(scaleForDivisor(NaN)).toBeNull()
    expect(scaleForDivisor(0)).toBeNull()
    expect(scaleForDivisor(-3)).toBeNull()
    // Exactly 1 asks for FG 65536 at SHF 0: 0xFFFF is within a part in 65536.
    expect(scaleForDivisor(1)).toEqual({ shf: 0, fg: 0xffff })
  })
  it('beyond 2^64 uses a fine gain under 0x8000 at SHF 63', () => {
    const sc = scaleForDivisor(2 ** 70)!
    expect(sc).toEqual({ shf: 63, fg: 0x8000 >> 6 })
    expect(sc.limit).toBeUndefined()
    const sc2 = scaleForDivisor(2 ** 66 * 3)!
    expect(sc2.shf).toBe(63)
    expect(Math.abs(1 / scaleFactor(sc2) / (2 ** 66 * 3) - 1)).toBeLessThan(0.01)
  })
  it('the same ratio applied to channels with different gains', () => {
    const a = scaleTimes({ shf: 18, fg: 0x1000 }, 2)!
    const b = scaleTimes({ shf: 10, fg: 0x9000 }, 2)!
    expect(scaleFactor(a) / scaleFactor({ shf: 18, fg: 0x1000 })).toBe(2)
    expect(scaleFactor(b) / scaleFactor({ shf: 10, fg: 0x9000 })).toBe(2)
  })
  it('the users\' SHF 0 / FG 0xFFFF overflows; the proposal puts full range at 75 %', () => {
    const s = shaping(200, 5000)
    const today = predictEnergy(A, s, { shf: 0, fg: 0xffff })
    expect(today).toBeGreaterThan(4e9)
    expect(verdict(today)).toBe('overflow')
    const target = 0.75 * ENERGY_FULL_SCALE
    const sc = scaleFromShaping(2 ** 14, s, target)!
    expect(sc.shf).toBe(20)
    expect(Math.abs(predictEnergy(2 ** 14, s, sc) / target - 1)).toBeLessThan(1e-4)
    expect(verdict(predictEnergy(2 ** 14, s, sc))).toBe('good')
  })
  it('from a measured peak the new values are exact', () => {
    // A line at 1124.5 with 18 / 0x1000, wanted at 2249: twice the gain, 17 / 0x1000 = 20 / 0x8000.
    expect(scaleFromPeak({ shf: 18, fg: 0x1000 }, 1124.5, 2249)).toEqual({ shf: 20, fg: 0x8000 })
    const sc = scaleFromPeak({ shf: 18, fg: 0x1000 }, 1000, 2000)!
    expect(scaleFactor(sc) / scaleFactor({ shf: 18, fg: 0x1000 })).toBe(2)
    // Halving the rise time halves the filter gain: the scale doubles to keep the line.
    const sc2 = scaleFromPeak({ shf: 18, fg: 0x1000 }, 1000, 1000, shaping(200, 5000), shaping(100, 5000))!
    expect(scaleFactor(sc2) / scaleFactor({ shf: 18, fg: 0x1000 })).toBe(2)
  })
  it('converts mV to ADC LSB with the input range', () => {
    expect(mvToLsb(1000, 2000, 14)).toBe(8192)
    expect(mvToLsb(250, 500, 14)).toBe(8192)
  })
})

describe('trapezoid energy scale: board names', () => {
  it('knows the family whatever the form factor', () => {
    for (const n of ['V1725', 'V1725S', 'VX1725', 'DT5725', 'N6725']) {
      expect(caenFamily(n)).toBe('725')
      expect(nsPerUnitFor(n)).toBe(16)
      expect(samplesPerUnitFor(n)).toBe(4)
      expect(measuredOn(n)).toBe(true)
    }
    for (const n of ['DT5730', 'VX1730', 'MOCK-V1730']) {
      expect(nsPerUnitFor(n)).toBe(8)
      expect(measuredOn(n)).toBe(false)
    }
    for (const n of ['DT5724', 'N6724', 'VX1724']) {
      expect(nsPerUnitFor(n)).toBe(10)
      expect(samplesPerUnitFor(n)).toBe(1)
    }
    expect(adcBitsFor('DT5720')).toBe(12)
    expect(nsPerUnitFor('SIS3316')).toBeNull()
    expect(caenFamily('V17250')).toBeNull()
  })
})
