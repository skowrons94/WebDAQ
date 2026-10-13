'use client'

import { useEffect } from 'react'
import {
  getCurrentRunNumber,
  getExperimentStats,
  getRunStatus,
  getStartTime,
} from '@/lib/api'
import useRunControlStore, { type RunControlState } from '@/store/run-control-store'
import { restoreTunerSaveFlag } from '@/lib/tuner-save'

/**
 * One poller for the run state, shared by every component that calls
 * useRunStatus(). It runs while at least one of them is mounted (the header's
 * indicator is on every page, so in practice: always, once logged in) and
 * stops when the last one unmounts.
 *
 * Three rules keep it from ever freezing or lying:
 * - Every poll has a deadline (POLL_DEADLINE_MS). A request that hangs (a
 *   half-open connection, a server stuck in a long call) is dropped: the store
 *   says `unreachable`, and the next tick sends a fresh poll instead of waiting
 *   on the stuck one forever.
 * - A poll sent before a Start or Stop (noteRunAction) cannot overwrite the
 *   state that action set: its answer may describe the world before the action.
 * - A failed field keeps its last value (a missing start time does not zero
 *   the timers); the run state itself is only ever set from a real answer.
 */
const POLL_MS = 2000
export const POLL_DEADLINE_MS = 4000

interface ChannelLike { event_rate?: number }
interface BoardLike { failed?: boolean; board_failures?: number; channels?: ChannelLike[] }

class Timeout extends Error {}

/** Resolve with the promise, or reject with Timeout after `ms`. The request
 *  itself cannot be cancelled here (api.ts takes no signal); it is abandoned. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let abandoned = false
    const id = setTimeout(() => {
      abandoned = true
      openAbandoned += 1
      if (openAbandoned >= ABANDONED_LIMIT) degraded = true
      reject(new Timeout('deadline'))
    }, ms)
    const settle = () => {
      clearTimeout(id)
      if (abandoned) {
        // A request we had given up on has come back: the server (or the
        // network) is answering again, so normal polling resumes.
        openAbandoned -= 1
        degraded = false
      }
    }
    p.then(
      (v) => { settle(); resolve(v) },
      (e) => { settle(); reject(e) },
    )
  })
}

/**
 * Bound on the pile-up during a long outage. Each abandoned request may stay
 * open in the browser until the connection gives up. Once ABANDONED_LIMIT of
 * them are open, no full polls are sent: one probe every PROBE_MS instead,
 * and normal polling resumes as soon as a probe succeeds or any abandoned
 * request settles.
 */
const ABANDONED_LIMIT = 2
const PROBE_MS = 10_000
let openAbandoned = 0
let degraded = false
let lastProbeAt = 0
let probing = false

/** Test hook / diagnostics: how many timed-out requests are still open. */
export function runStatusBackoff() {
  return { openAbandoned, degraded }
}

let subscribers = 0
let timer: ReturnType<typeof setInterval> | null = null
/** The poll currently waiting for an answer (at most one per tick). */
let inFlight: { promise: Promise<void>; startedAt: number; generation: number } | null = null
/** Bumped by every Start/Stop; a poll remembers the value it started with. */
let actionGeneration = 0

/** Call when a Start or Stop has just changed the run on the server. Answers
 *  to polls sent earlier are then ignored, and a fresh poll is sent. */
export function noteRunAction(): void {
  actionGeneration += 1
  void refreshRunStatus()
}

async function pollOnce(): Promise<void> {
  const generation = actionGeneration
  const stale = () => generation !== actionGeneration
  const store = useRunControlStore.getState()
  const settle = <T,>(p: Promise<T>) => withDeadline(p, POLL_DEADLINE_MS).then(
    (v) => ({ ok: true as const, v }),
    (e) => ({ ok: false as const, e }),
  )
  const [running, start, runNumber] = await Promise.all([
    settle(getRunStatus()),
    settle(getStartTime()),
    settle(getCurrentRunNumber()),
  ])
  if (stale()) return
  if (!running.ok) {
    // No answer about the run: say so, keep the last known values on screen.
    store.update({ unreachable: true })
    return
  }
  const isRunning = Boolean(running.v)
  const patch: Partial<RunControlState> = { known: true, unreachable: false, isRunning }
  if (!isRunning) patch.startTime = null
  else if (start.ok && typeof start.v === 'string') patch.startTime = start.v
  // (a failed start-time read during a run keeps the previous value)
  if (runNumber.ok && typeof runNumber.v === 'number') patch.runNumber = runNumber.v

  // Rates only while a run is on: /experiment/stats carries every channel of
  // every board, and the server answers [] when nothing is running.
  if (isRunning) {
    const stats = await settle(getExperimentStats())
    if (stale()) return
    if (stats.ok && Array.isArray(stats.v)) {
      const boards = stats.v as BoardLike[]
      patch.boardError = boards.some((b) => Boolean(b.failed) || (b.board_failures ?? 0) > 0)
      patch.totalRate = boards.reduce(
        (acc, b) => acc + (b.channels ?? []).reduce((s, c) => s + (Number(c.event_rate) || 0), 0),
        0,
      )
    }
  } else {
    patch.boardError = false
    patch.totalRate = null
    // A Tuner run that ended by any path (Dashboard, run bar, another tab):
    // put data saving back the way the Tuner found it.
    void restoreTunerSaveFlag()
  }
  store.update(patch)
}

/**
 * Ask now. If a poll is already waiting it is reused, unless it was sent
 * before the latest Start/Stop (then a fresh one goes out) or it has passed
 * its deadline (then it is abandoned). Never awaited by Start, Stop or the
 * Tuner: they set the state themselves and let this catch up.
 */
export function refreshRunStatus(): Promise<void> {
  const now = Date.now()
  if (degraded) {
    // Backed off: stay "No answer", one probe per PROBE_MS.
    useRunControlStore.getState().update({ unreachable: true })
    if (probing || now - lastProbeAt < PROBE_MS) return Promise.resolve()
    lastProbeAt = now
    probing = true
    return withDeadline(getRunStatus(), POLL_DEADLINE_MS)
      .then(() => { degraded = false })
      .catch(() => { /* still no answer: keep backing off */ })
      .finally(() => { probing = false })
      .then(() => (degraded ? undefined : refreshRunStatus()))
  }
  // A poll settles within two deadlines (status, then rates); the age check
  // only guards against a poll that somehow never settles.
  if (inFlight && inFlight.generation === actionGeneration
      && now - inFlight.startedAt < 2 * POLL_DEADLINE_MS + 500) {
    return inFlight.promise
  }
  const entry: NonNullable<typeof inFlight> = {
    promise: Promise.resolve(),
    startedAt: now,
    generation: actionGeneration,
  }
  entry.promise = pollOnce()
    .catch(() => { useRunControlStore.getState().update({ unreachable: true }) })
    .finally(() => { if (inFlight === entry) inFlight = null })
  inFlight = entry
  return entry.promise
}

function subscribe() {
  subscribers += 1
  if (subscribers === 1) {
    void refreshRunStatus()
    timer = setInterval(() => { void refreshRunStatus() }, POLL_MS)
  }
  return () => {
    subscribers -= 1
    if (subscribers === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

/**
 * The shared run state. Pass a selector to re-render only on what you read:
 *   const isRunning = useRunStatus((s) => s.isRunning)
 */
export function useRunStatus(): RunControlState
export function useRunStatus<T>(selector: (s: RunControlState) => T): T
export function useRunStatus<T>(selector?: (s: RunControlState) => T) {
  useEffect(subscribe, [])
  return useRunControlStore(selector ?? ((s) => s as unknown as T))
}
