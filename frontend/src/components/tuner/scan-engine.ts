/**
 * Shared machinery of the Tuner scans (P5, P6): step through register values
 * on the live board, measure each step, and put the starting values back.
 *
 * Every write the server receives also lands in the board's configuration
 * file (applySetting saves it), which the next run applies. So a scan's
 * values must never outlive the scan:
 *
 *  - The scan stops the moment the Tuner run ends (the caller aborts it), and
 *    "Stop" in the Tuner cancels it and waits for the restore first
 *    (cancelActiveScan).
 *  - A record in localStorage lists the starting values, every value the scan
 *    wrote, and the last one sent per register. While it exists, a production
 *    Start refuses (scanBlocksStart) until the values are restored.
 *  - Before restoring, writes still in flight are waited for (bounded); the
 *    restore order keeps short gate < long gate; a refused write is a
 *    failure; and the configuration is read back. Anything unconfirmed keeps
 *    the record and says so.
 *  - One tab at a time: the scanning tab refreshes a heartbeat in the record;
 *    another tab neither starts a scan nor restores while it is fresh.
 *  - Leaving or closing the page during a scan asks first.
 */
import { applySetting, getBoardSettings, getExperimentStats, type ApplySettingResult } from '@/lib/api'
import { pickChannel, type ChannelRates } from '@/components/tuner/use-channel-rates'

const SCAN_KEY = 'lunadaq:tuner-scan'
const DEADLINE_MS = 5000
/** How long a write that did not answer in time may still land. */
export const SETTLE_GRACE_MS = 20000
const HEARTBEAT_MS = 2000
/** A record whose heartbeat is older is an interrupted scan (hidden tabs tick about once a minute). */
export const HEARTBEAT_STALE_MS = 3 * 60 * 1000
/** An interrupted record older than this no longer blocks a Start; the Tuner still offers it. */
export const RECORD_EXPIRY_MS = 24 * 60 * 60 * 1000

export type RegisterValues = Record<string, number>

export interface ScanRecord {
  v: 2
  tab: string
  boardId: string
  name: string
  startedAt: number
  heartbeat: number
  /** Starting values, in the order they are to be restored by default. */
  original: { key: string; raw: number }[]
  /** Every value the scan sent, per register. */
  scanned: Record<string, number[]>
  /** The last value sent per register (it may still be in flight). */
  last: Record<string, number>
  /** PSD gates: restored in an order that keeps short < long. */
  pair?: { short: string; long: string }
}

export class ScanAborted extends Error {
  constructor(reason: string) { super(reason) }
}

const TAB_ID = typeof window !== 'undefined'
  ? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  : 'server'

// ── Requests ────────────────────────────────────────────────────────────

/** Requests sent by the scans that have not settled yet (they may land late). */
const outstanding = new Set<Promise<unknown>>()

function tracked<T>(p: Promise<T>): Promise<T> {
  outstanding.add(p)
  const done = () => { outstanding.delete(p) }
  p.then(done, done)
  return p
}

/** A promise that gives up after `ms` (resolves to null), so a hung request cannot hang a scan. */
export function withDeadline<T>(p: Promise<T>, ms = DEADLINE_MS): Promise<T | null> {
  return Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))])
}

/** Wait until every scan write has settled, at most `graceMs`. True when none is left. */
export async function settleWrites(graceMs = SETTLE_GRACE_MS): Promise<boolean> {
  const end = Date.now() + graceMs
  while (outstanding.size && Date.now() < end) {
    await Promise.race([Promise.allSettled(Array.from(outstanding)), new Promise((r) => setTimeout(r, Math.max(0, end - Date.now())))])
  }
  return outstanding.size === 0
}

function abortReason(signal?: AbortSignal): string {
  const r = signal?.reason
  return typeof r === 'string' ? r : 'Cancelled'
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ScanAborted(abortReason(signal)))
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(t); reject(new ScanAborted(abortReason(signal))) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// ── The record ──────────────────────────────────────────────────────────

export function readScanRecord(): ScanRecord | null {
  try {
    const s = window.localStorage.getItem(SCAN_KEY)
    if (!s) return null
    const r = JSON.parse(s) as Partial<ScanRecord>
    if (r.v === 2) return r as ScanRecord
    // A record from the first version: {boardId, original: {key: raw}, name, at}.
    const old = r as unknown as { boardId?: string; original?: Record<string, number>; name?: string; at?: number }
    if (old.boardId && old.original && typeof old.original === 'object') {
      return {
        v: 2, tab: '', boardId: old.boardId, name: old.name ?? 'Scan', startedAt: old.at ?? 0, heartbeat: 0,
        original: Object.entries(old.original).map(([key, raw]) => ({ key, raw })), scanned: {}, last: {},
      }
    }
    return null
  } catch { return null }
}

