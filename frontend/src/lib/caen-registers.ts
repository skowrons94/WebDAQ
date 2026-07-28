/**
 * CAEN register semantics — enumerated options, units and descriptions.
 *
 * Every value here is taken from the register manuals shipped in `manuals/`:
 *   • UM5678 — 725/730 DPP-PHA Registers, rev. 3
 *   • UM4380 — 725/730 DPP-PSD Registers, rev. 6
 *
 * The point is that an operator should never have to know that "Baseline
 * Averaging Window = 4" means 1024 samples, or that the RC-CR2 Smoothing Factor
 * only accepts 8 of its 64 possible values. Anything the manual defines as a
 * closed set of options is presented as a dropdown; anything with a physical
 * unit carries that unit.
 */

export interface RegisterOption {
  /** Raw value written to the register / bit field. */
  value: number
  /** What the operator sees. */
  label: string
  /** Optional extra note (e.g. a caveat from the manual). */
  hint?: string
}

// ============================================================
// Whole-register enumerations
// ============================================================

/**
 * RC-CR2 Smoothing Factor (PHA, 0x1n54) — the moving-average window used to
 * form the RC-CR2 timing signal.
 *
 * UM5678 rev.3 p.16: only these eight values are legal. Every other bit pattern
 * in [5:0] is undefined, which is why this must be a selector and never a free
 * numeric input.
 */
export const RC_CR2_SMOOTHING_OPTIONS: RegisterOption[] = [
  { value: 0x00, label: "Disabled" },
  { value: 0x01, label: "2 samples" },
  { value: 0x02, label: "4 samples" },
  { value: 0x04, label: "8 samples" },
  { value: 0x08, label: "16 samples" },
  { value: 0x10, label: "32 samples" },
  { value: 0x20, label: "64 samples" },
  { value: 0x3f, label: "128 samples" },
]

/**
 * Input Dynamic Range (0x1n28) — full-scale of the input stage. Changing it
 * rescales the charge sensitivity table for DPP-PSD.
 */
export const INPUT_DYNAMIC_RANGE_OPTIONS: RegisterOption[] = [
  { value: 0, label: "2 Vpp" },
  { value: 1, label: "0.5 Vpp" },
]

/** Registers whose full value is a closed set, keyed by register name. */
const REGISTER_VALUE_OPTIONS: { [regName: string]: RegisterOption[] } = {
  "RC-CR2 Smoothing Factor": RC_CR2_SMOOTHING_OPTIONS,
  "RC‐CR2 Smoothing Factor": RC_CR2_SMOOTHING_OPTIONS, // manual uses a non-ASCII hyphen
  "Input Dynamic Range": INPUT_DYNAMIC_RANGE_OPTIONS,
}

/**
 * Options for a whole register, or null when it is a plain numeric value.
 * Matching is tolerant of the ASCII/Unicode hyphen difference and of case.
 */
export function getRegisterOptions(registerName: string): RegisterOption[] | null {
  const direct = REGISTER_VALUE_OPTIONS[registerName]
  if (direct) return direct
  const normalised = registerName.replace(/[‐–—]/g, "-").toLowerCase()
  for (const [key, opts] of Object.entries(REGISTER_VALUE_OPTIONS)) {
    if (key.replace(/[‐–—]/g, "-").toLowerCase() === normalised) return opts
  }
  return null
}

// ============================================================
// Bit-field enumerations
// ============================================================

// ── Shared between PHA and PSD ──────────────────────────────

const TRIGGER_MODE_OPTIONS: RegisterOption[] = [
  { value: 0, label: "Normal (self-trigger)" },
  { value: 1, label: "Coincidence" },
  { value: 2, label: "Reserved" },
  { value: 3, label: "Anti-coincidence" },
]

const INVERT_INPUT_OPTIONS: RegisterOption[] = [
  { value: 0, label: "Positive polarity" },
  { value: 1, label: "Negative polarity" },
]

const DISABLE_SELF_TRIGGER_OPTIONS: RegisterOption[] = [
  { value: 0, label: "Acquire + propagate" },
  { value: 1, label: "Propagate only" },
]

const COUNT_TRIGGER_STEP_OPTIONS: RegisterOption[] = [
  { value: 0, label: "1024 (default)" },
  { value: 1, label: "128" },
  { value: 2, label: "8192" },
  { value: 3, label: "Reserved" },
]

const LOCAL_SHAPED_TRIGGER_OPTIONS: RegisterOption[] = [
  { value: 0, label: "AND of the couple" },
  { value: 1, label: "Even channel only" },
  { value: 2, label: "Odd channel only" },
  { value: 3, label: "OR of the couple" },
]

// ── PHA-specific ────────────────────────────────────────────

/** UM5678 p.26 — averaging window for the trapezoid height. */
const PHA_PEAK_MEAN_OPTIONS: RegisterOption[] = [
  { value: 0, label: "1 sample" },
  { value: 1, label: "4 samples" },
  { value: 2, label: "16 samples" },
  { value: 3, label: "64 samples" },
]

/** UM5678 p.26 — applies to the energy filter only. */
const PHA_DECIMATION_OPTIONS: RegisterOption[] = [
  { value: 0, label: "Disabled" },
  { value: 1, label: "2 samples" },
  { value: 2, label: "4 samples" },
  { value: 3, label: "8 samples" },
]

const PHA_DECIMATION_GAIN_OPTIONS: RegisterOption[] = [
  { value: 0, label: "×1" },
  { value: 1, label: "×2", hint: "needs decimation ≥ 2 samples" },
  { value: 2, label: "×4", hint: "needs decimation ≥ 4 samples" },
  { value: 3, label: "×8", hint: "needs decimation = 8 samples" },
]

