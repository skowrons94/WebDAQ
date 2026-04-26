"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { getBoardConfiguration, getRunStatus, getCurrentRunNumber, getHistogram, getRoiIntegral, getRebinFactor, setRebinFactor } from "@/lib/api"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useToast } from "@/components/ui/use-toast"
import { loadJSROOT } from "@/lib/load-jsroot"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useTheme } from "next-themes"
import { Settings, Grid2X2, Rows2, Plus, RotateCcw, Edit, Trash2, Save, Eye, EyeOff } from "lucide-react"
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

// Sortable Histogram Card Component
const SortableHistogramCard = ({ config, roiIntegrals, onAddROI, onEditHistogram, onEditROI, dashboardSettings, getHistogramSize, histogramRefs }: {
  config: HistogramConfig
  roiIntegrals: { [key: string]: number }
  onAddROI: (id: string) => void
  onEditHistogram: (config: HistogramConfig) => void
  onEditROI: (histogramId: string, roi: ROI) => void
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
  } = useSortable({id: config.id})

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <Card ref={setNodeRef} style={style} className={`relative ${isDragging ? 'z-50' : ''} bg-gradient-to-br from-card via-card/95 to-card/90 backdrop-blur-sm border-border/50`}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-base font-semibold leading-tight flex items-center gap-2">
          <div
            {...attributes}
            {...listeners}
            className="cursor-grab active:cursor-grabbing p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
            title="Drag to reorder"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" className="text-gray-400">
              <circle cx="3" cy="3" r="1" fill="currentColor"/>
              <circle cx="9" cy="3" r="1" fill="currentColor"/>
              <circle cx="3" cy="6" r="1" fill="currentColor"/>
              <circle cx="9" cy="6" r="1" fill="currentColor"/>
              <circle cx="3" cy="9" r="1" fill="currentColor"/>
              <circle cx="9" cy="9" r="1" fill="currentColor"/>
            </svg>
          </div>
          {config.label}
        </CardTitle>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => onAddROI(config.id)} title="Add ROI">
            <Plus className="h-3 w-3" />
          </Button>

          {/* Edit Histogram */}
          <Button variant="ghost" size="sm" onClick={() => onEditHistogram(config)} title="Edit Histogram">
            <Edit className="h-3 w-3" />
          </Button>

        </div>
      </CardHeader>

      <CardContent>
        {/* Chart with ROI legend overlay so card height is independent of ROI count */}
        <div className="relative w-full">
          <div
            ref={(el) => {
              histogramRefs.current[config.id] = el
            }}
            className={`w-full ${getHistogramSize(config.size)} border rounded-lg shadow-md bg-gradient-to-br from-white via-gray-50 to-gray-100 dark:from-gray-900 dark:via-gray-800 dark:to-gray-700`}
          />

          {dashboardSettings.showROIs && config.rois.filter((r) => r.enabled).length > 0 && (
            <div className="pointer-events-none absolute top-2 left-2 right-2 z-10 flex justify-start">
              <div className="pointer-events-auto max-h-[60%] overflow-y-auto rounded-md border border-border/40 bg-background/80 backdrop-blur-sm px-2 py-1.5 shadow-sm text-xs space-y-0.5 max-w-[60%]">
                {config.rois
                  .filter((r) => r.enabled)
                  .map((roi) => {
                    const value = roiIntegrals[`${config.id}_${roi.id}`] ?? roi.integral ?? 0
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

type ROI = {
  id: string
  name: string
  low: number
  high: number
  integral: number
  rate: number // counts per minute
  lastUpdateTime: number // timestamp for rate calculation
  color: string
  enabled: boolean
}

type HistogramConfig = {
  id: string
  boardId: string
  channel: number
  visible: boolean
  size: "small" | "medium" | "large"
  label: string
  customLabel?: string
  position: { row: number; col: number }
  order: number
  zoomRange?: {
    xmin: number
    xmax: number
    timestamp?: number
  }
  rois: ROI[]
}

type DashboardSettings = {
  layout: "grid" | "rows" | "custom"
  gridCols: number
  isLogScale: boolean
  syncZoom: boolean
  showLabels: boolean
  showROIs: boolean
  showIntegrals: boolean
  autoUpdate: boolean
  updateInterval: number
  theme: "auto" | "light" | "dark"
  rebinFactor: number
}

type HistogramDialogProps = {
  isOpen: boolean
  onClose: () => void
  histogram: HistogramConfig | null
  onSave: (config: HistogramConfig) => void
  onDelete?: (id: string) => void
  boards: BoardData[]
}

type ROIDialogProps = {
  isOpen: boolean
  onClose: () => void
  histogramId: string
  roi: ROI | null
  onSave: (histogramId: string, roi: ROI) => void
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
    const updatedROI: ROI = {
      id: roi?.id || `roi_${Date.now()}`,
      name,
      low,
      high,
      color,
      enabled,
      integral: roi?.integral || 0,
      rate: roi?.rate || 0,
      lastUpdateTime: roi?.lastUpdateTime || Date.now(),
    }
    onSave(histogramId, updatedROI)
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
              <Label htmlFor="roi-low">Low Value</Label>
              <Input id="roi-low" type="number" value={low} onChange={(e) => setLow(Number(e.target.value))} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="roi-high">High Value</Label>
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
                <Button variant="destructive" onClick={handleDelete}>
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </Button>
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

    const config: HistogramConfig = {
      id: histogram?.id || `hist_${Date.now()}`,
      boardId,
      channel,
      size,
      label: customLabel || `Board ${boardId} - Channel ${channel}`,
      customLabel,
      visible,
      position: histogram?.position || { row: 0, col: 0 },
      order: histogram?.order || Date.now(), // Use timestamp as default order
      zoomRange: histogram?.zoomRange,
      rois: histogram?.rois || [],
    }

    onSave(config)
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
                boards.find((b) => b.id === boardId)?.chan
                  ? Number.parseInt(boards.find((b) => b.id === boardId)!.chan) - 1
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
            <Label htmlFor="custom-label">Custom Label</Label>
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
                <Button variant="destructive" onClick={handleDelete}>
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </Button>
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
export default function EnhancedHistogramDashboard() {
  const [boards, setBoards] = useState<BoardData[]>([])
  const [jsrootLoaded, setJsrootLoaded] = useState(false)

  // Enhanced state management
  const [histograms, setHistograms] = useState<HistogramConfig[]>([])
  const histogramsRef = useRef<HistogramConfig[]>([])
  // ROI integrals are kept in their own map so live updates don't retrigger histogram redraws
  const [roiIntegrals, setRoiIntegrals] = useState<{ [key: string]: number }>({})
  const roiRateRef = useRef<{ [key: string]: { rate: number; lastUpdate: number; lastIntegral: number } }>({})
  const [dashboardSettings, setDashboardSettings] = useState<DashboardSettings>({
    layout: "grid",
    gridCols: 3,
    isLogScale: false,
    syncZoom: false,
    showLabels: true,
    showROIs: true,
    showIntegrals: true,
    autoUpdate: true,
    updateInterval: 5000, // Default 5 seconds
    theme: "auto",
    rebinFactor: 1,
  })

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
  // Per-histogram serialization. Each histogram has a chain so updates run in order;
  // a queued bit collapses redundant in-flight requests, and pendingForce carries the
  // forceRebuild flag forward across coalesced calls.
  const updateChain = useRef<{ [key: string]: { promise: Promise<void>; queued: boolean } }>({})
  const pendingForce = useRef<{ [key: string]: boolean }>({})

  // Update interval ref to properly manage the interval
  const updateIntervalRef = useRef<NodeJS.Timeout | null>(null)
  // Debounced server-write timers
  const histogramConfigsSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const settingsSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Keep ref in sync so callbacks can read latest histograms without stale closures
  useEffect(() => {
    histogramsRef.current = histograms
  }, [histograms])

  const { toast } = useToast()
  const { theme } = useTheme()

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
      await loadDashboardSettings()
      await loadHistogramConfigs()
      await fetchBoardConfiguration()
      await fetchRunStatus()
    }

    initializeApp()
    const statusInterval = setInterval(fetchRunStatus, 5000)

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

    return () => clearInterval(statusInterval)
  }, [])

  // Initialize histograms when JSROOT loads
  useEffect(() => {
    if (jsrootLoaded && histograms.length > 0) {
      histograms.forEach((config) => {
        if (config.visible && !histogramPainters.current[config.id]) {
          initializeHistogram(config)
        }
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

    if (dashboardSettings.autoUpdate && jsrootLoaded && boards.length > 0) {
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
  }, [jsrootLoaded, boards.length, dashboardSettings.autoUpdate, dashboardSettings.updateInterval])

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
  ])

  // Initialize a single histogram
  const initializeHistogram = async (config: HistogramConfig) => {
    const element = histogramRefs.current[config.id]
    if (!element || !window.JSROOT || histogramPainters.current[config.id]) return

    try {
      // Load saved zoom from cache first
      const savedZoom = await loadZoomFromCache(config.id)

      // Create histogram and draw it
      await updateHistogramData(config, savedZoom)
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

    const isFirstTime = !histogramPainters.current[config.id]

    const histogramData = await withTimeout(
      getHistogram(config.boardId, config.channel.toString()),
      15000,
      `getHistogram(${config.boardId}/${config.channel})`,
    )
    const histogram = window.JSROOT.parse(histogramData)

    histogram.fLineColor = 4
    histogram.fFillColor = 4
    histogram.fFillStyle = 3001
    histogram.fTitle = dashboardSettings.showLabels ? config.label : ""
    histogram.fName = `hist_${config.id}`
    histogram.fStats = 0

    const existingCanvas = canvasObjects.current[config.id]
    const existingHist = existingCanvas?.fPrimitives?.arr?.find(
      (p: any) => p._typename === "TH1F" || p._typename === "TH1I",
    )
    const binCountChanged =
      !!existingHist &&
      existingHist.fArray &&
      histogram.fArray &&
      existingHist.fArray.length !== histogram.fArray.length

    const expectedROIs = dashboardSettings.showROIs
      ? config.rois.filter((r) => r.enabled).length
      : 0
    const currentROIs =
      existingCanvas?.fPrimitives?.arr?.filter(
        (p: any) => p?.fName && p.fName.startsWith("roi_"),
      ).length ?? 0
    const roiCountChanged = expectedROIs !== currentROIs

    const logChanged = !!existingCanvas && existingCanvas.fLogy !== (dashboardSettings.isLogScale ? 1 : 0)

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
      canvas.fLogy = dashboardSettings.isLogScale ? 1 : 0
      canvas.fPrimitives.Add(histogram, "hist nostat")
      if (dashboardSettings.showROIs && config.rois.length > 0) {
        addROIOverlaysToCanvas(canvas, config, histogram)
      }
      canvasObjects.current[config.id] = canvas

      const painter: any = await withTimeout<any>(
        window.JSROOT.redraw(element, canvas),
        15000,
        `JSROOT.redraw(${config.id})`,
      )
      histogramPainters.current[config.id] = painter
      setupZoomPersistence(painter, config)

      const zoomToApply = preservedZoom ?? (isFirstTime ? initialZoom || config.zoomRange : null)
      if (zoomToApply && zoomToApply.xmin < zoomToApply.xmax) {
        setTimeout(() => {
          const fp = painter.getFramePainter?.()
          if (fp && fp.zoom) fp.zoom(zoomToApply.xmin, zoomToApply.xmax, 0, 0)
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
        saveZoomToCache(config.id, { xmin, xmax })

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

  // Save zoom to cache. Uses functional setState to avoid stale-closure overwrites
  // when several histograms zoom concurrently.
  const saveZoomToCache = async (histogramId: string, zoom: { xmin: number; xmax: number }) => {
    try {
      const zoomData = { ...zoom, timestamp: Date.now() }
      const synced = histogramsRef.current.map((h) =>
        h.id === histogramId ? { ...h, zoomRange: zoomData } : h,
      )
      histogramsRef.current = synced
      setHistograms(synced)
      await fetch("/api/cache", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "zoom-range",
          histogramId,
          data: zoomData,
        }),
      })
    } catch (error) {
      console.error("Failed to save zoom to cache:", error)
    }
  }

  // Load zoom from cache
  const loadZoomFromCache = async (histogramId: string) => {
    try {
      // Try loading from cache API first
      const response = await fetch(`/api/cache?type=zoom-ranges`)
      const data = await response.json()
      if (data.success && data.data && data.data[histogramId]) {
        return data.data[histogramId]
      }

      // Fallback: check if zoom is in histogram config
      const config = histograms.find((h) => h.id === histogramId)
      if (config?.zoomRange) {
        return config.zoomRange
      }

    } catch (error) {
      console.error("Failed to load zoom from cache:", error)
    }
    return null
  }

  // Sync zoom to other histograms
  const syncZoomToOthers = (sourceId: string, xmin: number, xmax: number) => {
    if (!dashboardSettings.syncZoom) return
        
    Object.entries(histogramPainters.current).forEach(([id, painter]) => {
      if (id !== sourceId && painter && histogramRefs.current[id]) {
        try {
          const fp = painter.getFramePainter()
          if (fp && fp.originalZoom) {
            fp.originalZoom(xmin, xmax, 0, 0)
            saveZoomToCache(id, { xmin, xmax })
          }
        } catch (error) {
          console.error(`Failed to sync zoom to histogram ${id}:`, error)
        }
      }
    })
  }

  // Settings persistence. Optimistic local update + debounced server write.
  // No remount, no re-fetch — the dependent useEffects pick up the change and redraw.
  const saveDashboardSettings = useCallback(
    (settings: DashboardSettings) => {
      const validatedSettings = {
        ...settings,
        updateInterval: Math.max(1000, settings.updateInterval),
      }

      setDashboardSettings(validatedSettings)

      // Push rebin to backend immediately so the next histogram fetch is rebinned correctly
      if (validatedSettings.rebinFactor !== dashboardSettings.rebinFactor) {
        setRebinFactor(validatedSettings.rebinFactor)
      }

      // Debounced persistence to avoid spam during slider drags
      if (settingsSaveTimeoutRef.current) clearTimeout(settingsSaveTimeoutRef.current)
      settingsSaveTimeoutRef.current = setTimeout(() => {
        fetch("/api/cache", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "settings", data: validatedSettings }),
        }).catch((error) => {
          console.error("Failed to save dashboard settings:", error)
          toast({
            title: "Error",
            description: "Failed to save dashboard settings.",
            variant: "destructive",
          })
        })
      }, 300)
    },
    [toast, dashboardSettings.rebinFactor],
  )

  const loadDashboardSettings = useCallback(async () => {
    try {
      const response = await fetch("/api/cache?type=settings")
      const data = await response.json()
      if (data.success && data.data) {
        const settings = {
          ...data.data,
          // Ensure minimum interval is 1 second, default to 5 seconds
          updateInterval: Math.max(1000, data.data.updateInterval || 5000),
          rebinFactor: data.data.rebinFactor || 1,
        }

        setDashboardSettings((prev) => ({ ...prev, ...settings }))
        setRebinFactor(settings.rebinFactor)
      }
    } catch (error) {
      console.error("Failed to load dashboard settings:", error)
    }
  }, [])

  // Optimistic in-memory update + debounced server write. The state update is what the
  // UI reacts to; the persistence is fire-and-forget so it never blocks the user.
  // Also syncs histogramsRef synchronously so any update scheduled in the same tick
  // sees the new config (the ref-syncing useEffect only runs after React commits).
  const saveHistogramConfigs = useCallback(
    (configs: HistogramConfig[]) => {
      histogramsRef.current = configs
      setHistograms(configs)
      if (histogramConfigsSaveTimeoutRef.current) clearTimeout(histogramConfigsSaveTimeoutRef.current)
      histogramConfigsSaveTimeoutRef.current = setTimeout(() => {
        fetch("/api/cache", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "histograms", data: configs }),
        }).catch((error) => {
          console.error("Failed to save histogram configs:", error)
          toast({
            title: "Error",
            description: "Failed to save histogram configurations.",
            variant: "destructive",
          })
        })
      }, 300)
    },
    [toast],
  )

  const loadHistogramConfigs = useCallback(async () => {
    try {
      const response = await fetch("/api/cache?type=histograms")
      const data = await response.json()
      if (data.success && data.data && Array.isArray(data.data) && data.data.length > 0) {
        histogramsRef.current = data.data
        setHistograms(data.data)
      }
    } catch (error) {
      console.error("Failed to load histogram configs:", error)
    }
  }, [])

  // Remove histogram from cache when visibility is toggled off
  const removeHistogramFromCache = useCallback(async (histogramId: string) => {
    try {
      await fetch("/api/cache", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "histogram", id: histogramId }),
      })

      // Clean up refs

    } catch (error) {
      console.error("Failed to remove histogram from cache:", error)
    }
  }, [])

  // API calls
  const fetchBoardConfiguration = async () => {
    try {
      const response = await getBoardConfiguration()
      setBoards(response.data)
      return response.data
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

  const fetchRunStatus = async () => {
    try {
      await Promise.all([getRunStatus(), getCurrentRunNumber()])
    } catch (error) {
      console.error("Failed to fetch run status:", error)
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

  const saveHistogram = (config: HistogramConfig) => {
    const current = histogramsRef.current
    const updatedHistograms = current.find((h) => h.id === config.id)
      ? current.map((h) => (h.id === config.id ? config : h))
      : [...current, config]

    saveHistogramConfigs(updatedHistograms)

    // Targeted redraw of the affected histogram (if visible) so changes apply now
    if (config.visible) updateHistogramData(config, undefined, { forceRebuild: true })
  }

  const deleteHistogram = (id: string) => {
    const updatedHistograms = histogramsRef.current.filter((h) => h.id !== id)
    saveHistogramConfigs(updatedHistograms)

    // Clean up refs and painters
    delete histogramRefs.current[id]
    delete histogramPainters.current[id]
    delete canvasObjects.current[id]
    delete updateChain.current[id]
    delete pendingForce.current[id]

    // Remove from cache
    removeHistogramFromCache(id)
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

  const saveROI = (histogramId: string, roi: ROI) => {
    const updatedHistograms = histogramsRef.current.map((h) => {
      if (h.id === histogramId) {
        const existingROI = h.rois.find((r) => r.id === roi.id)
        const updatedROIs = existingROI ? h.rois.map((r) => (r.id === roi.id ? roi : r)) : [...h.rois, roi]
        return { ...h, rois: updatedROIs }
      }
      return h
    })

    saveHistogramConfigs(updatedHistograms)

    // Targeted redraw of the affected histogram so ROI lines refresh immediately
    const affected = updatedHistograms.find((h) => h.id === histogramId)
    if (affected) updateHistogramData(affected, undefined, { forceRebuild: true })
  }

  const deleteROI = (histogramId: string, roiId: string) => {
    const updatedHistograms = histogramsRef.current.map((h) => {
      if (h.id === histogramId) {
        return { ...h, rois: h.rois.filter((r) => r.id !== roiId) }
      }
      return h
    })

    saveHistogramConfigs(updatedHistograms)

    // Drop any cached integral for the removed ROI
    setRoiIntegrals((prev) => {
      const next = { ...prev }
      delete next[`${histogramId}_${roiId}`]
      return next
    })
    delete roiRateRef.current[`${histogramId}_${roiId}`]

    const affected = updatedHistograms.find((h) => h.id === histogramId)
    if (affected) updateHistogramData(affected, undefined, { forceRebuild: true })
  }

  // Update ROI integrals for all visible histograms.
  // Writes only to the roiIntegrals map, not the histograms state, so this tick
  // does NOT cause histogram redraws / interval restarts.
  const updateROIIntegrals = async () => {
    const visibleHistograms = histogramsRef.current.filter((h) => h.visible)

    const integralPromises: Promise<{ histogramId: string; roiId: string; integral: number }>[] = []

    for (const config of visibleHistograms) {
      for (const roi of config.rois.filter((r) => r.enabled)) {
        integralPromises.push(
          getRoiIntegral(config.boardId, config.channel.toString(), roi.low, roi.high)
            .then((integral) => ({ histogramId: config.id, roiId: roi.id, integral }))
            .catch((error) => {
              console.error(`Failed to get ROI integral for ${config.id}/${roi.id}:`, error)
              return { histogramId: config.id, roiId: roi.id, integral: 0 }
            }),
        )
      }
    }

    const results = await Promise.all(integralPromises)
    if (results.length === 0) return

    const now = Date.now()
    setRoiIntegrals((prev) => {
      const next = { ...prev }
      for (const r of results) {
        const key = `${r.histogramId}_${r.roiId}`
        const previous = roiRateRef.current[key]
        const dt = previous ? (now - previous.lastUpdate) / 1000 : 0
        let rate = previous?.rate ?? 0
        if (previous && dt > 0.1 && previous.lastIntegral !== r.integral) {
          rate = Math.abs(r.integral - previous.lastIntegral) / dt
        }
        roiRateRef.current[key] = { rate: Math.max(0, rate), lastUpdate: now, lastIntegral: r.integral }
        next[key] = r.integral
      }
      return next
    })
  }

  // Reorder histograms. Pure state update — the visibleHistograms sort handles
  // the visual reorder; no remount or redraw is needed.
  const reorderHistograms = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const current = histogramsRef.current
    const oldIndex = current.findIndex((h) => h.id === active.id)
    const newIndex = current.findIndex((h) => h.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return

    const reordered = arrayMove(current, oldIndex, newIndex).map((histogram, index) => ({
      ...histogram,
      order: index,
    }))

    saveHistogramConfigs(reordered)
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

    const updatedHistograms = histogramsRef.current.map((h) => ({ ...h, zoomRange: undefined }))
    saveHistogramConfigs(updatedHistograms)

    // Clear zoom cache
    fetch("/api/cache", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "zoom-ranges" }),
    })

    toast({
      title: "Zoom Reset",
      description: "All histograms have been reset to default zoom.",
    })
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
        return "h-60"
      case "medium":
        return "h-80"
      case "large":
        return "h-96"
      default:
        return "h-80"
    }
  }

  const getGridClass = () => {
    if (dashboardSettings.layout === "rows") return "grid-cols-1"
    if (dashboardSettings.layout === "custom") return "grid-cols-1"
    return `grid-cols-1 md:grid-cols-2 lg:grid-cols-${Math.min(dashboardSettings.gridCols, 4)}`
  }

  const visibleHistograms = histograms.filter((h) => h.visible).sort((a, b) => a.order - b.order)

  return (
    <div className="flex flex-col min-h-screen bg-background text-foreground">
      <main className="flex-1 container mx-auto p-4">
        {/* Header Controls */}
        <div className="flex flex-wrap justify-between items-center mb-4 gap-4">
          <div className="flex items-center gap-2">
            <Button onClick={addHistogram} variant="outline">
              <Plus className="h-4 w-4 mr-2" />
              Add Histogram
            </Button>
            <Button onClick={resetAllZoom} variant="outline">
              <RotateCcw className="h-4 w-4 mr-2" />
              Reset Zoom
            </Button>
            <Button
              onClick={() => saveDashboardSettings({ ...dashboardSettings, isLogScale: !dashboardSettings.isLogScale })}
              variant={dashboardSettings.isLogScale ? "default" : "outline"}
            >
              {dashboardSettings.isLogScale ? "Linear Scale" : "Log Scale"}
            </Button>

            <div className="flex items-center gap-2">
              <Label htmlFor="rebin-factor" className="text-sm font-medium">
                Rebin:
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
              <ToggleGroupItem value="grid">
                <Grid2X2 className="h-4 w-4" />
              </ToggleGroupItem>
              <ToggleGroupItem value="rows">
                <Rows2 className="h-4 w-4" />
              </ToggleGroupItem>
            </ToggleGroup>

            <Button onClick={() => setSettingsDialogOpen(true)} variant="outline" size="icon">
              <Settings className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Empty State */}
        {visibleHistograms.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="text-muted-foreground mb-4">
              <Grid2X2 className="h-12 w-12 mx-auto mb-2" />
              <h3 className="text-lg font-semibold">No Histograms Added</h3>
              <p className="text-sm">Click "Add Histogram" to get started with your dashboard.</p>
            </div>
            <Button onClick={addHistogram}>
              <Plus className="h-4 w-4 mr-2" />
              Add Your First Histogram
            </Button>
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
                    onAddROI={addROI}
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
              <DialogTitle>Dashboard Settings</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-2">
                  <Label>Grid Columns</Label>
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
                  <Label>Update Interval (ms)</Label>
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
                <Label>Rebin Factor</Label>
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
                  <Label>Logarithmic Scale</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox
                    checked={dashboardSettings.showLabels}
                    onCheckedChange={(checked) =>
                      saveDashboardSettings({ ...dashboardSettings, showLabels: checked as boolean })
                    }
                  />
                  <Label>Show Labels</Label>
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
                  <Label>Show Integrals</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox
                    checked={dashboardSettings.autoUpdate}
                    onCheckedChange={(checked) =>
                      saveDashboardSettings({ ...dashboardSettings, autoUpdate: checked as boolean })
                    }
                  />
                  <Label>Auto Update</Label>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => setSettingsDialogOpen(false)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </main>
    </div>
  )
}
