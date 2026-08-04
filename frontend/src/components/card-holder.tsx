'use client'

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  Activity,
  BarChart,
  BatteryCharging,
  HardDrive,
  CheckCircle,
  XCircle,
  Cpu,
  Wifi,
  WifiOff,
  Save,
  AudioWaveform,
  Server,
  GripHorizontal,
  Pencil,
} from "lucide-react"

import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { useToast } from '@/components/ui/use-toast'
import { useVisualizationStore } from '@/store/visualization-settings-store'
import { useMetricsStore } from '@/store/metrics-store'
import { useStatsStore } from '@/store/stats-store'
import {
  getFileBandwidth,
  getConnectedCurrent,
  getIpCurrent,
  getPortCurrent,
  getMetricData,
  getBoardStatus,
  getBoardConfiguration,
  getBoardConnectivity,
  getStatsPaths,
  getStatsMetricLastValue,
  getCurrentModuleType,
  getCurrentModuleSettings,
  getRunMetadataAll,
  getSaveData,
  getWaveformStatusPerBoard,
  activateWaveformBoard,
  deactivateWaveformBoard,
  getCurrentStatus,
  getStatsRunStatus,
  setRunNumber,
  setSaveData,
} from '@/lib/api'
import {
  type ROI,
  getHistogramDashboardConfig,
  getROIIntegrals,
  roiKey,
} from '@/lib/histogram-config'
import { Slider } from "@/components/ui/slider"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/**
 * An ROI plus what it currently reads. The definition comes from the server;
 * `integral`, `rate` and `lastUpdateTime` are measurements this component
 * derives between refreshes and are deliberately not part of the stored record.
 */
type ROIMeasurement = ROI & {
  integral: number;
  rate: number;
  lastUpdateTime: number;
}

type ROICardData = {
  histogramId: string;
  histogramLabel: string;
  boardId: string;
  channel: number;
  roi: ROIMeasurement;
}

type BoardStatus = {
  failed: boolean;
  last_value: number;
}

type BoardConnectivity = {
  connected: boolean;
  ready: boolean;
  failed: boolean;
}

type BoardInfo = {
  id: string;
  name: string;
  link_type: string;
  link_num: number;
  vme: string;
  dpp: string;
  chan: number;
}


// What each beam-current source is called on screen. An unrecognised one keeps
// its own name: showing it under another module's is how a Graphite metric came
// to be labelled "TetrAMM".
const CURRENT_MODULE_LABELS: Record<string, string> = {
  tetramm: 'TetrAMM',
  rbd9103: 'RBD 9103',
  graphite: 'Monitored value',
}

// Sources that are a physical picoammeter, and so have a device card worth
// showing: an address to reach, a range, a connection that can drop. A
// monitored Graphite metric has none of those — it is a number the accelerator
// already publishes — so it gets no such card.
const PICOAMMETER_MODULES = new Set(['tetramm', 'rbd9103'])


interface CardHolderProps {
  isRunning: boolean
  timer: number
  startTime: string | null
  runNumber: number | null
  expandForBeam?: boolean
  // Let the run status card push the run number and the data saving flag back
  // to whoever owns them, so the whole dashboard agrees without a round trip.
  onRunNumberChange?: (runNumber: number) => void
  onSaveDataChange?: (save: boolean) => void
}

// How far the run number slider reaches on either side of where it starts. Wide
// enough to jump back over a spoiled series, narrow enough to stay usable; the
// number box next to it takes anything.
const RUN_SLIDER_SPAN = 25

// Each card row is 11.5rem with a 1.5rem gap. These viewport heights end after
// the row padding, before the following row begins, so no clipped preview of
// the next row appears beneath the pull handle.
const STATUS_PANEL_HEIGHTS = [220, 428, 636] as const
const DEFAULT_STATUS_PANEL_HEIGHT = STATUS_PANEL_HEIGHTS[0]
const STATUS_PANEL_STORAGE_KEY = 'overview-status-panel-height-v3'