/** UM5678 p.27 — 000 disables baseline subtraction entirely. */
const PHA_BASELINE_OPTIONS: RegisterOption[] = [
  { value: 0, label: "Not evaluated", hint: "energy is not baseline-subtracted" },
  { value: 1, label: "16 samples" },
  { value: 2, label: "64 samples" },
  { value: 3, label: "256 samples" },
  { value: 4, label: "1024 samples" },
  { value: 5, label: "4096 samples" },
  { value: 6, label: "16384 samples" },
  { value: 7, label: "Reserved" },
]

/** UM5678 p.32 — EXTRAS 2 word content. */
const PHA_EXTRAS2_OPTIONS: RegisterOption[] = [
  { value: 0, label: "Ext. time stamp + baseline×4" },
  { value: 1, label: "Reserved" },
  { value: 2, label: "Ext. time stamp + fine time stamp" },
  { value: 3, label: "Reserved" },
  { value: 4, label: "Lost + total trigger counter" },
  { value: 5, label: "Event before / after zero crossing" },
  { value: 6, label: "Reserved" },
  { value: 7, label: "Reserved" },
]

/** UM5678 p.32 — validation mode differs from PSD in option 00. */
const PHA_LOCAL_TRIGGER_VALIDATION_OPTIONS: RegisterOption[] = [
  { value: 0, label: "Crossed (val0=trg1, val1=trg0)" },
  { value: 1, label: "From mother-board mask" },
  { value: 2, label: "AND of the couple" },
  { value: 3, label: "OR of the couple", hint: "requires Trigger Mode = Normal" },
]

const PHA_VETO_SOURCE_OPTIONS: RegisterOption[] = [
  { value: 0, label: "Disabled" },
  { value: 1, label: "Common (0x810C)" },
  { value: 2, label: "Per couple (0x8180+4n)" },
  { value: 3, label: "Negative saturation" },
]

/** UM5678 p.33 — note the inverted sense: 0 = enabled. */
const PHA_READY_BASELINE_OPTIONS: RegisterOption[] = [
  { value: 0, label: "Enabled (baseline ready at start)" },
  { value: 1, label: "Disabled" },
]

// ── PSD-specific ────────────────────────────────────────────

/** UM4380 p.27 — the fC per channel depends on the input dynamic range. */
const PSD_CHARGE_SENSITIVITY_2VPP: RegisterOption[] = [
  { value: 0, label: "5 fC" },
  { value: 1, label: "20 fC" },
  { value: 2, label: "80 fC" },
  { value: 3, label: "320 fC" },
  { value: 4, label: "1.28 pC" },
  { value: 5, label: "5.12 pC" },
]

const PSD_DISCRIMINATION_OPTIONS: RegisterOption[] = [
  { value: 0, label: "Leading edge (LED)" },
  { value: 1, label: "Constant fraction (CFD)" },
]

/** UM4380 p.28 — 000 uses the fixed baseline from register 0x1n64. */
const PSD_BASELINE_OPTIONS: RegisterOption[] = [
  { value: 0, label: "Fixed (from 0x1n64)" },
  { value: 1, label: "16 samples" },
  { value: 2, label: "64 samples" },
  { value: 3, label: "256 samples" },
  { value: 4, label: "1024 samples" },
  { value: 5, label: "Reserved" },
  { value: 6, label: "Reserved" },
  { value: 7, label: "Reserved" },
]

/** UM4380 p.27 — built-in test pulse rate (730 series; 725 is half). */
const PSD_PULSE_RATE_OPTIONS: RegisterOption[] = [
  { value: 0, label: "1 kHz (500 Hz on 725)" },
  { value: 1, label: "10 kHz (5 kHz on 725)" },
  { value: 2, label: "100 kHz (50 kHz on 725)" },
  { value: 3, label: "1 MHz (500 kHz on 725)" },
]

/**
 * UM4380 p.30 — input smoothing factor for the PSD timing filter. This is the
 * PSD counterpart of the PHA RC-CR2 smoothing and is likewise a closed set.
 */
const PSD_SMOOTHING_OPTIONS: RegisterOption[] = [
  { value: 0, label: "Disabled" },
  { value: 1, label: "2 samples" },
  { value: 2, label: "4 samples" },
  { value: 3, label: "8 samples" },
  { value: 4, label: "16 samples" },
]

const PSD_EXTRAS_OPTIONS: RegisterOption[] = [
  { value: 0, label: "Ext. time stamp + baseline×4" },
  { value: 1, label: "Ext. time stamp + flags" },
  { value: 2, label: "Ext. time stamp + flags + fine time stamp" },
  { value: 3, label: "Reserved" },
  { value: 4, label: "Lost + total trigger counter" },
  { value: 5, label: "Positive / negative zero crossing" },
  { value: 6, label: "Reserved" },
  { value: 7, label: "Fixed 0x12345678 (debug)" },
]

const PSD_LOCAL_TRIGGER_VALIDATION_OPTIONS: RegisterOption[] = [
  { value: 0, label: "Reserved" },
  { value: 1, label: "From mother-board mask" },
  { value: 2, label: "AND of the couple" },
  { value: 3, label: "OR of the couple", hint: "requires Trigger Mode = Normal" },
]

const PSD_VETO_SOURCE_OPTIONS: RegisterOption[] = [
  { value: 0, label: "Disabled" },
  { value: 1, label: "Common (0x810C)" },
  { value: 2, label: "Per couple (0x8180+4n)" },
  { value: 3, label: "Saturating / opposite-polarity events" },
]

const PSD_ADDITIONAL_VALIDATION_OPTIONS: RegisterOption[] = [
  { value: 0, label: "Use bits [5:4]" },
  { value: 1, label: "Paired channel AND mother board" },
  { value: 2, label: "Paired channel OR mother board" },
  { value: 3, label: "Reserved" },
]

const PSD_VETO_MODE_OPTIONS: RegisterOption[] = [
  { value: 0, label: "Discard after integration" },
  { value: 1, label: "Inhibit self-triggers" },
]

/** UM4380 p.28 — inverted sense: 0 = enabled. */
const PSD_TRIGGER_HYSTERESIS_OPTIONS: RegisterOption[] = [
  { value: 0, label: "Enabled (default)" },
  { value: 1, label: "Disabled" },
]

