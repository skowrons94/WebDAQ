'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronRight, History } from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusBadge } from '@/components/ui/status-badge'
import { formatElapsed } from '@/components/run-status-indicator'
import { useRunStatus } from '@/hooks/use-run-status'
import { useRunBadge } from '@/hooks/use-run-badge'
import { getRunMetadataAll } from '@/lib/api'
import { formatRunDate, runRowNote, runRowState } from '@/lib/run-rows'

interface RunRow {
  run_number: number
  target_name?: string
  run_type?: string
  start_time?: string
  end_time?: string | null
  has_data?: boolean
  flag?: string
}

const SHOWN = 5

// Start records the run's name and type a moment after the run itself; a list
// read when isRunning flipped showed "Untitled run". Whoever writes run
// metadata says so, and the list reads again.
export const RUNS_CHANGED = 'webdaq:runs-changed'

export function notifyRunsChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(RUNS_CHANGED))
}

/**
 * The last few runs, each one click from its Logbook page (they used to be
 * reached only through the Logbook table). Re-read when a run starts or stops,
 * not on a timer: the endpoint returns every run ever taken.
 */
export function RecentRuns() {
  const isRunning = useRunStatus((s) => s.isRunning)
  const runNumber = useRunStatus((s) => s.runNumber)
  // An unsaved run has no Logbook row of its own: the row with its number is
  // an earlier run, which must not be shown as the one running.
  const saving = useRunStatus((s) => s.saving)
  // The live run is named by the header's rule: "Board failure" wins over
  // "Running", and a Tuner acquisition says "Tuning".
  const badge = useRunBadge()
  const [runs, setRuns] = useState<RunRow[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    const load = () => getRunMetadataAll()
      .then((res) => {
        if (!active) return
        const rows: RunRow[] = Array.isArray(res.data) ? res.data : []
        setRuns([...rows].sort((a, b) => b.run_number - a.run_number).slice(0, SHOWN))
        setFailed(false)
      })
      .catch(() => { if (active) setFailed(true) })
    load()
    window.addEventListener(RUNS_CHANGED, load)
    // A run started elsewhere (another browser, the Tuner) has no event here:
    // one more read a few seconds in picks up its name.
    const later = isRunning ? setTimeout(load, 5000) : undefined
    return () => {
      active = false
      window.removeEventListener(RUNS_CHANGED, load)
      if (later) clearTimeout(later)
    }
  }, [isRunning, runNumber])

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <History className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          Recent runs
        </CardTitle>
        <Link href="/logbook" className="text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          All runs in the Logbook
        </Link>
      </CardHeader>
      <CardContent className="px-2 pb-2 sm:px-3">
        {failed ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">The run list could not be loaded.</p>
        ) : runs === null ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">Loading…</p>
        ) : runs.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">No runs recorded yet.</p>
        ) : (
          <ul className="divide-y">
            {runs.map((run) => {
              const now = { isRunning, runNumber, saving }
              const live = runRowState(run, now) === 'live'
              // A run that never ended says why it has no duration.
              const note = runRowNote(run, now)
              const seconds = run.start_time && run.end_time
                ? Math.max(0, (new Date(run.end_time).getTime() - new Date(run.start_time).getTime()) / 1000)
                : null
              return (
                <li key={run.run_number}>
                  <Link
                    href={`/logbook/${run.run_number}`}
                    className="flex min-h-11 items-center gap-3 rounded-md px-2 py-2 hover:bg-muted"
                  >
                    <span className="w-16 shrink-0 font-semibold tabular-nums">Run {run.run_number}</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                      {run.target_name || 'Untitled run'}
                      {run.start_time && (
                        <span className="hidden sm:inline">
                          {' · '}{formatRunDate(run.start_time)}
                        </span>
                      )}
                    </span>
                    {live ? (
                      <StatusBadge state={badge.state} label={badge.label} title={badge.title} />
                    ) : note ? (
                      <span className="shrink-0 text-right text-xs text-warning">{note}</span>
                    ) : seconds !== null ? (
                      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                        {formatElapsed(seconds)}
                      </span>
                    ) : null}
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
