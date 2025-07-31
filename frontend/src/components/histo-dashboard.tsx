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

type ROI = {
  id: string
  name: string
  low: number
  high: number
  integral: number
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
            <Label htmlFor="roi-color">Color</Label>
            <div className="flex gap-2">
              <Input
                id="roi-color"
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="w-16 h-10"
              />
              <Input value={color} onChange={(e) => setColor(e.target.value)} placeholder="#ff0000" />
            </div>
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
  const isUpdating = useRef<{ [key: string]: boolean }>({})

  // Update interval ref to properly manage the interval
  const updateIntervalRef = useRef<NodeJS.Timeout | null>(null)

  const { toast } = useToast()
  const { theme } = useTheme()

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

  // FIXED: Auto-update histograms and ROI integrals with proper interval management
  useEffect(() => {
    // Clear any existing interval first
    if (updateIntervalRef.current) {
      console.log("Clearing existing update interval")
      clearInterval(updateIntervalRef.current)
      updateIntervalRef.current = null
    }

    // Only start new interval if conditions are met
    if (dashboardSettings.autoUpdate && jsrootLoaded && boards.length > 0 && histograms.length > 0) {
      console.log(`Starting auto-update with interval: ${dashboardSettings.updateInterval}ms`)

      updateIntervalRef.current = setInterval(() => {
        console.log(`Auto-updating histograms and ROI integrals every ${dashboardSettings.updateInterval}ms...`)
        updateAllHistograms()
      }, dashboardSettings.updateInterval)
    }

    // Cleanup function
    return () => {
      if (updateIntervalRef.current) {
        console.log("Cleaning up update interval")
        clearInterval(updateIntervalRef.current)
        updateIntervalRef.current = null
      }
    }
  }, [jsrootLoaded, boards.length, histograms.length, dashboardSettings.autoUpdate, dashboardSettings.updateInterval])

  // JSROOT theme handling
  useEffect(() => {
    if (jsrootLoaded) {
      const effectiveTheme = dashboardSettings.theme === "auto" ? theme : dashboardSettings.theme
      window.JSROOT.settings.DarkMode = effectiveTheme === "dark"
    }
  }, [jsrootLoaded, theme, dashboardSettings.theme])

  // Force update when settings change
  useEffect(() => {
    if (jsrootLoaded && histograms.length > 0) {
      histograms
        .filter((h) => h.visible)
        .forEach((config) => {
          updateHistogramData(config)
        })
    }
  }, [
    jsrootLoaded,
    histograms,
    dashboardSettings.isLogScale,
    dashboardSettings.showROIs,
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
      console.log(`Loading saved zoom for ${config.id}:`, savedZoom)

      // Create histogram and draw it
      await updateHistogramData(config, savedZoom)
    } catch (error) {
      console.error(`Failed to initialize histogram ${config.id}:`, error)
    }
  }

  // Update all visible histograms and ROI integrals
  const updateAllHistograms = async () => {
    const visibleConfigs = histograms.filter((h) => h.visible)

    // Update histograms in batches for performance
    const batchSize = 10
    for (let i = 0; i < visibleConfigs.length; i += batchSize) {
      const batch = visibleConfigs.slice(i, i + batchSize)
      await Promise.all(batch.map((config) => updateHistogramData(config)))
    }

    // Update ROI integrals after histogram updates
    await updateROIIntegrals()
  }

  // Helper function to determine if ROI lines need updating
  const shouldUpdateROIs = (canvas: any, config: HistogramConfig): boolean => {
    if (!dashboardSettings.showROIs || config.rois.length === 0) {
      // Check if there are existing ROI lines that need to be removed
      const hasROILines = canvas.fPrimitives.arr.some((p: any) => p.fName && p.fName.startsWith('roi_'))
      return hasROILines
    }

    // Check if ROI configuration has changed
    const existingROILines = canvas.fPrimitives.arr.filter((p: any) => p.fName && p.fName.startsWith('roi_'))
    const expectedROILines = config.rois.filter(r => r.enabled).length * 2 // 2 lines per ROI (start + end)
    
    return existingROILines.length !== expectedROILines
  }

  // Update histogram data - core function using proper canvas management
  const updateHistogramData = async (config: HistogramConfig, initialZoom?: any) => {
    if (isUpdating.current[config.id]) return
    isUpdating.current[config.id] = true

    console.log(`Updating histogram ${config.id}...`, {
      boardId: config.boardId,
      channel: config.channel,
      zoomRange: initialZoom || config.zoomRange,
    })

    try {
      const element = histogramRefs.current[config.id]
      if (!element || !window.JSROOT) return

      // Only use initial zoom for first-time creation, not for updates
      const isFirstTime = !histogramPainters.current[config.id]
      const zoomToApply = isFirstTime ? (initialZoom || config.zoomRange) : null

      // ALWAYS fetch fresh histogram data from server
      const histogramData = await getHistogram(config.boardId, config.channel.toString())
      const histogram = window.JSROOT.parse(histogramData)

      // Style histogram
      histogram.fLineColor = 4
      histogram.fFillColor = 4
      histogram.fFillStyle = 3001
      histogram.fTitle = dashboardSettings.showLabels ? config.label : ""
      histogram.fName = `hist_${config.id}`

      // Create canvas object
      let canvas = canvasObjects.current[config.id]
      if (!canvas) {
        // Create new canvas
        canvas = window.JSROOT.create("TCanvas")
        canvas.fName = `canvas_${config.id}`
        canvas.fTitle = config.label
        canvasObjects.current[config.id] = canvas
      }

      // Set log scale
      canvas.fLogy = dashboardSettings.isLogScale ? 1 : 0

      // Only clear and rebuild primitives for first-time creation or when ROI settings change
      // This preserves zoom state during regular updates
      if (isFirstTime || shouldUpdateROIs(canvas, config)) {
        canvas.fPrimitives.Clear()
        canvas.fPrimitives.Add(histogram, "hist")

        // Add ROI TLines to canvas primitives
        if (dashboardSettings.showROIs && config.rois.length > 0) {
          addROILinesToCanvas(canvas, config, histogram)
        }
      } else {
        // For regular updates, only update the histogram data without clearing primitives
        // Find and update the existing histogram primitive
        const histPrimitive = canvas.fPrimitives.arr.find((p: any) => p._typename === "TH1F" || p._typename === "TH1I")
        if (histPrimitive) {
          // Copy data from new histogram to existing one
          histPrimitive.fArray = histogram.fArray
          histPrimitive.fMaximum = histogram.fMaximum
          histPrimitive.fMinimum = histogram.fMinimum
          histPrimitive.fEntries = histogram.fEntries
          histPrimitive.fTsumw = histogram.fTsumw
          histPrimitive.fTsumw2 = histogram.fTsumw2
          histPrimitive.fTsumwx = histogram.fTsumwx
          histPrimitive.fTsumwx2 = histogram.fTsumwx2
        }
      }

      // Draw or redraw the canvas
      let painter = histogramPainters.current[config.id]
      if (!painter) {
        // First time - create painter
        painter = await window.JSROOT.redraw(element, canvas)
        histogramPainters.current[config.id] = painter

        // Setup zoom functionality
        setupZoomPersistence(painter, config)

        // Apply saved zoom ONLY once after first creation
        if (zoomToApply && zoomToApply.xmin < zoomToApply.xmax) {
          console.log(`Applying saved zoom to ${config.id}:`, zoomToApply)
          setTimeout(() => {
            const fp = painter.getFramePainter()
            if (fp && fp.zoom) {
              fp.zoom(zoomToApply.xmin, zoomToApply.xmax, 0, 0)
            }
          }, 100)
        }
      } else {
        // For existing painters, only redraw if primitives were rebuilt
        // Otherwise just update the display without full redraw to preserve zoom
        if (isFirstTime || shouldUpdateROIs(canvas, config)) {
          await window.JSROOT.redraw(element, canvas)
        } else {
          // Just refresh/repaint the existing painter without full redraw
          if (painter.redrawPad) {
            painter.redrawPad()
          } else if (painter.refresh) {
            painter.refresh()
          }
        }
      }
    } catch (error) {
      console.error(`Failed to update histogram ${config.id}:`, error)
    } finally {
      isUpdating.current[config.id] = false
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


  // Add ROI vertical lines to canvas primitives
  const addROILinesToCanvas = (canvas: any, config: HistogramConfig, histogram: any) => {
    // Get histogram Y range for proper line positioning
    const data = histogram.fArray
    const histMax = Math.max(...data)
    const histMin = Math.min(...data)
    // Get max from Canvas y axis
    const yAxis = canvas.fPrimitives.arr.find((p: any) => p._typename === "TAttAxis")
    const yMin = yAxis ? yAxis.fYmin : histMin

    //const yMin = 0.1 // 10% below min for visibility
    const yMax = 10 // 10% above max for visibility

    console.log(`Adding ROI lines at yMin=${yMin}, yMax=${yMax}`)


    // Add each enabled ROI as vertical boundary lines
    for (const roi of config.rois.filter((r) => r.enabled)) {
      try {
        console.log('ROI color:', roi.color)
        // Convert to RGB the string with #
        if (!roi.color.startsWith("#")) {
          roi.color = `#${roi.color}`
        }

        const rootColor = convertColorToRoot(roi.color)

        // Create vertical line at ROI low boundary
        const roiLineStart = window.JSROOT.create("TLine")
        roiLineStart.fX1 = roi.low
        roiLineStart.fY1 = yMin
        roiLineStart.fX2 = roi.high
        roiLineStart.fY2 = yMin
        roiLineStart.fLineColor = rootColor
        roiLineStart.fLineWidth = 4
        roiLineStart.fLineStyle = 1 // Dashed line
        roiLineStart.fName = `roi_start_${roi.id}`

        // Create vertical line at ROI high boundary
        const roiLineEnd = window.JSROOT.create("TLine")
        roiLineEnd.fX1 = roi.low
        roiLineEnd.fY1 = yMin
        roiLineEnd.fX2 = roi.high
        roiLineEnd.fY2 = yMin
        roiLineEnd.fLineColor = rootColor
        roiLineEnd.fLineWidth = 4
        roiLineEnd.fLineStyle = 1 // Dashed line
        roiLineEnd.fName = `roi_end_${roi.id}`

        // Add lines to canvas primitives
        canvas.fPrimitives.Add(roiLineStart, "")
        canvas.fPrimitives.Add(roiLineEnd, "")

        // Restore canvas min/max if needed

        console.log(`Added ROI vertical lines for ${roi.name}: start=${roi.low}, end=${roi.high}, color=${rootColor}`)
      } catch (error) {
        console.error(`Failed to add ROI lines for ${roi.name}:`, error)
      }
    }
  }

  // Convert hex color to ROOT color index
  const convertColorToRoot = (hexColor: string): number => {
    const colorMap: { [key: string]: number } = {
      "#ff0000": 2,
      "#00ff00": 3,
      "#0000ff": 4,
      "#ffff00": 5,
      "#ff00ff": 6,
      "#00ffff": 7,
      "#000000": 1,
      "#ffffff": 0,
      // Safari colors
      "#ff7f00": 8, // Orange
      "#7f00ff": 9, // Violet
      "#7f7f7f": 10, // Gray
      "#808080": 11, // Dark Gray
      "#800000": 12, // Maroon
      "#008000": 13, // Green
      "#000080": 14, // Navy
      "#7f7f00": 15, // Olive
      "#007f7f": 16, // Teal
      "#800080": 17, // Purple
    }
    return colorMap[hexColor.toLowerCase()] || 2
  }

  // Save zoom to cache
  const saveZoomToCache = async (histogramId: string, zoom: { xmin: number; xmax: number }) => {
    try {
      const zoomData = { ...zoom, timestamp: Date.now() }
      console.log(`Saving zoom for ${histogramId}:`, zoomData)

      // Save to cache API
      await fetch("/api/cache", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "zoom-range",
          histogramId,
          data: zoomData,
        }),
      })

      // Also update the histogram config locally
      const updatedHistograms = histograms.map((h) => (h.id === histogramId ? { ...h, zoomRange: zoomData } : h))
      setHistograms(updatedHistograms)
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
        console.log(`Found zoom in cache for ${histogramId}:`, data.data[histogramId])
        return data.data[histogramId]
      }

      // Fallback: check if zoom is in histogram config
      const config = histograms.find((h) => h.id === histogramId)
      if (config?.zoomRange) {
        console.log(`Found zoom in config for ${histogramId}:`, config.zoomRange)
        return config.zoomRange
      }

      console.log(`No zoom found for ${histogramId}`)
    } catch (error) {
      console.error("Failed to load zoom from cache:", error)
    }
    return null
  }

  // Sync zoom to other histograms
  const syncZoomToOthers = (sourceId: string, xmin: number, xmax: number) => {
    Object.entries(histogramPainters.current).forEach(([id, painter]) => {
      if (id !== sourceId && painter) {
        const fp = painter.getFramePainter()
        if (fp?.originalZoom) {
          fp.originalZoom(xmin, xmax, 0, 0)
          saveZoomToCache(id, { xmin, xmax })
        }
      }
    })
  }

  // Settings persistence using enhanced cache API
  const saveDashboardSettings = useCallback(
    async (settings: DashboardSettings) => {
      try {
        // Ensure minimum interval is 1 second (1000ms)
        const validatedSettings = {
          ...settings,
          updateInterval: Math.max(1000, settings.updateInterval),
        }

        await fetch("/api/cache", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "settings", data: validatedSettings }),
        })

        setDashboardSettings(validatedSettings)
        setRebinFactor(validatedSettings.rebinFactor)
        toast({
          title: "Settings Saved",
          description: "Dashboard settings have been saved successfully.",
        })
      } catch (error) {
        console.error("Failed to save dashboard settings:", error)
        toast({
          title: "Error",
          description: "Failed to save dashboard settings.",
          variant: "destructive",
        })
      }
    },
    [toast],
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

  const saveHistogramConfigs = useCallback(
    async (configs: HistogramConfig[]) => {
      try {
        await fetch("/api/cache", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "histograms", data: configs }),
        })
        setHistograms(configs)
      } catch (error) {
        console.error("Failed to save histogram configs:", error)
        toast({
          title: "Error",
          description: "Failed to save histogram configurations.",
          variant: "destructive",
        })
      }
    },
    [toast],
  )

  const loadHistogramConfigs = useCallback(async () => {
    try {
      const response = await fetch("/api/cache?type=histograms")
      const data = await response.json()
      if (data.success && data.data && Array.isArray(data.data) && data.data.length > 0) {
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
      delete histogramRefs.current[histogramId]
      delete histogramPainters.current[histogramId]
      delete canvasObjects.current[histogramId]
      delete isUpdating.current[histogramId]
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
    const updatedHistograms = histograms.find((h) => h.id === config.id)
      ? histograms.map((h) => (h.id === config.id ? config : h))
      : [...histograms, config]

    saveHistogramConfigs(updatedHistograms)
  }

  const deleteHistogram = (id: string) => {
    const updatedHistograms = histograms.filter((h) => h.id !== id)
    saveHistogramConfigs(updatedHistograms)

    // Clean up refs and painters
    delete histogramRefs.current[id]
    delete histogramPainters.current[id]
    delete canvasObjects.current[id]
    delete isUpdating.current[id]

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
    const updatedHistograms = histograms.map((h) => {
      if (h.id === histogramId) {
        const existingROI = h.rois.find((r) => r.id === roi.id)
        const updatedROIs = existingROI ? h.rois.map((r) => (r.id === roi.id ? roi : r)) : [...h.rois, roi]
        return { ...h, rois: updatedROIs }
      }
      return h
    })

    setHistograms(updatedHistograms)
    saveHistogramConfigs(updatedHistograms)

    // Refresh the specific histogram with new ROI
    setTimeout(() => {
      const config = updatedHistograms.find((h) => h.id === histogramId)
      if (config && config.visible) {
        updateHistogramData(config)
      }
    }, 100)
  }

  const deleteROI = (histogramId: string, roiId: string) => {
    const updatedHistograms = histograms.map((h) => {
      if (h.id === histogramId) {
        return { ...h, rois: h.rois.filter((r) => r.id !== roiId) }
      }
      return h
    })

    setHistograms(updatedHistograms)
    saveHistogramConfigs(updatedHistograms)

    // Refresh the specific histogram after ROI deletion
    setTimeout(() => {
      const config = updatedHistograms.find((h) => h.id === histogramId)
      if (config && config.visible) {
        updateHistogramData(config)
      }
    }, 100)
  }

  // Update ROI integrals for all visible histograms
  const updateROIIntegrals = async () => {
    const visibleHistograms = histograms.filter((h) => h.visible)

    // Batch all ROI integral requests
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

    // Wait for all integral calculations
    const results = await Promise.all(integralPromises)

    // Update histograms with new integrals in a single batch
    if (results.length > 0) {
      const updatedHistograms = histograms.map((h) => {
        const histogramIntegrals = results.filter((r) => r.histogramId === h.id)
        if (histogramIntegrals.length === 0) return h

        return {
          ...h,
          rois: h.rois.map((roi) => {
            const integralResult = histogramIntegrals.find((r) => r.roiId === roi.id)
            return integralResult ? { ...roi, integral: integralResult.integral } : roi
          }),
        }
      })

      setHistograms(updatedHistograms)
    }
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

    const updatedHistograms = histograms.map((h) => ({ ...h, zoomRange: undefined }))
    setHistograms(updatedHistograms)
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

  const visibleHistograms = histograms.filter((h) => h.visible)

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
            <Button onClick={toggleSyncZoom} variant={dashboardSettings.syncZoom ? "default" : "outline"}>
              {dashboardSettings.syncZoom ? "Unsync Zoom" : "Sync Zoom"}
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
          <div className={`grid ${getGridClass()} gap-6`}>
            {visibleHistograms.map((config) => (
              <Card key={config.id} className="relative">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-base font-semibold leading-tight">{config.label}</CardTitle>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" onClick={() => addROI(config.id)} title="Add ROI">
                      <Plus className="h-3 w-3" />
                    </Button>

                    {/* Edit Histogram */}
                    <Button variant="ghost" size="sm" onClick={() => editHistogram(config)} title="Edit Histogram">
                      <Edit className="h-3 w-3" />
                    </Button>

                    {/* Toggle Visibility */}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        const updated = { ...config, visible: !config.visible }
                        if (!updated.visible) {
                          removeHistogramFromCache(config.id)
                        }
                        saveHistogram(updated)
                      }}
                      title="Toggle Visibility"
                    >
                      {config.visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                    </Button>
                  </div>
                </CardHeader>

                <CardContent>
                  {/* ROI Information */}
                  {dashboardSettings.showROIs && config.rois.length > 0 && (
                    <div className="mb-3 space-y-2">
                      {config.rois
                        .filter((r) => r.enabled)
                        .map((roi) => (
                          <div key={roi.id} className="flex items-center justify-between p-2 bg-muted/30 rounded-md">
                            <div className="flex items-center gap-2">
                              <div
                                className="w-3 h-3 rounded-full border border-gray-400"
                                style={{ backgroundColor: roi.color }}
                              />
                              <span className="text-sm font-medium">{roi.name}</span>
                              <span className="text-xs text-muted-foreground font-mono">
                                [{roi.low} - {roi.high}]
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              {dashboardSettings.showIntegrals && (
                                <span className="text-sm font-mono bg-background px-2 py-1 rounded border">
                                  {roi.integral.toLocaleString()}
                                </span>
                              )}
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => editROI(config.id, roi)}
                                className="h-6 w-6 p-0"
                              >
                                <Edit className="h-3 w-3" />
                              </Button>
                            </div>
                          </div>
                        ))}
                    </div>
                  )}

                  {/* Histogram Display */}
                  <div
                    ref={(el) => {
                      histogramRefs.current[config.id] = el
                    }}
                    className={`w-full ${getHistogramSize(config.size)} border rounded-lg shadow-md bg-white dark:bg-gray-900`}
                  />
                </CardContent>
              </Card>
            ))}
          </div>
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
