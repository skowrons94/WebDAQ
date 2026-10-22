/**
 * Units and controls of the Tuner, per firmware (DPP-PHA, DPP-PSD).
 *
 * The trap this file exists for: on the x730 an ADC sample is 2 ns, but the
 * DPP-PHA time registers (rise times, flat top, decay, hold-offs) count in
 * steps of 4 samples = 8 ns, while the DPP-PSD gates (gate offset, short and
 * long gate) count in single samples = 2 ns. Showing a PSD gate through the PHA
 * step makes it look 4x too long. Every time control below names which of the
 * two it uses.
 *
 *   x730: 500 MS/s, sample 2 ns, PHA step 8 ns, 14 bit
 *   x725: 250 MS/s, sample 4 ns, PHA step 16 ns, 14 bit
 *   x724: 100 MS/s, sample 10 ns, PHA step 10 ns, 14 bit
 *   x720: 250 MS/s, sample 4 ns, 12 bit (DPP-PSD only)
 *
 * Sources: UM5678 (725/730 DPP-PHA registers), UM4380 (725/730 DPP-PSD
 * registers), and lib/caen-registers.ts for descriptions and enumerations.
 * Record Length counts 8 samples, Pre Trigger 4 samples (UM5678/UM4380).
 */
import {
  getFieldDoc,
  getFieldOptions,
  getRegisterDoc,
  getRegisterOptions,
  type RegisterOption,
} from '@/lib/caen-registers'
import { caenFamily } from '@/lib/trapezoid-scale'

export interface BoardTiming {
  /** One ADC sample, ns. */
  sampleNs: number
  /** One DPP-PHA time step (4 samples on the x725/x730), ns. */
  phaStepNs: number
  /** Largest ADC code. */
  adcMax: number
}

export function boardTiming(boardName: string): BoardTiming {
  // By family: V1725, VX1725, DT5725 and N6725 are the same digitizer.
  const family = caenFamily(boardName)
  if (family === '730') return { sampleNs: 2, phaStepNs: 8, adcMax: 16383 }
  if (family === '725') return { sampleNs: 4, phaStepNs: 16, adcMax: 16383 }
  if (family === '724') return { sampleNs: 10, phaStepNs: 10, adcMax: 16383 }
  if (family === '720') return { sampleNs: 4, phaStepNs: 16, adcMax: 4095 }
  // Unknown model: say "samples" rather than invent nanoseconds.
  return { sampleNs: 1, phaStepNs: 1, adcMax: 16383 }
}

/** Whether the model is known (time controls are then shown in ns). */
export function timingKnown(t: BoardTiming): boolean {
  return t.sampleNs > 1
}

/** How a raw register value is shown. */
export type UnitKind =
  | 'step'    // DPP time step (PHA timing; also the trigger hold-off of both firmwares), ns
  | 'sample'  // one ADC sample (PSD gates), ns
  | 'lsb'     // ADC codes (thresholds)
  | 'dc'      // DC offset DAC, shown in %
  | 'raw'     // plain number
  | 'enum'    // closed set of options
  | 'bool'    // one bit

export interface ControlSpec {
  id: string
  /** Channel-0 address of the register (0x10xx). */
  address: number
  /** Bit field inside the register, inclusive; omitted = the whole value. */
  bits?: [number, number]
  label: string
  unit: UnitKind
  group: 'input' | 'trigger' | 'energy' | 'gates' | 'baseline' | 'pileup'
  /** What it does and how to set it, in the Tuner's words. */
  help: string
  /** For 'enum': where the options come from. */
  options?: RegisterOption[]
  /** For 'bool': which value means "on" (default 1). */
  onValue?: number
}

export const GROUP_TITLES: Record<ControlSpec['group'], string> = {
  input: 'Input',
  trigger: 'Trigger',
  energy: 'Energy filter (trapezoid)',
  gates: 'Charge integration (gates)',
  baseline: 'Baseline',
  pileup: 'Pile-up',
}

