/**
 * Shared machinery of the Tuner scans (P5, P6): step through register values
 * on the live board, measure each step, and always put the starting values
 * back — on success, cancel, failure, or (via a record in localStorage) after
 * a reload in the middle of a scan.
 *
 * Scans write to the board, so they are only offered in a run the Tuner
 * started itself (tunerOwnsRun); the callers check that and abort when it
 * stops being true.
 */
import { applySetting, getExperimentStats } from '@/lib/api'
import { pickChannel, type ChannelRates } from '@/components/tuner/use-channel-rates'

const SCAN_KEY = 'lunadaq:tuner-scan'
const DEADLINE_MS = 5000

export type RegisterValues = Record<string, number>

export interface ScanRecord {
  boardId: string
  original: RegisterValues
  name: string
  at: number
}

export class ScanAborted extends Error {
  constructor(reason: string) { super(reason) }
}

/** A promise that gives up after `ms` (resolves to null), so a hung request cannot hang a scan. */
export function withDeadline<T>(p: Promise<T>, ms = DEADLINE_MS): Promise<T | null> {
  return Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))])
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ScanAborted('Cancelled'))
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(t); reject(new ScanAborted('Cancelled')) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function readRecord(): ScanRecord | null {
  try { const s = window.localStorage.getItem(SCAN_KEY); return s ? (JSON.parse(s) as ScanRecord) : null } catch { return null }
}
function writeRecord(r: ScanRecord | null) {
  try { if (r) window.localStorage.setItem(SCAN_KEY, JSON.stringify(r)); else window.localStorage.removeItem(SCAN_KEY) } catch { /* best effort */ }
}

/**
 * Write register values to the board (and its configuration). Returns the
 * first refusal, or null when every value went to the board.
 */
export async function writeLive(boardId: string, values: RegisterValues): Promise<string | null> {
  for (const [key, raw] of Object.entries(values)) {
    const r = await withDeadline(applySetting(boardId, key, raw, true))
    if (!r) return 'The server did not answer in time.'
    if (!r.written) return r.reason || 'The board did not accept the value.'
  }
  return null
}

/**
 * Put back the values a scan started from. The configuration is always
 * restored; the board too when `live` (the Tuner's run is still on).
 */
export async function restoreValues(boardId: string, original: RegisterValues, live: boolean): Promise<boolean> {
  let ok = true
  for (const [key, raw] of Object.entries(original)) {
    // Two tries: the first answer may be lost on a busy link.
    let r = await withDeadline(applySetting(boardId, key, raw, live))
    if (!r) r = await withDeadline(applySetting(boardId, key, raw, live))
    if (!r) ok = false
  }
  return ok
}

/**
 * A scan left unfinished by a reload or a closed tab: restore its starting
 * values in the configuration (and on the board when `live`). Returns the
 * scan's name when something was restored.
 */
export async function recoverInterruptedScan(live: (boardId: string) => boolean): Promise<string | null> {
  const r = readRecord()
  if (!r) return null
  const ok = await restoreValues(r.boardId, r.original, live(r.boardId))
  if (ok) writeRecord(null)
  return ok ? r.name : null
}

/** Mean rates of one channel over `dwellMs`, polled once a second. */
export async function measureRates(boardId: string, channel: number, dwellMs: number, signal: AbortSignal): Promise<ChannelRates & { samples: number }> {
  const acc = { event: 0, pileup: 0, lost: 0, satu: 0, samples: 0 }
  const end = Date.now() + dwellMs
  while (Date.now() < end || acc.samples === 0) {
    await sleep(1000, signal)
    const stats = await withDeadline(getExperimentStats())
    const r = pickChannel(stats, boardId, channel)
    if (r) { acc.event += r.event; acc.pileup += r.pileup; acc.lost += r.lost; acc.satu += r.satu; acc.samples++ }
    if (Date.now() > end + 10000) break
  }
  const n = Math.max(1, acc.samples)
  return { event: acc.event / n, pileup: acc.pileup / n, lost: acc.lost / n, satu: acc.satu / n, at: Date.now(), samples: acc.samples }
}

export interface ScanStep<V, M> { value: V; values: RegisterValues; result: M }

/**
 * Run a scan: for each step write its values, wait `settleMs`, measure. The
 * starting values are restored in every case before this returns or throws.
 * `stopAfter` may end the scan early (it keeps the step that triggered it).
 */
export async function runScan<V, M>(opts: {
  name: string
  boardId: string
  original: RegisterValues
  steps: { value: V; values: RegisterValues }[]
  settleMs: number
  measure: (signal: AbortSignal) => Promise<M>
  signal: AbortSignal
  isLive: () => boolean
  onStep?: (done: ScanStep<V, M>[], next: number) => void
  stopAfter?: (step: ScanStep<V, M>, done: ScanStep<V, M>[]) => string | null
}): Promise<{ steps: ScanStep<V, M>[]; stoppedEarly: string | null; restored: boolean }> {
  const done: ScanStep<V, M>[] = []
  let stoppedEarly: string | null = null
  writeRecord({ boardId: opts.boardId, original: opts.original, name: opts.name, at: Date.now() })
  let restored = false
  try {
    for (let i = 0; i < opts.steps.length; i++) {
      if (opts.signal.aborted) throw new ScanAborted('Cancelled')
      if (!opts.isLive()) throw new ScanAborted('The Tuner run is no longer on.')
      opts.onStep?.(done.slice(), i)
      const refusal = await writeLive(opts.boardId, opts.steps[i].values)
      if (refusal) throw new ScanAborted(refusal)
      await sleep(opts.settleMs, opts.signal)
      const result = await opts.measure(opts.signal)
      const step = { ...opts.steps[i], result }
      done.push(step)
      opts.onStep?.(done.slice(), i + 1)
      stoppedEarly = opts.stopAfter?.(step, done) ?? null
      if (stoppedEarly) break
    }
  } finally {
    restored = await restoreValues(opts.boardId, opts.original, opts.isLive())
    if (restored) writeRecord(null)
  }
  return { steps: done, stoppedEarly, restored }
}

/** n values from `from` to `to`, evenly spaced on a log scale, rounded, without repeats. */
export function geometricSteps(from: number, to: number, n: number, quantum = 1): number[] {
  const out: number[] = []
  if (n < 2 || from <= 0 || to <= 0) return [Math.round(from / quantum) * quantum]
  for (let i = 0; i < n; i++) {
    const v = from * Math.pow(to / from, i / (n - 1))
    const q = Math.max(quantum, Math.round(v / quantum) * quantum)
    if (!out.includes(q)) out.push(q)
  }
  return out
}

/** n values from `from` to `to`, evenly spaced, rounded to `quantum`, without repeats. */
export function linearSteps(from: number, to: number, n: number, quantum = 1): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const v = n < 2 ? from : from + ((to - from) * i) / (n - 1)
    const q = Math.max(quantum, Math.round(v / quantum) * quantum)
    if (!out.includes(q)) out.push(q)
  }
  return out
}