// ── Board Configuration (0x8000) ────────────────────────────

/** UM5678 rev.3 p.38 — Analog Probe 1, bits[13:12]. */
const ANALOG_PROBE_1_PHA_OPTIONS: RegisterOption[] = [
  { value: 0, label: "Input" },
  { value: 1, label: "RC-CR (1st derivative)" },
  { value: 2, label: "RC-CR2 (2nd derivative)" },
  { value: 3, label: "Trapezoid" },
]

/** UM5678 rev.3 p.38 — Analog Probe 2, bits[15:14]. A different set from probe 1. */
const ANALOG_PROBE_2_PHA_OPTIONS: RegisterOption[] = [
  { value: 0, label: "Input" },
  { value: 1, label: "Threshold", hint: "referred to the RC-CR2 signal" },
  { value: 2, label: "Trapezoid − Baseline" },
  { value: 3, label: "Baseline (of the trapezoid)" },
]

/** UM4380 rev.6 p.38 — what the traces show depends on Dual Trace as well. */
const ANALOG_PROBE_PSD_OPTIONS: RegisterOption[] = [
  { value: 0, label: "Input", hint: "with dual trace: Input + Baseline" },
  { value: 1, label: "CFD", hint: "with dual trace: CFD + Baseline. Needs CFD discrimination, else this is the smoothed input" },
  { value: 2, label: "Input + CFD", hint: "dual trace only" },
  { value: 3, label: "Reserved" },
]

/** UM5678 rev.3 p.39 — Digital Virtual Probe 1, bits[23:20]. */
const DIGITAL_PROBE_1_PHA_OPTIONS: RegisterOption[] = [
  { value: 0x0, label: "Peaking", hint: "where the energy is calculated" },
  { value: 0x1, label: "Armed", hint: "RC-CR2 crossing the threshold" },
  { value: 0x2, label: "Peak Run", hint: "starts at the trigger, lasts the whole event" },
  { value: 0x3, label: "Pile-up", hint: "where a pile-up event occurred" },
  { value: 0x4, label: "Peaking", hint: "same as 0000" },
  { value: 0x5, label: "TRG Validation Window", hint: "trigger validation acceptance window" },
  { value: 0x6, label: "Baseline Freeze", hint: "where the baseline is frozen" },
  { value: 0x7, label: "TRG Hold-off" },
  { value: 0x8, label: "TRG Validation" },
  { value: 0x9, label: "Acq Busy", hint: "board busy or vetoed" },
  { value: 0xa, label: "Zero Crossing Window", hint: "the RT discrimination width" },
  { value: 0xb, label: "Ext TRG", hint: "external trigger, when available" },
  { value: 0xc, label: "Busy", hint: "memory board full" },
]

/** UM5678 rev.3 p.39 — Digital Virtual Probe 2, bits[28:26]. Only one option. */
const DIGITAL_PROBE_2_PHA_OPTIONS: RegisterOption[] = [
  { value: 0, label: "Trigger" },
]

/** UM4380 rev.6 p.39 — Digital Virtual Probe 1, bits[25:23]. */
const DIGITAL_PROBE_1_PSD_OPTIONS: RegisterOption[] = [
  { value: 0, label: "Long Gate" },
  { value: 1, label: "Over Threshold", hint: "1 while the input is above threshold" },
  { value: 2, label: "Shaped TRG", hint: "the self-trigger propagated to other channels and boards" },
  { value: 3, label: "TRG Validation Acceptance Window" },
  { value: 4, label: "Pile Up", hint: "high for the whole long gate when a pile-up occurred" },
  { value: 5, label: "Coincidence" },
  { value: 6, label: "Reserved" },
  { value: 7, label: "Trigger" },
]

/** UM4380 rev.6 p.39 — Digital Virtual Probe 2, bits[28:26]. */
const DIGITAL_PROBE_2_PSD_OPTIONS: RegisterOption[] = [
  { value: 0, label: "Short Gate" },
  { value: 1, label: "Over Threshold", hint: "1 while the input is above threshold" },
  { value: 2, label: "TRG Validation", hint: "coincidence validation from the mother board" },
  { value: 3, label: "TRG Hold-off" },
  { value: 4, label: "Pile Up Trigger" },
  { value: 5, label: "PSD Cut High", hint: "event above the PSD threshold (0x1n78)" },
  { value: 6, label: "Baseline Freeze", hint: "during gate integration or trigger hold-off" },
  { value: 7, label: "Trigger" },
]

// ── Acquisition Control (0x8100) — synchronisation ──────────

/**
 * UM5678 p.43 / UM4380 p.43 — Start/Stop Mode. This is *the* register that
 * decides whether a multi-board system takes synchronised data, which is why
 * the dashboard surfaces it on its own card.
 */
export const START_STOP_MODE_OPTIONS: RegisterOption[] = [
  {
    value: 0,
    label: "SW controlled",
    hint: "Run starts/stops on software command (bit[2]). Use for the MASTER board.",
  },
  {
    value: 1,
    label: "S-IN / GPI controlled",
    hint: "Armed by bit[2]; runs while S-IN (VME) / GPI (Desktop-NIM) is asserted. Use for SLAVE boards.",
  },
  {
    value: 2,
    label: "First trigger controlled",
    hint: "Armed by bit[2]; starts on the first TRG-IN rising edge (that pulse is not acquired).",
  },
  {
    value: 3,
    label: "LVDS controlled (VME only)",
    hint: "Like S-IN, but driven by the LVDS RUN signal (0x811C, 0x81A0).",
  },
]

const ACQ_START_ARM_OPTIONS: RegisterOption[] = [
  { value: 0, label: "Stopped / disarmed" },
  { value: 1, label: "Running / armed" },
]

const PLL_CLOCK_SOURCE_OPTIONS: RegisterOption[] = [
  { value: 0, label: "Internal oscillator (50 MHz)" },
  { value: 1, label: "External CLK-IN" },
]

