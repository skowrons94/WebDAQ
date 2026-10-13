'use client'

import { useEffect, useRef, useState } from 'react'
import { getExperimentStats } from '@/lib/api'

/** One channel's rates from GET /experiment/stats, per second. */
export interface ChannelRates {
  event: number
  pileup: number
  lost: number
  satu: number
  /** When this reading arrived (ms). */
  at: number
}

interface ChannelLike { board?: number | string; channel: number; event_rate?: number; pileup_rate?: number; lost_rate?: number; satu_rate?: number }
interface BoardLike { board_id?: number | string; name?: string; channels?: ChannelLike[] }

/** Read one channel out of a /experiment/stats answer (null if absent). */
export function pickChannel(stats: unknown, boardId: string, channel: number): ChannelRates | null {
  if (!Array.isArray(stats)) return null
  const boards = stats as BoardLike[]
  // Each channel names its board; else the board entry may; a single board in
  // the run is that board.
  const all = boards.flatMap((b) => (b.channels ?? []).map((c) => ({ b, c })))
  const hit = all.find(({ b, c }) => c.channel === channel
      && String(c.board ?? b.board_id ?? '') === String(boardId))
    ?? (boards.length === 1 ? all.find(({ c }) => c.channel === channel) : undefined)
  const c = hit?.c
  if (!c) return null
  return {
    event: Number(c.event_rate) || 0,
    pileup: Number(c.pileup_rate) || 0,
    lost: Number(c.lost_rate) || 0,
    satu: Number(c.satu_rate) || 0,
    at: Date.now(),
  }
}

/**
 * The selected channel's rates while a run is on, every `periodMs`. Keeps a
 * short history for the strip's trend. Polls only while `active`.
 */
export function useChannelRates(boardId: string, channel: number, active: boolean, periodMs = 2000) {
  const [now, setNow] = useState<ChannelRates | null>(null)
  const history = useRef<ChannelRates[]>([])
  useEffect(() => {
    history.current = []
    setNow(null)
    if (!active || !boardId) return
    let alive = true
    const poll = async () => {
      const stats = await Promise.race([
        getExperimentStats().catch(() => null),
        new Promise<null>((r) => setTimeout(() => r(null), 4000)),
      ])
      if (!alive) return
      const r = pickChannel(stats, boardId, channel)
      if (r) {
        history.current = [...history.current, r].slice(-60)
        setNow(r)
      }
    }
    void poll()
    const id = setInterval(poll, periodMs)
    return () => { alive = false; clearInterval(id) }
  }, [boardId, channel, active, periodMs])
  return { now, history: history.current }
}
