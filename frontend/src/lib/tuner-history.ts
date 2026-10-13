/**
 * The Tuner's change log and presets (P7), kept in this browser
 * (localStorage). The log records every register change the Tuner sent,
 * with the resolution at the time, so any step can be undone; presets keep a
 * channel's settings by name, per firmware.
 */
import { baseAddress, controlsFor, getBits, setBits, type ControlSpec } from '@/components/tuner/units'
import { findRegKey, type BoardSettings } from '@/components/tuner/controls-panel'

export interface HistoryEntry {
  id: string
  at: number
  boardId: string
  channel: number
  regKey: string
  name: string
  label: string
  /** Firmware the change was made with: register keys mean different things in PHA and PSD. */
  dpp?: string
  /** Entries saved together by one Save all share a group. */
  group?: string
  /** The control (ControlSpec.id) and its bits when the entry is one field of a shared register. */
  field?: string
  bits?: [number, number]
  /** Field values when `bits` is set, else whole register values. */
  from: number
  to: number
  /** Written to the board (else configuration only, from the next run). */
  written: boolean
  source: 'manual' | 'undo' | 'preset' | 'run'
  /** The fitted FWHM when the change was made (before it took effect). */
  fwhmBefore: number | null
  unit: string | null
}

export interface Preset {
  id: string
  name: string
  dpp: string
  created: number
  /** Field values by control id (ControlSpec.id). */
  values: Record<string, number>
}

const HISTORY_KEY = 'lunadaq:tuner-history'
const PRESET_KEY = 'lunadaq:tuner-presets'
const MAX_HISTORY = 300

const read = <T,>(k: string, fallback: T): T => {
  try { const s = window.localStorage.getItem(k); return s ? (JSON.parse(s) as T) : fallback } catch { return fallback }
}
const write = (k: string, v: unknown) => { try { window.localStorage.setItem(k, JSON.stringify(v)) } catch { /* full or blocked: the log is a convenience */ } }
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

export function loadHistory(boardId: string, channel: number, dpp: string): HistoryEntry[] {
  return filterHistory(read<HistoryEntry[]>(HISTORY_KEY, []), boardId, channel, dpp)
}

/** The entries of one board, channel and firmware (entries without a firmware are from before it was recorded: left out). */
export function filterHistory(all: HistoryEntry[], boardId: string, channel: number, dpp: string): HistoryEntry[] {
  return all.filter((e) => e.boardId === boardId && e.channel === channel && e.dpp === dpp)
}

export function addHistory(e: Omit<HistoryEntry, 'id' | 'at'>): HistoryEntry {
  const entry = { ...e, id: newId(), at: Date.now() }
  write(HISTORY_KEY, [...read<HistoryEntry[]>(HISTORY_KEY, []), entry].slice(-MAX_HISTORY))
  return entry
}

/** Clear the list shown: this board, channel and firmware only. */
export function clearHistory(boardId: string, channel: number, dpp: string) {
  write(HISTORY_KEY, read<HistoryEntry[]>(HISTORY_KEY, []).filter((e) => !(e.boardId === boardId && e.channel === channel && e.dpp === dpp)))
}

export function loadPresets(dpp: string): Preset[] {
  return read<Preset[]>(PRESET_KEY, []).filter((p) => p.dpp === dpp)
}

export function savePreset(name: string, dpp: string, values: Record<string, number>): Preset {
  const p = { id: newId(), name, dpp, created: Date.now(), values }
  write(PRESET_KEY, [...read<Preset[]>(PRESET_KEY, []).filter((q) => !(q.dpp === dpp && q.name === name)), p])
  return p
}

export function deletePreset(id: string) {
  write(PRESET_KEY, read<Preset[]>(PRESET_KEY, []).filter((p) => p.id !== id))
}

/** The Tuner controls' field values for a channel (pending values win). */
export function channelValues(dpp: string, settings: BoardSettings, pending: Record<string, number>, channel: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const spec of controlsFor(dpp)) {
    const k = findRegKey(settings, channel, spec.address)
    if (!k) continue
    const raw = pending[k] ?? settings[k].value_dec
    out[spec.id] = spec.bits ? getBits(raw, spec.bits) : raw
  }
  return out
}

