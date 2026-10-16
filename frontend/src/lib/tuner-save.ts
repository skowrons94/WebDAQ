/**
 * The Tuner switches data saving off for its own acquisition. The value it
 * found is kept here, in localStorage (shared by every tab of this browser),
 * so it is put back however that acquisition ends: the Tuner's Stop, the
 * dashboard's Stop Run, the phone run bar, or a stop seen by the run-status
 * poller. A production run must never start with saving silently off.
 */
import { setSaveData } from '@/lib/api'

const KEY = 'lunadaq:tuner-saved-save-flag'

interface Record_ {
  original: boolean
  started: boolean
  /** The server's start_time of the Tuner's run: only that run is the Tuner's. */
  startTime: string | null
  /** When the record was written (ms), to expire one whose run never started. */
  createdAt: number
}

/** A record whose run never started (the tab closed during Start) expires. */
export const UNSTARTED_RECORD_TTL_MS = 2 * 60 * 1000

function read(): Record_ | null {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) || 'null')
    if (!v || typeof v.original !== 'boolean') return null
    return {
      original: v.original,
      started: Boolean(v.started),
      startTime: typeof v.startTime === 'string' ? v.startTime : null,
      createdAt: typeof v.createdAt === 'number' ? v.createdAt : 0,
    }
  } catch {
    return null
  }
}
function write(r: Record_) {
  try { window.localStorage.setItem(KEY, JSON.stringify(r)) } catch { /* see restore */ }
}
function expired(r: Record_): boolean {
  return !r.started && Date.now() - r.createdAt > UNSTARTED_RECORD_TTL_MS
}

/** Before switching saving off: remember what it was. */
export function rememberTunerSaveFlag(original: boolean): void {
  write({ original, started: false, startTime: null, createdAt: Date.now() })
}

/** The Tuner's acquisition has started, with this server start_time. */
export function markTunerRunStarted(startTime: string | null): void {
  const r = read()
  if (r) write({ ...r, started: true, startTime })
}

/** The Tuner's run started, but its server start time could not be read then. */
export function tunerRunStartUnknown(): boolean {
  const r = read()
  return !!r && r.started && r.startTime === null
}

/**
 * The run with this start_time is the one the Tuner started from this
 * browser. A record from an older Tuner run (stopped elsewhere while this
 * browser was closed) never claims a later production run.
 */
export function tunerOwnsRun(startTime: string | null): boolean {
  const r = typeof window === 'undefined' ? null : read()
  return !!r && r.started && r.startTime !== null && startTime !== null && r.startTime === startTime
}

/** A Tuner run was started from this browser and saving not yet put back. */
export function tunerRunRecordStarted(): boolean {
  return typeof window !== 'undefined' && read()?.started === true
}

/** Drop the record without touching the server (the switch-off itself was refused). */
export function forgetTunerSaveFlag(): void {
  try { window.localStorage.removeItem(KEY) } catch { /* ignore */ }
}

let restoring: Promise<boolean | null> | null = null

/**
 * If a Tuner acquisition switched saving off, switch it back and forget the
 * record. Resolves to the restored value, or null if there was nothing to do.
 * The record is kept if the server refuses, so the next attempt retries.
 */
export function restoreTunerSaveFlag(opts: { evenIfNotStarted?: boolean } = {}): Promise<boolean | null> {
  const r = typeof window === 'undefined' ? null : read()
  // Not yet started: the Tuner is between "saving off" and "start"; a stop
  // seen now is the state before its run, not the end of it -- unless the
  // record is minutes old (the tab closed during Start): then it is restored.
  if (r === null || (!r.started && !opts.evenIfNotStarted && !expired(r))) return Promise.resolve(null)
  const original = r.original
  if (!restoring) {
    restoring = setSaveData(original)
      .then(() => {
        try { window.localStorage.removeItem(KEY) } catch { /* ignore */ }
        return original
      })
      .catch((error) => {
        console.error('Could not restore data saving after the Tuner run:', error?.message ?? error)
        return null
      })
      .finally(() => { restoring = null })
  }
  return restoring
}
