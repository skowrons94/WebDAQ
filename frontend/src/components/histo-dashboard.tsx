"use client"

import { ConfirmAction } from '@/components/ui/confirm-action'
import { useState, useEffect, useMemo, useRef, useCallback } from "react"
import { getBoardConfiguration, getExperimentStats, getHistogram, setRebinFactor } from "@/lib/api"
import { useRunStatus } from "@/hooks/use-run-status"
import { pickChannel, type ChannelRates } from "@/components/tuner/use-channel-rates"
// The dashboard's configuration lives on the DAQ server (conf/histograms.json).
// These are the only definitions of ROI and HistogramConfig — see
// lib/histogram-config.ts for why there used to be three.
import {
  type DashboardSettings,
  type HistogramConfig,
  type ROI,
  roiKey,
} from "@/lib/histogram-config"
import useHistogramStore from "@/store/histogram-store"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useToast } from "@/components/ui/use-toast"
import { loadJSROOT } from "@/lib/load-jsroot"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useTheme } from "next-themes"
import { Settings, Grid2X2, Rows2, Plus, RotateCcw, Edit, Trash2, Save, Eye, EyeOff, Crosshair, Maximize2, Minimize2, GripVertical, ZoomIn, ListChecks, Scan, AlertTriangle } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { Slider } from "@/components/ui/slider"
import {
  DndContext, 
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import {
  useSortable,
} from '@dnd-kit/sortable'
import {CSS} from '@dnd-kit/utilities'

type ChannelStats = ChannelRates & { trigger?: number; energyWarning?: string }

function formatRate(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return "—"
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)} MHz`
  if (v >= 1e3) return `${(v / 1e3).toFixed(2)} kHz`
  return `${v.toFixed(v < 10 ? 1 : 0)} Hz`
}

/** One labelled number of the stats line on top of a histogram. */
function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono tabular-nums ${warn ? "text-amber-600 dark:text-amber-400" : ""}`}>{value}</span>
    </span>
  )
}

