'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { PlayCircle, StopCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ConfirmAction } from '@/components/ui/confirm-action'
import { StatusBadge } from '@/components/ui/status-badge'
import { useToast } from '@/components/ui/use-toast'
import { formatElapsed, useElapsed } from '@/components/run-status-indicator'
import { useRunStatus } from '@/hooks/use-run-status'
import { getDataCurrent, getSaveData } from '@/lib/api'
import { StopRunBody } from '@/components/stop-run-body'
import { stopRunSequence } from '@/lib/run-actions'
import { useDashboardTabStore } from '@/store/dashboard-tab-store'
import { useVisualizationStore } from '@/store/visualization-settings-store'

/** Hz → "812 Hz", "12.4 kHz", "1.20 MHz". */
export function formatRate(hz: number): string {
  if (hz >= 1e6) return `${(hz / 1e6).toFixed(2)} MHz`
  if (hz >= 1e3) return `${(hz / 1e3).toFixed(1)} kHz`
  return `${Math.round(hz)} Hz`
}

/**
 * The phone's run bar: fixed at the bottom of every page below 768 px, so the
 * run state, the total rate, the beam current and the way to Start or Stop
 * are always one thumb away (the run controls are three screens down on the
 * overview).
 *
 * - Running: Stop, behind the same confirmation as the dashboard's Stop Run,
 *   and the same stop sequence (lib/run-actions.ts).
 * - Stopped: "Start…" opens the dashboard's Run control (run name, type,
 *   saving and the overwrite check all live there), it does not start a run
 *   by itself.
 *
 * The layout mounts it (lazily) only on a phone-width screen, so it costs
 * desktops neither code nor polling.
 */
export function RunBar() {
  const { toast } = useToast()
  const router = useRouter()
  const pathname = usePathname()
  const setDashboardTab = useDashboardTabStore((s) => s.setTab)
  const { known, isRunning, startTime, runNumber, boardError, totalRate, unreachable } = useRunStatus()
  const elapsed = useElapsed(isRunning, startTime)
  const currentEnabled = useVisualizationStore((s) => s.settings.currentEnabled !== false)
  const [beam, setBeam] = useState<number | null>(null)
  const [stopping, setStopping] = useState(false)
  const [savingNow, setSavingNow] = useState<boolean | null>(null)

  useEffect(() => {
    if (!currentEnabled) { setBeam(null); return }
    let active = true
    const poll = () => getDataCurrent()
      .then((v) => { if (active) setBeam(Number(v)) })
      .catch(() => { if (active) setBeam(null) })
    poll()
    const id = setInterval(poll, 2000)
    return () => { active = false; clearInterval(id) }
  }, [currentEnabled])

  const stop = async () => {
    setStopping(true)
    try {
      const { warnings } = await stopRunSequence()
      toast({
        title: warnings.length ? 'Run stopped (with warnings)' : 'Run stopped',
        description: warnings.length ? `The DAQ is stopped, but ${warnings.join(' and ')}.` : undefined,
        variant: warnings.length ? 'destructive' : undefined,
      })
    } catch (error) {
      console.error('Failed to stop run:', error)
      toast({ title: 'The run is still going', description: 'Failed to stop the run. Please try again.', variant: 'destructive' })
    } finally {
      setStopping(false)
    }
  }

  const openRunControl = () => {
    setDashboardTab('overview')
    const onDashboard = (pathname || '').replace(/\/+$/, '') === '/dashboard'
    if (onDashboard) {
      document.getElementById('run-control')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } else {
      router.push('/dashboard#run-control')
    }
  }

  // "No answer" outranks everything: a last-known "Running" is not shown as fact.
  const state = unreachable ? 'warning' : !known ? 'unknown' : boardError && isRunning ? 'error' : isRunning ? 'running' : 'stopped'
  const label = state === 'warning' ? 'No answer' : state === 'error' ? 'CAEN Error' : undefined
  const beamText = beam !== null && Number.isFinite(beam) ? `${beam.toFixed(2)} µA` : null

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 px-3 pt-2 shadow-[0_-4px_12px_rgba(0,0,0,0.08)] backdrop-blur-sm pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      role="region"
      aria-label="Run status"
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <StatusBadge state={state} label={label} />
            {runNumber !== null && (
              isRunning ? (
                <Link href={`/logbook/${runNumber}`} className="truncate text-sm font-semibold underline-offset-2 hover:underline">
                  Run {runNumber}
                </Link>
              ) : (
                <span className="truncate text-sm text-muted-foreground">Next: run {runNumber}</span>
              )
            )}
            {isRunning && !unreachable && (
              <span className="font-mono text-sm tabular-nums">{formatElapsed(elapsed)}</span>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {unreachable
              ? `No answer from the server${isRunning ? ' (last known: running)' : ''}`
              : isRunning && totalRate !== null ? `${formatRate(totalRate)} total` : isRunning ? 'Rate …' : 'No run in progress'}
            {beamText && <> · beam {beamText}</>}
          </p>
        </div>
        {isRunning ? (
          <ConfirmAction
            trigger={
              <Button variant="destructive" className="h-11 shrink-0" disabled={stopping} aria-label="Stop the run (asks first)">
                <StopCircle className="mr-1.5 h-4 w-4" />
                Stop…
              </Button>
            }
            title={runNumber !== null ? `Stop run ${runNumber}?` : 'Stop the run?'}
            onOpenChange={(open) => {
              if (!open) return
              setSavingNow(null)
              getSaveData().then((v) => setSavingNow(Boolean(v))).catch(() => setSavingNow(null))
            }}
            description={<StopRunBody elapsed={elapsed} saving={savingNow} />}
            confirmLabel={runNumber !== null ? `Stop run ${runNumber}` : 'Stop run'}
            onConfirm={stop}
          />
        ) : (
          <Button
            variant="outline"
            className="h-11 shrink-0"
            onClick={openRunControl}
            disabled={!known}
            aria-label="Open run control to start a run"
          >
            <PlayCircle className="mr-1.5 h-4 w-4 text-success" />
            Start…
          </Button>
        )}
      </div>
    </div>
  )
}