// ── Front Panel I/O Control (0x811C) — synchronisation ──────

/** UM5678 p.52 — what TRG-OUT/GPO carries. Option 11 forwards S-IN down a chain. */
export const TRG_OUT_MODE_OPTIONS: RegisterOption[] = [
  { value: 0, label: "Trigger (per 0x8110)" },
  { value: 1, label: "Motherboard probe", hint: "select which one below — RUN propagates the start" },
  { value: 2, label: "Channel probe" },
  { value: 3, label: "S-IN / GPI propagation", hint: "forwards the start to the next board in the chain" },
]

/** UM5678 p.52 — which motherboard signal goes onto TRG-OUT/GPO. */
export const MOTHERBOARD_PROBE_OPTIONS: RegisterOption[] = [
  { value: 0, label: "RUN / delayed RUN", hint: "use this on the master to drive the chain" },
  { value: 1, label: "CLKOUT", hint: "for aligning clock phase across boards" },
  { value: 2, label: "CLK phase" },
  { value: 3, label: "BUSY / UNLOCK" },
]

const LEMO_LEVEL_OPTIONS: RegisterOption[] = [
  { value: 0, label: "NIM" },
  { value: 1, label: "TTL" },
]

const TRG_IN_CONTROL_OPTIONS: RegisterOption[] = [
  { value: 0, label: "Synchronised with the edge" },
  { value: 1, label: "Synchronised with the whole duration" },
]

// ============================================================
// Field lookup
// ============================================================

/** Options common to both firmwares, keyed by the field name used in the UI. */
const COMMON_FIELD_OPTIONS: { [fieldName: string]: RegisterOption[] } = {
  "Trigger Mode": TRIGGER_MODE_OPTIONS,
  "Invert Input": INVERT_INPUT_OPTIONS,
  "Disable Self Trigger": DISABLE_SELF_TRIGGER_OPTIONS,
  "Count Trigger Step": COUNT_TRIGGER_STEP_OPTIONS,
  "Local Shaped Trigger": LOCAL_SHAPED_TRIGGER_OPTIONS,
  // Acquisition Control (0x8100)
  "Start/Stop Mode": START_STOP_MODE_OPTIONS,
  "Acquisition Start/Arm": ACQ_START_ARM_OPTIONS,
  "PLL Reference Clock": PLL_CLOCK_SOURCE_OPTIONS,
  // Front Panel I/O Control (0x811C)
  "TRG-OUT Mode": TRG_OUT_MODE_OPTIONS,
  "Motherboard Probe": MOTHERBOARD_PROBE_OPTIONS,
  "LEMO I/O Level": LEMO_LEVEL_OPTIONS,
  "TRG-IN Control": TRG_IN_CONTROL_OPTIONS,
}

const PHA_FIELD_OPTIONS: { [fieldName: string]: RegisterOption[] } = {
  "Peak Mean": PHA_PEAK_MEAN_OPTIONS,
  Decimation: PHA_DECIMATION_OPTIONS,
  "Decimation Gain": PHA_DECIMATION_GAIN_OPTIONS,
  "Baseline Averaging Window": PHA_BASELINE_OPTIONS,
  "Extras 2": PHA_EXTRAS2_OPTIONS,
  "Local Trigger Validation": PHA_LOCAL_TRIGGER_VALIDATION_OPTIONS,
  "Veto Source": PHA_VETO_SOURCE_OPTIONS,
  "Ready Baseline": PHA_READY_BASELINE_OPTIONS,
  "Analog Probe 1": ANALOG_PROBE_1_PHA_OPTIONS,
  "Analog Probe 2": ANALOG_PROBE_2_PHA_OPTIONS,
  "Digital Virtual Probe 1": DIGITAL_PROBE_1_PHA_OPTIONS,
  "Digital Virtual Probe 2": DIGITAL_PROBE_2_PHA_OPTIONS,
}

const PSD_FIELD_OPTIONS: { [fieldName: string]: RegisterOption[] } = {
  "Charge Sensitivity": PSD_CHARGE_SENSITIVITY_2VPP,
  "Discrimination Mode": PSD_DISCRIMINATION_OPTIONS,
  "Baseline Averaging Window": PSD_BASELINE_OPTIONS,
  "Internal Pulse Rate": PSD_PULSE_RATE_OPTIONS,
  "Smoothed Signal Samples": PSD_SMOOTHING_OPTIONS,
  "Extras 2": PSD_EXTRAS_OPTIONS,
  "Local Trigger Validation": PSD_LOCAL_TRIGGER_VALIDATION_OPTIONS,
  "Veto Source": PSD_VETO_SOURCE_OPTIONS,
  "Additional Local Trigger Val.": PSD_ADDITIONAL_VALIDATION_OPTIONS,
  "Veto Signal Mode": PSD_VETO_MODE_OPTIONS,
  "Trigger Hysteresis": PSD_TRIGGER_HYSTERESIS_OPTIONS,
  "Analog Probe": ANALOG_PROBE_PSD_OPTIONS,
  "Digital Virtual Probe 1": DIGITAL_PROBE_1_PSD_OPTIONS,
  "Digital Virtual Probe 2": DIGITAL_PROBE_2_PSD_OPTIONS,
}

/**
 * Enumerated options for a bit field, or null when it is a plain number.
 * `dppType` picks between the PHA and PSD meanings of same-named fields
 * (e.g. "Baseline Averaging Window" has different windows in each firmware).
 */
export function getFieldOptions(fieldName: string, dppType: string): RegisterOption[] | null {
  const isPSD = dppType.toUpperCase().includes("PSD")
  const specific = isPSD ? PSD_FIELD_OPTIONS[fieldName] : PHA_FIELD_OPTIONS[fieldName]
  return specific ?? COMMON_FIELD_OPTIONS[fieldName] ?? null
}

// ============================================================
// Register documentation
// ============================================================

