'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronRight, History } from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusBadge } from '@/components/ui/status-badge'
import { formatElapsed } from '@/components/run-status-indicator'
import { useRunStatus } from '@/hooks/use-run-status'
import { getRunMetadataAll } from '@/lib/api'

interface RunRow {
  run_number: number
  target_name?: string
  run_type?: string
  start_time?: string
  end_time?: string | null
  flag?: string
}

const SHOWN = 5

/**
 * The last few runs, each one click from its Logbook page (they used to be
 * reached only through the Logbook table). Re-read when a run starts or stops,
 * not on a timer: the endpoint returns every run ever taken.
 */
export function RecentRuns() {
  const isRunning = useRunStatus((s) => s.isRunning)
  const runNumber = useRunStatus((s) => s.runNumber)
  const [runs, setRuns] = useState<RunRow[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    getRunMetadataAll()
      .then((res) => {
        if (!active) return
        const rows: RunRow[] = Array.isArray(res.data) ? res.data : []
        setRuns([...rows].sort((a, b) => b.run_number - a.run_number).slice(0, SHOWN))
        setFailed(false)
      })
      .catch(() => { if (active) setFailed(true) })
    return () => { active = false }
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
              const live = !run.end_time && isRunning && run.run_number === runNumber
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
                          {' · '}{new Date(run.start_time).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                        </span>
                      )}
                    </span>
                    {live ? (
                      <StatusBadge state="running" label="Running" />
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
