'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, AlertTriangle, HeartPulse, Pause, RefreshCw } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  getBoardDiagnostics, getBoardConfiguration,
  type BoardCounters, type BoardDiagnostics,
} from '@/lib/api'

/**
 * Board Health — the readout counters caendaq keeps for each board this run.
 *
 * The board status on the dashboard answers one question ("is this board
 * failed?"). This page answers the one asked next: what has the board actually
 * done — blocks read, bytes read and written, blocks the write queue refused,
 * CAEN read errors, events decoded — and is it still doing it right now.
 *
 * Counters are cumulative for the run, so the numbers that tell you something in
 * the moment are their rates; both are shown, the rate from the change since the
 * previous poll.
 */

const POLL_MS = 1000

// A board is called stalled once it has read no new block for this long: long
// enough not to fire between two slow blocks, short enough to notice.
const STALL_AFTER_S = 10

type BoardRow = {
  id: string
  name: string
  counters: BoardCounters
  buffersPerSecond: number | null
  bytesPerSecond: number | null
  eventsPerSecond: number | null
  stalledFor: number | null
}

type Sample = { counters: BoardCounters; at: number }

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—'
  const units = ['B', 'kB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`
}

function formatCount(value: number | null): string {
  return value === null ? '—' : value.toLocaleString()
}

function formatRate(value: number | null, unit: string): string {
  if (value === null) return '—'
  return `${value < 10 ? value.toFixed(1) : Math.round(value).toLocaleString()} ${unit}`
}