// Sortable Histogram Card Component
const SortableHistogramCard = ({
  config, roiIntegrals, stats, counts, running, expanded,
  onAddROI, onROIFromView, onEditHistogram, onEditROI, onToggleExpand, onHide,
  onZoomToROI, onToggleROI, dashboardSettings, getHistogramSize, histogramRefs,
}: {
  config: HistogramConfig
  roiIntegrals: { [key: string]: number }
  stats: ChannelStats | null
  counts: number | undefined
  running: boolean
  expanded: boolean
  onAddROI: (id: string) => void
  onROIFromView: (id: string) => void
  onEditHistogram: (config: HistogramConfig) => void
  onEditROI: (histogramId: string, roi: ROI) => void
  onToggleExpand: (id: string) => void
  onHide: (id: string) => void
  onZoomToROI: (histogramId: string, roi: ROI) => void
  onToggleROI: (histogramId: string, roi: ROI) => void
  dashboardSettings: DashboardSettings
  getHistogramSize: (size: "small" | "medium" | "large") => string
  histogramRefs: React.MutableRefObject<{ [key: string]: HTMLDivElement | null }>
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({id: config.id, disabled: expanded})

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }
  const pileupShare = stats && stats.event > 0 ? stats.pileup / stats.event : 0

  return (
    <Card ref={setNodeRef} style={style}
          className={`relative ${isDragging ? 'z-50' : ''} ${expanded ? 'md:col-span-2 lg:col-span-full' : ''}`}>
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 p-3 pb-2">
        <div className="min-w-0 space-y-1">
          <CardTitle className="text-base font-semibold leading-tight flex items-center gap-1.5">
            {!expanded && (
              <span
                {...attributes}
                {...listeners}
                className="cursor-grab active:cursor-grabbing rounded p-0.5 text-muted-foreground hover:bg-muted"
                title="Drag to reorder"
              >
                <GripVertical className="h-4 w-4" />
              </span>
            )}
            <span className="truncate">{config.label}</span>
          </CardTitle>
          {/* What the channel is doing, so a quiet or saturated detector shows
              without opening the run statistics. */}
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
            {running && stats ? (
              <>
                <Stat label="Rate" value={formatRate(stats.event)} />
                {stats.trigger !== undefined && <Stat label="Triggers" value={formatRate(stats.trigger)} />}
                <Stat label="Pile-up" value={formatRate(stats.pileup)} warn={pileupShare > 0.1} />
                <Stat label="Lost" value={formatRate(stats.lost)} warn={stats.lost > 0 && stats.lost >= 0.1 * stats.event} />
                {stats.satu > 0 && <Stat label="Saturated" value={formatRate(stats.satu)} warn />}
              </>
            ) : (
              <span className="text-muted-foreground">{running ? "No rates for this channel" : "No run"}</span>
            )}
            <Stat label="Counts" value={counts === undefined ? "—" : Math.round(counts).toLocaleString()} />
          </div>
          {running && stats?.energyWarning && (
            <p className="flex items-start gap-1 text-xs text-warning" role="status">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
              {stats.energyWarning}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onROIFromView(config.id)}
                  title="Add an ROI over the visible range (zoom on the peak first)" aria-label={`Add an ROI from the view of ${config.label}`}>
            <Crosshair className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onToggleExpand(config.id)}
                  title={expanded ? "Back to the grid" : "Enlarge, with the ROI table"} aria-label={expanded ? `Shrink ${config.label}` : `Enlarge ${config.label}`}>
            {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onEditHistogram(config)}
                  title="Edit histogram" aria-label={`Edit ${config.label}`}>
            <Edit className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onHide(config.id)}
                  title="Hide (show it again from the channel list)" aria-label={`Hide ${config.label}`}>
            <EyeOff className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="p-3 pt-0">
        {/* Chart with ROI legend overlay so card height is independent of ROI count */}
        <div className="relative w-full">
          <div
            ref={(el) => {
              histogramRefs.current[config.id] = el
            }}
            className={`w-full ${expanded ? "h-[65vh]" : `${getHistogramSize(config.size)} max-md:h-auto max-md:aspect-[4/3]`} rounded-md border bg-background`}
          />

          {!expanded && dashboardSettings.showROIs && config.rois.filter((r) => r.enabled).length > 0 && (
            <div className="pointer-events-none absolute top-2 left-2 right-2 z-10 flex justify-end">
              <div className="pointer-events-auto max-h-[60%] overflow-y-auto rounded-md border border-border/40 bg-background/85 backdrop-blur-sm px-2 py-1.5 shadow-sm text-xs space-y-0.5 max-w-[60%]">
                {config.rois
                  .filter((r) => r.enabled)
                  .map((roi) => {
                    const value = roiIntegrals[roiKey(config.id, roi.id)] ?? 0
                    return (
                      <button
                        key={roi.id}
                        type="button"
                        onClick={() => onEditROI(config.id, roi)}
                        className="flex w-full items-center gap-2 rounded px-1 py-0.5 hover:bg-muted/60 transition-colors text-left"
                        title={`Edit ${roi.name} (range ${roi.low}–${roi.high})`}
                      >
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-sm shrink-0"
                          style={{ backgroundColor: roi.color }}
                        />
                        <span className="font-medium truncate">{roi.name}</span>
                        {dashboardSettings.showIntegrals && (
                          <span className="ml-auto font-mono tabular-nums text-muted-foreground">
                            {value.toFixed(0)}
                          </span>
                        )}
                      </button>
                    )
                  })}
              </div>
            </div>
          )}
        </div>

        {/* Enlarged: every ROI of this histogram, to read, zoom to, switch off or edit. */}
        {expanded && (
          <div className="mt-3">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-semibold">Regions of interest</h4>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => onROIFromView(config.id)}>
                  <Crosshair className="h-4 w-4 mr-1.5" />From the view
                </Button>
                <Button variant="outline" size="sm" onClick={() => onAddROI(config.id)}>
                  <Plus className="h-4 w-4 mr-1.5" />By range
                </Button>
              </div>
            </div>
            {config.rois.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No ROI yet. Zoom on a peak (drag along the x axis) and use “From the view”.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    <th className="text-left py-1.5 font-medium">Name</th>
                    <th className="text-right py-1.5 font-medium">Range</th>
                    <th className="text-right py-1.5 font-medium">Counts</th>
                    <th className="py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  {config.rois.map((roi) => (
                    <tr key={roi.id} className={`border-b last:border-0 ${roi.enabled ? "" : "text-muted-foreground"}`}>
                      <td className="py-1.5">
                        <span className="inline-flex items-center gap-2">
                          <span className="inline-block h-3 w-3 rounded-sm" style={{ backgroundColor: roi.color }} />
                          {roi.name}
                        </span>
                      </td>
                      <td className="py-1.5 text-right font-mono tabular-nums">{roi.low} – {roi.high}</td>
                      <td className="py-1.5 text-right font-mono tabular-nums">
                        {roi.enabled ? (roiIntegrals[roiKey(config.id, roi.id)] ?? 0).toFixed(0) : "off"}
                      </td>
                      <td className="py-1.5 text-right whitespace-nowrap">
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onZoomToROI(config.id, roi)}
                                title="Zoom to this ROI" aria-label={`Zoom to ${roi.name}`}>
                          <ZoomIn className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onToggleROI(config.id, roi)}
                                title={roi.enabled ? "Switch off" : "Switch on"} aria-label={`${roi.enabled ? "Switch off" : "Switch on"} ${roi.name}`}>
                          {roi.enabled ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onEditROI(config.id, roi)}
                                title="Edit" aria-label={`Edit ${roi.name}`}>
                          <Edit className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * Every channel of every board, as chips: one click shows or hides its
 * histogram, so a full board is two clicks instead of sixteen dialogs. During a
 * run each chip carries the channel's rate, which tells which inputs are alive.
 */
function ChannelBrowser({ boards, histograms, statsFor, running, onToggle, onBoard }: {
  boards: BoardData[]
  histograms: HistogramConfig[]
  statsFor: (boardId: string, channel: number) => ChannelStats | null
  running: boolean
  onToggle: (boardId: string, channel: number) => void
  onBoard: (boardId: string, show: boolean) => void
}) {
  if (boards.length === 0) return null
  return (
    <Card className="mb-4">
      <CardContent className="p-3 space-y-3">
        {boards.map((board) => {
          const n = Number(board.chan) || 0
          return (
            <div key={board.id} className="flex flex-col gap-2 sm:flex-row sm:items-start">
              <div className="flex items-center gap-2 sm:w-56 sm:shrink-0">
                <span className="text-sm font-medium truncate">{board.name} <span className="text-muted-foreground">#{board.id}</span></span>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onBoard(board.id, true)}>All</Button>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onBoard(board.id, false)}>None</Button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {Array.from({ length: n }, (_, ch) => {
                  const shown = histograms.some((h) => h.boardId === board.id && h.channel === ch && h.visible)
                  const st = running ? statsFor(board.id, ch) : null
                  const alive = !!st && st.event > 0
                  return (
                    <button
                      key={ch}
                      type="button"
                      onClick={() => onToggle(board.id, ch)}
                      aria-pressed={shown}
                      title={`${shown ? "Hide" : "Show"} board ${board.id} channel ${ch}`}
                      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors ${
                        shown ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-muted"
                      }`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${alive ? "bg-green-500" : "bg-muted-foreground/40"}`} />
                      Ch {ch}
                      {st && <span className="font-mono tabular-nums opacity-80">{formatRate(st.event)}</span>}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

// Types
type BoardData = {
  id: string
  name: string
  vme: string
  link_type: string
  link_num: string
  dpp: string
  chan: string
}

// ROOT color palette presets. The hex values are the exact ones convertColorToRoot
// recognizes — keeping the picker locked to this list guarantees ROI overlays render
// in the right ROOT color (otherwise the converter falls back to red).
const ROOT_COLOR_PRESETS: { hex: string; name: string; index: number }[] = [
  { hex: "#ff0000", name: "Red", index: 2 },
  { hex: "#0000ff", name: "Blue", index: 4 },
  { hex: "#00ff00", name: "Green", index: 3 },
  { hex: "#ff7f00", name: "Orange", index: 8 },
  { hex: "#7f00ff", name: "Violet", index: 9 },
  { hex: "#ffff00", name: "Yellow", index: 5 },
  { hex: "#ff00ff", name: "Magenta", index: 6 },
  { hex: "#00ffff", name: "Cyan", index: 7 },
  { hex: "#800000", name: "Maroon", index: 12 },
  { hex: "#008000", name: "Dark Green", index: 13 },
  { hex: "#000080", name: "Navy", index: 14 },
  { hex: "#7f7f00", name: "Olive", index: 15 },
  { hex: "#007f7f", name: "Teal", index: 16 },
  { hex: "#800080", name: "Purple", index: 17 },
  { hex: "#7f7f7f", name: "Gray", index: 10 },
  { hex: "#000000", name: "Black", index: 1 },
]

type HistogramDialogProps = {
  isOpen: boolean
  onClose: () => void
  histogram: HistogramConfig | null
  /** The id is absent when creating: the server assigns it. */
  onSave: (config: Partial<HistogramConfig> & { id?: string }) => void
  onDelete?: (id: string) => void
  boards: BoardData[]
}

type ROIDialogProps = {
  isOpen: boolean
  onClose: () => void
  histogramId: string
  roi: ROI | null
  /** The id is absent when creating: the server assigns it. */
  onSave: (histogramId: string, roi: Partial<ROI> & { id?: string }) => void
  onDelete?: (histogramId: string, roiId: string) => void
}

// ROI Management Dialog
const ROIDialog = ({ isOpen, onClose, histogramId, roi, onSave, onDelete }: ROIDialogProps) => {
  const [name, setName] = useState(roi?.name || "New ROI")
  const [low, setLow] = useState(roi?.low || 0)
  const [high, setHigh] = useState(roi?.high || 100)
  const [color, setColor] = useState(roi?.color || "#ff0000")
  const [enabled, setEnabled] = useState(roi?.enabled ?? true)

  useEffect(() => {
    if (roi) {
      setName(roi.name)
      setLow(roi.low)
      setHigh(roi.high)
      setColor(roi.color)
      setEnabled(roi.enabled)
    } else {
      setName("New ROI")
      setLow(0)
      setHigh(100)
      setColor("#ff0000")
      setEnabled(true)
    }
  }, [roi])

  const handleSave = () => {
    // Only the definition. Integrals and rates are measurements the server
    // reports, not fields of the stored ROI.
    onSave(histogramId, { id: roi?.id, name, low, high, color, enabled })
    onClose()
  }

  const handleDelete = () => {
    if (roi && onDelete) {
      onDelete(histogramId, roi.id)
      onClose()
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{roi ? "Edit ROI" : "Add New ROI"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="roi-name">ROI Name</Label>
            <Input id="roi-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="roi-low">Low value</Label>
              <Input id="roi-low" type="number" value={low} onChange={(e) => setLow(Number(e.target.value))} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="roi-high">High value</Label>
              <Input id="roi-high" type="number" value={high} onChange={(e) => setHigh(Number(e.target.value))} />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label>Color (ROOT palette)</Label>
            <div className="grid grid-cols-8 gap-2">
              {ROOT_COLOR_PRESETS.map((preset) => {
                const selected = color.toLowerCase() === preset.hex.toLowerCase()
                return (
                  <button
                    key={preset.hex}
                    type="button"
                    onClick={() => setColor(preset.hex)}
                    title={`${preset.name} · ROOT color ${preset.index}`}
                    aria-label={preset.name}
                    aria-pressed={selected}
                    className={`h-7 w-7 rounded-md border transition shadow-sm ${
                      selected
                        ? "ring-2 ring-offset-1 ring-foreground border-foreground"
                        : "border-border/40 hover:border-foreground/60"
                    }`}
                    style={{ backgroundColor: preset.hex }}
                  />
                )
              })}
            </div>
            <p className="text-xs text-muted-foreground font-mono">
              {ROOT_COLOR_PRESETS.find((p) => p.hex.toLowerCase() === color.toLowerCase())?.name ??
                color}
            </p>
          </div>
          <div className="flex items-center space-x-2">
            <Checkbox
              id="roi-enabled"
              checked={enabled}
              onCheckedChange={(checked) => setEnabled(checked as boolean)}
            />
            <Label htmlFor="roi-enabled">Enabled</Label>
          </div>
        </div>
        <DialogFooter>
          <div className="flex justify-between w-full">
            <div>
              {roi && onDelete && (
                <ConfirmAction
                  trigger={
                    <Button variant="destructive">
                      <Trash2 className="h-4 w-4 mr-2" />
                      Delete
                    </Button>
                  }
                  title={`Delete the ROI "${roi.name}"?`}
                  description={<p>The region and its integral leave this histogram and the overview cards. The spectrum is not affected.</p>}
                  confirmLabel="Delete ROI"
                  onConfirm={handleDelete}
                />
              )}
            </div>
            <div className="flex gap-2">
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
              <Button onClick={handleSave}>
                <Save className="h-4 w-4 mr-2" />
                Save
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Histogram Configuration Dialog
const HistogramDialog = ({ isOpen, onClose, histogram, onSave, onDelete, boards }: HistogramDialogProps) => {
  const [boardId, setBoardId] = useState(histogram?.boardId || "")
  const [channel, setChannel] = useState(histogram?.channel || 0)
  const [size, setSize] = useState(histogram?.size || "medium")
  const [customLabel, setCustomLabel] = useState(histogram?.customLabel || "")
  const [visible, setVisible] = useState(histogram?.visible ?? true)

  useEffect(() => {
    if (histogram) {
      setBoardId(histogram.boardId)
      setChannel(histogram.channel)
      setSize(histogram.size)
      setCustomLabel(histogram.customLabel || "")
      setVisible(histogram.visible)
    } else {
      setBoardId("")
      setChannel(0)
      setSize("medium")
      setCustomLabel("")
      setVisible(true)
    }
  }, [histogram])

  const handleSave = () => {
    if (!boardId) return

    // Only what this dialog edits. Id, order, zoom and ROIs are the server's —
    // sending them back would let a stale dialog undo an ROI added since it opened.
    onSave({
      id: histogram?.id,
      boardId,
      channel,
      size,
      label: customLabel || `Board ${boardId} - Channel ${channel}`,
      customLabel,
      visible,
    })
    onClose()
  }

  const handleDelete = () => {
    if (histogram && onDelete) {
      onDelete(histogram.id)
      onClose()
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{histogram ? "Edit Histogram" : "Add New Histogram"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="board-select">Board</Label>
            <Select value={boardId} onValueChange={setBoardId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a board" />
              </SelectTrigger>
              <SelectContent>
                {boards.map((board) => (
                  <SelectItem key={board.id} value={board.id}>
                    {board.name} (ID: {board.id})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="channel-select">Channel</Label>
            <Input
              id="channel-select"
              type="number"
              min="0"
              max={
                boards.find((b) => String(b.id) === String(boardId))?.chan
                  ? Number(boards.find((b) => String(b.id) === String(boardId))!.chan) - 1
                  : 0
              }
              value={channel}
              onChange={(e) => setChannel(Number(e.target.value))}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="size-select">Size</Label>
            <Select value={size} onValueChange={(value) => setSize(value as "small" | "medium" | "large")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="small">Small</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="large">Large</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="custom-label">Custom label</Label>
            <Input
              id="custom-label"
              value={customLabel}
              onChange={(e) => setCustomLabel(e.target.value)}
              placeholder="Enter custom label (optional)"
            />
          </div>

          <div className="flex items-center space-x-2">
            <Checkbox id="visible" checked={visible} onCheckedChange={(checked) => setVisible(checked as boolean)} />
            <Label htmlFor="visible">Visible</Label>
          </div>
        </div>
        <DialogFooter>
          <div className="flex justify-between w-full">
            <div>
              {histogram && onDelete && (
                <ConfirmAction
                  trigger={
                    <Button variant="destructive">
                      <Trash2 className="h-4 w-4 mr-2" />
                      Delete
                    </Button>
                  }
                  title={`Delete the histogram "${histogram.label}"?`}
                  description={<p>The plot and all its ROIs are removed from the dashboard. The data being acquired is not affected; the histogram can be added again.</p>}
                  confirmLabel="Delete histogram"
                  onConfirm={handleDelete}
                />
              )}
            </div>
            <div className="flex gap-2">
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
              <Button onClick={handleSave} disabled={!boardId}>
                <Save className="h-4 w-4 mr-2" />
                Save
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Main Enhanced Dashboard Component
/**
 * Axis titles for a spectrum: "Energy (keV)" on a calibrated axis, "ADC channel"
 * on a raw one (an uncalibrated spectrum spans 0 … 2^n channels, rebinned or
 * not), and "Counts / bin". Bigger tick labels on a narrow (phone) canvas: at
 * JSROOT's default they were about 7 px.
 */
function labelHistogramAxes(histogram: any, showTitles: boolean, widthPx: number, heightPx = 0) {
  const x = histogram?.fXaxis
  const y = histogram?.fYaxis
  if (!x || !y) return
  const xmax = Number(x.fXmax)
  const raw = Number(x.fXmin) === 0 && Number.isInteger(xmax) && xmax >= 256 && (xmax & (xmax - 1)) === 0
  x.fTitle = showTitles ? (x.fTitle || (raw ? "ADC channel" : "Energy (keV)")) : ""
  y.fTitle = showTitles ? (y.fTitle || "Counts / bin") : ""
  const narrow = widthPx > 0 && widthPx < 520
  // JSROOT sizes text as a fraction of the pad height, so a tall (enlarged)
  // pad would get huge labels: aim at a fixed pixel size instead.
  const frac = (px: number, fallback: number) =>
    heightPx > 0 ? Math.min(0.06, Math.max(0.018, px / heightPx)) : fallback
  for (const axis of [x, y]) {
    axis.fLabelSize = frac(narrow ? 15 : 13, narrow ? 0.045 : 0.03)
    axis.fTitleSize = frac(narrow ? 15 : 14, narrow ? 0.045 : 0.035)
  }
  x.fTitleOffset = 1.2
  y.fTitleOffset = 1.5
}

/**
 * --chart-1 ("220 70% 50%") as "rrggbb", or null when it cannot be read.
 * JSROOT's dark mode inverts the whole SVG (filter: invert(100%)), so there
 * the colour is passed pre-inverted and shows as the dark theme's token.
 */
function seriesHex(inverted = false): string | null {
  if (typeof window === "undefined") return null
  const v = getComputedStyle(document.documentElement).getPropertyValue("--chart-1").trim()
  const m = v.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/)
  if (!m) return null
  const h = Number(m[1]) / 360, sat = Number(m[2]) / 100, l = Number(m[3]) / 100
  const f = (n: number) => {
    const k = (n + h * 12) % 12
    const a = sat * Math.min(l, 1 - l)
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    const v = Math.round(c * 255)
    return (inverted ? 255 - v : v).toString(16).padStart(2, "0")
  }
  return `${f(0)}${f(8)}${f(4)}`
}

export default function EnhancedHistogramDashboard() {
  const [boards, setBoards] = useState<BoardData[]>([])
  const [jsrootLoaded, setJsrootLoaded] = useState(false)

  // Configuration comes from the server, through the store. Nothing about which
  // histograms exist, their ROIs or their zooms is owned by this component any
  // more — it renders them and asks the store to change them.
  const histograms = useHistogramStore((state) => state.histograms)
  const dashboardSettings = useHistogramStore((state) => state.settings)
  const storeIntegrals = useHistogramStore((state) => state.integrals)
  const configLoaded = useHistogramStore((state) => state.loaded)
  const loadConfig = useHistogramStore((state) => state.load)
  const refreshIntegrals = useHistogramStore((state) => state.refreshIntegrals)
  const histogramsRef = useRef<HistogramConfig[]>([])

  // The card wants a plain number per ROI; `net` is gross minus background once
  // an estimator exists, and equals gross until then.
  const roiIntegrals = useMemo(() => {
    const map: { [key: string]: number } = {}
    for (const [key, result] of Object.entries(storeIntegrals)) map[key] = result.net
    return map
  }, [storeIntegrals])

  // Dialog states
  const [histogramDialogOpen, setHistogramDialogOpen] = useState(false)
  const [roiDialogOpen, setRoiDialogOpen] = useState(false)
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false)
  const [selectedHistogram, setSelectedHistogram] = useState<HistogramConfig | null>(null)
  const [selectedROI, setSelectedROI] = useState<{ histogramId: string; roi: ROI | null }>({
    histogramId: "",
    roi: null,
  })

  // JSROOT refs - proper canvas approach
  const histogramRefs = useRef<{ [key: string]: HTMLDivElement | null }>({})
  const canvasObjects = useRef<{ [key: string]: any }>({})
  const histogramPainters = useRef<{ [key: string]: any }>({})
  // The element each painter draws into. A card hidden and shown again gets a
  // new element; a painter bound to the old one must not be reused.
  const painterElements = useRef<{ [key: string]: HTMLDivElement | null }>({})
  // A zoom scheduled on a fresh painter but not applied yet: a rebuild in that
  // window carries it over instead of losing it.
  const pendingZoom = useRef<{ [key: string]: { xmin: number; xmax: number } | null }>({})
  // Channels whose add/show/hide is waiting for the server (no double adds).
  const pendingChannels = useRef<Set<string>>(new Set())
  // Per-histogram serialization. Each histogram has a chain so updates run in order;
  // a queued bit collapses redundant in-flight requests, and pendingForce carries the
  // forceRebuild flag forward across coalesced calls.
  const updateChain = useRef<{ [key: string]: { promise: Promise<void>; queued: boolean } }>({})
  const pendingForce = useRef<{ [key: string]: boolean }>({})

  // Update interval ref to properly manage the interval
  const updateIntervalRef = useRef<NodeJS.Timeout | null>(null)

  // Live channel rates (one /experiment/stats poll for every card) and each
  // histogram's entry count, refreshed with the spectra.
  const running = useRunStatus((st) => st.isRunning)
  const [runStats, setRunStats] = useState<unknown>(null)
  const entriesRef = useRef<{ [id: string]: number }>({})
  const [entries, setEntries] = useState<{ [id: string]: number }>({})
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [browserOpen, setBrowserOpen] = useState(true)

  // Keep ref in sync so callbacks can read latest histograms without stale closures
  useEffect(() => {
    histogramsRef.current = histograms
  }, [histograms])

  const { toast } = useToast()
  // resolvedTheme, not theme: with the OS theme ("system") theme is neither
  // "light" nor "dark", and the canvases stayed white on a dark page.
  const { resolvedTheme: theme } = useTheme()

  // Drag and drop sensors
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  // Load saved settings and histograms
  useEffect(() => {
    const initializeApp = async () => {
      // One request for the whole dashboard, instead of three cache round trips.
      await loadConfig()
      // The spy manager's rebin has to match what the stored settings say, or the
      // first integrals come back binned differently from the spectra on screen.
      setRebinFactor(useHistogramStore.getState().settings.rebinFactor)
        .catch((error) => console.error("Failed to apply the rebin factor:", error))
      await fetchBoardConfiguration()
    }

    initializeApp()

    loadJSROOT()
      .then(() => setJsrootLoaded(true))
      .catch((error) => {
        console.error("Failed to load JSROOT:", error)
        toast({
          title: "Error",
          description: "Failed to load JSROOT. Some features may not work correctly.",
          variant: "destructive",
        })
      })

  }, [])

  // Initialize histograms when JSROOT loads
  useEffect(() => {
    if (jsrootLoaded && histograms.length > 0) {
      histograms.forEach((config) => {
        if (!config.visible) return
        const el = histogramRefs.current[config.id]
        if (histogramPainters.current[config.id] && painterElements.current[config.id] !== el) {
          forgetPainter(config.id)
        }
        if (!histogramPainters.current[config.id]) initializeHistogram(config)
      })
    }
  }, [jsrootLoaded, histograms])

  // Auto-update histograms and ROI integrals. Reads from histogramsRef so ROI-integral
  // mutations don't tear down and re-create the interval each tick.
  useEffect(() => {
    if (updateIntervalRef.current) {
      clearInterval(updateIntervalRef.current)
      updateIntervalRef.current = null
    }

    // Also waits on configLoaded: ticking before the server's configuration
    // arrives would ask for the integrals of an empty dashboard.
    if (configLoaded && dashboardSettings.autoUpdate && jsrootLoaded && boards.length > 0) {
      updateIntervalRef.current = setInterval(() => {
        if (histogramsRef.current.length === 0) return
        updateAllHistograms()
      }, dashboardSettings.updateInterval)
    }

    return () => {
      if (updateIntervalRef.current) {
        clearInterval(updateIntervalRef.current)
        updateIntervalRef.current = null
      }
    }
  }, [configLoaded, jsrootLoaded, boards.length, dashboardSettings.autoUpdate, dashboardSettings.updateInterval])

  // Rates for the stats line, at the same cadence as the spectra.
  useEffect(() => {
    if (!running) { setRunStats(null); return }
    let alive = true
    const poll = () => getExperimentStats().then((s) => { if (alive) setRunStats(s) }).catch(() => {})
    poll()
    const id = setInterval(poll, Math.max(1000, dashboardSettings.updateInterval))
    return () => { alive = false; clearInterval(id) }
  }, [running, dashboardSettings.updateInterval])

  const statsFor = useCallback((boardId: string, channel: number): ChannelStats | null => {
    const base = pickChannel(runStats, boardId, channel)
    if (!base) return null
    // An SIS3316 also reports its own internal trigger count.
    const boardsArr = Array.isArray(runStats) ? (runStats as { board_id?: unknown; channels?: { channel: number; board?: unknown; trigger_rate?: number; energy_warning?: string }[] }[]) : []
    const ch = boardsArr.flatMap((b) => (b.channels ?? []).map((c) => ({ b, c })))
      .find(({ b, c }) => c.channel === channel && String(c.board ?? b.board_id) === String(boardId))?.c
    return {
      ...base,
      trigger: typeof ch?.trigger_rate === "number" ? ch.trigger_rate : undefined,
      // The server judges whether the channel's energies are usable at all.
      energyWarning: typeof ch?.energy_warning === "string" ? ch.energy_warning : undefined,
    }
  }, [runStats])

  // An enlarged (or shrunk) card changes its canvas size: tell JSROOT, which
  // keeps the zoom, so the view survives the switch.
  const lastExpanded = useRef<string | null>(null)
  useEffect(() => {
    if (!jsrootLoaded) return
    const affected = [lastExpanded.current, expandedId].filter((id): id is string => !!id)
    lastExpanded.current = expandedId
    const t = setTimeout(() => {
      // A rebuild rather than a resize: the axis text is sized for the new
      // height. The zoom is taken from the old painter and put back.
      for (const id of affected) {
        const config = histogramsRef.current.find((h) => h.id === id)
        if (config?.visible) updateHistogramData(config, undefined, { forceRebuild: true })
      }
      Object.entries(histogramRefs.current).forEach(([id, el]) => {
        if (el && !affected.includes(id)) { try { window.JSROOT.resize(el) } catch { /* not drawn yet */ } }
      })
    }, 60)
    return () => clearTimeout(t)
  }, [expandedId, jsrootLoaded])

  // JSROOT theme and font handling
  useEffect(() => {
    if (jsrootLoaded) {
      const effectiveTheme = dashboardSettings.theme === "auto" ? theme : dashboardSettings.theme
      window.JSROOT.settings.DarkMode = effectiveTheme === "dark"
      
      // Configure modern fonts and appearance
      window.JSROOT.settings.Palette = 57 // Modern color palette
      window.JSROOT.settings.OptStat = 0  // Disable stats box globally
      window.JSROOT.settings.OptTitle = 1 // Show titles
      
      // Set modern font
      if (window.JSROOT.gStyle) {
        window.JSROOT.gStyle.fTextFont = 42 // Helvetica
        window.JSROOT.gStyle.fLabelFont = 42
        window.JSROOT.gStyle.fTitleFont = 42
        window.JSROOT.gStyle.fStatFont = 42
      }
    }
  }, [jsrootLoaded, theme, dashboardSettings.theme])

  // Redraw all visible histograms when display-affecting settings change.
  // Force a rebuild because rebin changes bin count and showROIs/showLabels
  // change the canvas primitives.
  useEffect(() => {
    if (!jsrootLoaded) return
    histogramsRef.current
      .filter((h) => h.visible)
      .forEach((config) => {
        updateHistogramData(config, undefined, { forceRebuild: true })
      })
  }, [
    jsrootLoaded,
    dashboardSettings.isLogScale,
    dashboardSettings.showROIs,
    dashboardSettings.showLabels,
    dashboardSettings.showIntegrals,
    dashboardSettings.rebinFactor,
    // A theme change redraws: JSROOT's DarkMode and the series colour are
    // read when a canvas is built.
    theme,
    dashboardSettings.theme,
  ])

  // Initialize a single histogram
  const initializeHistogram = async (config: HistogramConfig) => {
    const element = histogramRefs.current[config.id]
    if (!element || !window.JSROOT || histogramPainters.current[config.id]) return

    try {
      // Load saved zoom from cache first
      const savedZoom = savedZoomFor(config.id)

      // Create histogram and draw it
      await updateHistogramData(config, savedZoom)
      // Show its count at once, not only after the first periodic refresh.
      setEntries({ ...entriesRef.current })
    } catch (error) {
      console.error(`Failed to initialize histogram ${config.id}:`, error)
    }
  }

  // Update all visible histograms and ROI integrals. Reads from histogramsRef so
  // it always sees the latest state regardless of when the surrounding closure was
  // captured (the auto-update interval is created once and would otherwise hold a
  // stale histograms snapshot).
  const updateAllHistograms = async () => {
    const visibleConfigs = histogramsRef.current.filter((h) => h.visible)

    const batchSize = 10
    for (let i = 0; i < visibleConfigs.length; i += batchSize) {
      const batch = visibleConfigs.slice(i, i + batchSize)
      await Promise.all(batch.map((config) => updateHistogramData(config)))
    }

    await updateROIIntegrals()
    setEntries({ ...entriesRef.current })
  }

  // Schedule a histogram update with strict per-histogram serialization. Multiple
  // rapid calls coalesce into a single follow-up update (latest config wins), and
  // forceRebuild is preserved across the merge.
  const updateHistogramData = (
    config: HistogramConfig,
    initialZoom?: any,
    options?: { forceRebuild?: boolean },
  ): Promise<void> => {
    const id = config.id
    if (options?.forceRebuild) pendingForce.current[id] = true

    const existing = updateChain.current[id]
    // If an update is already queued behind the running one, coalesce into it.
    // The running task will read the latest config from histogramsRef when it starts.
    if (existing && existing.queued) return existing.promise

    const prev = existing?.promise ?? Promise.resolve()
    const slot: { promise: Promise<void>; queued: boolean } = { promise: null as any, queued: true }
    updateChain.current[id] = slot

    slot.promise = prev.then(async () => {
      slot.queued = false
      const force = pendingForce.current[id] === true
      pendingForce.current[id] = false
      // Always read the latest config — it may have changed (ROI added, etc.) since
      // this task was scheduled.
      const latest = histogramsRef.current.find((h) => h.id === id) ?? config
      try {
        await runHistogramUpdate(latest, initialZoom, force)
      } catch (e) {
        console.error(`Histogram update failed for ${id}:`, e)
      }
    })
    return slot.promise
  }

  // Helper: race a promise against a hard timeout so a single hung op can never
  // block the per-histogram chain forever.
  const withTimeout = <T,>(p: Promise<T>, ms: number, label: string): Promise<T> => {
    return Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
      ),
    ])
  }

  // Actual update worker. Single-flight per histogram thanks to updateChain.
  // Two paths:
  //   - REBUILD: fresh TCanvas, explicit JSROOT cleanup of the element, new painter.
  //     Used on first paint, ROI/rebin/showROIs/showLabels/log-scale changes, and any
  //     mismatch between cached primitives and current config.
  //   - FAST: same canvas, mutate the histogram primitive's data fields and refresh
  //     overlay bin contents in place; redrawPad without recreating the painter so
  //     the user's zoom is preserved.
  // Reusing the same canvas object across rebuilds caused JSROOT to reuse stale
  // internal painters and silently no-op on primitive changes — that's why ROI add
  // wouldn't show, and ROI remove could wedge the canvas. Building a brand-new
  // canvas + cleanup eliminates both.
  const runHistogramUpdate = async (
    config: HistogramConfig,
    initialZoom: any,
    forceRebuild: boolean,
  ) => {
    const element = histogramRefs.current[config.id]
    if (!element || !window.JSROOT) return
    // The interval that calls this was created once: read the settings now,
    // not from the render that created it.
    const settings = useHistogramStore.getState().settings

    const isFirstTime = !histogramPainters.current[config.id]
      || painterElements.current[config.id] !== element

    const histogramData = await withTimeout(
      getHistogram(config.boardId, config.channel.toString()),
      15000,
      `getHistogram(${config.boardId}/${config.channel})`,
    )
    // The card may have been hidden (or hidden and shown again) meanwhile:
    // never draw into an element that is no longer this card's.
    if (histogramRefs.current[config.id] !== element || !element.isConnected) return
    const histogram = window.JSROOT.parse(histogramData)
    entriesRef.current[config.id] = Number(histogram.fEntries) || 0

    // The card header names the histogram: no second title on the canvas.
    // "Show labels" now means the axis titles, with units.
    // Fallback colours when the theme token cannot be read (the draw option
    // below overrides them).
    histogram.fLineColor = 4
    histogram.fFillColor = 4
    histogram.fFillStyle = 3001
    histogram.fTitle = ""
    histogram.fName = `hist_${config.id}`
    histogram.fStats = 0
    labelHistogramAxes(histogram, settings.showLabels, element.clientWidth, element.clientHeight)

    const existingCanvas = canvasObjects.current[config.id]
    const existingHist = existingCanvas?.fPrimitives?.arr?.find(
      (p: any) => p._typename === "TH1F" || p._typename === "TH1I",
    )
    const binCountChanged =
      !!existingHist &&
      existingHist.fArray &&
      histogram.fArray &&
      existingHist.fArray.length !== histogram.fArray.length

    const expectedROIs = settings.showROIs
      ? config.rois.filter((r) => r.enabled).length
      : 0
    const currentROIs =
      existingCanvas?.fPrimitives?.arr?.filter(
        (p: any) => p?.fName && p.fName.startsWith("roi_"),
      ).length ?? 0
    const roiCountChanged = expectedROIs !== currentROIs

    const logChanged = !!existingCanvas && existingCanvas.fLogy !== (settings.isLogScale ? 1 : 0)

    const needsRebuild =
      isFirstTime || forceRebuild || binCountChanged || roiCountChanged || logChanged

    if (needsRebuild) {
      // Capture current zoom from the OLD painter before we tear it down.
      let preservedZoom: { xmin: number; xmax: number } | null = null
      if (!isFirstTime) {
        const fp = histogramPainters.current[config.id]?.getFramePainter?.()
        if (
          fp &&
          typeof fp.zoom_xmin === "number" &&
          typeof fp.zoom_xmax === "number" &&
          fp.zoom_xmin !== fp.zoom_xmax
        ) {
          preservedZoom = { xmin: fp.zoom_xmin, xmax: fp.zoom_xmax }
        }
      }

      // Explicit teardown of the previous painter so JSROOT doesn't try to reuse it.
      if (!isFirstTime) {
        try {
          window.JSROOT.cleanup(element)
        } catch (e) {
          console.warn(`JSROOT cleanup failed for ${config.id}:`, e)
        }
      }
      histogramPainters.current[config.id] = null

      // Brand-new canvas every rebuild — guarantees JSROOT actually re-renders.
      const canvas = window.JSROOT.create("TCanvas")
      canvas.fName = `canvas_${config.id}`
      canvas.fTitle = config.label
      canvas.fLogy = settings.isLogScale ? 1 : 0
      // Room for the axis titles, which the default margins clip.
      if (settings.showLabels) {
        canvas.fLeftMargin = 0.15
        canvas.fBottomMargin = 0.15
      }
      // The series colour comes from the theme's chart token (--chart-1), as a
      // JSROOT draw option: translucent fill, solid line.
      const series = seriesHex(Boolean(window.JSROOT.settings?.DarkMode))
      canvas.fPrimitives.Add(histogram, series ? `hist nostat fill_${series}55 line_${series}` : "hist nostat")
      if (settings.showROIs && config.rois.length > 0) {
        addROIOverlaysToCanvas(canvas, config, histogram)
      }
      canvasObjects.current[config.id] = canvas

      const painter: any = await withTimeout<any>(
        window.JSROOT.redraw(element, canvas),
        15000,
        `JSROOT.redraw(${config.id})`,
      )
      if (histogramRefs.current[config.id] !== element || !element.isConnected) {
        try { window.JSROOT.cleanup(element) } catch { /* already gone */ }
        return
      }
      histogramPainters.current[config.id] = painter
      painterElements.current[config.id] = element
      setupZoomPersistence(painter, config)

      const zoomToApply = preservedZoom
        ?? pendingZoom.current[config.id]
        ?? (isFirstTime ? initialZoom || config.zoom : null)
      if (zoomToApply && zoomToApply.xmin < zoomToApply.xmax) {
        pendingZoom.current[config.id] = zoomToApply
        setTimeout(() => {
          pendingZoom.current[config.id] = null
          const fp = painter.getFramePainter?.()
          // Restoring a saved zoom is not a new zoom: the unwrapped call, so it
          // is neither saved again nor copied to the others by Sync zoom.
          if (fp?.originalZoom) fp.originalZoom(zoomToApply.xmin, zoomToApply.xmax, 0, 0)
          else if (fp && fp.zoom) fp.zoom(zoomToApply.xmin, zoomToApply.xmax, 0, 0)
        }, 100)
      }
      return
    }

    // Fast path: existing canvas, same bins/ROIs/log scale. Just refresh data.
    if (!existingCanvas || !existingHist) return

    existingHist.fArray = histogram.fArray
    existingHist.fMaximum = histogram.fMaximum
    existingHist.fMinimum = histogram.fMinimum
    existingHist.fEntries = histogram.fEntries
    existingHist.fTsumw = histogram.fTsumw
    existingHist.fTsumw2 = histogram.fTsumw2
    existingHist.fTsumwx = histogram.fTsumwx
    existingHist.fTsumwx2 = histogram.fTsumwx2

    // Refresh ROI overlay bin contents so colored regions track live data.
    const xaxis = histogram.fXaxis
    if (xaxis && xaxis.fNbins) {
      const nbins: number = xaxis.fNbins
      const xmin: number = xaxis.fXmin
      const xmax: number = xaxis.fXmax
      const binWidth = (xmax - xmin) / nbins
      const enabledROIs = config.rois.filter((r) => r.enabled)
      for (const overlay of existingCanvas.fPrimitives.arr) {
        if (!overlay?.fName?.startsWith("roi_")) continue
        const roi = enabledROIs.find((r) => `roi_${r.id}` === overlay.fName)
        if (!roi) continue
        for (let i = 1; i <= nbins; i++) {
          const binCenter = xmin + (i - 0.5) * binWidth
          overlay.fArray[i] =
            binCenter >= roi.low && binCenter <= roi.high ? histogram.fArray[i] : 0
        }
      }
    }

    const painter = histogramPainters.current[config.id]
    if (painter) {
      if (painter.redrawPad) painter.redrawPad()
      else if (painter.refresh) painter.refresh()
    }
  }

  // Setup zoom persistence
  const setupZoomPersistence = (painter: any, config: HistogramConfig) => {
    const fp = painter.getFramePainter()
    if (!fp || fp.zoomConfigured) return

    fp.originalZoom = fp.zoom
    fp.zoomConfigured = true

    fp.zoom = (xmin: number, xmax: number, ymin: number, ymax: number) => {
      const result = fp.originalZoom(xmin, xmax, ymin, ymax)

      // Save zoom to cache with debouncing
      clearTimeout(fp.saveZoomTimeout)
      fp.saveZoomTimeout = setTimeout(() => {
        saveZoom(config.id, { xmin, xmax })

        // Sync zoom if enabled
        if (dashboardSettings.syncZoom) {
          syncZoomToOthers(config.id, xmin, xmax)
        }
      }, 200)

      return result
    }
  }


  // Build a colored overlay histogram for each enabled ROI: same binning as the
  // original, but only the bins inside [roi.low, roi.high] are populated. Stacking
  // these "hist same" on top of the original outline paints each ROI region with
  // its own color — visually closer to standard physics-experiment plots than
  // boundary lines.
  const addROIOverlaysToCanvas = (canvas: any, config: HistogramConfig, histogram: any) => {
    const xaxis = histogram.fXaxis
    if (!xaxis) return
    const nbins: number = xaxis.fNbins
    const xmin: number = xaxis.fXmin
    const xmax: number = xaxis.fXmax
    if (!nbins || xmax <= xmin) return
    const binWidth = (xmax - xmin) / nbins

    for (const roi of config.rois.filter((r) => r.enabled)) {
      try {
        if (!roi.color.startsWith("#")) roi.color = `#${roi.color}`
        const rootColor = convertColorToRoot(roi.color)

        const overlay = window.JSROOT.createHistogram("TH1F", nbins)
        overlay.fName = `roi_${roi.id}`
        overlay.fTitle = roi.name
        overlay.fXaxis.fXmin = xmin
        overlay.fXaxis.fXmax = xmax
        overlay.fStats = 0
        overlay.fFillColor = rootColor
        overlay.fLineColor = rootColor
        overlay.fFillStyle = 1001 // solid fill

        // fArray indices: 0 = underflow, 1..nbins = bin contents, nbins+1 = overflow
        for (let i = 1; i <= nbins; i++) {
          const binCenter = xmin + (i - 0.5) * binWidth
          overlay.fArray[i] =
            binCenter >= roi.low && binCenter <= roi.high ? histogram.fArray[i] : 0
        }

        canvas.fPrimitives.Add(overlay, "hist same")
      } catch (error) {
        console.error(`Failed to add ROI overlay for ${roi.name}:`, error)
      }
    }
  }

  // Hex → ROOT color index, derived from the same preset list the picker uses so
  // they can never drift apart.
  const convertColorToRoot = (hexColor: string): number => {
    const match = ROOT_COLOR_PRESETS.find((p) => p.hex.toLowerCase() === hexColor.toLowerCase())
    return match ? match.index : 2 // fall back to red if somehow unknown
  }

  // Persist a zoom. The store applies it locally at once and debounces the write,
  // so this is safe to call from a wheel handler.
  const saveZoom = (histogramId: string, zoom: { xmin: number; xmax: number }) => {
    useHistogramStore.getState().setZoom(histogramId, zoom)
  }

  // The zoom to restore on mount, from the configuration the server just sent.
  // This is what makes leaving the page and coming back land on the same view.
  const savedZoomFor = (histogramId: string) =>
    histogramsRef.current.find((h) => h.id === histogramId)?.zoom ?? null

  // Sync zoom to other histograms
  const syncZoomToOthers = (sourceId: string, xmin: number, xmax: number) => {
    if (!dashboardSettings.syncZoom) return
        
    Object.entries(histogramPainters.current).forEach(([id, painter]) => {
      if (id !== sourceId && painter && histogramRefs.current[id]) {
        try {
          const fp = painter.getFramePainter()
          if (fp && fp.originalZoom) {
            fp.originalZoom(xmin, xmax, 0, 0)
            saveZoom(id, { xmin, xmax })
          }
        } catch (error) {
          console.error(`Failed to sync zoom to histogram ${id}:`, error)
        }
      }
    })
  }

  // Settings changes go to the store, which applies them locally at once and
  // debounces the write. Call sites pass a whole settings object; the store
  // treats it as a patch, so that keeps working.
  const saveDashboardSettings = useCallback(
    (settings: DashboardSettings) => {
      const rebinChanged = settings.rebinFactor !== dashboardSettings.rebinFactor
      useHistogramStore.getState().setSettings(settings)

      // The spy manager rebins server-side, so it has to be told before the next
      // fetch or the spectrum and its integrals disagree about binning.
      if (rebinChanged) {
        setRebinFactor(settings.rebinFactor).catch((error) => {
          console.error("Failed to apply the rebin factor:", error)
          toast({
            title: "Error",
            description: "Failed to apply the rebin factor.",
            variant: "destructive",
          })
        })
      }
    },
    [toast, dashboardSettings.rebinFactor],
  )

  // API calls
  const fetchBoardConfiguration = async () => {
    try {
      const response = await getBoardConfiguration()
      // Ids arrive as numbers and are compared against the strings the Select
      // and the saved histogram configurations use. Normalise once here.
      const boardList = (response.data ?? []).map((board: BoardData) => ({
        ...board,
        id: String(board.id),
      }))
      setBoards(boardList)
      return boardList
    } catch (error) {
      console.error("Failed to fetch board configuration:", error)
      toast({
        title: "Error",
        description: "Failed to fetch board configuration. Please try again.",
        variant: "destructive",
      })
      return []
    }
  }

  // Histogram management
  const addHistogram = () => {
    setSelectedHistogram(null)
    setHistogramDialogOpen(true)
  }

  const editHistogram = (histogram: HistogramConfig) => {
    setSelectedHistogram(histogram)
    setHistogramDialogOpen(true)
  }

  const saveHistogram = async (config: Partial<HistogramConfig> & { id?: string }) => {
    const store = useHistogramStore.getState()
    const saved = config.id
      ? (await store.updateHistogram(config.id, config), store.histograms.find((h) => h.id === config.id))
      : await store.addHistogram(config)

    // Targeted redraw of the affected histogram (if visible) so changes apply now
    const latest = useHistogramStore.getState().histograms.find((h) => h.id === (saved?.id ?? config.id))
    if (latest?.visible) updateHistogramData(latest, undefined, { forceRebuild: true })
    else if (latest) forgetPainter(latest.id)
  }

  const deleteHistogram = async (id: string) => {
    await useHistogramStore.getState().removeHistogram(id)

    // Clean up refs and painters
    delete histogramRefs.current[id]
    delete histogramPainters.current[id]
    delete canvasObjects.current[id]
    delete updateChain.current[id]
    delete pendingForce.current[id]
  }

  // ROI management
  const addROI = (histogramId: string) => {
    setSelectedROI({ histogramId, roi: null })
    setRoiDialogOpen(true)
  }

  const editROI = (histogramId: string, roi: ROI) => {
    setSelectedROI({ histogramId, roi })
    setRoiDialogOpen(true)
  }

  const saveROI = async (histogramId: string, roi: Partial<ROI> & { id?: string }) => {
    const store = useHistogramStore.getState()
    if (roi.id) {
      await store.updateRoi(histogramId, roi.id, roi)
    } else {
      await store.addRoi(histogramId, roi)
    }

    // Targeted redraw of the affected histogram so ROI overlays refresh immediately
    const affected = useHistogramStore.getState().histograms.find((h) => h.id === histogramId)
    if (affected) updateHistogramData(affected, undefined, { forceRebuild: true })
  }

  const deleteROI = async (histogramId: string, roiId: string) => {
    await useHistogramStore.getState().removeRoi(histogramId, roiId)

    const affected = useHistogramStore.getState().histograms.find((h) => h.id === histogramId)
    if (affected) updateHistogramData(affected, undefined, { forceRebuild: true })
  }

  // A painter whose element is gone (the card was hidden) must not be reused:
  // forgetting it makes the card draw afresh when it is shown again.
  const forgetPainter = (id: string) => {
    const el = painterElements.current[id]
    if (el) { try { window.JSROOT?.cleanup(el) } catch { /* detached */ } }
    delete painterElements.current[id]
    delete histogramPainters.current[id]
    delete canvasObjects.current[id]
    delete updateChain.current[id]
    delete pendingForce.current[id]
  }

  const hideHistogram = async (id: string) => {
    if (expandedId === id) setExpandedId(null)
    await useHistogramStore.getState().updateHistogram(id, { visible: false })
    forgetPainter(id)
  }

  const showChannel = async (boardId: string, channel: number, show: boolean) => {
    const key = `${boardId}/${channel}`
    if (pendingChannels.current.has(key)) return       // a click is already on its way
    pendingChannels.current.add(key)
    try {
      const store = useHistogramStore.getState()
      const matches = store.histograms.filter((h) => h.boardId === boardId && h.channel === channel)
      if (!show) {
        // Hide every histogram of the channel (a Custom one too), as the chip shows.
        for (const h of matches.filter((m) => m.visible)) {
          if (expandedId === h.id) setExpandedId(null)
          await store.updateHistogram(h.id, { visible: false })
          forgetPainter(h.id)
        }
      } else if (!matches.some((m) => m.visible)) {
        if (matches.length) {
          await store.updateHistogram(matches[0].id, { visible: true })
        } else {
          await store.addHistogram({ boardId, channel, size: "medium",
                                     label: `Board ${boardId} - Channel ${channel}`, customLabel: "", visible: true })
        }
      }
    } finally {
      pendingChannels.current.delete(key)
    }
  }

  const toggleChannel = (boardId: string, channel: number) => {
    const shown = histogramsRef.current.some((h) => h.boardId === boardId && h.channel === channel && h.visible)
    void showChannel(boardId, channel, !shown)
  }

  const showBoard = async (boardId: string, show: boolean) => {
    const board = boards.find((b) => b.id === boardId)
    const n = Number(board?.chan) || 0
    for (let ch = 0; ch < n; ch++) await showChannel(boardId, ch, show)
  }

  // An ROI over exactly what is on screen: zoom on the peak, one click.
  const roiFromView = async (histogramId: string) => {
    const fp = histogramPainters.current[histogramId]?.getFramePainter?.()
    const xmin = Number(fp?.zoom_xmin), xmax = Number(fp?.zoom_xmax)
    if (!(xmax > xmin)) {
      toast({ title: "Zoom in first", description: "Drag along the x axis over the peak, then add the ROI from the view." })
      return
    }
    const config = histogramsRef.current.find((h) => h.id === histogramId)
    const norm = (c: string) => (c.startsWith("#") ? c : `#${c}`).toLowerCase()
    const used = new Set((config?.rois ?? []).map((r) => norm(r.color)))
    const color = (ROOT_COLOR_PRESETS.find((c) => !used.has(c.hex)) ?? ROOT_COLOR_PRESETS[0]).hex
    const round = (v: number) => Math.round(v * 100) / 100
    // "ROI n" with n one above the highest so far, so a deletion never repeats a name.
    const highest = Math.max(0, ...(config?.rois ?? []).map((r) => Number(/^ROI (\d+)$/.exec(r.name)?.[1] ?? 0)))
    await useHistogramStore.getState().addRoi(histogramId, {
      name: `ROI ${highest + 1}`, low: round(xmin), high: round(xmax), color, enabled: true,
    })
    const affected = useHistogramStore.getState().histograms.find((h) => h.id === histogramId)
    if (affected) updateHistogramData(affected, undefined, { forceRebuild: true })
    toast({ title: "ROI added", description: `${round(xmin)} – ${round(xmax)}. Click its name to rename or adjust it.` })
  }

  const zoomToROI = (histogramId: string, roi: ROI) => {
    const fp = histogramPainters.current[histogramId]?.getFramePainter?.()
    const margin = Math.max((roi.high - roi.low) * 0.25, 1)
    if (fp?.zoom) fp.zoom(roi.low - margin, roi.high + margin, 0, 0)
  }

  const toggleROI = async (histogramId: string, roi: ROI) => {
    await useHistogramStore.getState().updateRoi(histogramId, roi.id, { enabled: !roi.enabled })
    const affected = useHistogramStore.getState().histograms.find((h) => h.id === histogramId)
    if (affected) updateHistogramData(affected, undefined, { forceRebuild: true })
  }

  // Every ROI's counts in a single request, rather than one request per ROI per
  // tick, each of which made the server re-read the same spectrum.
  const updateROIIntegrals = () => refreshIntegrals()

  // Reorder histograms. Pure state update — the visibleHistograms sort handles
  // the visual reorder; no remount or redraw is needed.
  const reorderHistograms = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const current = histogramsRef.current
    const oldIndex = current.findIndex((h) => h.id === active.id)
    const newIndex = current.findIndex((h) => h.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return

    const reordered = arrayMove(current, oldIndex, newIndex)
    useHistogramStore.getState().reorder(reordered.map((h) => h.id))
  }

  // Zoom management
  const resetAllZoom = () => {
    Object.values(histogramPainters.current).forEach((painter) => {
      const fp = painter?.getFramePainter()
      if (fp?.originalZoom) {
        clearTimeout(fp.saveZoomTimeout)
        fp.originalZoom(0, 0, 0, 0)
      }
    })

    useHistogramStore.getState().clearZoom()

    toast({
      title: "Zoom reset",
      description: "All histograms have been reset to default zoom.",
    })
  }

  // Zoom every shown histogram onto the bins that have counts (with a margin),
  // through the same zoom as a mouse drag, so it is saved like any other.
  const fitAllToData = () => {
    let fitted = 0
    for (const config of histogramsRef.current.filter((h) => h.visible)) {
      const canvas = canvasObjects.current[config.id]
      const hist = canvas?.fPrimitives?.arr?.find((p: any) => p._typename === "TH1F" || p._typename === "TH1I")
      const fp = histogramPainters.current[config.id]?.getFramePainter?.()
      if (!hist?.fArray || !fp?.zoom) continue
      const n = hist.fXaxis.fNbins, xmin = hist.fXaxis.fXmin, xmax = hist.fXaxis.fXmax
      let first = -1, last = -1
      for (let i = 1; i <= n; i++) if (hist.fArray[i] > 0) { if (first < 0) first = i; last = i }
      if (first < 0) continue
      const w = (xmax - xmin) / n
      const lo = xmin + (first - 1) * w, hi = xmin + last * w
      const margin = Math.max((hi - lo) * 0.15, 5 * w)
      // Each card to its own data: the unwrapped zoom, so "Sync zoom" does
      // not copy the last card's range onto all of them.
      const zx0 = Math.max(xmin, lo - margin), zx1 = Math.min(xmax, hi + margin)
      if (fp.originalZoom) fp.originalZoom(zx0, zx1, 0, 0)
      else fp.zoom(zx0, zx1, 0, 0)
      saveZoom(config.id, { xmin: zx0, xmax: zx1 })
      fitted += 1
    }
    if (!fitted) toast({ title: "Nothing to fit", description: "No shown histogram has counts yet." })
  }

  const toggleSyncZoom = () => {
    const newSyncState = !dashboardSettings.syncZoom
    saveDashboardSettings({ ...dashboardSettings, syncZoom: newSyncState })

    toast({
      title: `Synchronized Zooming ${newSyncState ? "Enabled" : "Disabled"}`,
      description: `Histograms will ${newSyncState ? "now" : "no longer"} zoom together.`,
    })
  }

  // Layout calculations
  const getHistogramSize = (size: "small" | "medium" | "large") => {
    switch (size) {
      case "small":
        return "h-72"
      case "medium":
        return "h-96"
      case "large":
        return "h-[32rem]"
      default:
        return "h-96"
    }
  }

  // Whole class names, so Tailwind's scanner sees them (a built
  // `lg:grid-cols-${n}` only worked while the same literals existed elsewhere).
  const LG_GRID_COLS: Record<number, string> = {
    1: "lg:grid-cols-1",
    2: "lg:grid-cols-2",
    3: "lg:grid-cols-3",
    4: "lg:grid-cols-4",
  }
  const getGridClass = () => {
    if (dashboardSettings.layout === "rows") return "grid-cols-1"
    if (dashboardSettings.layout === "custom") return "grid-cols-1"
    const n = Math.max(1, Math.min(dashboardSettings.gridCols, 4))
    return `grid-cols-1 md:grid-cols-2 ${LG_GRID_COLS[n]}`
  }

  // An enlarged histogram comes first, so it opens in view.
  const visibleHistograms = histograms.filter((h) => h.visible).sort((a, b) =>
    (a.id === expandedId ? -1 : b.id === expandedId ? 1 : 0) || a.order - b.order)

  return (
    <div className="flex flex-col min-h-screen bg-background text-foreground">
      <div className="flex-1 w-full px-0 py-4 sm:px-4">
        {/* Header Controls */}
        <div className="flex flex-wrap justify-between items-center mb-4 gap-4">
          {/* Wraps on a narrow screen instead of cutting off Log scale and Rebin. */}
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => setBrowserOpen((v) => !v)} variant={browserOpen ? "default" : "outline"}>
              <ListChecks className="h-4 w-4 mr-2" />
              Channels
            </Button>
            <Button onClick={addHistogram} variant="outline" title="A histogram with its own label and size">
              <Plus className="h-4 w-4 mr-2" />
              Custom
            </Button>
            <Button onClick={fitAllToData} variant="outline" title="Zoom every histogram onto its counts">
              <Scan className="h-4 w-4 mr-2" />
              Fit to data
            </Button>
            <Button onClick={resetAllZoom} variant="outline">
              <RotateCcw className="h-4 w-4 mr-2" />
              Reset zoom
            </Button>
            <Button
              onClick={() => saveDashboardSettings({ ...dashboardSettings, isLogScale: !dashboardSettings.isLogScale })}
              variant={dashboardSettings.isLogScale ? "default" : "outline"}
            >
              {dashboardSettings.isLogScale ? "Linear scale" : "Log scale"}
            </Button>

            <div className="flex items-center gap-2">
              <Label htmlFor="rebin-factor" className="text-sm font-medium">
                Rebin
              </Label>
              <Input
                id="rebin-factor"
                type="number"
                min={1}
                max={1000}
                value={dashboardSettings.rebinFactor}
                onChange={(e) => {
                  const value = Math.max(1, Math.min(1000, Number(e.target.value)))
                  saveDashboardSettings({ ...dashboardSettings, rebinFactor: value })
                }}
                className="w-20 h-8"
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <ToggleGroup
              type="single"
              value={dashboardSettings.layout}
              onValueChange={(value) => value && saveDashboardSettings({ ...dashboardSettings, layout: value as any })}
            >
              <ToggleGroupItem value="grid" aria-label="Grid layout">
                <Grid2X2 className="h-4 w-4" />
              </ToggleGroupItem>
              <ToggleGroupItem value="rows" aria-label="One histogram per row">
                <Rows2 className="h-4 w-4" />
              </ToggleGroupItem>
            </ToggleGroup>

            <Button onClick={() => setSettingsDialogOpen(true)} variant="outline" size="icon" aria-label="Histogram dashboard settings">
              <Settings className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {browserOpen && (
          <ChannelBrowser
            boards={boards}
            histograms={histograms}
            statsFor={statsFor}
            running={running}
            onToggle={toggleChannel}
            onBoard={(id, show) => void showBoard(id, show)}
          />
        )}

        {/* Empty State */}
        {visibleHistograms.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="text-muted-foreground mb-4">
              <Grid2X2 className="h-12 w-12 mx-auto mb-2" />
              <h3 className="text-lg font-semibold">No histograms shown</h3>
              <p className="text-sm">Pick channels above — or “All” for a whole board.</p>
            </div>
            {!browserOpen && (
              <Button onClick={() => setBrowserOpen(true)}>
                <ListChecks className="h-4 w-4 mr-2" />
                Choose channels
              </Button>
            )}
          </div>
        )}

        {/* Histograms Grid */}
        {visibleHistograms.length > 0 && (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={reorderHistograms}
          >
            <SortableContext
              items={visibleHistograms.map(h => h.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className={`grid ${getGridClass()} gap-6`}>
                {visibleHistograms.map((config) => (
                  <SortableHistogramCard
                    key={config.id}
                    config={config}
                    roiIntegrals={roiIntegrals}
                    stats={statsFor(config.boardId, config.channel)}
                    counts={entries[config.id]}
                    running={running}
                    expanded={expandedId === config.id}
                    onAddROI={addROI}
                    onROIFromView={(id) => void roiFromView(id)}
                    onToggleExpand={(id) => setExpandedId((cur) => (cur === id ? null : id))}
                    onHide={(id) => void hideHistogram(id)}
                    onZoomToROI={zoomToROI}
                    onToggleROI={(id, roi) => void toggleROI(id, roi)}
                    onEditHistogram={editHistogram}
                    onEditROI={editROI}
                    dashboardSettings={dashboardSettings}
                    getHistogramSize={getHistogramSize}
                    histogramRefs={histogramRefs}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}

        {/* Dialogs */}
        <HistogramDialog
          isOpen={histogramDialogOpen}
          onClose={() => setHistogramDialogOpen(false)}
          histogram={selectedHistogram}
          onSave={saveHistogram}
          onDelete={deleteHistogram}
          boards={boards}
        />

        <ROIDialog
          isOpen={roiDialogOpen}
          onClose={() => setRoiDialogOpen(false)}
          histogramId={selectedROI.histogramId}
          roi={selectedROI.roi}
          onSave={saveROI}
          onDelete={deleteROI}
        />

        {/* Settings Dialog */}
        <Dialog open={settingsDialogOpen} onOpenChange={setSettingsDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Dashboard settings</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-2">
                  <Label>Grid columns</Label>
                  <Slider
                    value={[dashboardSettings.gridCols]}
                    onValueChange={(value) => saveDashboardSettings({ ...dashboardSettings, gridCols: value[0] })}
                    min={1}
                    max={6}
                    step={1}
                  />
                  <span className="text-xs text-muted-foreground">{dashboardSettings.gridCols} columns</span>
                </div>

                <div className="flex flex-col gap-2">
                  <Label>Update interval (ms)</Label>
                  <Input
                    type="number"
                    value={dashboardSettings.updateInterval}
                    onChange={(e) => {
                      // Minimum 1 second (1000ms), round to nearest 100ms
                      const value = Math.max(1000, Math.round(Number(e.target.value) / 100) * 100)
                      saveDashboardSettings({ ...dashboardSettings, updateInterval: value })
                    }}
                    min={1000}
                    max={60000}
                    step={100}
                  />
                  <span className="text-xs text-muted-foreground">Minimum: 1000ms (1 second), Steps: 100ms</span>
                </div>
              </div>

              {/* Rebin Factor in Settings */}
              <div className="flex flex-col gap-2">
                <Label>Rebin factor</Label>
                <Input
                  type="number"
                  value={dashboardSettings.rebinFactor}
                  onChange={(e) => {
                    const value = Math.max(1, Math.min(1000, Number(e.target.value)))
                    saveDashboardSettings({ ...dashboardSettings, rebinFactor: value })
                  }}
                  min={1}
                  max={1000}
                />
                <span className="text-xs text-muted-foreground">Range: 1-1000</span>
              </div>

              <div className="space-y-2">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    checked={dashboardSettings.isLogScale}
                    onCheckedChange={(checked) =>
                      saveDashboardSettings({ ...dashboardSettings, isLogScale: checked as boolean })
                    }
                  />
                  <Label>Logarithmic scale</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox
                    checked={dashboardSettings.showLabels}
                    onCheckedChange={(checked) =>
                      saveDashboardSettings({ ...dashboardSettings, showLabels: checked as boolean })
                    }
                  />
                  <Label>Show axis titles</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox
                    checked={dashboardSettings.showROIs}
                    onCheckedChange={(checked) =>
                      saveDashboardSettings({ ...dashboardSettings, showROIs: checked as boolean })
                    }
                  />
                  <Label>Show ROIs</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox
                    checked={dashboardSettings.showIntegrals}
                    onCheckedChange={(checked) =>
                      saveDashboardSettings({ ...dashboardSettings, showIntegrals: checked as boolean })
                    }
                  />
                  <Label>Show integrals</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox
                    checked={dashboardSettings.autoUpdate}
                    onCheckedChange={(checked) =>
                      saveDashboardSettings({ ...dashboardSettings, autoUpdate: checked as boolean })
                    }
                  />
                  <Label>Auto update</Label>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => setSettingsDialogOpen(false)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}
