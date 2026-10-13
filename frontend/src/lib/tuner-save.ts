/**
 * The Tuner switches data saving off for its own acquisition. The value it
 * found is kept here, in localStorage (shared by every tab of this browser),
 * so it is put back however that acquisition ends: the Tuner's Stop, the
 * dashboard's Stop Run, the phone run bar, or a stop seen by the run-status
 * poller. A production run must never start with saving silently off.
 */
import { setSaveData } from '@/lib/api'

const KEY = 'lunadaq:tuner-saved-save-flag'

interface Record_ { original: boolean; started: boolean }

function read(): Record_ | null {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) || 'null')
    return v && typeof v.original === 'boolean' ? { original: v.original, started: Boolean(v.started) } : null
  } catch {
    return null
  }
}
function write(r: Record_) {
  try { window.localStorage.setItem(KEY, JSON.stringify(r)) } catch { /* see restore */ }
}

/** Before switching saving off: remember what it was. */
export function rememberTunerSaveFlag(original: boolean): void {
  write({ original, started: false })
}

/** The Tuner's acquisition has started: from now on any stop restores. */
export function markTunerRunStarted(): void {
  const r = read()
  if (r) write({ ...r, started: true })
}

/** Saving is switched off by the Tuner and not yet put back. */
export function tunerSaveRecordPending(): boolean {
  return typeof window !== 'undefined' && read() !== null
}

/** A Tuner acquisition was started from this browser and not yet stopped. */
export function tunerRunStarted(): boolean {
  return read()?.started === true
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
  // seen now is the state before its run, not the end of it.
  if (r === null || (!r.started && !opts.evenIfNotStarted)) return Promise.resolve(null)
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