export default function BoardHealth() {
  const [diagnostics, setDiagnostics] = useState<BoardDiagnostics | null>(null)
  const [names, setNames] = useState<Record<string, string>>({})
  const [rows, setRows] = useState<BoardRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // The previous poll, to turn cumulative counters into rates, and the moment
  // each board's block count last moved, to spot one that has stopped.
  const previous = useRef<Record<string, Sample>>({})
  const lastProgress = useRef<Record<string, { buffers: number; at: number }>>({})

  useEffect(() => {
    getBoardConfiguration()
      .then((res) => {
        const map: Record<string, string> = {}
        for (const board of res.data || []) map[String(board.id)] = board.name
        setNames(map)
      })
      .catch(() => setNames({}))
  }, [])

  const poll = useCallback(async () => {
    try {
      const data = await getBoardDiagnostics()
      const now = Date.now()
      setError(null)
      setDiagnostics(data)

      if (!data.running) {
        // Counters live with the run: between runs there is nothing to rate.
        previous.current = {}
        lastProgress.current = {}
        setRows([])
        return
      }

      const next: BoardRow[] = Object.entries(data.boards).map(([id, counters]) => {
        const before = previous.current[id]
        const seconds = before ? (now - before.at) / 1000 : 0
        const rate = (key: keyof BoardCounters) => {
          const current = counters[key]
          const earlier = before?.counters[key]
          if (!seconds || typeof current !== 'number' || typeof earlier !== 'number') {
            return null
          }
          return Math.max(0, (current - earlier) / seconds)
        }

        const buffers = counters.buffers_read
        const progress = lastProgress.current[id]
        if (typeof buffers === 'number' && (!progress || progress.buffers !== buffers)) {
          lastProgress.current[id] = { buffers, at: now }
        }
        const since = lastProgress.current[id]
        const stalledFor = since && typeof buffers === 'number'
          ? (now - since.at) / 1000
          : null

        previous.current[id] = { counters, at: now }
        return {
          id,
          name: names[id] ?? '',
          counters,
          buffersPerSecond: rate('buffers_read'),
          bytesPerSecond: rate('bytes_read'),
          eventsPerSecond: rate('events_decoded'),
          stalledFor,
        }
      })
      setRows(next.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not read the board counters')
    } finally {
      setLoading(false)
    }
  }, [names])

  useEffect(() => {
    poll()
    const timer = setInterval(poll, POLL_MS)
    return () => clearInterval(timer)
  }, [poll])

  const running = diagnostics?.running ?? false

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                <HeartPulse className="h-5 w-5" />
              </div>
              <div>
                <CardTitle className="text-xl">Board Health</CardTitle>
                <p className="text-sm text-muted-foreground">
                  What each board has read, written and lost during this run
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={running ? 'default' : 'secondary'} className="gap-1.5">
                {running ? <Activity className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
                {running ? 'Run in progress' : 'No run'}
              </Badge>
              <Button variant="outline" size="icon" onClick={poll} title="Refresh now">
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardHeader>
      </Card>

      {error && (
        <Card className="border-destructive">
          <CardContent className="py-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      {!running ? (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            {loading ? 'Reading the counters…' : (
              <>
                <p>These counters belong to a run: they start at zero when a run starts
                  and are gone when it ends.</p>
                <p className="mt-2 text-sm">Start a run to watch the boards here.</p>
              </>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((row) => {
            const stalled = row.stalledFor !== null && row.stalledFor >= STALL_AFTER_S
            const dropped = row.counters.blocks_dropped ?? 0
            const commErrors = row.counters.comm_errors ?? 0
            const failed = row.counters.failed
            const accent = failed || dropped > 0
              ? 'border-destructive'
              : stalled || commErrors > 0
                ? 'border-amber-500'
                : ''

            return (
              <Card key={row.id} className={accent}>
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <CardTitle className="text-base">Board {row.id}</CardTitle>
                      {row.name && (
                        <p className="text-xs text-muted-foreground">{row.name}</p>
                      )}
                    </div>
                    {failed ? (
                      <Badge variant="destructive" className="gap-1">
                        <AlertTriangle className="h-3 w-3" />
                        FAIL flag
                      </Badge>
                    ) : stalled ? (
                      <Badge className="gap-1 bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
                        <Pause className="h-3 w-3" />
                        No data for {Math.round(row.stalledFor ?? 0)} s
                      </Badge>
                    ) : (
                      <Badge className="gap-1 bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
                        <Activity className="h-3 w-3" />
                        Reading
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <Counter label="Data blocks" value={formatCount(row.counters.buffers_read)}
                             rate={formatRate(row.buffersPerSecond, '/s')} />
                    <Counter label="Events decoded" value={formatCount(row.counters.events_decoded)}
                             rate={formatRate(row.eventsPerSecond, '/s')} />
                    <Counter label="Read from board" value={formatBytes(row.counters.bytes_read)}
                             rate={row.bytesPerSecond === null ? '—'
                               : `${formatBytes(row.bytesPerSecond)}/s`} />
                    <Counter label="Sent to file" value={formatBytes(row.counters.bytes_written)} />
                  </div>

                  <div className="grid grid-cols-3 gap-2 border-t pt-3 text-sm">
                    <Problem label="FAIL blocks" value={row.counters.board_failures} />
                    <Problem label="Dropped" value={row.counters.blocks_dropped} />
                    <Problem label="Read errors" value={row.counters.comm_errors} />
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {running && rows.length === 0 && !loading && (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            The run is active but no board reported any counter yet.
          </CardContent>
        </Card>
      )}

      {diagnostics?.fail_meaning && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">What the FAIL flag means</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {diagnostics.fail_meaning}
          </CardContent>
        </Card>
      )}

      <p className="px-1 text-xs text-muted-foreground">
        Every counter is cumulative for the current run and starts again at zero with the
        next one. A dash means the installed CaenDAQ build does not report that counter.
      </p>
    </div>
  )
}

function Counter({ label, value, rate }: { label: string; value: string; rate?: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="font-mono text-base">{value}</p>
      {rate && <p className="font-mono text-xs text-muted-foreground">{rate}</p>}
    </div>
  )
}

function Problem({ label, value }: { label: string; value: number | null }) {
  const bad = (value ?? 0) > 0
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`font-mono text-base ${bad ? 'text-destructive font-semibold' : ''}`}>
        {formatCount(value)}
      </p>
    </div>
  )
}