function writeScanRecord(r: ScanRecord | null) {
  try {
    if (r) window.localStorage.setItem(SCAN_KEY, JSON.stringify(r))
    else window.localStorage.removeItem(SCAN_KEY)
  } catch { /* storage blocked: the in-page guards still hold */ }
}

function updateRecord(f: (r: ScanRecord) => void) {
  const r = readScanRecord()
  if (!r || r.tab !== TAB_ID) return
  f(r)
  writeScanRecord(r)
}

export type ScanRecordState =
  | 'none'
  | 'active-here'      // a scan is running (or restoring) in this tab
  | 'active-elsewhere' // another tab's scan is running (fresh heartbeat)
  | 'interrupted'      // the scan ended without a confirmed restore
  | 'expired'          // interrupted, over RECORD_EXPIRY_MS ago

let active: { ctl: AbortController; done: Promise<void> } | null = null

export function scanRecordState(now = Date.now()): ScanRecordState {
  const r = readScanRecord()
  if (!r) return 'none'
  if (active && r.tab === TAB_ID) return 'active-here'
  if (r.tab !== TAB_ID && r.heartbeat > 0 && now - r.heartbeat < HEARTBEAT_STALE_MS) return 'active-elsewhere'
  if (now - r.startedAt > RECORD_EXPIRY_MS) return 'expired'
  return 'interrupted'
}

/** Whether a production Start must wait: a scan running, or one not yet restored (unless expired). */
export function scanBlocksStart(): boolean {
  const s = scanRecordState()
  return s !== 'none' && s !== 'expired'
}

/** Drop the record without restoring (the operator chose to keep the present values). */
export function discardScanRecord(): boolean {
  const s = scanRecordState()
  if (s === 'active-here' || s === 'active-elsewhere') return false
  writeScanRecord(null)
  return true
}

/** Subscribe to record changes from other tabs. */
export function onScanRecordChange(fn: () => void): () => void {
  const h = (e: StorageEvent) => { if (e.key === SCAN_KEY || e.key === null) fn() }
  window.addEventListener('storage', h)
  return () => window.removeEventListener('storage', h)
}

// ── Writes ──────────────────────────────────────────────────────────────

/**
 * The order to write `target` in, given what the board has now. For the PSD
 * gates, short < long must hold after every single write: long first when the
 * present short gate is below the new long gate, else short first.
 */
export function writeOrder(target: RegisterValues, current: RegisterValues, pair?: { short: string; long: string }): string[] {
  const keys = Object.keys(target)
  if (!pair || !(pair.short in target) || !(pair.long in target)) return keys
  const rest = keys.filter((k) => k !== pair.short && k !== pair.long)
  const s = current[pair.short]
  const longFirst = s === undefined || s < target[pair.long]
  return longFirst ? [pair.long, pair.short, ...rest] : [pair.short, pair.long, ...rest]
}

/**
 * Write register values to the board (and its configuration), in a safe
 * order. Returns the first refusal, or null when every value went to the board.
 */
async function writeLive(boardId: string, target: RegisterValues, current: RegisterValues, pair?: ScanRecord['pair']): Promise<string | null> {
  for (const key of writeOrder(target, current, pair)) {
    const raw = target[key]
    // Recorded before it is sent: if it never answers it may still land.
    updateRecord((r) => {
      r.last[key] = raw
      r.scanned[key] = Array.from(new Set([...(r.scanned[key] ?? []), raw]))
    })
    const res = await withDeadline(tracked(applySetting(boardId, key, raw, true)))
    if (!res) return 'The server did not answer in time.'
    current[key] = raw
    if (!res.written) return res.reason || 'The board did not accept the value.'
  }
  return null
}

export interface RestoreResult {
  ok: boolean
  /** What happened, for the operator. */
  message: string
  /** Registers left out because they were changed since the scan. */
  skipped: string[]
}

type Settings = Record<string, { value_dec: number; name?: string }>

/**
 * Put back the values a scan started from: configuration always, the board
 * too when `live`. Waits for writes in flight first, keeps short < long,
 * counts a refused or unanswered write as a failure, and reads the
 * configuration back. The record is cleared only when every value is
 * confirmed. `onlyScanned`: leave a register alone when it no longer holds a
 * value the scan wrote (someone changed it since).
 */