const doc = (name: string, extra = '') => {
  const d = getRegisterDoc(name)?.description ?? ''
  return [d, extra].filter(Boolean).join(' ')
}
const fdoc = (name: string, dpp: string, extra = '') => {
  const d = getFieldDoc(name, dpp) ?? ''
  return [d, extra].filter(Boolean).join(' ')
}

/** The controls the Tuner shows for one firmware, in signal-chain order. */
export function controlsFor(dpp: string): ControlSpec[] {
  const psd = dpp.toUpperCase().includes('PSD')
  const common: ControlSpec[] = [
    { id: 'invert', address: 0x1080, bits: [16, 16], label: 'Negative input (invert)', unit: 'bool', group: 'input',
      help: 'On for negative pulses: the board inverts them before processing. The trace and the spectrum stay empty, or noise-only, with the wrong polarity.' },
    { id: 'dc', address: 0x1098, label: 'DC offset', unit: 'dc', group: 'input',
      help: doc('DC Offset', 'Sets where the baseline sits on the 0…full-scale ADC range, and so how much range is left for the pulses (headroom). Check the measured baseline under the waveform.') },
  ]
  if (!psd) {
    return [
      ...common,
      { id: 'thr', address: 0x106c, label: 'Trigger threshold', unit: 'lsb', group: 'trigger',
        help: 'In LSB of the RC-CR² (timing filter) signal, not of the input. Too low and noise triggers flood the channel: lower it until the rate climbs steeply, then raise it by about a third.' },
      { id: 'tin', address: 0x1058, label: 'Input rise time', unit: 'step', group: 'trigger',
        help: doc('Input Rise Time') },
      { id: 'smooth', address: 0x1054, label: 'RC-CR² smoothing', unit: 'enum', group: 'trigger',
        options: getRegisterOptions('RC-CR2 Smoothing Factor') ?? undefined, help: doc('RC-CR2 Smoothing Factor') },
      { id: 'tho', address: 0x1074, label: 'Trigger hold-off', unit: 'step', group: 'trigger',
        help: doc('Trigger Hold-Off Width') },
      { id: 'decay', address: 0x1068, label: 'Decay time (pole-zero)', unit: 'step', group: 'energy',
        help: doc('Decay Time', 'Watch the PZ residual under the trapezoid trace: it should be near 0.') },
      { id: 'rise', address: 0x105c, label: 'Trapezoid rise time', unit: 'step', group: 'energy',
        help: doc('Trapezoid Rise Time', 'Longer: less series noise, more pile-up. Compare the FWHM "since last change" for a few values.') },
      { id: 'flat', address: 0x1060, label: 'Trapezoid flat top', unit: 'step', group: 'energy',
        help: doc('Trapezoid Flat Top', 'Must exceed the charge collection time (ballistic deficit otherwise).') },
      { id: 'peaking', address: 0x1064, label: 'Energy sampling delay (in flat top)', unit: 'step', group: 'energy',
        help: 'Called "Peaking Time" in the register list: the delay from the start of the flat top to where the energy is sampled. It must be shorter than the flat top.' },
      { id: 'peakmean', address: 0x1080, bits: [12, 13], label: 'Peak mean', unit: 'enum', group: 'energy',
        options: getFieldOptions('Peak Mean', dpp) ?? undefined, help: fdoc('Peak Mean', dpp) || 'Samples averaged at the sampling point.' },
      { id: 'rescale', address: 0x1080, bits: [0, 5], label: 'Trapezoid rescaling', unit: 'raw', group: 'energy',
        help: fdoc('Trapezoid Rescaling', dpp) || 'Power-of-two scaling of the trapezoid to the energy range.' },
      { id: 'finegain', address: 0x10c4, label: 'Fine gain', unit: 'raw', group: 'energy',
        help: doc('Fine Gain', 'Changing it moves the peaks: check the calibration afterwards.') },
      { id: 'blmean', address: 0x1080, bits: [20, 22], label: 'Baseline mean', unit: 'enum', group: 'baseline',
        options: getFieldOptions('Baseline Averaging Window', dpp) ?? undefined, help: fdoc('Baseline Averaging Window', dpp) },
      { id: 'pho', address: 0x1078, label: 'Peak hold-off', unit: 'step', group: 'pileup',
        help: doc('Peak Hold-Off', 'Sets, with the trapezoid length, the pile-up window.') },
      { id: 'pu', address: 0x1080, bits: [27, 27], label: 'Keep pile-up events', unit: 'bool', group: 'pileup',
        help: fdoc('Enable Pile-Up', dpp) },
    ]
  }
  return [
    ...common,
    { id: 'thr', address: 0x1060, label: 'Trigger threshold', unit: 'lsb', group: 'trigger',
      help: 'In LSB of the (smoothed) input signal. Too low and noise triggers flood the channel: lower it until the rate climbs steeply, then raise it by about a third.' },
    { id: 'disc', address: 0x1080, bits: [6, 6], label: 'Discrimination', unit: 'enum', group: 'trigger',
      options: getFieldOptions('Discrimination Mode', dpp) ?? undefined, help: fdoc('Discrimination Mode', dpp) },
    { id: 'cfddelay', address: 0x103c, bits: [0, 7], label: 'CFD delay', unit: 'sample', group: 'trigger',
      help: 'Delay of the constant-fraction discriminator, in ADC samples. About the rise time of the pulse.' },
    { id: 'cfdfrac', address: 0x103c, bits: [8, 9], label: 'CFD fraction', unit: 'enum', group: 'trigger',
      options: [
        { value: 0, label: '25 %' }, { value: 1, label: '50 %' }, { value: 2, label: '75 %' }, { value: 3, label: '100 %' },
      ], help: 'Fraction of the pulse height the CFD fires at.' },
    { id: 'smooth', address: 0x1084, bits: [12, 15], label: 'Input smoothing', unit: 'enum', group: 'trigger',
      options: getFieldOptions('Smoothed Signal Samples', dpp) ?? undefined, help: fdoc('Smoothed Signal Samples', dpp) },
    { id: 'tho', address: 0x1074, label: 'Trigger hold-off', unit: 'step', group: 'trigger',
      help: doc('Trigger Hold-Off Width') },
    { id: 'goff', address: 0x105c, label: 'Gate offset', unit: 'sample', group: 'gates',
      help: 'How far before the trigger both gates open, in ADC samples. The pulse must start inside the gate: check the gate probe on the trace.' },
    { id: 'sgate', address: 0x1054, label: 'Short gate', unit: 'sample', group: 'gates',
      help: 'Covers the fast component of the light: the n/γ cut is made on short vs long. Compare the separation on the PSD plot for a few values.' },
    { id: 'lgate', address: 0x1058, label: 'Long gate', unit: 'sample', group: 'gates',
      help: 'Total charge: at least 3–5 decay times of the slow component. Longer gates add noise and pile-up.' },
    { id: 'csens', address: 0x1080, bits: [0, 2], label: 'Charge sensitivity', unit: 'enum', group: 'gates',
      options: getFieldOptions('Charge Sensitivity', dpp) ?? undefined, help: fdoc('Charge Sensitivity', dpp, 'Higher sensitivity = fewer fC per channel: big pulses saturate the Q-long range.') },
    { id: 'blmean', address: 0x1080, bits: [20, 22], label: 'Baseline mean', unit: 'enum', group: 'baseline',
      options: getFieldOptions('Baseline Averaging Window', dpp) ?? undefined, help: fdoc('Baseline Averaging Window', dpp) },
    { id: 'fixedbl', address: 0x1064, label: 'Fixed baseline', unit: 'lsb', group: 'baseline',
      help: doc('Fixed Baseline', 'Used only when the baseline mean is "Fixed".') },
    { id: 'purgap', address: 0x107c, label: 'PUR-GAP threshold', unit: 'lsb', group: 'pileup',
      help: doc('PUR-GAP Threshold') },
    { id: 'pur', address: 0x1080, bits: [26, 26], label: 'Reject pile-up', unit: 'bool', group: 'pileup',
      help: fdoc('Pile-Up Rejection', dpp) },
    { id: 'psdthr', address: 0x1078, label: 'PSD threshold', unit: 'raw', group: 'pileup',
      help: doc('Threshold for the PSD') },
  ]
}