export interface RegisterDoc {
  /** One-line explanation of what the register does. */
  description: string
  /** Physical unit of the raw value, when it has one. */
  unit?: string
}

/**
 * Short descriptions for the registers an operator actually tunes. Keyed by the
 * register name as it appears in the board configuration; lookup is by
 * case-insensitive substring so firmware spelling variants still match.
 */
const REGISTER_DOCS: { [regName: string]: RegisterDoc } = {
  // ── Timing / trigger ──
  "Trigger Threshold": {
    description: "Self-trigger threshold on the timing filter output.",
    unit: "LSB",
  },
  "Input Rise Time": {
    description:
      "Time constant of the RC-CR2 derivative. Should match the input rising edge (or be up to 50% longer) so the RC-CR2 peak equals the pulse height.",
  },
  "RC-CR2 Smoothing Factor": {
    description:
      "Moving-average window used to form the RC-CR2 timing signal. Only the listed values are legal.",
  },
  "Trigger Hold-Off Width": {
    description: "Dead time after a trigger during which new triggers are ignored.",
  },
  "Trigger Hold-off Width": {
    description: "Dead time after a trigger during which new triggers are ignored.",
  },
  "Shaped Trigger Width": {
    description: "Width of the fast-discriminator output used for coincidences and TRG-OUT.",
  },
  "Pre Trigger": {
    description: "Samples recorded before the trigger inside the waveform window.",
  },
  // ── Energy filter (PHA) ──
  "Trapezoid Rise Time": {
    description:
      "Shaping time of the energy filter. Rise time + flat top must stay under 16 µs (725) / 8 µs (730).",
  },
  "Trapezoid Flat Top": {
    description: "Flat-top length of the trapezoid; must contain the peaking window.",
  },
  "Peaking Time": {
    description: "Delay from the start of the flat top to where the trapezoid height is sampled.",
  },
  "Decay Time": {
    description:
      "Pole-zero compensation — must match the exponential decay constant of the preamplifier signal.",
  },
  "Peak Hold-Off": {
    description: "Pile-up inspection window after the peak.",
  },
  "Fine Gain": {
    description: "Digital gain applied to the energy, alongside the trapezoid rescaling.",
  },
  // ── Charge integration (PSD) ──
  "Short Gate Width": { description: "Length of the short integration gate." },
  "Long Gate Width": { description: "Length of the long integration gate." },
  "Gate Offset": { description: "How far before the trigger both gates start." },
  // ── Common ──
  "DC Offset": {
    description:
      "Baseline position on the ADC scale, via a 16-bit DAC. Higher values move the baseline down.",
  },
  "Record Length": { description: "Length of the acquisition window (waveform)." },
  "Number of Events per Aggregate": {
    description: "Events packed into one channel aggregate before readout.",
  },
  "Input Dynamic Range": { description: "Full-scale range of the input stage." },
  // ── Board-level ──
  "Acquisition Control": {
    description:
      "How the run starts and stops. This is what synchronises several boards — see the Acquisition Control card.",
  },
  "Acquistion Control": {
    description:
      "How the run starts and stops. This is what synchronises several boards — see the Acquisition Control card.",
  },
  "Board Configuration": {
    description: "Global data-format options: waveforms, extras, probes and trigger propagation.",
  },
  "Front Panel I/O Control": {
    description:
      "What the front-panel LEMO connectors carry. Drives the start signal down a daisy chain.",
  },
  "Global Trigger Mask": {
    description: "Which sources contribute to the global (board-level) trigger.",
  },
  "Front Panel TRG-OUT": {
    description: "Which sources are propagated on the TRG-OUT / GPO connector.",
  },
  "Channel Enable Mask": { description: "Which channels take part in the readout." },
  "Run/Start/Stop Delay": {
    description:
      "Compensates the propagation of the START signal along a daisy chain — zero for the last board, rising going backwards.",
  },
  "Aggregate Number per BLT": {
    description: "Board aggregates transferred per block read.",
  },
  "Board ID": { description: "Identifier stamped into every aggregate header." },
  // ── Remaining registers, so nothing in the curated view is unexplained ──
  "CFD Settings": {
    description:
      "Delay and fraction of the constant-fraction discriminator. Only used when the discrimination mode is CFD.",
  },
  "Fixed Baseline": {
    description:
      "Baseline value in LSB used when the baseline mean is set to Fixed. Ignored when the baseline is calculated dynamically.",
  },
  "Threshold for the PSD": {
    description:
      "PSD value (0 to 1) at which events are cut online. Write the value times 1024 — e.g. 122 for 0.12. Enable the cut on gammas or neutrons in the rejection settings.",
  },
  "PUR-GAP Threshold": {
    description:
      "How deep the valley between two peaks inside a gate must be to count as pile-up, in LSB (1 LSB = 0.12 mV at 2 Vpp, 0.03 mV at 0.5 Vpp).",
  },
  "Trigger Latency": {
    description:
      "Extra window added to the shaped trigger width to absorb trigger-propagation delay when using coincidences. The manual mandates 0x2 within a channel couple and 0x9 across couples on the 725/730 series.",
  },
  // NOTE: "Baseline Hold-Off" (0x1n7C), "Shaped Trigger Delay" (0x1n44) and
  // "Trapezoid Baseline Offset" (0x1nB8) are intentionally absent — none of
  // them exist in the current DPP-PHA register set (CAEN removed Baseline
  // Hold-Off in UM5678 rev.01), and DPP-PSD has no Fine Gain either.
  "Rise Time Validation Window": {
    description:
      "Window in which the rise time of the pulse must fall for the trigger to be validated — rejects events with the wrong pulse shape.",
  },
  "Charge Zero Suppression Threshold": {
    description: "Events whose long-gate charge falls below this value are discarded.",
  },
  "Early Baseline Freeze": {
    description: "Freezes the baseline this long before the gate opens, so the pulse itself cannot pull it.",
  },
  "Veto Width": { description: "Duration of the veto applied to this channel." },
  "Disable External Trigger": {
    description: "Ignore the external trigger arriving on TRG-IN, without recabling.",
  },
  "Extended Veto Delay": {
    description:
      "Extends how long the veto inhibits TRG-OUT, used when synchronising a multi-board system.",
  },
  "Aggregate Configuration": {
    description: "How events are packed into aggregates before readout.",
  },
  "Short Gate": {
    description: "Length of the short gate — should cover the fast component of the pulse.",
  },
  "Long Gate": {
    description: "Length of the long gate — should cover the whole pulse, including its tail.",
  },
}