export async function restoreScan(live: boolean, opts: { onlyScanned?: boolean; graceMs?: number } = {}): Promise<RestoreResult> {
  const rec = readScanRecord()
  if (!rec) return { ok: true, message: 'Nothing to restore.', skipped: [] }
  const grace = opts.graceMs ?? SETTLE_GRACE_MS
  if (!(await settleWrites(grace))) {
    return { ok: false, message: 'A write to the board has not answered yet, so nothing was restored. The scan record is kept: restore again in a moment.', skipped: [] }
  }
  const before = await withDeadline(getBoardSettings(rec.boardId) as Promise<Settings>, 8000)
  if (!before) return { ok: false, message: 'The board settings could not be read, so nothing was restored. The scan record is kept.', skipped: [] }

  const target: RegisterValues = {}
  const skipped: string[] = []
  const current: RegisterValues = {}
  for (const o of rec.original) {
    const now = before[o.key]?.value_dec
    current[o.key] = now ?? rec.last[o.key] ?? o.raw
    if (now === undefined) continue
    const byScan = (rec.scanned[o.key] ?? []).includes(now)
    if (opts.onlyScanned && now !== o.raw && !byScan && rec.scanned[o.key]) {
      skipped.push(before[o.key]?.name ?? o.key)
      continue
    }
    // Live: always write, the board may differ from the file. Else only what differs.
    if (live || now !== o.raw) target[o.key] = o.raw
  }

  const failures: string[] = []
  for (const key of writeOrder(target, current, rec.pair)) {
    const res: ApplySettingResult | null = await withDeadline(tracked(applySetting(rec.boardId, key, target[key], live)))
    const name = before[key]?.name ?? key
    if (!res) { failures.push(`${name}: no answer`); break }
    if (res.saved === false) { failures.push(`${name}: not saved`); break }
    if (live && !res.written) { failures.push(`${name}: the board refused it${res.reason ? ` (${res.reason})` : ''}`); break }
    current[key] = target[key]
  }
  if (!(await settleWrites(grace))) failures.push('a write has still not answered')

  // Read the configuration back: the record goes only when it shows the originals.
  const after = await withDeadline(getBoardSettings(rec.boardId) as Promise<Settings>, 8000)
  if (!after) failures.push('the settings could not be read back')
  else {
    for (const key of Object.keys(target)) {
      if (after[key]?.value_dec !== target[key]) failures.push(`${after[key]?.name ?? key} reads ${after[key]?.value_dec}, not ${target[key]}`)
    }
  }
  if (failures.length) {
    return { ok: false, message: `Not restored: ${Array.from(new Set(failures)).join('; ')}. The scan record is kept: restore before the next run.`, skipped }
  }
  writeScanRecord(null)
  return {
    ok: true,
    message: skipped.length ? `Restored. Left as they are (changed since the scan): ${skipped.join(', ')}.` : 'The starting values are back.',
    skipped,
  }
}

// ── The running scan ────────────────────────────────────────────────────

/** A scan is running (or restoring) in this tab. */
export function scanActive(): boolean { return !!active }

/** Cancel the scan running in this tab and wait until it has restored (or given up). */
export async function cancelActiveScan(reason = 'Cancelled'): Promise<void> {
  const a = active
  if (!a) return
  a.ctl.abort(reason)
  await a.done
}

function confirmLeave(e: BeforeUnloadEvent) {
  e.preventDefault()
  e.returnValue = 'A Tuner scan is running: leaving now leaves its values on the board.'
  return e.returnValue
}

