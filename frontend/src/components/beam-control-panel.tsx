'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Columns2,
  MoreHorizontal,
  PanelLeft,
  RefreshCw,
  Zap,
} from 'lucide-react'

import CurrentGraph from '@/components/current-graph'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ConfirmAction } from '@/components/ui/confirm-action'
import { useToast } from '@/components/ui/use-toast'
import {
  getAccumulatedCharge,
  getDataCurrent,
  getRunMetadataAll,
  getRunStartCurrent,
  getTotalAccumulatedCharge,
  resetTotalAccumulatedCharge,
} from '@/lib/api'
import { formatCharge } from '@/lib/format-charge'
import { signed } from '@/lib/run-rows'
import { RUNS_CHANGED } from '@/components/recent-runs'
import { useRunStatus } from '@/hooks/use-run-status'
import type { BeamPanelPlacement } from '@/store/visualization-settings-store'

const PLACEMENT_OPTIONS = [
  { value: 'beside-controls' as const, label: 'Next to run controls', Icon: Columns2 },
  { value: 'top' as const, label: 'Top of overview', Icon: ArrowUpToLine },
  { value: 'status' as const, label: 'Next to system status', Icon: PanelLeft },
  { value: 'below-status' as const, label: 'Below system status', Icon: ArrowDownToLine },
]

interface BeamControlPanelProps {
  placement: BeamPanelPlacement
  onPlacementChange: (placement: BeamPanelPlacement) => void
}