/**
 * Register values (raw, by register key) that give the channel the field
 * values in `values`, starting from its current (pending or saved) values.
 * Only registers that would change are returned.
 */
export function registersFor(dpp: string, settings: BoardSettings, pending: Record<string, number>, channel: number, values: Record<string, number>): Record<string, number> {
  const work: Record<string, number> = {}
  for (const spec of controlsFor(dpp)) {
    if (!(spec.id in values)) continue
    const k = findRegKey(settings, channel, spec.address)
    if (!k) continue
    const base = work[k] ?? pending[k] ?? settings[k].value_dec
    work[k] = spec.bits ? setBits(base, spec.bits, values[spec.id]) : values[spec.id]
  }
  for (const k of Object.keys(work)) if (work[k] === (pending[k] ?? settings[k].value_dec)) delete work[k]
  return work
}

/** One control that differs between two sets of field values. */
export interface ControlDiff { spec: ControlSpec; a: number; b: number }

export function diffValues(dpp: string, a: Record<string, number>, b: Record<string, number>): ControlDiff[] {
  return controlsFor(dpp).filter((s) => s.id in a && s.id in b && a[s.id] !== b[s.id]).map((spec) => ({ spec, a: a[spec.id], b: b[spec.id] }))
}

/**
 * The Tuner controls' field values for a channel in a run's register dump
 * (`registers` of GET /data/runs/<n>), or null if the dump has none.
 */
export function valuesFromDump(dpp: string, registers: Record<string, { channel: number; address: string; value: string }>, channel: number): Record<string, number> | null {
  const byAddr = new Map<number, number>()
  for (const r of Object.values(registers)) {
    if (Number(r.channel) !== channel) continue
    const a = parseInt(r.address, 16)
    const base = a >= 0x1000 && a <= 0x1fff ? a & 0xf0ff : a
    const v = typeof r.value === 'number' ? r.value : parseInt(String(r.value), String(r.value).startsWith('0x') ? 16 : 10)
    if (Number.isFinite(v)) byAddr.set(base, v)
  }
  const out: Record<string, number> = {}
  for (const spec of controlsFor(dpp)) {
    const raw = byAddr.get(spec.address)
    if (raw === undefined) continue
    out[spec.id] = spec.bits ? getBits(raw, spec.bits) : raw
  }
  return Object.keys(out).length ? out : null
}

/**
 * The Tuner controls that differ between two values of one register: a
 * register such as 0x1080 holds several fields (polarity, baseline mean,
 * peak mean...), and each is logged (and undone) on its own. A register the
 * Tuner has no control for comes back as one whole-register change.
 */
export function fieldChanges(dpp: string, address: string, from: number, to: number): { spec: ControlSpec | null; from: number; to: number }[] {
  const specs = controlsFor(dpp).filter((s) => s.address === baseAddress(address))
  const out: { spec: ControlSpec | null; from: number; to: number }[] = specs
    .map((spec) => ({ spec, from: spec.bits ? getBits(from, spec.bits) : from, to: spec.bits ? getBits(to, spec.bits) : to }))
    .filter((c) => c.from !== c.to)
  // Bits no control covers changed too: log the whole register as well.
  const covered = specs.reduce((m, s) => (s.bits ? m | Number(((BigInt(1) << BigInt(s.bits[1] - s.bits[0] + 1)) - BigInt(1)) << BigInt(s.bits[0])) : 0xffffffff), 0) >>> 0
  if (((from ^ to) & ~covered) >>> 0 || (!specs.length && from !== to)) out.push({ spec: null, from, to })
  return out
}

/** The register value Undo stages: only the entry's field is put back, the rest stays as it is now. */
export function undoTarget(e: Pick<HistoryEntry, 'bits' | 'from'>, currentRaw: number): number {
  return e.bits ? setBits(currentRaw, e.bits, e.from) : e.from
}

/** Whether the entry's field (or register) no longer holds the value the entry set. */
export function changedSince(e: Pick<HistoryEntry, 'bits' | 'to'>, currentRaw: number): boolean {
  return (e.bits ? getBits(currentRaw, e.bits) : currentRaw) !== e.to
}
