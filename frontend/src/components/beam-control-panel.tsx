'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Columns2,
  PanelLeft,
  PanelsTopLeft,
  Zap,
} from 'lucide-react'

import CurrentGraph from '@/components/current-graph'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  getAccumulatedCharge,
  getDataCurrent,
  getTotalAccumulatedCharge,
} from '@/lib/api'
import useRunControlStore from '@/store/run-control-store'
import type { BeamPanelPlacement } from '@/store/visualization-settings-store'

const PLACEMENT_OPTIONS = [
  { value: 'beside-controls' as const, label: 'Next to run controls', Icon: Columns2 },
  { value: 'top' as const, label: 'Top of overview', Icon: ArrowUpToLine },
  { value: 'status' as const, label: 'Next to system status', Icon: PanelLeft },
  { value: 'below-status' as const, label: 'Below system status', Icon: ArrowDownToLine },
]

const formatCharge = (microCoulombs: number): string => {
  const value = Number.isFinite(microCoulombs) ? microCoulombs : 0
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} C`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(2)} mC`
  return `${value.toFixed(2)} uC`
}

interface BeamControlPanelProps {
  placement: BeamPanelPlacement
  onPlacementChange: (placement: BeamPanelPlacement) => void
}

export function BeamControlPanel({
  placement,
  onPlacementChange,
}: BeamControlPanelProps) {
  const isRunning = useRunControlStore((state) => state.isRunning)
  const [beamCurrent, setBeamCurrent] = useState(0)
  const [beamCurrentChange, setBeamCurrentChange] = useState(0)
  const [runCharge, setRunCharge] = useState(0)
  const [totalCharge, setTotalCharge] = useState(0)
  const runStartCurrentRef = useRef<number | null>(null)

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
          <span className="text-3xl font-bold tabular-nums">{beamCurrent.toFixed(2)} uA</span>
          <span className="text-xs text-muted-foreground">
            {isRunning
              ? `${beamCurrentChange >= 0 ? '+' : ''}${beamCurrentChange.toFixed(2)} uA since start`
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
            isRunning ? 'bg-green-500' : 'bg-muted-foreground/40'
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
          <Button variant="outline" size="sm" className="gap-2">
            <PanelsTopLeft className="h-4 w-4" />
            <span>Position</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>Beam Control position</DropdownMenuLabel>
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
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )

  return (
    <CurrentGraph
      title="Beam Control"
      description={null}
      summary={summary}
      headerActions={headerActions}
      compact
      className="h-full"
      fillHeight={placement === 'status'}
    />
  )
}
