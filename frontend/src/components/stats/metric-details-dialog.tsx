"use client"

import { useEffect, useState } from 'react'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"

// Units seen most often here; typing anything else is still allowed.
const COMMON_UNITS = ['kV', 'V', 'uA', 'mA', 'A', 'counts/s', 'Hz', '%', 'C', 'mbar']

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The Graphite path being named — shown, not editable. */
  path: string
  initialName?: string
  initialUnit?: string
  /** "Add" when the metric is new, "Save" when editing an existing one. */
  mode: 'add' | 'edit'
  onSubmit: (name: string, unit: string) => void
}

/**
 * Name and unit for a metric.
 *
 * Both travel into the run's stats.csv — the name becomes the column heading
 * and the unit is written beside it — so a file can be read later without
 * anyone having to remember what "accelerator.charge" was measured in.
 */
export function MetricDetailsDialog({
  open, onOpenChange, path, initialName = '', initialUnit = '', mode, onSubmit,
}: Props) {
  const [name, setName] = useState(initialName)
  const [unit, setUnit] = useState(initialUnit)

  useEffect(() => {
    if (!open) return
    // Default the name to the last part of the path — "terminal_voltage" is a
    // better starting point than the whole dotted path.
    setName(initialName || path.split('.').pop() || path)
    setUnit(initialUnit)
  }, [open, path, initialName, initialUnit])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === 'add' ? 'Add metric' : 'Edit metric'}</DialogTitle>
          <DialogDescription className="break-all font-mono text-xs">{path}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="metric-name">Name</Label>
            <Input
              id="metric-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Terminal Voltage"
              onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) onSubmit(name.trim(), unit.trim()) }}
            />
            <p className="text-xs text-muted-foreground">
              Shown on the card and used as the column heading in the run&apos;s stats.csv.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="metric-unit">Unit</Label>
            <Input
              id="metric-unit"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              placeholder="kV (optional)"
              onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) onSubmit(name.trim(), unit.trim()) }}
            />
            <div className="flex flex-wrap gap-1 pt-1">
              {COMMON_UNITS.map(u => (
                <Button
                  key={u}
                  type="button"
                  variant={unit === u ? 'default' : 'outline'}
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => setUnit(unit === u ? '' : u)}
                >
                  {u}
                </Button>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!name.trim()} onClick={() => onSubmit(name.trim(), unit.trim())}>
            {mode === 'add' ? 'Add metric' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