/** In-app links: ask before leaving the page; leaving cancels the scan (which restores). */
function guardLinks(e: MouseEvent) {
  if (!active || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
  if (!a || a.target === '_blank') return
  const url = new URL(a.href, window.location.href)
  if (url.origin === window.location.origin && url.pathname === window.location.pathname) return
  if (!window.confirm('A Tuner scan is running. Leave the page? The scan is cancelled and its starting values are restored.')) {
    e.preventDefault(); e.stopPropagation()
    return
  }
  active?.ctl.abort('Left the Tuner page')
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

/** Why a scan cannot start in this tab now, or null. */
export function scanStartBlocker(): string | null {
  switch (scanRecordState()) {
    case 'active-here': return 'A scan is already running.'
    case 'active-elsewhere': return 'A scan is running in another Tuner tab or window: finish it there first.'
    case 'interrupted':
    case 'expired': return 'An earlier scan was not restored: restore its values first.'
    default: return null
  }
}

export interface ScanOutcome<V, M> {
  steps: ScanStep<V, M>[]
  stoppedEarly: string | null
  /** Why it ended before its last step (cancel, refusal, run ended), or null. */
  aborted: string | null
  /** The restore was confirmed (else the record stays and Start waits). */
  restored: boolean
  restoreMessage: string
}

/**
 * Run a scan: for each step write its values, wait `settleMs`, measure. The
 * starting values are restored before this returns; `restored` says whether
 * that was confirmed. `stopAfter` may end the scan early (it keeps the step
 * that triggered it). Throws only when the scan cannot start.
 */
export async function runScan<V, M>(opts: {
  name: string
  boardId: string
  /** Starting values, in restore order. */
  original: { key: string; raw: number }[]
  pair?: { short: string; long: string }
  steps: { value: V; values: RegisterValues }[]
  settleMs: number
  measure: (signal: AbortSignal) => Promise<M>
  signal: AbortSignal
  isLive: () => boolean
  onStep?: (done: ScanStep<V, M>[], next: number) => void
  stopAfter?: (step: ScanStep<V, M>, done: ScanStep<V, M>[]) => string | null
}): Promise<ScanOutcome<V, M>> {
  const blocker = scanStartBlocker()
  if (blocker) throw new ScanAborted(blocker)
  const ctl = new AbortController()
  const onOuter = () => ctl.abort(abortReason(opts.signal))
  opts.signal.addEventListener('abort', onOuter, { once: true })
  if (opts.signal.aborted) ctl.abort(abortReason(opts.signal))
  let finish!: () => void
  active = { ctl, done: new Promise<void>((r) => { finish = r }) }

  const t0 = Date.now()
  writeScanRecord({
    v: 2, tab: TAB_ID, boardId: opts.boardId, name: opts.name, startedAt: t0, heartbeat: t0,
    original: opts.original, scanned: {}, last: {}, pair: opts.pair,
  })
  const beat = setInterval(() => updateRecord((r) => { r.heartbeat = Date.now() }), HEARTBEAT_MS)
  window.addEventListener('beforeunload', confirmLeave)
  document.addEventListener('click', guardLinks, true)

  const done: ScanStep<V, M>[] = []
  const current: RegisterValues = Object.fromEntries(opts.original.map((o) => [o.key, o.raw]))
  let stoppedEarly: string | null = null
  let aborted: string | null = null
  let restore: RestoreResult = { ok: false, message: '', skipped: [] }
  try {
    for (let i = 0; i < opts.steps.length; i++) {
      if (ctl.signal.aborted) throw new ScanAborted(abortReason(ctl.signal))
      if (!opts.isLive()) throw new ScanAborted('The Tuner run is no longer on.')
      opts.onStep?.(done.slice(), i)
      const refusal = await writeLive(opts.boardId, opts.steps[i].values, current, opts.pair)
      if (refusal) throw new ScanAborted(refusal)
      await sleep(opts.settleMs, ctl.signal)
      const result = await opts.measure(ctl.signal)
      if (ctl.signal.aborted) throw new ScanAborted(abortReason(ctl.signal))
      const step = { ...opts.steps[i], result }
      done.push(step)
      opts.onStep?.(done.slice(), i + 1)
      stoppedEarly = opts.stopAfter?.(step, done) ?? null
      if (stoppedEarly) break
    }
  } catch (e) {
    aborted = e instanceof ScanAborted ? e.message : 'The scan failed.'
  } finally {
    clearInterval(beat)
    updateRecord((r) => { r.heartbeat = Date.now() })
    try {
      restore = await restoreScan(opts.isLive())
    } catch {
      restore = { ok: false, message: 'The restore failed. The scan record is kept: restore before the next run.', skipped: [] }
    }
    // Not confirmed: mark it interrupted, so any tab (and Start) sees it at once.
    if (!restore.ok) updateRecord((r) => { r.heartbeat = 0 })
    window.removeEventListener('beforeunload', confirmLeave)
    document.removeEventListener('click', guardLinks, true)
    opts.signal.removeEventListener('abort', onOuter)
    active = null
    finish()
  }
  return { steps: done, stoppedEarly, aborted, restored: restore.ok, restoreMessage: restore.message }
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

/** The toast for how a scan ended (null when it finished and restored normally). */
export function outcomeToast(out: ScanOutcome<unknown, unknown>, name: string, backText: string): { title: string; description: string; variant?: 'destructive' } | null {
  if (!out.restored) return { title: `${name}: values not restored`, description: out.restoreMessage, variant: 'destructive' }
  if (out.aborted) return { title: `${name} stopped`, description: `${out.aborted} ${backText}` }
  return null
}
