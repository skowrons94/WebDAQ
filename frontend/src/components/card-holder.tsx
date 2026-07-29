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
  Database,
  HardDrive,
  Thermometer,
  CheckCircle,
  XCircle,
  Cpu,
  Wifi,
  WifiOff,
  Save,
  AudioWaveform,
  Server,
  Zap,
  GripHorizontal,
} from "lucide-react"

import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { useToast } from '@/components/ui/use-toast'
import { useVisualizationStore } from '@/store/visualization-settings-store'
import { useMetricsStore } from '@/store/metrics-store'
import { useStatsStore } from '@/store/stats-store'
import {
  getRoiIntegral,
  getFileBandwidth,
  getDataCurrent,
  getAccumulatedCharge,
  getTotalAccumulatedCharge,
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
} from '@/lib/api'

type ROI = {
  id: string;
  name: string;
  low: number;
  high: number;
  integral: number;
  rate: number;
  lastUpdateTime: number;
  color: string;
  enabled: boolean;
}

type HistogramConfig = {
  id: string;
  boardId: string;
  channel: number;
  visible: boolean;
  size: 'small' | 'medium' | 'large';
  label: string;
  customLabel?: string;
  position: { row: number; col: number };
  rois: ROI[];
}

type ROICardData = {
  histogramId: string;
  histogramLabel: string;
  boardId: string;
  channel: number;
  roi: ROI;
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


/**
 * Charge in µC, in whichever unit keeps it readable — a long run reaches
 * millicoulombs and a target's lifetime total reaches coulombs.
 */
const formatCharge = (microCoulombs: number): string => {
  const value = Number.isFinite(microCoulombs) ? microCoulombs : 0
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} C`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(2)} mC`
  return `${value.toFixed(2)} uC`
}

interface CardHolderProps {
  isRunning: boolean
  timer: number
  startTime: string | null
  runNumber: number | null
}

// The overview starts at two rows, as before, and can be snapped one complete
// card row smaller or larger.  Keeping discrete row heights avoids leaving the
// final row awkwardly clipped after a free-form drag.
const STATUS_PANEL_HEIGHTS = [220, 420, 620] as const
const DEFAULT_STATUS_PANEL_HEIGHT = STATUS_PANEL_HEIGHTS[1]
const STATUS_PANEL_STORAGE_KEY = 'overview-status-panel-height'