export function BeamControlPanel({
  placement,
  onPlacementChange,
}: BeamControlPanelProps) {
  const isRunning = useRunStatus((state) => state.isRunning)
  const runNumber = useRunStatus((state) => state.runNumber)
  const startTime = useRunStatus((state) => state.startTime)
  const unsavedRun = useRunStatus((state) => state.unsavedRun)
  const [beamCurrent, setBeamCurrent] = useState(0)
  const [runCharge, setRunCharge] = useState(0)
  const [totalCharge, setTotalCharge] = useState(0)
  // The current at the start of the running run, from the server (the run's
  // current log, or the reading taken when it started). It used to be the
  // first reading this page saw, so every reload or other device moved it.
  const [startCurrent, setStartCurrent] = useState<number | null>(null)
  // Stopped: the last run as its record says (number and stored charge). The
  // live accumulator reads 0 after a server restart, and "next run − 1" named
  // run 6 when the last run was an unfinished run 7.
  const [lastRecord, setLastRecord] = useState<{ number: number; charge: number | null; ended: boolean } | null>(null)
  const { toast } = useToast()
  // Reset total charge lives here, in this card's menu, beside the total it
  // zeroes: it used to sit right under Stop run.
  const [confirmReset, setConfirmReset] = useState(false)

  const resetTotal = async () => {
    try {
      await resetTotalAccumulatedCharge()
      setTotalCharge(0)
      toast({ title: 'Total charge reset', description: 'The lifetime accumulated charge has been reset.' })
    } catch (error) {
      console.error('Failed to reset total accumulated charge:', error)
      toast({ title: 'Error', description: 'Failed to reset total accumulated charge.', variant: 'destructive' })
    }
  }

  const updateBeamTelemetry = useCallback(async () => {
    try {
      const [current, accumulated, total] = await Promise.all([
        getDataCurrent(),
        getAccumulatedCharge(),
        getTotalAccumulatedCharge(),
      ])
      setBeamCurrent(Number(current) || 0)
      setRunCharge(Number(accumulated) || 0)
      setTotalCharge(Number(total) || 0)
    } catch (error) {
      console.error('Failed to update beam telemetry:', error)
    }
  }, [])

  useEffect(() => {
    updateBeamTelemetry()
    const interval = setInterval(updateBeamTelemetry, 1000)
    return () => clearInterval(interval)
  }, [updateBeamTelemetry])

  // The run's starting current: asked once per run, and again every few
  // seconds until the server knows it (the current log's first line is
  // written a moment after the start).
  useEffect(() => {
    setStartCurrent(null)
    if (!isRunning) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const ask = () => getRunStartCurrent()
      .then((r) => {
        if (!active) return
        if (r && typeof r.current === 'number' && Number.isFinite(r.current)) setStartCurrent(r.current)
        else timer = setTimeout(ask, 5000)
      })
      .catch(() => { if (active) timer = setTimeout(ask, 5000) })
    ask()
    return () => { active = false; if (timer) clearTimeout(timer) }
  }, [isRunning, runNumber, startTime])

  // The last run's record, read when the run state or number changes and
  // when a page says the run list changed (a Stop writes the charge).
  useEffect(() => {
    if (isRunning) return
    let active = true
    const load = () => getRunMetadataAll()
      .then((res) => {
        if (!active) return
        const rows: { run_number: number; end_time?: string | null; accumulated_charge?: number | null }[] =
          Array.isArray(res.data) ? res.data : []
        const last = rows.reduce<(typeof rows)[number] | null>(
          (best, r) => (best === null || r.run_number > best.run_number ? r : best), null)
        setLastRecord(last
          ? {
              number: last.run_number,
              charge: typeof last.accumulated_charge === 'number' ? last.accumulated_charge : null,
              ended: Boolean(last.end_time),
            }
          : null)
      })
      .catch(() => { /* keep what is shown */ })
    load()
    // The charge is stored as the run stops: read again a moment later.
    const later = setTimeout(load, 3000)
    window.addEventListener(RUNS_CHANGED, load)
    return () => {
      active = false
      clearTimeout(later)
      window.removeEventListener(RUNS_CHANGED, load)
    }
  }, [isRunning, runNumber])

  // A run just stopped here without saving has no record: its charge is the
  // live accumulator's, until the server restarts.
  const unsavedJustNow = !isRunning && unsavedRun !== null && unsavedRun === runNumber
  const beamCurrentChange = startCurrent === null ? null : beamCurrent - startCurrent

  const summary = (
    <div className="grid gap-3 rounded-lg bg-muted/35 p-3 sm:grid-cols-4">
      <div className="sm:col-span-2">
        <p className="text-xs font-medium text-muted-foreground">
          Beam current
        </p>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-3xl font-bold tabular-nums">{signed(beamCurrent, 2, false)} µA</span>
          <span className="text-xs text-muted-foreground">
            {!isRunning
              ? 'No run in progress'
              : beamCurrentChange !== null
                ? `${signed(beamCurrentChange, 2)} µA since the run started`
                : 'Current at the run start not known yet'}
          </span>
        </div>
      </div>
      <div>
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Zap className="h-3.5 w-3.5" />
          {isRunning
            ? (runNumber !== null ? `Run ${runNumber}` : 'This run')
            : unsavedJustNow
              ? `Last run (${unsavedRun}, not saved)`
              : lastRecord !== null ? `Last run (${lastRecord.number})` : 'Last run'}
        </p>
        <p className="mt-1 text-lg font-semibold tabular-nums">
          {isRunning || unsavedJustNow
            ? formatCharge(runCharge)
            : lastRecord !== null && lastRecord.charge !== null ? formatCharge(lastRecord.charge) : '—'}
        </p>
        <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
          <span className={`h-1.5 w-1.5 rounded-full ${
            isRunning ? 'bg-success' : 'bg-muted-foreground/40'
          }`} />
          {isRunning
            ? 'Integrating'
            : !unsavedJustNow && lastRecord !== null && !lastRecord.ended ? 'Never stopped properly' : 'Stopped'}
        </p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Lifetime total</p>
        <p className="mt-1 text-lg font-semibold tabular-nums">{formatCharge(totalCharge)}</p>
        <p className="mt-1 text-xs text-muted-foreground">On target, also between runs</p>
      </div>
    </div>
  )

  const headerActions = (
    <div className="flex items-center">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" aria-label="Beam control options" title="Options">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>Beam control position</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={placement}
            onValueChange={(value) => onPlacementChange(value as BeamPanelPlacement)}
          >
            {PLACEMENT_OPTIONS.map(({ value, label, Icon }) => (
              <DropdownMenuRadioItem key={value} value={value}>
                <Icon className="mr-2 h-4 w-4 text-muted-foreground" />
                {label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Maintenance</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => setConfirmReset(true)} className="text-destructive focus:text-destructive">
            <RefreshCw className="mr-2 h-4 w-4" />
            Reset lifetime total…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmAction
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Reset the lifetime charge total?"
        description={
          <p>
            The lifetime accumulated charge is set to zero and cannot be recovered.
            The charge of the current run is not affected.
          </p>
        }
        confirmLabel="Reset total charge"
        onConfirm={resetTotal}
      >
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
          Total now: <span className="font-semibold tabular-nums">{formatCharge(totalCharge)}</span>
        </p>
      </ConfirmAction>
    </div>
  )

  return (
    <CurrentGraph
      title="Beam control"
      description={null}
      summary={summary}
      headerActions={headerActions}
      compact
      className="h-full"
      fillHeight={placement === 'status'}
      // Beside the run controls the row is as tall as the controls column:
      // the chart takes that height instead of leaving the card empty below it.
      grow={placement === 'beside-controls'}
    />
  )
}