/** Channel-0 form of a register address ("0x1268" → 0x1068). */
export function baseAddress(address: string): number {
  const a = parseInt(address, 16)
  return a >= 0x1000 && a <= 0x1fff ? a & 0xf0ff : a
}

/** Bits [lo, hi] of a 32-bit value. */
export function getBits(value: number, [lo, hi]: [number, number]): number {
  const width = hi - lo + 1
  return Number((BigInt(value >>> 0) >> BigInt(lo)) & ((BigInt(1) << BigInt(width)) - BigInt(1)))
}

/** `value` with bits [lo, hi] replaced by `field`. */
export function setBits(value: number, [lo, hi]: [number, number], field: number): number {
  const width = hi - lo + 1
  const mask = ((BigInt(1) << BigInt(width)) - BigInt(1)) << BigInt(lo)
  const out = (BigInt(value >>> 0) & ~mask) | ((BigInt(field) << BigInt(lo)) & mask)
  return Number(out & BigInt(0xffffffff))
}

/** Raw → number shown, for the numeric units. */
export function toDisplay(raw: number, unit: UnitKind, t: BoardTiming): number {
  switch (unit) {
    case 'step': return raw * t.phaStepNs
    case 'sample': return raw * t.sampleNs
    case 'dc': return Math.round((raw / 65535) * 1000) / 10
    default: return raw
  }
}

