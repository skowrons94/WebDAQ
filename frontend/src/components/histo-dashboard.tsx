"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import {
  getBoardConfiguration,
  getRunStatus,
  getCurrentRunNumber,
  getHistogram,
  getRoiHistogram,
  getRoiIntegral,
  getRebinFactor,
  setRebinFactor,
} from "@/lib/api"
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

// Enhanced Types
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

type ROIValues = {
  [key: string]: ROI[]
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
  zoomRange?: { xmin: number; xmax: number; ymin: number; ymax: number }
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

type ZoomRanges = {
  [histogramId: string]: {
    xmin: number
    xmax: number
    ymin: number
    ymax: number
    timestamp: number
  }
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
  const [label, setLabel] = useState(histogram?.label || "")
  const [customLabel, setCustomLabel] = useState(histogram?.customLabel || "")
  const [visible, setVisible] = useState(histogram?.visible ?? true)

  useEffect(() => {
    if (histogram) {
      setBoardId(histogram.boardId)
      setChannel(histogram.channel)
      setSize(histogram.size)
      setLabel(histogram.label)
      setCustomLabel(histogram.customLabel || "")
      setVisible(histogram.visible)
    } else {
      setBoardId("")
      setChannel(0)
      setSize("medium")
      setLabel("")
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
  const [isRunning, setIsRunning] = useState(false)
  const [runNumber, setRunNumber] = useState<number | null>(null)
  const [jsrootLoaded, setJsrootLoaded] = useState(false)
  const [updateTrigger, setUpdateTrigger] = useState(0)

  // Enhanced state management
  const [histograms, setHistograms] = useState<HistogramConfig[]>([])
  const [roiValues, setRoiValues] = useState<ROIValues>({})
  const [zoomRanges, setZoomRanges] = useState<ZoomRanges>({})
  const [dashboardSettings, setDashboardSettings] = useState<DashboardSettings>({
    layout: "grid",
    gridCols: 3,
    isLogScale: false,
    syncZoom: false,
    showLabels: true,
    showROIs: true,
    showIntegrals: true,
    autoUpdate: true,
    updateInterval: 2000,
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

  const histogramRefs = useRef<{ [key: string]: HTMLDivElement | null }>({})
  const framePainters = useRef<{ [key: string]: any }>({})
  const currentZoomRanges = useRef<{ [key: string]: { xmin: number; xmax: number; ymin: number; ymax: number } }>({})
  const initialDrawComplete = useRef<{ [key: string]: boolean }>({}) // Add this line

  const { toast } = useToast()
  const { theme } = useTheme()

  // State to track if app is initialized to avoid default generation
  const [appInitialized, setAppInitialized] = useState(false)

  // Zoom ranges are now automatically saved on every zoom change

  // Load saved settings and histograms
  useEffect(() => {
    const initializeApp = async () => {
      // Load settings, histograms, and zoom ranges
      await loadDashboardSettings()
      await loadHistogramConfigs()
      await loadZoomRanges()

      // Then fetch board configuration
      await fetchBoardConfiguration()
      await fetchRunStatus()

      setAppInitialized(true)
    }

    initializeApp()

    const statusInterval = setInterval(fetchRunStatus, 5000)

    loadJSROOT()
      .then(() => {
        setJsrootLoaded(true)
      })
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

  // Generate default histograms after app initialization if none exist
  useEffect(() => {
    if (appInitialized && histograms.length === 0 && boards.length > 0) {
      generateDefaultHistograms(boards)
    }
  }, [appInitialized, histograms.length, boards])

  // Initialize histograms when JSROOT loads and histograms are available
  useEffect(() => {
    if (jsrootLoaded && histograms.length > 0) {
      setTimeout(() => {
        // Initialize blank histograms
        if (window.JSROOT) {
          histograms.forEach((config) => {
            if (config.visible) {
              const histoElement = histogramRefs.current[config.id]
              if (histoElement) {
                const blankHist = window.JSROOT.createHistogram("TH1F", 100)
                blankHist.fName = config.id
                blankHist.fTitle = config.label
                window.JSROOT.redraw(histoElement, blankHist, "hist")
              }
            }
          })
        }
      }, 100)
    }
  }, [jsrootLoaded, histograms])

  // Auto-update histograms
  useEffect(() => {
    if (dashboardSettings.autoUpdate && jsrootLoaded && boards.length > 0) {
      const updateInterval = setInterval(() => {
        updateHistograms()
        updateROIIntegrals()
        setUpdateTrigger((prev) => prev + 1)
      }, dashboardSettings.updateInterval)

      return () => clearInterval(updateInterval)
    }
  }, [jsrootLoaded, boards, dashboardSettings.autoUpdate, dashboardSettings.updateInterval])

  // JSROOT theme handling
  useEffect(() => {
    if (jsrootLoaded) {
      const effectiveTheme = dashboardSettings.theme === "auto" ? theme : dashboardSettings.theme
      window.JSROOT.settings.DarkMode = effectiveTheme === "dark"
    }
  }, [jsrootLoaded, theme, dashboardSettings.theme])

  // Trigger histogram updates when settings change - FIXED: Immediate updates
  useEffect(() => {
    if (jsrootLoaded && histograms.length > 0) {
      // Force immediate re-render when settings change
      const forceUpdate = async () => {
        if (window.JSROOT) {
          const visibleHistograms = histograms.filter((h) => h.visible)

          for (const config of visibleHistograms) {
            const histoElement = histogramRefs.current[config.id]
            if (histoElement) {
              try {
                const histogramData = await getHistogram(config.boardId, config.channel.toString())
                const histogram = window.JSROOT.parse(histogramData)
                await drawHistogramWithROIs(histoElement, histogram, config)
              } catch (error) {
                console.error(`Failed to update histogram for ${config.id}:`, error)
                // Draw blank histogram on error
                const blankHist = window.JSROOT.createHistogram("TH1F", 100)
                blankHist.fName = config.id
                blankHist.fTitle = config.label
                window.JSROOT.redraw(histoElement, blankHist, "hist")
              }
            }
          }
        }
      }

      forceUpdate()
    }
  }, [
    jsrootLoaded,
    histograms,
    dashboardSettings.isLogScale,
    dashboardSettings.showROIs,
    dashboardSettings.showIntegrals,
    dashboardSettings.rebinFactor,
  ])

  // NEW: Load zoom ranges from cache
  const loadZoomRanges = useCallback(async () => {
    try {
      const response = await fetch("/api/cache?type=zoom-ranges")
      const data = await response.json()
      if (data.success && data.data) {
        setZoomRanges(data.data)
        // Also update the current zoom ranges ref
        currentZoomRanges.current = Object.fromEntries(
          Object.entries(data.data).map(([id, zoom]: [string, any]) => [
            id,
            { xmin: zoom.xmin, xmax: zoom.xmax, ymin: zoom.ymin, ymax: zoom.ymax },
          ]),
        )
      }
    } catch (error) {
      console.error("Failed to load zoom ranges:", error)
    }
  }, [])

  // Settings persistence using enhanced cache API
  const saveDashboardSettings = useCallback(
    async (settings: DashboardSettings) => {
      try {
        await fetch("/api/cache", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "settings", data: settings }),
        })

        // Update rebin factor via API
        if (settings.rebinFactor !== dashboardSettings.rebinFactor) {
          try {
            await setRebinFactor(settings.rebinFactor)
          } catch (error) {
            console.error("Failed to set rebin factor:", error)
          }
        }

        setDashboardSettings(settings)
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
    [toast, dashboardSettings.rebinFactor],
  )

  const loadDashboardSettings = useCallback(async () => {
    try {
      const response = await fetch("/api/cache?type=settings")
      const data = await response.json()
      if (data.success && data.data) {
        // Ensure minimum update interval of 2000ms
        const settings = {
          ...data.data,
          updateInterval: Math.max(2000, data.data.updateInterval || 2000),
          rebinFactor: data.data.rebinFactor || 1,
        }

        // Load rebin factor from API
        try {
          const apiRebinFactor = await getRebinFactor()
          settings.rebinFactor = apiRebinFactor
        } catch (error) {
          console.error("Failed to get rebin factor:", error)
        }

        setDashboardSettings((prev) => ({ ...prev, ...settings }))
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

        // Also save ROI data from configs
        const roiData: ROIValues = {}
        configs.forEach((config) => {
          if (config.rois && config.rois.length > 0) {
            roiData[config.id] = config.rois
          }
        })
        setRoiValues(roiData)

        await fetch("/api/cache", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "rois", data: roiData }),
        })
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

        // Load ROI data as well
        const roiResponse = await fetch("/api/cache?type=rois")
        const roiData = await roiResponse.json()
        if (roiData.success && roiData.data) {
          setRoiValues(roiData.data)
        }
      }
    } catch (error) {
      console.error("Failed to load histogram configs:", error)
    }
  }, [])

  // FIXED: Remove from cache when visibility is toggled off
  const removeHistogramFromCache = useCallback(async (histogramId: string) => {
    try {
      await fetch("/api/cache", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "histogram", id: histogramId }),
      })

      // Also remove from local zoom ranges
      setZoomRanges((prev) => {
        const updated = { ...prev }
        delete updated[histogramId]
        return updated
      })

      // Clear from current zoom ranges ref
      delete currentZoomRanges.current[histogramId]
      delete initialDrawComplete.current[histogramId] // Add this line
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
      const [statusResponse, runNumberResponse] = await Promise.all([getRunStatus(), getCurrentRunNumber()])
      setIsRunning(statusResponse)
      setRunNumber(runNumberResponse)
    } catch (error) {
      console.error("Failed to fetch run status:", error)
    }
  }

  // Generate default histograms
  const generateDefaultHistograms = (boardData: BoardData[]) => {
    const defaultConfigs: HistogramConfig[] = []

    boardData.forEach((board) => {
      for (let channel = 0; channel < Number.parseInt(board.chan); channel++) {
        const config: HistogramConfig = {
          id: `hist_${board.id}_${channel}`,
          boardId: board.id,
          channel,
          visible: true,
          size: "medium",
          label: `${board.name} - Channel ${channel}`,
          position: { row: Math.floor(defaultConfigs.length / 3), col: defaultConfigs.length % 3 },
          rois: [
            {
              id: `roi_default_${board.id}_${channel}`,
              name: "Default ROI",
              low: 0,
              high: 1000,
              integral: 0,
              color: "#ff0000",
              enabled: true,
            },
          ],
        }
        defaultConfigs.push(config)
      }
    })

    saveHistogramConfigs(defaultConfigs)
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
    if (histogramRefs.current[id]) {
      delete histogramRefs.current[id]
    }
    if (framePainters.current[id]) {
      delete framePainters.current[id]
    }
    if (currentZoomRanges.current[id]) {
      delete currentZoomRanges.current[id]
    }
    if (initialDrawComplete.current[id]) {
      // Add this line
      delete initialDrawComplete.current[id]
    }
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

    // Update local state immediately before saving
    setHistograms(updatedHistograms)
    
    // Update ROI values immediately for display
    const updatedRoiValues = { ...roiValues }
    updatedRoiValues[histogramId] = updatedHistograms.find((h) => h.id === histogramId)?.rois || []
    setRoiValues(updatedRoiValues)

    // Save to persistent storage
    saveHistogramConfigs(updatedHistograms)
  }

  const deleteROI = (histogramId: string, roiId: string) => {
    const updatedHistograms = histograms.map((h) => {
      if (h.id === histogramId) {
        return { ...h, rois: h.rois.filter((r) => r.id !== roiId) }
      }
      return h
    })

    saveHistogramConfigs(updatedHistograms)
  }

  // Zoom management
  const resetAllZoom = () => {
    Object.values(framePainters.current).forEach((fp) => {
      if (fp && fp.zoom) {
        fp.zoom(0, 0, 0, 0) // Reset to default zoom
      }
    })

    // Clear stored zoom ranges
    currentZoomRanges.current = {}

    // Clear cached zoom ranges
    fetch("/api/cache", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "zoom-ranges" }),
    }).catch((error) => console.error("Failed to clear zoom ranges:", error))

    setZoomRanges({})

    toast({
      title: "Zoom Reset",
      description: "All histograms have been reset to default zoom.",
    })
  }

  const toggleSyncZoom = () => {
    const newSyncState = !dashboardSettings.syncZoom
    saveDashboardSettings({ ...dashboardSettings, syncZoom: newSyncState })

    // Apply sync logic to frame painters
    Object.entries(framePainters.current).forEach(([histoId, fp]) => {
      if (fp && fp.oldZoom) {
        if (newSyncState) {
          // Enable synchronized zoom with automatic saving
          fp.zoom = (xmin: number, xmax: number, ymin: number, ymax: number, zmin?: number, zmax?: number) => {
            const zoomRange = { xmin, xmax, ymin, ymax }
            currentZoomRanges.current[histoId] = zoomRange

            // Automatically save zoom changes to cache
            const zoomToSave = {
              ...zoomRange,
              timestamp: Date.now(),
            }
            
            // Update local zoom ranges state
            setZoomRanges(prev => ({
              ...prev,
              [histoId]: zoomToSave
            }))

            Object.entries(framePainters.current).forEach(([id, painter]) => {
              if (id !== histoId && painter && painter.oldZoom) {
                painter.oldZoom(xmin, xmax, painter.scale_ymin, painter.scale_ymax, zmin, zmax)
                const syncZoomRange = {
                  xmin,
                  xmax,
                  ymin: painter.scale_ymin,
                  ymax: painter.scale_ymax,
                }
                currentZoomRanges.current[id] = syncZoomRange
                
                // Save synced zoom as well
                const syncZoomToSave = {
                  ...syncZoomRange,
                  timestamp: Date.now(),
                }
                setZoomRanges(prev => ({
                  ...prev,
                  [id]: syncZoomToSave
                }))
              }
            })

            // Save all zoom ranges to cache
            fetch("/api/cache", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                type: "zoom-ranges",
                data: { ...zoomRanges, [histoId]: zoomToSave },
              }),
            }).catch(error => console.error("Failed to save zoom ranges:", error))

            return fp.oldZoom(xmin, xmax, ymin, ymax, zmin, zmax)
          }
        } else {
          // Restore original zoom function
          fp.zoom = fp.oldZoom
        }
      }
    })

    toast({
      title: `Synchronized Zooming ${newSyncState ? "Enabled" : "Disabled"}`,
      description: `Histograms will ${newSyncState ? "now" : "no longer"} zoom together.`,
    })
  }

  // Histogram rendering

  const updateHistograms = useCallback(async () => {
    if (!window.JSROOT) return

    for (const config of histograms.filter((h) => h.visible)) {
      const histoElement = histogramRefs.current[config.id]
      if (histoElement) {
        try {
          const histogramData = await getHistogram(config.boardId, config.channel.toString())
          const histogram = window.JSROOT.parse(histogramData)
          await drawHistogramWithROIs(histoElement, histogram, config)
        } catch (error) {
          console.error(`Failed to fetch histogram for ${config.id}:`, error)
          // Draw blank histogram on error
          const blankHist = window.JSROOT.createHistogram("TH1F", 100)
          blankHist.fName = config.id
          blankHist.fTitle = config.label
          window.JSROOT.redraw(histoElement, blankHist, "hist")
        }
      }
    }
  }, [histograms, dashboardSettings.isLogScale, dashboardSettings.showROIs])

  const updateROIIntegrals = useCallback(async () => {
    for (const config of histograms.filter((h) => h.visible)) {
      for (const roi of config.rois.filter((r) => r.enabled)) {
        try {
          const integral = await getRoiIntegral(config.boardId, config.channel.toString(), roi.low, roi.high)

          // Update the ROI integral in the histogram config
          const updatedHistograms = histograms.map((h) => {
            if (h.id === config.id) {
              return {
                ...h,
                rois: h.rois.map((r) => (r.id === roi.id ? { ...r, integral } : r)),
              }
            }
            return h
          })

          setHistograms(updatedHistograms)
        } catch (error) {
          console.error(`Failed to get ROI integral for ${config.id}:`, error)
        }
      }
    }
  }, [histograms])

  const drawHistogramWithROIs = async (element: HTMLDivElement, histogram: any, config: HistogramConfig) => {
    if (window.JSROOT) {
      const canv = window.JSROOT.create("TCanvas")

      // Style main histogram
      histogram.fLineColor = 4
      histogram.fFillColor = 4
      histogram.fFillStyle = 3001
      histogram.fTitle = dashboardSettings.showLabels ? config.label : ""

      canv.fName = "c1"
      canv.fPrimitives.Add(histogram, "histo")

      // Add ROIs if enabled
      if (dashboardSettings.showROIs) {
        for (const roi of config.rois.filter((r) => r.enabled)) {
          try {
            const roiData = await getRoiHistogram(config.boardId, config.channel.toString(), roi.low, roi.high)
            const roiHistogram = window.JSROOT.parse(roiData)

            // Convert hex color to ROOT color index (simplified)
            const colorMap = {
              "#ff0000": 2,
              "#00ff00": 3,
              "#0000ff": 4,
              "#ffff00": 5,
              "#ff00ff": 6,
              "#00ffff": 7,
              "#000000": 1,
              "#ffffff": 0,
            }
            const rootColor = colorMap[roi.color as keyof typeof colorMap] || 2

            roiHistogram.fLineColor = rootColor
            roiHistogram.fFillColor = rootColor
            roiHistogram.fFillStyle = 3001

            canv.fPrimitives.Add(roiHistogram, "histo")
          } catch (error) {
            console.error(`Failed to draw ROI ${roi.name}:`, error)
          }
        }
      }

      // Apply log scale
      if (dashboardSettings.isLogScale) {
        canv.fLogy = 1
      } else {
        canv.fLogy = 0
      }

      // Redraw with new data
      const painter = await window.JSROOT.redraw(element, canv)

      // Setup frame painter
      if (painter && painter.getFramePainter) {
        const fp = painter.getFramePainter()
        if (fp) {
          framePainters.current[config.id] = fp

          // Setup zoom synchronization without automatic persistence (only once)
          if (!fp.syncedZoomSetup) {
            fp.oldZoom = fp.zoom
            fp.syncedZoomSetup = true

            // Enhanced zoom function to track and automatically save zoom changes
            fp.zoom = (xmin: number, xmax: number, ymin: number, ymax: number, zmin?: number, zmax?: number) => {
              const zoomRange = { xmin, xmax, ymin, ymax }
              currentZoomRanges.current[config.id] = zoomRange

              // Automatically save zoom changes to cache
              const zoomToSave = {
                ...zoomRange,
                timestamp: Date.now(),
              }
              
              // Update local zoom ranges state
              setZoomRanges(prev => ({
                ...prev,
                [config.id]: zoomToSave
              }))
              
              // Save to cache asynchronously
              fetch("/api/cache", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  type: "zoom-ranges",
                  data: { ...zoomRanges, [config.id]: zoomToSave },
                }),
              }).catch(error => console.error("Failed to save zoom range:", error))

              if (dashboardSettings.syncZoom) {
                Object.entries(framePainters.current).forEach(([id, painter]) => {
                  if (id !== config.id && painter && painter.oldZoom) {
                    painter.oldZoom(xmin, xmax, painter.scale_ymin, painter.scale_ymax, zmin, zmax)
                    const syncZoomRange = {
                      xmin,
                      xmax,
                      ymin: painter.scale_ymin,
                      ymax: painter.scale_ymax,
                    }
                    currentZoomRanges.current[id] = syncZoomRange
                    
                    // Save synced zoom as well
                    const syncZoomToSave = {
                      ...syncZoomRange,
                      timestamp: Date.now(),
                    }
                    setZoomRanges(prev => ({
                      ...prev,
                      [id]: syncZoomToSave
                    }))
                  }
                })
              }

              return fp.oldZoom(xmin, xmax, ymin, ymax, zmin, zmax)
            }

            // ONLY restore zoom on initial draw, not on updates
            const isInitialDraw = !initialDrawComplete.current[config.id]
            if (isInitialDraw) {
              // Mark as initially drawn
              initialDrawComplete.current[config.id] = true

              // Determine which zoom to apply (priority order)
              const cachedZoom = zoomRanges[config.id]
              const configZoom = config.zoomRange
              const zoomToApply = cachedZoom || configZoom

              if (zoomToApply) {
                // Apply zoom after a short delay to ensure painter is fully ready
                setTimeout(() => {
                  if (fp.zoom && fp.scale_xmin !== undefined) {
                    // Validate zoom ranges before applying
                    const isValidZoom =
                      zoomToApply.xmin < zoomToApply.xmax &&
                      zoomToApply.ymin < zoomToApply.ymax &&
                      !isNaN(zoomToApply.xmin) &&
                      !isNaN(zoomToApply.xmax) &&
                      !isNaN(zoomToApply.ymin) &&
                      !isNaN(zoomToApply.ymax) &&
                      isFinite(zoomToApply.xmin) &&
                      isFinite(zoomToApply.xmax) &&
                      isFinite(zoomToApply.ymin) &&
                      isFinite(zoomToApply.ymax)

                    if (isValidZoom) {
                      try {
                        fp.zoom(zoomToApply.xmin, zoomToApply.xmax, zoomToApply.ymin, zoomToApply.ymax)
                        // Update current zoom ranges after successful application
                        currentZoomRanges.current[config.id] = {
                          xmin: zoomToApply.xmin,
                          xmax: zoomToApply.xmax,
                          ymin: zoomToApply.ymin,
                          ymax: zoomToApply.ymax
                        }
                        console.log(`Applied saved zoom for ${config.id}:`, zoomToApply)
                      } catch (error) {
                        console.error(`Failed to apply zoom for ${config.id}:`, error)
                      }
                    } else {
                      console.warn(`Invalid zoom range for ${config.id}:`, zoomToApply)
                    }
                  }
                }, 150)
              }
            }
          }
          
          // Apply saved zoom ranges on every update (similar to toggleSyncZoom behavior)
          const savedZoom = zoomRanges[config.id] || currentZoomRanges.current[config.id]
          if (savedZoom && fp.zoom) {
            // Apply saved zoom after a short delay to ensure painter is ready
            setTimeout(() => {
              if (fp.zoom && fp.scale_xmin !== undefined) {
                // Validate zoom ranges before applying
                const isValidZoom =
                  savedZoom.xmin < savedZoom.xmax &&
                  savedZoom.ymin < savedZoom.ymax &&
                  !isNaN(savedZoom.xmin) &&
                  !isNaN(savedZoom.xmax) &&
                  !isNaN(savedZoom.ymin) &&
                  !isNaN(savedZoom.ymax) &&
                  isFinite(savedZoom.xmin) &&
                  isFinite(savedZoom.xmax) &&
                  isFinite(savedZoom.ymin) &&
                  isFinite(savedZoom.ymax)

                if (isValidZoom) {
                  try {
                    // Use oldZoom to avoid triggering the save mechanism
                    fp.oldZoom(savedZoom.xmin, savedZoom.xmax, savedZoom.ymin, savedZoom.ymax)
                    console.log(`Applied saved zoom for ${config.id}:`, savedZoom)
                  } catch (error) {
                    console.error(`Failed to apply saved zoom for ${config.id}:`, error)
                  }
                }
              }
            }, 50)
          }
        }
      }
    }
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
    if (dashboardSettings.layout === "custom") return "grid-cols-1" // Custom positioning handled separately
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

            {/* ADDED: Rebin Factor Input */}
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

        {/* Histograms Grid */}
        <div className={`grid ${getGridClass()} gap-6`}>
          {visibleHistograms.map((config) => (
            <Card key={config.id} className="relative">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-base font-semibold leading-tight">{config.label}</CardTitle>
                <div className="flex items-center gap-1">
                  {/* ROI Controls */}
                  <Button variant="ghost" size="sm" onClick={() => addROI(config.id)} title="Add ROI">
                    <Plus className="h-3 w-3" />
                  </Button>

                  {/* Edit Histogram */}
                  <Button variant="ghost" size="sm" onClick={() => editHistogram(config)} title="Edit Histogram">
                    <Edit className="h-3 w-3" />
                  </Button>

                  {/* Toggle Visibility - FIXED: Remove from cache when toggled off */}
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
                {/* IMPROVED: ROI Information with better styling and alignment */}
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
                      const value = Math.max(2000, Math.round(Number(e.target.value) / 500) * 500)
                      saveDashboardSettings({ ...dashboardSettings, updateInterval: value })
                    }}
                    min={2000}
                    max={10000}
                    step={500}
                  />
                  <span className="text-xs text-muted-foreground">Minimum: 2000ms, Steps: 500ms</span>
                </div>
              </div>

              {/* ADDED: Rebin Factor in Settings */}
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