export function CardHolder({
  isRunning,
  timer,
  startTime,
  runNumber,
  expandForBeam = false,
  onRunNumberChange,
  onSaveDataChange,
}: CardHolderProps) {
  const { toast } = useToast()
  const { settings } = useVisualizationStore()
  // Treat a missing flag (older persisted settings) as enabled.
  const currentEnabled = settings.currentEnabled !== false
  const { metrics } = useMetricsStore()
  const { paths, currentValues, setPaths, setCurrentValue } = useStatsStore()
  const [visibleMetrics, setVisibleMetrics] = useState(() => metrics.filter(metric => metric.isVisible))

  const [roiCards, setRoiCards] = useState<ROICardData[]>([])
  const [fileBandwidth, setFileBandwidth] = useState<number>(0)
  const [isConnectedCurrent, setIsConnectedCurrent] = useState(false)
  const [ipCurrent, setIpCurrent] = useState<string>('')
  const [portCurrent, setPortCurrent] = useState<string>('')
  // null until the server has said which module is configured. Defaulting to a
  // device would flash that device's card at someone using a different one.
  const [currentModuleType, setCurrentModuleType] = useState<string | null>(null)
  const [currentModuleName, setCurrentModuleName] = useState<string>('')
  // Device settings as the server reports them. The address differs by module:
  // the TetrAMM has ip + port, the RBD 9103 has a serial port and no ip at all.
  const [currentModuleInfo, setCurrentModuleInfo] = useState<{
    module_type?: string
    ip?: string
    port?: string | number
    settings?: Record<string, string>
  } | null>(null)
  const [metricValues, setMetricValues] = useState<{ [key: string]: number }>({})
  const [boardStatus, setBoardStatus] = useState<{ [key: string]: BoardStatus }>({})
  const [boardConnectivity, setBoardConnectivity] = useState<{ [key: string]: BoardConnectivity }>({})
  const [boards, setBoards] = useState<BoardInfo[]>([])
  // The most recent finished run: its number and how long it lasted, shown
  // under the run number on the status card.
  const [lastRun, setLastRun] = useState<{ number: number; duration: number } | null>(null)
  const [dataSavingEnabled, setDataSavingEnabled] = useState<boolean>(false)
  // Run number editor, opened by clicking the run number on the status card.
  const [runEditorOpen, setRunEditorOpen] = useState(false)
  const [runDraft, setRunDraft] = useState<number>(0)
  const [runDraftText, setRunDraftText] = useState<string>('')
  const [savingRunNumber, setSavingRunNumber] = useState(false)
  // Pinned when the editor opens: bounds that moved with the draft would make
  // the handle crawl instead of slide.
  const [runSliderMin, setRunSliderMin] = useState(0)
  const [runSliderMax, setRunSliderMax] = useState(RUN_SLIDER_SPAN)
  const [boardWaveforms, setBoardWaveforms] = useState<{ [boardId: string]: boolean }>({})
  const [currentAcquiring, setCurrentAcquiring] = useState<boolean>(false)
  // The device is sampling (independent of whether a run is logging it).
  const [currentSampling, setCurrentSampling] = useState<boolean>(false)
  const [statsCollecting, setStatsCollecting] = useState<boolean>(false)
  const [statsCount, setStatsCount] = useState<number>(0)
  const intervalRefs = useRef<{ [key: string]: NodeJS.Timeout }>({})
  const roiDataHistoryRef = useRef<{ [key: string]: ROIMeasurement }>({})
  const [statusPanelHeight, setStatusPanelHeight] = useState<number>(DEFAULT_STATUS_PANEL_HEIGHT)
  const minimumStatusPanelHeight = expandForBeam
    ? STATUS_PANEL_HEIGHTS[1]
    : STATUS_PANEL_HEIGHTS[0]
  const displayedStatusPanelHeight = Math.max(statusPanelHeight, minimumStatusPanelHeight)
  const availableStatusPanelHeights = STATUS_PANEL_HEIGHTS.filter(
    height => height >= minimumStatusPanelHeight,
  )
  const [isResizingStatusPanel, setIsResizingStatusPanel] = useState(false)
  const statusPanelDragRef = useRef<{
    pointerId: number
    startY: number
    startHeight: number
  } | null>(null)

  useEffect(() => {
    const stored = Number(window.localStorage.getItem(STATUS_PANEL_STORAGE_KEY))
    if (STATUS_PANEL_HEIGHTS.includes(stored as typeof STATUS_PANEL_HEIGHTS[number])) {
      setStatusPanelHeight(stored)
    }
  }, [])

  const snapStatusPanelHeight = useCallback((height: number) => {
    const snapped = availableStatusPanelHeights.reduce((closest, candidate) =>
      Math.abs(candidate - height) < Math.abs(closest - height) ? candidate : closest)
    setStatusPanelHeight(snapped)
    window.localStorage.setItem(STATUS_PANEL_STORAGE_KEY, String(snapped))
  }, [availableStatusPanelHeights])

  const handleStatusResizeStart = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    statusPanelDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: displayedStatusPanelHeight,
    }
    setIsResizingStatusPanel(true)
  }

  const handleStatusResizeMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = statusPanelDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const nextHeight = Math.min(
      STATUS_PANEL_HEIGHTS[STATUS_PANEL_HEIGHTS.length - 1],
      Math.max(minimumStatusPanelHeight, drag.startHeight + event.clientY - drag.startY),
    )
    setStatusPanelHeight(nextHeight)
  }

  const handleStatusResizeEnd = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = statusPanelDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const finalHeight = Math.min(
      STATUS_PANEL_HEIGHTS[STATUS_PANEL_HEIGHTS.length - 1],
      Math.max(minimumStatusPanelHeight, drag.startHeight + event.clientY - drag.startY),
    )
    statusPanelDragRef.current = null
    setIsResizingStatusPanel(false)
    snapStatusPanelHeight(finalHeight)
  }

  const handleStatusResizeKey = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = availableStatusPanelHeights.reduce((closestIndex, height, index) =>
      Math.abs(height - displayedStatusPanelHeight) <
      Math.abs(availableStatusPanelHeights[closestIndex] - displayedStatusPanelHeight)
        ? index
        : closestIndex, 0)
    const direction = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (!direction) return
    event.preventDefault()
    const nextIndex = Math.min(
      availableStatusPanelHeights.length - 1,
      Math.max(0, currentIndex + direction),
    )
    snapStatusPanelHeight(availableStatusPanelHeights[nextIndex])
  }

  useEffect(() => {
    setVisibleMetrics(metrics.filter(metric => metric.isVisible))
  }, [metrics])

  // Load stats paths on mount
  useEffect(() => {
    const loadStatsPaths = async () => {
      try {
        const data = await getStatsPaths()
        setPaths(data || [])
        // Immediately fetch values after loading paths to avoid showing N/A on page refresh
        if (data && data.length > 0) {
          for (const path of data.filter((p: any) => p.enabled)) {
            try {
              const valueData = await getStatsMetricLastValue(path.path)
              if (valueData && valueData.value !== undefined && valueData.value !== null) {
                setCurrentValue(path.path, valueData.value, valueData.timestamp)
              }
            } catch (error) {
              console.error(`Failed to fetch initial value for ${path.path}:`, error)
            }
          }
        }
      } catch (error) {
        console.error('Failed to fetch stats paths:', error)
      }
    }

    loadStatsPaths()
  }, [setPaths, setCurrentValue])

  // Update last run duration when run stops
  useEffect(() => {
    if (!isRunning) {
      updateLastRunDuration()
    }
  }, [isRunning])

  useEffect(() => {
    const fetchInitialData = async () => {
      try {
        const [ip, port, isConnected, moduleType, moduleSettings] = await Promise.all([
          getIpCurrent(),
          getPortCurrent(),
          getConnectedCurrent(),
          getCurrentModuleType(),
          // Range, averaging and the charge channel decide how the reading
          // behaves; without them the card says only "Connected".
          getCurrentModuleSettings().catch(() => null),
        ])
        setIpCurrent(ip)
        setPortCurrent(port)
        setIsConnectedCurrent(isConnected)
        setCurrentModuleType(moduleType.module_type)
        setCurrentModuleName(CURRENT_MODULE_LABELS[moduleType.module_type] ?? moduleType.module_type)
        if (moduleSettings) setCurrentModuleInfo(moduleSettings)
      } catch (error) {
        console.error('Failed to fetch initial current device data:', error)
      }
    }

    fetchInitialData()
    fetchBoardConfiguration()
    updateBoardConnectivity() // Initial connectivity check on page load
    updateDaqStatuses() // Initial DAQ status check

    // Call updateStatsValues immediately and then set up interval
    // Small delay to ensure paths are loaded from store
    setTimeout(updateStatsValues, 500)

    const roiInterval = setInterval(updateROIData, 1000)
    const bandwidthInterval = setInterval(updateBandwidthData, 1000)
    const boardStatusInterval = setInterval(updateBoardStatus, 2000)
    const boardConnectivityInterval = setInterval(updateBoardConnectivity, 5000) // Check every 5 seconds
    const statsInterval = setInterval(updateStatsValues, 5000) // Refresh stats every 5 seconds
    const daqStatusInterval = setInterval(updateDaqStatuses, 3000)

    return () => {
      clearInterval(roiInterval)
      clearInterval(bandwidthInterval)
      clearInterval(boardStatusInterval)
      clearInterval(boardConnectivityInterval)
      clearInterval(statsInterval)
      clearInterval(daqStatusInterval)
    }
  }, [])

  useEffect(() => {
    visibleMetrics.forEach(metric => {
      if (intervalRefs.current[metric.id]) return

      const fetchMetricData = async () => {
        try {
          const data = await getMetricData(metric.entityName)
          const latestValue = Array.isArray(data) && data.length > 0 ?
            data[0][1] :
            0;

          setMetricValues(prev => ({
            ...prev,
            [metric.id]: latestValue * (metric.multiplier || 1)
          }))
        } catch (error) {
          console.error(`Failed to fetch metric ${metric.entityName}/${metric.metricName}:`, error)
        }
      }

      fetchMetricData()

      if (metric.refreshInterval && metric.refreshInterval > 0) {
        const intervalMs = metric.refreshInterval * 1000
        intervalRefs.current[metric.id] = setInterval(fetchMetricData, intervalMs)
      }
    })

    return () => {
      Object.keys(intervalRefs.current).forEach(clearMetricInterval)
    }
  }, [visibleMetrics])

  const clearMetricInterval = (metricId: string) => {
    if (intervalRefs.current[metricId]) {
      clearInterval(intervalRefs.current[metricId])
      delete intervalRefs.current[metricId]
    }
  }

  /**
   * Refresh the ROI cards.
   *
   * Two requests, made together, whatever the number of ROIs: the configuration
   * (which the DAQ server owns) and every integral in one batch. This used to be
   * one request per ROI, awaited one after another inside a nested loop, so ten
   * regions meant ten serialised round trips — and ten separate reads of the
   * same spectra — before a single card could update.
   */
  const updateROIData = async () => {
    try {
      const [config, integrals] = await Promise.all([
        getHistogramDashboardConfig(),
        getROIIntegrals(),
      ])

      const counts = new Map(
        integrals.map((result) => [roiKey(result.histogramId, result.roiId), result]),
      )
      const now = Date.now()
      const newRoiCards: ROICardData[] = []

      for (const histogram of config.histograms) {
        if (!histogram.visible || !histogram.rois?.length) continue

        for (const roi of histogram.rois) {
          if (!roi.enabled) continue

          const key = roiKey(histogram.id, roi.id)
          const integral = counts.get(key)?.net ?? 0

          // Counts per minute, from the change since the previous refresh.
          const previous = roiDataHistoryRef.current[key]
          let rate = previous?.rate ?? 0
          if (previous) {
            const minutes = (now - (previous.lastUpdateTime || now)) / 60000
            if (minutes > 0.0016 && previous.integral !== integral) {
              rate = Math.abs(integral - previous.integral) / minutes
            }
          }

          const measured: ROIMeasurement = {
            ...roi,
            integral,
            rate: Math.max(0, rate),
            lastUpdateTime: now,
          }
          roiDataHistoryRef.current[key] = measured

          newRoiCards.push({
            histogramId: histogram.id,
            histogramLabel: histogram.customLabel || histogram.label,
            boardId: histogram.boardId,
            channel: histogram.channel,
            roi: measured,
          })
        }
      }

      setRoiCards(newRoiCards)
    } catch (error) {
      console.error('Failed to update ROI data:', error)
    }
  }

  const updateBandwidthData = async () => {
    try {
      const fileBW = await getFileBandwidth()
      setFileBandwidth(fileBW)
    } catch (error) {
      console.error('Failed to update bandwidth data:', error)
    }
  }

  const fetchBoardConfiguration = async () => {
    try {
      const response = await getBoardConfiguration()
      setBoards(response.data || [])
    } catch (error) {
      console.error('Failed to fetch board configuration:', error)
    }
  }

  const updateBoardStatus = async () => {
    try {
      const status = await getBoardStatus()
      setBoardStatus(status)
    } catch (error) {
      console.error('Failed to update board status:', error)
    }
  }

  const updateBoardConnectivity = async () => {
    try {
      const connectivity = await getBoardConnectivity()
      setBoardConnectivity(connectivity)
    } catch (error) {
      console.error('Failed to update board connectivity:', error)
    }
  }

  const updateDaqStatuses = async () => {
    try {
      const [save, waves, currentStatus, currentConnected, statsStatus] = await Promise.all([
        getSaveData().catch(() => null),
        getWaveformStatusPerBoard().catch(() => null),
        getCurrentStatus().catch(() => null),
        getConnectedCurrent().catch(() => null),
        getStatsRunStatus().catch(() => null),
      ])
      if (save !== null && save !== undefined) setDataSavingEnabled(Boolean(save))
      if (waves) setBoardWaveforms(waves)
      if (currentConnected !== null) setIsConnectedCurrent(Boolean(currentConnected))
      if (currentStatus) {
        // Two different things, and they were being confused:
        //   running   — per-run current logging, which only starts with a run
        //               that saves data. This is what the DAQ status row means.
        //   acquiring — the picoammeter itself is producing samples, which it
        //               does continuously once initialised. This is what the
        //               device card means by "reading".
        setCurrentAcquiring(Boolean(currentStatus.running))
        setCurrentSampling(Boolean(currentStatus.acquiring ?? currentStatus.thread_alive))
      }
      if (statsStatus) {
        setStatsCollecting(Boolean(statsStatus.collecting))
        setStatsCount(Number(statsStatus.enabled_paths_count ?? 0))
      }
    } catch (error) {
      console.error('Failed to update DAQ statuses:', error)
    }
  }

  // ── Run number editor ────────────────────────────────────────────────────
  // Only reachable while the DAQ is stopped: during a run the number shown is
  // the run being taken, and moving it would divorce the files already on disk
  // from the metadata still to be written.

  const openRunEditor = () => {
    if (isRunning) return
    const start = runNumber ?? 0
    setRunDraft(start)
    setRunDraftText(String(start))
    setRunSliderMin(Math.max(0, start - RUN_SLIDER_SPAN))
    setRunSliderMax(Math.max(RUN_SLIDER_SPAN, start + RUN_SLIDER_SPAN))
    setRunEditorOpen(true)
  }

  const applyRunDraft = (value: number) => {
    const clamped = Math.max(0, Math.floor(value))
    setRunDraft(clamped)
    setRunDraftText(String(clamped))
  }

  // A run can be started from another browser or from the Tuner. If that
  // happens while this dialog is open, close it rather than let someone commit
  // a run number under a live acquisition.
  useEffect(() => {
    if (isRunning) setRunEditorOpen(false)
  }, [isRunning])

  const commitRunNumber = async () => {
    const target = Math.max(0, Math.floor(runDraft))
    if (target === runNumber) { setRunEditorOpen(false); return }
    setSavingRunNumber(true)
    try {
      await setRunNumber(target)
      onRunNumberChange?.(target)
      setRunEditorOpen(false)
      toast({
        title: 'Run number set',
        description: `The next run will be run ${target}.`,
      })
    } catch (error) {
      console.error('Failed to set the run number:', error)
      toast({
        title: 'Error',
        description: 'Could not set the run number.',
        variant: 'destructive',
      })
    } finally {
      setSavingRunNumber(false)
    }
  }

  const toggleDataSaving = async (checked: boolean) => {
    const previous = dataSavingEnabled
    setDataSavingEnabled(checked)   // optimistic: the switch must feel immediate
    try {
      await setSaveData(checked)
      onSaveDataChange?.(checked)
    } catch (error) {
      console.error('Failed to change data saving:', error)
      setDataSavingEnabled(previous)
      toast({
        title: 'Error',
        description: 'Could not change data saving.',
        variant: 'destructive',
      })
    }
  }


  /**
   * Activates or deactivates waveform recording for a single board.
   * Optimistically updates the toggle and reverts if the request fails.
   */
  const handleBoardWaveformToggle = async (boardId: string, enabled: boolean) => {
    setBoardWaveforms(prev => ({ ...prev, [boardId]: enabled }))
    try {
      if (enabled) {
        await activateWaveformBoard(boardId)
      } else {
        await deactivateWaveformBoard(boardId)
      }
    } catch (error) {
      console.error(`Failed to toggle waveforms for board ${boardId}:`, error)
      setBoardWaveforms(prev => ({ ...prev, [boardId]: !enabled }))
      toast({
        title: "Error",
        description: `Failed to change waveform status for board ${boardId}.`,
        variant: "destructive",
      })
    }
  }

  const updateStatsValues = useCallback(async () => {
    try {
      // Get current paths from store instead of closure
      const currentPaths = useStatsStore.getState().paths
      for (const path of currentPaths.filter(p => p.enabled)) {
        try {
          const data = await getStatsMetricLastValue(path.path)
          // Graphite sometimes returns null briefly (ingestion lag, transient
          // render errors). Don't overwrite a previously good value with null —
          // keep showing the last reading instead of flipping the card to N/A.
          if (data && data.value !== undefined && data.value !== null) {
            setCurrentValue(path.path, data.value, data.timestamp)
          }
        } catch (error) {
          console.error(`Failed to fetch value for ${path.path}:`, error)
        }
      }
    } catch (error) {
      console.error('Failed to update stats values:', error)
    }
  }, [setCurrentValue])

  const updateLastRunDuration = async () => {
    try {
      const response = await getRunMetadataAll()
      if (response.data && response.data.length > 0) {
        // Pick the highest finished run rather than an end of the array: the
        // endpoint sorts by run number descending, so the last element is the
        // OLDEST run, and a run still in progress has no end_time yet.
        const previous = response.data
          .filter((run: any) => run.start_time && run.end_time)
          .reduce(
            (latest: any, run: any) =>
              latest === null || run.run_number > latest.run_number ? run : latest,
            null,
          )
        if (previous) {
          const startTime = new Date(previous.start_time)
          const endTime = new Date(previous.end_time)
          const durationSeconds = Math.round((endTime.getTime() - startTime.getTime()) / 1000)
          setLastRun({ number: previous.run_number, duration: durationSeconds })
        }
      }
    } catch (error) {
      console.error('Failed to fetch last run duration:', error)
    }
  }

  const formatTime = (seconds: number) => {
    return `${seconds} seconds`
  }

  const enabledStatsPaths = paths.filter((path: any) => path.enabled)
  const hasMonitoringCards =
    (settings.showROIs && roiCards.length > 0) ||
    (settings.showMetrics && visibleMetrics.length > 0) ||
    (settings.showStats && enabledStatsPaths.length > 0)

  return (
    <div className="h-full">
      {(settings.showStatus || hasMonitoringCards) && (
        <section className="h-full">
          <div className="relative mb-2">
            <div className="rounded-md border">
              <div className="p-4 pb-0">
                <h2 className="text-sm font-semibold">System status</h2>
              </div>
              <ScrollArea
                className={isResizingStatusPanel
                  ? ''
                  : 'transition-[height] duration-150 ease-out'}
                viewportClassName="snap-y snap-mandatory scroll-py-4 scroll-smooth"
                style={{ height: displayedStatusPanelHeight }}
              >
                <div className="grid auto-rows-[11.5rem] grid-cols-[repeat(auto-fit,minmax(16rem,1fr))] gap-6 p-4 pb-5 [&>*]:h-full [&>*]:overflow-hidden [&>*]:snap-start">
        {/* Run Status Card */}
        {settings.showStatus && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <div className="flex items-center gap-2">
                <CardTitle className="text-sm font-medium">
                  Run Status
                </CardTitle>
                {/* In the header, not the body: the status cards are a fixed
                    11.5rem and hide their overflow, so a row of its own in the
                    body pushed the file bandwidth line out of the card. Scaled
                    down to the height of the title so the header does not grow
                    either — the Switch primitive has a fixed thumb, so this is
                    a transform rather than smaller classes. */}
                <span className="flex h-4 w-7 items-center" title={isRunning
                  ? "Data saving cannot be changed while a run is going"
                  : dataSavingEnabled
                    ? "Data is being written to disk"
                    : "Nothing will be written to disk"}>
                  <Switch
                    className="origin-left scale-[0.65]"
                    checked={dataSavingEnabled}
                    onCheckedChange={toggleDataSaving}
                    disabled={isRunning}
                    aria-label="Save data to disk"
                  />
                </span>
                <span className={cn(
                  "text-xs font-medium",
                  isRunning ? "text-muted-foreground/60" : "text-muted-foreground",
                )}>
                  Save
                </span>
              </div>
              <Activity className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {/* While a run is live the number is the run being taken and is
                  read only. Stopped, the same number is the run that WILL be
                  taken next, so it says so and can be clicked to change it. */}
              <div className="flex items-baseline gap-2 text-2xl font-bold">
                {runNumber !== null && (
                  isRunning ? (
                    <span>Run {runNumber}</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => runEditorOpen ? setRunEditorOpen(false) : openRunEditor()}
                      title="Click to change the run number"
                      className="group inline-flex items-baseline gap-1.5 rounded-sm hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span>Run {runNumber}</span>
                      <Pencil className="h-3.5 w-3.5 self-center opacity-40 transition-opacity group-hover:opacity-100" />
                    </button>
                  )
                )}
                <span>{isRunning ? "Running" : "Stopped"}</span>
              </div>
              <p className="truncate text-xs text-muted-foreground">
                {isRunning
                  ? `started ${formatTime(timer)} ago`
                  : lastRun !== null
                    ? `last run (${lastRun.number}): ${lastRun.duration}s`
                    : 'no previous run'}
              </p>

              <div className="mt-3 flex items-center justify-between border-t pt-2 text-sm">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <HardDrive className="h-3.5 w-3.5" />
                  File Bandwidth
                </span>
                <span className="font-semibold">
                  {fileBandwidth < 0.1
                    ? `${(fileBandwidth * 1024).toFixed(2)} KB/s`
                    : `${fileBandwidth.toFixed(2)} MB/s`}
                </span>
              </div>

              {/* A dialog rather than an inline panel: the status cards have a
                  fixed height and hide their overflow, so anything unfolded in
                  place would be clipped. */}
              <Dialog
                open={runEditorOpen}
                onOpenChange={(open) => open ? openRunEditor() : setRunEditorOpen(false)}
              >
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>Next run</DialogTitle>
                    <DialogDescription>
                      Sets the number the next run will be given. It can only be
                      changed while the DAQ is stopped.
                    </DialogDescription>
                  </DialogHeader>

                  <div className="space-y-5 py-2">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="run-number-draft">Run number</Label>
                        <span className="text-2xl font-bold tabular-nums">{runDraft}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <Slider
                          className="flex-1"
                          value={[runDraft]}
                          min={runSliderMin}
                          max={runSliderMax}
                          step={1}
                          onValueChange={([v]) => applyRunDraft(v)}
                        />
                        <Input
                          id="run-number-draft"
                          type="number"
                          min={0}
                          className="h-9 w-24"
                          value={runDraftText}
                          onChange={(e) => {
                            setRunDraftText(e.target.value)
                            const parsed = parseInt(e.target.value, 10)
                            if (!isNaN(parsed) && parsed >= 0) setRunDraft(parsed)
                          }}
                          onBlur={() => applyRunDraft(runDraft)}
                        />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        The slider covers ±{RUN_SLIDER_SPAN} runs; type any number in the box.
                      </p>
                    </div>

                    {/* The toggle itself lives on the card. Repeated here it
                        would be a second control for one setting; what belongs
                        here is what it means for the number above. */}
                    <p className="border-t pt-4 text-xs text-muted-foreground">
                      <Save className="mr-1 inline h-3 w-3 align-[-2px]" />
                      {dataSavingEnabled
                        ? 'Data saving is on: files are written and this number advances after each run.'
                        : 'Data saving is off: nothing is written and this number stays where it is.'}
                    </p>
                  </div>

                  <DialogFooter>
                    <Button variant="ghost" onClick={() => setRunEditorOpen(false)}>
                      Cancel
                    </Button>
                    <Button onClick={commitRunNumber} disabled={savingRunNumber}>
                      {savingRunNumber ? 'Setting…' : 'Set run number'}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </CardContent>
          </Card>
        )}

        {/* DAQ Status Card — data saving / waveforms */}
        {settings.showStatus && (() => {
          const okIcon = <CheckCircle className="h-3.5 w-3.5 text-green-500" />
          const offIcon = <XCircle className="h-3.5 w-3.5 text-red-500" />

          // Waveforms are configured per-board; summarise how many are active.
          const waveformBoardCount = Object.values(boardWaveforms).filter(Boolean).length
          const anyWaveforms = waveformBoardCount > 0

          return (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">DAQ Status</CardTitle>
                <Server className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="space-y-1.5 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <Save className="h-3.5 w-3.5" />
                      Data Saving
                    </span>
                    <span className="flex items-center gap-1 font-semibold">
                      {dataSavingEnabled ? 'On' : 'Off'}
                      {dataSavingEnabled ? okIcon : offIcon}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <AudioWaveform className="h-3.5 w-3.5" />
                      Waveforms
                    </span>
                    <span className="flex items-center gap-1 font-semibold">
                      {boards.length > 0 ? `${waveformBoardCount}/${boards.length}` : 'Off'}
                      {anyWaveforms ? okIcon : offIcon}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <BatteryCharging className="h-3.5 w-3.5" />
                      Current
                    </span>
                    <span className="flex items-center gap-1 font-semibold">
                      {!currentEnabled ? 'Disabled' : currentAcquiring ? 'On' : 'Off'}
                      {currentEnabled && (currentAcquiring ? okIcon : offIcon)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <Activity className="h-3.5 w-3.5" />
                      Stats
                    </span>
                    <span className="flex items-center gap-1 font-semibold">
                      {statsCollecting ? `${statsCount} acquiring` : 'Off'}
                      {statsCollecting ? okIcon : offIcon}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )
        })()}


        {/* Picoammeter card — the settings that change how the reading behaves,
            so a number that looks wrong can be explained without opening
            Settings: which input is integrated, the range, and how much
            averaging sits between the beam and the value on screen.

            Only for an actual picoammeter. When the current is read from a
            monitored Graphite metric there is no device here to describe, and
            the card was showing that case as a TetrAMM. */}
        {settings.showStatus && currentEnabled
          && currentModuleType !== null
          && PICOAMMETER_MODULES.has(currentModuleType) && (() => {
          const deviceSettings = currentModuleInfo?.settings ?? {}
          const isTetramm = currentModuleType === 'tetramm'
          // Two rows only — where the device is, and the setting that decides
          // how the reading behaves. Everything else is one click away in
          // Settings, and a card taller than its neighbours breaks the grid.
          const rows: [string, string][] = isTetramm
            ? [
                ['Address', `${currentModuleInfo?.ip ?? ipCurrent}:${currentModuleInfo?.port ?? portCurrent}`],
                ['Range', deviceSettings.RNG || 'AUTO'],
              ]
            : [
                // The RBD is on a serial port; it has no IP.
                ['Port', String(currentModuleInfo?.port ?? 'not set')],
                // R0 is the RBD's autorange code; R1…R7 are fixed ranges.
                ['Range', deviceSettings.range === 'R0'
                  ? 'AUTO'
                  : (deviceSettings.range || 'AUTO')],
              ]

          return (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{currentModuleName}</CardTitle>
                <BatteryCharging className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="flex items-baseline gap-2">
                  <span className={`text-2xl font-bold ${
                    isConnectedCurrent ? '' : 'text-red-600 dark:text-red-400'}`}>
                    {isConnectedCurrent ? 'Connected' : 'Disconnected'}
                  </span>
                  {isConnectedCurrent && (
                    <span className={`text-xs ${
                      currentSampling ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'}`}>
                      {currentSampling ? 'reading' : 'not sampling'}
                    </span>
                  )}
                </div>

                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 border-t pt-2 text-xs">
                  {rows.map(([label, value]) => (
                    <div key={label} className="contents">
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="truncate text-right font-medium" title={value}>{value}</dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>
          )
        })()}

        {/* Board Status Cards */}
        {settings.showStatus && boards.map((board) => {
          const status = boardStatus[board.id];
          const connectivity = boardConnectivity[board.id];
          const isOk = !status || !status.failed;
          const isConnected = connectivity?.connected ?? false;

          // Determine display status based on requirements:
          // - If running, don't update ready status, maintain current version
          // - If not running and connected, show "Ready" in green
          // - If not connected, show "Disconnected" in red
          let displayText = "Unknown";
          let displayColor = "text-gray-600";
          
          if (!isConnected) {
            displayText = "Disconnected";
            displayColor = "text-red-600";
          } else if (isRunning) {
            // If running, maintain current status - don't update to "Ready"
            if (!isOk) {
              if( status.last_value.toString(16).toUpperCase() === "10") {
                displayText = "PLL Lock Lost";
                displayColor = "text-red-600";
              }
              else if( status.last_value.toString(16).toUpperCase() === "1") {
                displayText = "Connection Error";
                displayColor = "text-red-600";
              }
              else {
                displayText = "Generic Failure";
                displayColor = "text-red-600";
              }
            } else {
              displayText = "Running";
              displayColor = "text-green-600";
            }
          } else if (isConnected) {
            displayText = "Ready";
            displayColor = "text-green-600";
          } else {
            displayText = "Failed";
            displayColor = "text-red-600";
          }
          
          const waveformsOn = boardWaveforms[board.id] ?? false

          return (
            <Card key={`board-status-${board.id}`}>
              <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
                <div className="flex flex-col min-w-0">
                  <CardTitle className="text-sm font-medium">Board {board.id}</CardTitle>
                  <p className="text-xs text-muted-foreground truncate">{board.name}</p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {isConnected ? (
                    <Wifi className="h-4 w-4 text-green-500" />
                  ) : (
                    <WifiOff className="h-4 w-4 text-red-500" />
                  )}
                  {isOk ? (
                    <CheckCircle className="h-4 w-4 text-green-500" />
                  ) : (
                    <XCircle className="h-4 w-4 text-red-500" />
                  )}
                  <Cpu className="h-4 w-4 text-muted-foreground" />
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className={`text-xl font-bold ${displayColor}`}>
                  {displayText}
                </div>
                <p className="text-xs text-muted-foreground truncate">
                  {[board.dpp, `${board.chan} ch`, board.link_type].filter(Boolean).join(' · ')}
                </p>
                <div className="flex items-center justify-between border-t pt-2">
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <AudioWaveform className="h-3.5 w-3.5" />
                    Waveforms
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium w-6 text-right">
                      {waveformsOn ? 'On' : 'Off'}
                    </span>
                    <Switch
                      checked={waveformsOn}
                      onCheckedChange={(checked) => handleBoardWaveformToggle(String(board.id), checked)}
                      disabled={isRunning}
                      aria-label={`Toggle waveforms for board ${board.id}`}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          )
        })}

        {/* ROI Cards */}
        {settings.showROIs &&
          roiCards.map((cardData) => (
            <Card key={`${cardData.histogramId}_${cardData.roi.id}`}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <div className="flex flex-col min-w-0">
                  <CardTitle className="text-sm font-medium truncate">
                    {cardData.histogramLabel}
                  </CardTitle>
                  <p
                    className="text-xs font-medium truncate flex items-center gap-1.5"
                    style={{ color: cardData.roi.color }}
                  >
                    <span
                      className="inline-block h-2 w-2 rounded-sm shrink-0"
                      style={{ backgroundColor: cardData.roi.color }}
                    />
                    {cardData.roi.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Board {cardData.boardId} • Channel {cardData.channel}
                  </p>
                </div>
                <BarChart className="h-4 w-4 text-muted-foreground shrink-0" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{cardData.roi.integral.toFixed(0)}</div>
                <p className="text-xs text-muted-foreground">
                  Range: {cardData.roi.low} – {cardData.roi.high}
                </p>
              </CardContent>
            </Card>
          ))
        }

        {/* Custom Metrics Cards */}
        {settings.showMetrics && visibleMetrics.map(metric => (
          <Card key={metric.id}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                {metric.metricName.split('_').map(word =>
                  word.charAt(0).toUpperCase() + word.slice(1)
                ).join(' ')}
              </CardTitle>
              <Activity className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {metricValues[metric.id] !== undefined
                  ? (Number(metricValues[metric.id])).toFixed(2)
                  : 'Loading...'} {metric.unit}
              </div>
              <p className="text-xs text-muted-foreground">
                Last updated: {new Date().toLocaleTimeString()}
              </p>
            </CardContent>
          </Card>
        ))}

        {/* Stats/Graphite Metric Cards */}
        {settings.showStats &&
          enabledStatsPaths.map((path: any) => (
            <Card key={path.path}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">
                  {path.alias}
                </CardTitle>
                <Activity className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {currentValues[path.path]?.value !== undefined && currentValues[path.path]?.value !== null
                    ? (() => {
                        const value = Number(currentValues[path.path].value);
                        return value < 1 ? value.toExponential(5) : value.toFixed(3);
                      })()
                    : 'N/A'}
                </div>
                <p className="text-xs text-muted-foreground">
                  {currentValues[path.path]?.timestamp
                    ? new Date(currentValues[path.path].timestamp!).toLocaleTimeString()
                    : 'No data'}
                </p>
              </CardContent>
            </Card>
          ))
        }
                </div>
              </ScrollArea>
            </div>
            <button
              type="button"
              role="separator"
              aria-label="Resize overview status cards"
              aria-orientation="horizontal"
              aria-valuemin={expandForBeam ? 2 : 1}
              aria-valuemax={3}
              aria-valuenow={STATUS_PANEL_HEIGHTS.reduce((closestIndex, height, index) =>
                Math.abs(height - displayedStatusPanelHeight) <
                Math.abs(STATUS_PANEL_HEIGHTS[closestIndex] - displayedStatusPanelHeight)
                  ? index
                  : closestIndex, 0) + 1}
              title="Drag to show one card row less or more. Use ↑ and ↓ with the keyboard."
              onPointerDown={handleStatusResizeStart}
              onPointerMove={handleStatusResizeMove}
              onPointerUp={handleStatusResizeEnd}
              onPointerCancel={handleStatusResizeEnd}
              onKeyDown={handleStatusResizeKey}
              className={`absolute -bottom-3 left-1/2 z-10 flex h-6 w-16 -translate-x-1/2 touch-none items-center justify-center rounded-full border bg-background shadow-sm transition-colors hover:border-primary/50 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                isResizingStatusPanel ? 'cursor-grabbing border-primary bg-muted' : 'cursor-row-resize'
              }`}
            >
              <GripHorizontal className="h-4 w-4 text-muted-foreground" />
            </button>
          </div>
        </section>
      )}
    </div>
  )
}
