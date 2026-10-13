'use client'

import { useEffect } from 'react'
import {
  getCurrentRunNumber,
  getExperimentStats,
  getRunStatus,
  getStartTime,
} from '@/lib/api'
import useRunControlStore, { type RunControlState } from '@/store/run-control-store'

/**
 * One poller for the run state, shared by every component that calls
 * useRunStatus(). It runs while at least one of them is mounted (the header's
 * indicator is on every page, so in practice: always, once logged in) and
 * stops when the last one unmounts.
 *
 * Errors keep the last known state on screen (a momentary hiccup must not flip
 * the UI to "Stopped"); `unreachable` says the last poll failed.
 */
const POLL_MS = 2000

interface ChannelLike { event_rate?: number }
interface BoardLike { failed?: boolean; board_failures?: number; channels?: ChannelLike[] }

let subscribers = 0
let timer: ReturnType<typeof setInterval> | null = null
let inFlight: Promise<void> | null = null

async function pollOnce(): Promise<void> {
  const store = useRunControlStore.getState()
  const [running, start, runNumber] = await Promise.all([
    getRunStatus().catch(() => null),
    getStartTime().catch(() => null),
    getCurrentRunNumber().catch(() => null),
  ])
  if (running === null) {
    store.update({ unreachable: true })
    return
  }
  const isRunning = Boolean(running)
  const patch: Partial<RunControlState> = {
    known: true,
    unreachable: false,
    isRunning,
    startTime: isRunning && typeof start === 'string' ? start : null,
  }
  if (typeof runNumber === 'number') patch.runNumber = runNumber

  // Rates only while a run is on: /experiment/stats carries every channel of
  // every board, and the server answers [] when nothing is running.
  if (isRunning) {
    const stats = await getExperimentStats().catch(() => null)
    if (Array.isArray(stats)) {
      const boards = stats as BoardLike[]
      patch.boardError = boards.some((b) => Boolean(b.failed) || (b.board_failures ?? 0) > 0)
      patch.totalRate = boards.reduce(
        (acc, b) => acc + (b.channels ?? []).reduce((s, c) => s + (Number(c.event_rate) || 0), 0),
        0,
      )
    }
  } else {
    patch.boardError = false
    patch.totalRate = null
  }
  store.update(patch)
}

/** Ask now (after Start or Stop) instead of waiting for the next tick. */
export function refreshRunStatus(): Promise<void> {
  if (!inFlight) {
    inFlight = pollOnce().finally(() => { inFlight = null })
  }
  return inFlight
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