// ============================================================
// Bit-field documentation
// ============================================================

/**
 * Explanations for the individual bit fields surfaced as standalone controls.
 * Keyed by field name; PSD entries win for a board running DPP-PSD, since a few
 * names mean different things in the two firmwares.
 */
const COMMON_FIELD_DOCS: { [fieldName: string]: string } = {
  "Invert Input":
    "Polarity of the input pulse. The DPP algorithms expect positive pulses, so negative signals are inverted in the FPGA.",
  "Trigger Mode":
    "Whether the channel acquires on its own trigger, or only when a validation signal does (coincidence) or does not (anti-coincidence) arrive within its window.",
  "Disable Self Trigger":
    "When set, the channel's self-trigger is still sent to the trigger logic and TRG-OUT, but the channel no longer acquires on it.",
  "Count Trigger Step":
    "How many counted events the trigger-rate flag in the EXTRAS word represents.",
  "Local Shaped Trigger":
    "How the self-triggers of the two channels in a couple are combined into one trigger request.",
  "Local Trigger Validation":
    "How the validation signal for the two channels in a couple is formed.",
  "Enable Waveform":
    "Save the sampled trace with each event. This multiplies the data volume — normally off for production runs.",
  "Enable Extras":
    "Add the EXTRAS word to each event, carrying the extended time stamp and, depending on its setting, the fine time stamp or trigger counters.",
  "Dual Trace":
    "Show two analogue probes interleaved in the same trace instead of one.",
  "Trigger Propagation":
    "Propagate this board's trigger to the front-panel TRG-OUT connector.",
  "Automatic Data Flush":
    "Periodically flush partially filled aggregates so data is not held back at low rates.",
  "Veto Source": "Where this channel's veto signal comes from.",
  "Extras 2": "What the 32-bit EXTRAS word carries in each event.",
  // Probe naming differs between firmwares (PHA exposes two analogue probes,
  // PSD one), so keep both spellings here rather than in the per-firmware maps.
  "Analog Probe": "Which internal signal the analogue probe shows. What you get also depends on Dual Trace.",
  "Analog Probe 1": "Which internal signal the first analogue trace shows.",
  "Analog Probe 2": "Which internal signal the second analogue trace shows. Note this is a different set of choices from probe 1.",
  "Digital Virtual Probe 1":
    "First logic signal recorded alongside the waveform in mixed mode — use it to see when the firmware triggered, integrated or froze the baseline.",
  "Digital Virtual Probe 2":
    "Second logic signal recorded alongside the waveform in mixed mode.",
  "Enable Digital Probe":
    "Record the digital traces in the waveform data. With this off, the digital probe selections have no effect.",
  "Decimated Samples":
    "Save decimated waveform samples in the event instead of every sample, reducing the trace size.",
}

const PHA_FIELD_DOCS: { [fieldName: string]: string } = {
  "Peak Mean":
    "How many samples the trapezoid height is averaged over. It must fit inside the flat top.",
  "Trapezoid Rescaling":
    "Right shift applied to the trapezoid before the 15-bit pulse height is extracted. Together with the fine gain this sets the energy scale — pick the shift so the peaks land in range.",
  Decimation:
    "Averages input samples for the energy filter only, as if the sampling frequency were lower. Timing, baseline, hold-off and record length are unaffected.",
  "Decimation Gain":
    "Multiplies the decimated samples to recover the resolution lost to decimation.",
  "Baseline Averaging Window":
    "How many samples the baseline is averaged over. Longer is smoother but slower to follow drifts; 'Not evaluated' disables baseline subtraction entirely.",
  "Baseline Restorer":
    "Optimises the baseline restorer to avoid tails on the energy peaks.",
  "Ready Baseline":
    "Keeps computing the baseline while the acquisition is stopped, so the first events of a run are not mis-measured.",
  "Enable Pile-Up":
    "Keep piled-up events and report their (unreliable) energy with the pile-up flag set, instead of the usual behaviour of saving them with energy = 0.",
  "Enable Roll-Over":
    "Emit a synthetic zero-energy event when the time stamp rolls over, so long runs can be reconstructed unambiguously.",
}

const PSD_FIELD_DOCS: { [fieldName: string]: string } = {
  "Charge Sensitivity":
    "How much charge corresponds to one channel of the energy spectrum. The scale depends on the input dynamic range.",
  "Charge Pedestal":
    "Adds a fixed offset of 1024 to the charge, so energies near zero are not clipped.",
  "Discrimination Mode":
    "Leading edge triggers on the threshold crossing; constant fraction gives timing that does not depend on pulse amplitude.",
  "Baseline Averaging Window":
    "How many samples the baseline is averaged over. 'Fixed' uses the constant value from the Fixed Baseline register instead.",
  "Baseline Recalculation":
    "Restarts the baseline calculation at the end of the long gate. Useful for short pulses on a fluctuating baseline.",
  "Smoothed Signal": "Use the smoothed input for the charge integration.",
  "Smoothed Signal Samples":
    "Moving-average window applied to the input before discrimination. Smooths noisy signals so the trigger does not fire on ripple.",
  "Pile-Up Rejection": "Discard events that pile up inside the integration gate.",
  "PSD Cut Below Threshold":
    "Discard events whose PSD value is below the threshold — cuts gammas. Independent of the cut above.",
  "PSD Cut Above Threshold":
    "Discard events whose PSD value is above the threshold — cuts neutrons. Independent of the cut below.",
  "Over Range Rejection":
    "Discard events that saturate the ADC during the long gate, since their charge is wrong.",
  "Trigger Hysteresis":
    "Inhibits re-triggering on the trailing edge of a pulse. Normally left enabled.",
  "Trigger Counting":
    "Whether the shaped trigger reflects only accepted events, or every self-trigger including rejected ones.",
  "Internal Pulse": "Replace the ADC data with a built-in test pulse, for debugging.",
  "Internal Pulse Rate": "Rate of the built-in test pulse generator.",
  "Mark Saturated Pulses": "Flag events that clipped inside the gate, instead of silently keeping them.",
  "Veto Signal Mode":
    "Whether the veto discards the event after integration, or inhibits the self-trigger so no dead time is incurred.",
  "Reset Time Stamp":
    "Reset the time stamp while an external veto is active, splitting the data into spills.",
}

