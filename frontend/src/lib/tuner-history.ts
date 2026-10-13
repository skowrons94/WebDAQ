/**
 * The Tuner's change log and presets (P7), kept in this browser
 * (localStorage). The log records every register change the Tuner sent,
 * with the resolution at the time, so any step can be undone; presets keep a
 * channel's settings by name, per firmware.
 */
import { controlsFor, getBits, setBits, type ControlSpec } from '@/components/tuner/units'
import { findRegKey, type BoardSettings } from '@/components/tuner/controls-panel'

export interface HistoryEntry {
  id: string
  at: number
  boardId: string
  channel: number
  regKey: string
  name: string
  label: string
  from: number
  to: number
  /** Written to the board (else configuration only, from the next run). */
  written: boolean
  source: 'manual' | 'scan' | 'undo' | 'preset' | 'run'
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

export function loadHistory(boardId: string, channel: number): HistoryEntry[] {
  return read<HistoryEntry[]>(HISTORY_KEY, []).filter((e) => e.boardId === boardId && e.channel === channel)
}

export function addHistory(e: Omit<HistoryEntry, 'id' | 'at'>): HistoryEntry {
  const entry = { ...e, id: newId(), at: Date.now() }
  write(HISTORY_KEY, [...read<HistoryEntry[]>(HISTORY_KEY, []), entry].slice(-MAX_HISTORY))
  return entry
}

export function clearHistory(boardId: string, channel: number) {
  write(HISTORY_KEY, read<HistoryEntry[]>(HISTORY_KEY, []).filter((e) => !(e.boardId === boardId && e.channel === channel)))
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