export function CardHolder({ isRunning, timer, startTime, runNumber }: CardHolderProps) {
  const { toast } = useToast()
  const { settings } = useVisualizationStore()
  // Treat a missing flag (older persisted settings) as enabled.
  const currentEnabled = settings.currentEnabled !== false
  const { metrics } = useMetricsStore()
  const { paths, currentValues, setPaths, setCurrentValue } = useStatsStore()
  const [visibleMetrics, setVisibleMetrics] = useState(() => metrics.filter(metric => metric.isVisible))

  const [roiCards, setRoiCards] = useState<ROICardData[]>([])
  const [fileBandwidth, setFileBandwidth] = useState<number>(0)
  const [beamCurrent, setBeamCurrent] = useState<number>(0)
  const [beamCurrentChange, setBeamCurrentChange] = useState<number>(0)
  const [accumulatedCharge, setAccumulatedCharge] = useState<number>(0)
  const [totalAccumulatedCharge, setTotalAccumulatedCharge] = useState<number>(0)
  const [isConnectedCurrent, setIsConnectedCurrent] = useState(false)
  const [ipCurrent, setIpCurrent] = useState<string>('')
  const [portCurrent, setPortCurrent] = useState<string>('')
  const [currentModuleType, setCurrentModuleType] = useState<string>('tetramm')
  const [currentModuleName, setCurrentModuleName] = useState<string>('TetrAMM')
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
  const [lastRunDuration, setLastRunDuration] = useState<number | null>(null)
  const [dataSavingEnabled, setDataSavingEnabled] = useState<boolean>(false)
  const [boardWaveforms, setBoardWaveforms] = useState<{ [boardId: string]: boolean }>({})
  const [currentAcquiring, setCurrentAcquiring] = useState<boolean>(false)
  // The device is sampling (independent of whether a run is logging it).
  const [currentSampling, setCurrentSampling] = useState<boolean>(false)
  const [statsCollecting, setStatsCollecting] = useState<boolean>(false)
  const [statsCount, setStatsCount] = useState<number>(0)
  // First beam current reading of the current run; null between runs.
  const runStartCurrentRef = useRef<number | null>(null)
  const intervalRefs = useRef<{ [key: string]: NodeJS.Timeout }>({})
  const roiDataHistoryRef = useRef<{ [key: string]: ROI }>({})
  const [statusPanelHeight, setStatusPanelHeight] = useState<number>(DEFAULT_STATUS_PANEL_HEIGHT)
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
    const snapped = STATUS_PANEL_HEIGHTS.reduce((closest, candidate) =>
      Math.abs(candidate - height) < Math.abs(closest - height) ? candidate : closest)
    setStatusPanelHeight(snapped)
    window.localStorage.setItem(STATUS_PANEL_STORAGE_KEY, String(snapped))
  }, [])

  const handleStatusResizeStart = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    statusPanelDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: statusPanelHeight,
    }
    setIsResizingStatusPanel(true)
  }

  const handleStatusResizeMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = statusPanelDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const nextHeight = Math.min(
      STATUS_PANEL_HEIGHTS[STATUS_PANEL_HEIGHTS.length - 1],
      Math.max(STATUS_PANEL_HEIGHTS[0], drag.startHeight + event.clientY - drag.startY),
    )
    setStatusPanelHeight(nextHeight)
  }

  const handleStatusResizeEnd = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = statusPanelDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const finalHeight = Math.min(
      STATUS_PANEL_HEIGHTS[STATUS_PANEL_HEIGHTS.length - 1],
      Math.max(STATUS_PANEL_HEIGHTS[0], drag.startHeight + event.clientY - drag.startY),
    )
    statusPanelDragRef.current = null
    setIsResizingStatusPanel(false)
    snapStatusPanelHeight(finalHeight)
  }

  const handleStatusResizeKey = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = STATUS_PANEL_HEIGHTS.reduce((closestIndex, height, index) =>
      Math.abs(height - statusPanelHeight) <
      Math.abs(STATUS_PANEL_HEIGHTS[closestIndex] - statusPanelHeight)
        ? index
        : closestIndex, 0)
    const direction = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (!direction) return
    event.preventDefault()
    const nextIndex = Math.min(
      STATUS_PANEL_HEIGHTS.length - 1,
      Math.max(0, currentIndex + direction),
    )
    snapStatusPanelHeight(STATUS_PANEL_HEIGHTS[nextIndex])
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
        setCurrentModuleName(moduleType.module_type === 'rbd9103' ? 'RBD 9103' : 'TetrAMM')
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

    const beamCurrentInterval = setInterval(updateBeamCurrent, 1000)
    const roiInterval = setInterval(updateROIData, 1000)
    const bandwidthInterval = setInterval(updateBandwidthData, 1000)
    const accumulatedChargeInterval = setInterval(updateAccumulatedCharge, 1000)
    const totalAccumulatedChargeInterval = setInterval(updateTotalAccumulatedCharge, 1000)
    const boardStatusInterval = setInterval(updateBoardStatus, 2000)
    const boardConnectivityInterval = setInterval(updateBoardConnectivity, 5000) // Check every 5 seconds
    const statsInterval = setInterval(updateStatsValues, 5000) // Refresh stats every 5 seconds
    const daqStatusInterval = setInterval(updateDaqStatuses, 3000)

    return () => {
      clearInterval(beamCurrentInterval)
      clearInterval(roiInterval)
      clearInterval(bandwidthInterval)
      clearInterval(accumulatedChargeInterval)
      clearInterval(totalAccumulatedChargeInterval)
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

  // ✅ FIXED updateROIData FUNCTION
  const updateROIData = async () => {
    try {
      const response = await fetch('/api/cache?type=histograms')
      const result = await response.json()

      if (!result.success) {
        console.error('Failed to fetch histogram configs:', result.error)
        return
      }

      const histogramConfigs: HistogramConfig[] = result.data
      const newRoiCards: ROICardData[] = []
      const newRoiDataHistory: { [key: string]: ROI } = {}

      for (const config of histogramConfigs) {
        if (!config.visible || !config.rois || config.rois.length === 0) continue

        for (const roi of config.rois) {
          if (!roi.enabled) continue

          try {
            const integral = await getRoiIntegral(
              config.boardId,
              config.channel.toString(),
              roi.low,
              roi.high
            )

            const roiKey = `${config.id}_${roi.id}`
            const currentTime = Date.now()

            const previousROI = roiDataHistoryRef.current[roiKey]
            const previousIntegral = previousROI?.integral || 0
            const previousUpdateTime = previousROI?.lastUpdateTime || currentTime
            const timeDifferenceSeconds = (currentTime - previousUpdateTime) / 1000

            let rate = previousROI?.rate || 0
            if (timeDifferenceSeconds > 0.1 && previousIntegral !== integral) {
              const integralDifference = integral - previousIntegral
              rate = Math.abs(integralDifference) / (timeDifferenceSeconds / 60)
            }

            const updatedROI: ROI = {
              ...roi,
              integral,
              rate: Math.max(0, rate),
              lastUpdateTime: currentTime
            }

            roiDataHistoryRef.current[roiKey] = updatedROI

            const cardData: ROICardData = {
              histogramId: config.id,
              histogramLabel: config.customLabel || config.label,
              boardId: config.boardId,
              channel: config.channel,
              roi: updatedROI
            }

            newRoiCards.push(cardData)
          } catch (error) {
            console.error(`Failed to get ROI integral for ${config.id}, ROI ${roi.id}:`, error)

            const roiKey = `${config.id}_${roi.id}`
            const previousROI = roiDataHistoryRef[roiKey] || {
              ...roi,
              rate: 0,
              lastUpdateTime: Date.now(),
              integral: 0
            }

            newRoiDataHistory[roiKey] = previousROI

            const cardData: ROICardData = {
              histogramId: config.id,
              histogramLabel: config.customLabel || config.label,
              boardId: config.boardId,
              channel: config.channel,
              roi: previousROI
            }

            newRoiCards.push(cardData)
          }
        }
      }

      // ✅ Update state once, safely
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

  const updateBeamCurrent = async () => {
    try {
      const currentData = await getDataCurrent()
      setBeamCurrent(currentData)

      // Reference for "since run start". It used to come from localStorage,
      // written by whichever browser pressed Start — so a page opened later, or
      // a run started from the Tuner or another PC, compared against 0 or
      // against a stale value from a previous run. Take the first reading of
      // this run instead, in this component, and drop the reference when the
      // run ends rather than leaving a number nobody can interpret.
      if (isRunning) {
        const reference = runStartCurrentRef.current ?? currentData
        runStartCurrentRef.current = reference
        setBeamCurrentChange(currentData - reference)
      } else {
        runStartCurrentRef.current = null
        setBeamCurrentChange(0)
      }
    } catch (error) {
      console.error('Failed to update beam current:', error)
    }
  }

  const updateAccumulatedCharge = async () => {
    try {
      const charge = await getAccumulatedCharge()
      setAccumulatedCharge(charge)
    } catch (error) {
      console.error('Failed to update accumulated charge:', error)
    }
  }

  const updateTotalAccumulatedCharge = async () => {
    try {
      const totalCharge = await getTotalAccumulatedCharge()
      setTotalAccumulatedCharge(totalCharge)
    } catch (error) {
      console.error('Failed to update total accumulated charge:', error)
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
      const [save, waves, currentStatus, statsStatus] = await Promise.all([
        getSaveData().catch(() => null),
        getWaveformStatusPerBoard().catch(() => null),
        getCurrentStatus().catch(() => null),
        getStatsRunStatus().catch(() => null),
      ])
      if (save !== null && save !== undefined) setDataSavingEnabled(Boolean(save))
      if (waves) setBoardWaveforms(waves)
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
        // Get the last run (most recent)
        const lastRun = response.data[response.data.length - 1]
        if (lastRun.start_time && lastRun.end_time) {
          const startTime = new Date(lastRun.start_time)
          const endTime = new Date(lastRun.end_time)
          const durationSeconds = Math.round((endTime.getTime() - startTime.getTime()) / 1000)
          setLastRunDuration(durationSeconds)
        }
      }
    } catch (error) {
      console.error('Failed to fetch last run duration:', error)
    }
  }

  const formatTime = (seconds: number) => {
    return `${seconds} seconds`
  }

  return (
    <div className="relative mb-2">
      <ScrollArea
        className={`rounded-md border ${
          isResizingStatusPanel ? '' : 'transition-[height] duration-150 ease-out'
        }`}
        viewportClassName="snap-y snap-mandatory scroll-py-4 scroll-smooth"
        style={{ height: statusPanelHeight }}
      >
        <div className="grid gap-4 p-4 pb-5 sm:grid-cols-2 2xl:grid-cols-6 md:gap-8 lg:grid-cols-4 [&>*]:snap-start">
        {/* Run Status Card */}
        {settings.showStatus && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Run Status
              </CardTitle>
              <Activity className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {runNumber !== null ? `Run ${runNumber} - ` : ""}
                {isRunning ? "Running" : "Stopped"}
              </div>
              <p className="text-xs text-muted-foreground">
                {isRunning ? `started ${formatTime(timer)} ago` : (lastRunDuration !== null ? `Last Run: ${lastRunDuration}s` : "Stopped")}
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
            averaging sits between the beam and the value on screen. */}
        {settings.showStatus && currentEnabled && (() => {
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

        {/* Beam & Charge Card — the live current and both charge figures in one
            place, because they are read together: the current says what the beam
            is doing now, the run charge is what the analysis normalises to, and
            the total says how much beam this target has seen. */}
        {settings.showCurrent && currentEnabled && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Beam &amp; Charge
              </CardTitle>
              <Thermometer className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{beamCurrent.toFixed(2)} uA</div>
              <p className="text-xs text-muted-foreground">
                {/* Only claim a drift when there is a run to measure it against.
                    Between runs the line said "0.00 uA from Start", which was
                    not a measurement of anything. */}
                {isRunning
                  ? `${beamCurrentChange >= 0 ? '+' : ''}${beamCurrentChange.toFixed(2)} uA since run start`
                  : 'No run in progress'}
              </p>

              <div className="mt-3 space-y-1.5 border-t pt-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <Zap className="h-3.5 w-3.5" />
                    This run
                  </span>
                  <span className="flex items-center gap-1.5 font-semibold">
                    {formatCharge(accumulatedCharge)}
                    {/* Integrating only while the run is on — a still number
                        between runs is the point, not a stalled readout. */}
                    <span
                      className={`inline-block h-1.5 w-1.5 rounded-full ${
                        isRunning ? 'bg-green-500' : 'bg-muted-foreground/40'}`}
                      title={isRunning ? 'Integrating' : 'Paused until the next run'}
                    />
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <Database className="h-3.5 w-3.5" />
                    Total
                  </span>
                  <span className="font-semibold">{formatCharge(totalAccumulatedCharge)}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

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
        {visibleMetrics.map(metric => (
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
          paths.filter((p: any) => p.enabled).map((path: any) => (
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
      <button
        type="button"
        role="separator"
        aria-label="Resize overview status cards"
        aria-orientation="horizontal"
        aria-valuemin={1}
        aria-valuemax={3}
        aria-valuenow={STATUS_PANEL_HEIGHTS.reduce((closestIndex, height, index) =>
          Math.abs(height - statusPanelHeight) <
          Math.abs(STATUS_PANEL_HEIGHTS[closestIndex] - statusPanelHeight)
            ? index
            : closestIndex, 0) + 1}
        title="Drag to show one row less or more. Use ↑ and ↓ with the keyboard."
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
  )
}