/** Number typed → raw register value. NaN when it is not a number. */
export function fromDisplay(shown: number, unit: UnitKind, t: BoardTiming): number {
  if (!Number.isFinite(shown)) return NaN
  switch (unit) {
    case 'step': return Math.max(0, Math.round(shown / t.phaStepNs))
    case 'sample': return Math.max(0, Math.round(shown / t.sampleNs))
    case 'dc': return Math.min(65535, Math.max(0, Math.round((shown / 100) * 65535)))
    default: return Math.max(0, Math.round(shown))
  }
}

/** The unit label and the input step for a numeric control. */
export function unitLabel(unit: UnitKind, t: BoardTiming): { label: string; step: number } {
  switch (unit) {
    case 'step': return timingKnown(t) ? { label: 'ns', step: t.phaStepNs } : { label: 'steps', step: 1 }
    case 'sample': return timingKnown(t) ? { label: 'ns', step: t.sampleNs } : { label: 'samples', step: 1 }
    case 'lsb': return { label: 'LSB', step: 1 }
    case 'dc': return { label: '%', step: 0.1 }
    default: return { label: '', step: 1 }
  }
}

/** A secondary reading next to a time control: "(24 samples)", "(3 steps of 8 ns)". */
export function rawHint(raw: number, unit: UnitKind, t: BoardTiming): string {
  if (!timingKnown(t)) return ''
  if (unit === 'sample') return `${raw} sample${raw === 1 ? '' : 's'}`
  if (unit === 'step') return `${raw} × ${t.phaStepNs} ns`
  return ''
}

/**
 * Where the baseline sits for a DC offset, and the headroom left for pulses of
 * the given polarity. This follows the convention that the offset in % is the
 * baseline position on the ADC scale (as in CoMPASS); the measured baseline
 * under the waveform is the reference: if the two disagree, trust the trace.
 */
export function dcOffsetReading(raw: number, negative: boolean, t: BoardTiming) {
  const baseline = Math.round((raw / 65535) * t.adcMax)
  const headroom = negative ? baseline : t.adcMax - baseline
  return { baseline, headroom, headroomPct: Math.round((headroom / t.adcMax) * 100) }
}

/** A control's field value as text with its unit ("400 ns", "50 %", "On", "1024 samples"). */
export function formatControl(spec: ControlSpec, v: number, t: BoardTiming): string {
  if (spec.unit === 'bool') return v === (spec.onValue ?? 1) ? 'On' : 'Off'
  if (spec.unit === 'enum') return spec.options?.find((o) => o.value === v)?.label ?? String(v)
  const u = unitLabel(spec.unit, t).label
  return `${toDisplay(v, spec.unit, t)}${u ? ` ${u}` : ''}`
}