/** Explanation for a bit field, or null when we have nothing to add. */
export function getFieldDoc(fieldName: string, dppType: string): string | null {
  const isPSD = dppType.toUpperCase().includes("PSD")
  const specific = isPSD ? PSD_FIELD_DOCS[fieldName] : PHA_FIELD_DOCS[fieldName]
  return specific ?? COMMON_FIELD_DOCS[fieldName] ?? null
}

/** Documentation for a register, or null when we have nothing useful to say. */
export function getRegisterDoc(registerName: string): RegisterDoc | null {
  const direct = REGISTER_DOCS[registerName]
  if (direct) return direct
  const normalised = registerName.replace(/[‐–—]/g, "-").toLowerCase()
  for (const [key, doc] of Object.entries(REGISTER_DOCS)) {
    const k = key.replace(/[‐–—]/g, "-").toLowerCase()
    if (normalised === k || normalised.includes(k)) return doc
  }
  return null
}

// ============================================================
// Curated settings — the signal chain, in order
// ============================================================

/**
 * A single control in the curated view.
 *
 * Most of what an operator actually tunes is not a whole register but a *field*
 * inside one — "enable pile-up" is bit 27 of DPP Algorithm Control, the baseline
 * window is bits [22:20] of the same word. Referencing fields directly lets the
 * dashboard present them as ordinary switches and dropdowns, grouped by what
 * they do, instead of making the user find the right bit of the right hex value.
 */
export interface CuratedSetting {
  /** Register name as it appears in the board configuration. */
  register: string
  /** Bit-field name within that register; omitted = the whole register value. */
  field?: string
  /** Display name override (defaults to the field or register name). */
  label?: string
}

export interface SettingSection {
  id: string
  title: string
  description: string
  settings: CuratedSetting[]
}

// ── Per-channel: DPP-PHA ────────────────────────────────────
// Ordered the way the signal flows through the firmware: the input stage, the
// timing filter that triggers, the trapezoid that measures energy, the baseline
// it is measured against, and finally what gets rejected.
const PHA_CHANNEL_SECTIONS: SettingSection[] = [
  {
    id: "input",
    title: "Input",
    description: "How the analogue signal is presented to the ADC.",
    settings: [
      { register: "DPP Algorithm Control", field: "Invert Input", label: "Signal polarity" },
      { register: "DC Offset" },
      { register: "Input Dynamic Range" },
    ],
  },
  {
    id: "trigger",
    title: "Trigger & Timing",
    description:
      "The RC-CR2 timing filter and the self-trigger it feeds. Set the input rise time to match your signal's leading edge.",
    settings: [
      { register: "Trigger Threshold" },
      { register: "Input Rise Time" },
      { register: "RC-CR2 Smoothing Factor" },
      { register: "Trigger Hold-Off Width" },
      { register: "DPP Algorithm Control", field: "Trigger Mode" },
      { register: "DPP Algorithm Control", field: "Disable Self Trigger" },
    ],
  },
  {
    id: "energy",
    title: "Energy Filter (Trapezoid)",
    description:
      "The trapezoidal shaper that measures pulse height. Decay time must match the preamplifier fall time, and the peaking window must sit inside the flat top.",
    settings: [
      { register: "Decay Time" },
      { register: "Trapezoid Rise Time" },
      { register: "Trapezoid Flat Top" },
      { register: "Peaking Time" },
      { register: "DPP Algorithm Control", field: "Peak Mean" },
      { register: "DPP Algorithm Control", field: "Trapezoid Rescaling" },
      { register: "Fine Gain" },
      { register: "DPP Algorithm Control", field: "Decimation" },
    ],
  },
  {
    id: "baseline",
    title: "Baseline",
    description: "What the pulse height is measured against.",
    settings: [
      // No Baseline Hold-Off: CAEN removed register 0x1n7C in UM5678 rev.01.
      { register: "DPP Algorithm Control", field: "Baseline Averaging Window", label: "Averaging window" },
      { register: "DPP Algorithm Control 2", field: "Baseline Restorer" },
      { register: "DPP Algorithm Control 2", field: "Ready Baseline" },
    ],
  },
  {
    id: "rejection",
    title: "Pile-up & Rejection",
    description: "Which events are kept, and how pile-up is flagged.",
    settings: [
      { register: "DPP Algorithm Control", field: "Enable Pile-Up", label: "Keep pile-up events" },
      { register: "Peak Hold-Off" },
      { register: "DPP Algorithm Control", field: "Enable Roll-Over" },
    ],
  },
]

