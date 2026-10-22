/**
 * What a row of the run list is, read from the server's data rather than from
 * what this browser happened to see: Recent runs, the Logbook, the run bar and
 * the overwrite question at Start all use it, so they agree.
 *
 * A row with no end time is either the run being taken, or a run that never
 * ended: it saved nothing (no data/run<N>/, so its number is used again), or
 * the server went down before it was stopped.
 */

export interface RunRowLike {
  run_number: number
  start_time?: string | null
  end_time?: string | null
  /** data/run<N>/ exists (sent by the server since round 3; undefined before). */
  has_data?: boolean
}

export type RunRowState = 'finished' | 'live' | 'not-saved' | 'unfinished'

export interface RunNow {
  isRunning: boolean
  /** The server's run number: the running run's, or the next run's when stopped. */
  runNumber: number | null
  saving?: boolean | null
}

export function runRowState(row: RunRowLike, now: RunNow): RunRowState {
  if (row.end_time) return 'finished'
  if (now.isRunning && now.saving !== false && row.run_number === now.runNumber) return 'live'
  if (row.has_data === false) return 'not-saved'
  return 'unfinished'
}

/** The words for a row that did not end normally, or null for a finished or live run. */
export function runRowNote(row: RunRowLike, now: RunNow): string | null {
  const state = runRowState(row, now)
  if (state === 'not-saved') {
    return row.run_number === now.runNumber ? 'Not saved – number reused' : 'Not saved'
  }
  if (state === 'unfinished') return 'Never stopped properly'
  return null
}

/**
 * One date format for runs everywhere: "2026-10-22 09:45", local time. The
 * Logbook used the browser's date ("10/22/2026") and Recent runs its short
 * form ("10/22/26, 9:45 AM"); a lab with people from several countries reads
 * the ISO order without guessing which number is the month.
 */
export function formatRunDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** A signed number with a real minus sign ("−0.31", not "-0.31"). */
export function signed(value: number, decimals: number, plus = true): string {
  const text = Math.abs(value).toFixed(decimals)
  if (Number(text) === 0) return text
  return value < 0 ? `−${text}` : plus ? `+${text}` : text
}
