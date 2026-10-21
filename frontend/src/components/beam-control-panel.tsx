'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
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
  getTotalAccumulatedCharge,
  resetTotalAccumulatedCharge,
} from '@/lib/api'
import { formatCharge } from '@/lib/format-charge'
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
  const [beamCurrent, setBeamCurrent] = useState(0)
  const [beamCurrentChange, setBeamCurrentChange] = useState(0)
  const [runCharge, setRunCharge] = useState(0)
  const [totalCharge, setTotalCharge] = useState(0)
  const runStartCurrentRef = useRef<number | null>(null)
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
      const currentValue = Number(current) || 0
      setBeamCurrent(currentValue)
      setRunCharge(Number(accumulated) || 0)
      setTotalCharge(Number(total) || 0)

      if (isRunning) {
        if (runStartCurrentRef.current === null) {
          runStartCurrentRef.current = currentValue
        }
        setBeamCurrentChange(currentValue - runStartCurrentRef.current)
      } else {
        runStartCurrentRef.current = null
        setBeamCurrentChange(0)
      }
    } catch (error) {
      console.error('Failed to update beam telemetry:', error)
    }
  }, [isRunning])

  useEffect(() => {
    updateBeamTelemetry()
    const interval = setInterval(updateBeamTelemetry, 1000)
    return () => clearInterval(interval)
  }, [updateBeamTelemetry])

  const summary = (
    <div className="grid gap-3 rounded-lg bg-muted/35 p-3 sm:grid-cols-4">
      <div className="sm:col-span-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Beam current
        </p>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-3xl font-bold tabular-nums">{beamCurrent.toFixed(2)} µA</span>
          <span className="text-xs text-muted-foreground">
            {isRunning
              ? `${beamCurrentChange >= 0 ? '+' : ''}${beamCurrentChange.toFixed(2)} µA since start`
              : 'No run in progress'}
          </span>
        </div>
      </div>
      <div>
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Zap className="h-3.5 w-3.5" />
          This run
        </p>
        <p className="mt-1 text-lg font-semibold tabular-nums">{formatCharge(runCharge)}</p>
        <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
          <span className={`h-1.5 w-1.5 rounded-full ${
            isRunning ? 'bg-success' : 'bg-muted-foreground/40'
          }`} />
          {isRunning ? 'Integrating' : 'Paused'}
        </p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Lifetime total</p>
        <p className="mt-1 text-lg font-semibold tabular-nums">{formatCharge(totalCharge)}</p>
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
    />
  )
}