// ── Per-channel: DPP-PSD ────────────────────────────────────
const PSD_CHANNEL_SECTIONS: SettingSection[] = [
  {
    id: "input",
    title: "Input",
    description: "How the analogue signal is presented to the ADC.",
    settings: [
      { register: "DPP Algorithm Control", field: "Invert Input", label: "Signal polarity" },
      { register: "DC Offset" },
      { register: "Input Dynamic Range" },
    ],
  },
  {
    id: "trigger",
    title: "Trigger & Timing",
    description:
      "The self-trigger and its discriminator. CFD gives better timing than a leading edge; the smoothing factor filters the input the discriminator sees.",
    settings: [
      { register: "Trigger Threshold" },
      { register: "DPP Algorithm Control", field: "Discrimination Mode" },
      { register: "CFD Settings" },
      { register: "DPP Algorithm Control 2", field: "Smoothed Signal Samples", label: "Input smoothing factor" },
      { register: "Trigger Hold-Off Width" },
      { register: "DPP Algorithm Control", field: "Trigger Mode" },
      { register: "DPP Algorithm Control", field: "Disable Self Trigger" },
    ],
  },
  {
    id: "charge",
    title: "Charge Integration",
    description:
      "The two gates whose ratio gives the pulse-shape discrimination. The short gate should cover the fast component, the long gate the whole pulse.",
    settings: [
      { register: "Gate Offset" },
      { register: "Short Gate" },
      { register: "Long Gate" },
      { register: "DPP Algorithm Control", field: "Charge Sensitivity" },
      { register: "DPP Algorithm Control", field: "Charge Pedestal" },
      // No Fine Gain here: DPP-PSD has no 0x1nC4 register (UM4380 rev.6 p.7).
      { register: "Charge Zero Suppression Threshold" },
    ],
  },
  {
    id: "baseline",
    title: "Baseline",
    description: "What the charge is integrated against.",
    settings: [
      { register: "DPP Algorithm Control", field: "Baseline Averaging Window", label: "Baseline mean" },
      { register: "Fixed Baseline" },
      { register: "DPP Algorithm Control", field: "Baseline Recalculation" },
    ],
  },
  {
    id: "rejection",
    title: "Pile-up & Rejection",
    description: "Which events are discarded before they reach the file.",
    settings: [
      { register: "DPP Algorithm Control", field: "Pile-Up Rejection" },
      { register: "PUR-GAP Threshold" },
      { register: "Threshold for the PSD" },
      { register: "DPP Algorithm Control", field: "PSD Cut Below Threshold" },
      { register: "DPP Algorithm Control", field: "PSD Cut Above Threshold" },
      { register: "DPP Algorithm Control", field: "Over Range Rejection" },
      { register: "DPP Algorithm Control", field: "Trigger Hysteresis" },
    ],
  },
]

// ── Board-wide sections (both firmwares) ────────────────────
const BOARD_SECTIONS: SettingSection[] = [
  {
    id: "waveform",
    title: "Waveform Recording",
    description:
      "The oscilloscope-like trace saved with each event. Recording waveforms multiplies the data volume — leave it off for production runs.",
    settings: [
      { register: "Board Configuration", field: "Enable Waveform", label: "Record waveforms" },
      { register: "Record Length", label: "Record length (samples)" },
      { register: "Pre Trigger" },
      { register: "Board Configuration", field: "Dual Trace" },
      { register: "Board Configuration", field: "Analog Probe" },
      { register: "Board Configuration", field: "Analog Probe 1" },
      { register: "Board Configuration", field: "Analog Probe 2" },
      { register: "Board Configuration", field: "Decimated Samples" },
    ],
  },
  {
    id: "digitalprobes",
    title: "Digital Probes",
    description:
      "Logic signals recorded alongside the trace in mixed mode — the firmware's own view of when it triggered, integrated, froze the baseline or rejected a pile-up. The most direct way to see why an event was treated the way it was.",
    settings: [
      { register: "Board Configuration", field: "Enable Digital Probe", label: "Record digital traces" },
      { register: "Board Configuration", field: "Digital Virtual Probe 1" },
      { register: "Board Configuration", field: "Digital Virtual Probe 2" },
    ],
  },
  {
    id: "dataformat",
    title: "Data Format",
    description:
      "What each event carries besides energy and time stamp. The EXTRAS word is where the fine time stamp and the trigger counters live.",
    settings: [
      { register: "Board Configuration", field: "Enable Extras" },
      { register: "DPP Algorithm Control 2", field: "Extras 2", label: "EXTRAS word content" },
      { register: "Number of Events per Aggregate" },
      { register: "Aggregate Number per BLT" },
    ],
  },
]

/** Curated per-channel sections for a firmware, in signal-chain order. */
export function getChannelSections(dppType: string): SettingSection[] {
  return dppType.toUpperCase().includes("PSD") ? PSD_CHANNEL_SECTIONS : PHA_CHANNEL_SECTIONS
}

/** Curated board-wide sections. */
export function getBoardSections(): SettingSection[] {
  return BOARD_SECTIONS
}

// ============================================================
// Register grouping
// ============================================================

export type RegisterCategory = "trigger" | "energy" | "gates" | "input" | "readout" | "other"

const CATEGORY_KEYWORDS: [RegisterCategory, string[]][] = [
  ["trigger", [
    "trigger threshold", "input rise time", "rc-cr2", "trigger hold", "shaped trigger",
    "trigger validation", "self trigger", "trigger mode",
  ]],
  ["energy", [
    "trapezoid", "peaking time", "decay time", "peak hold", "fine gain", "rescaling",
  ]],
  ["gates", ["gate", "charge", "psd", "cfd"]],
  ["input", ["dc offset", "dynamic range", "polarity", "invert"]],
  ["readout", [
    "record length", "aggregate", "pre trigger", "extras", "probe", "waveform",
  ]],
]

/** Bucket a register into a display group so related settings sit together. */
export function categorizeRegister(registerName: string): RegisterCategory {
  const n = registerName.replace(/[‐–—]/g, "-").toLowerCase()
  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some(k => n.includes(k))) return category
  }
  return "other"
}

export const CATEGORY_LABELS: Record<RegisterCategory, string> = {
  trigger: "Trigger & Timing",
  energy: "Energy Filter",
  gates: "Charge Integration",
  input: "Input Stage",
  readout: "Readout & Data Format",
  other: "Other Settings",
}

/** Order the categories are rendered in. */
export const CATEGORY_ORDER: RegisterCategory[] = [
  "trigger", "energy", "gates", "input", "readout", "other",
]
