'use client'

import { useState, useEffect, useRef } from 'react'
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
} from "lucide-react"

import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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

interface CardHolderProps {
  isRunning: boolean
  timer: number
  startTime: string | null
}

export function CardHolder({ isRunning, timer, startTime }: CardHolderProps) {
  const { settings } = useVisualizationStore()
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
  const [metricValues, setMetricValues] = useState<{ [key: string]: number }>({})
  const [boardStatus, setBoardStatus] = useState<{ [key: string]: BoardStatus }>({})
  const [boardConnectivity, setBoardConnectivity] = useState<{ [key: string]: BoardConnectivity }>({})
  const [boards, setBoards] = useState<BoardInfo[]>([])
  const intervalRefs = useRef<{ [key: string]: NodeJS.Timeout }>({})
  const roiDataHistoryRef = useRef<{ [key: string]: ROI }>({})

  useEffect(() => {
    setVisibleMetrics(metrics.filter(metric => metric.isVisible))
  }, [metrics])

  // Load stats paths on mount
  useEffect(() => {
    const loadStatsPaths = async () => {
      try {
        const data = await getStatsPaths()
        setPaths(data || [])
      } catch (error) {
        console.error('Failed to fetch stats paths:', error)
      }
    }

    loadStatsPaths()
  }, [setPaths])

  useEffect(() => {
    const fetchInitialData = async () => {
      try {
        const [ip, port, isConnected, moduleType] = await Promise.all([
          getIpCurrent(),
          getPortCurrent(),
          getConnectedCurrent(),
          getCurrentModuleType()
        ])
        setIpCurrent(ip)
        setPortCurrent(port)
        setIsConnectedCurrent(isConnected)
        setCurrentModuleType(moduleType.module_type)
        setCurrentModuleName(moduleType.module_type === 'rbd9103' ? 'RBD 9103' : 'TetrAMM')
      } catch (error) {
        console.error('Failed to fetch initial current device data:', error)
      }
    }

    fetchInitialData()
    fetchBoardConfiguration()
    updateBoardConnectivity() // Initial connectivity check on page load

    const beamCurrentInterval = setInterval(updateBeamCurrent, 1000)
    const roiInterval = setInterval(updateROIData, 1000)
    const bandwidthInterval = setInterval(updateBandwidthData, 1000)
    const accumulatedChargeInterval = setInterval(updateAccumulatedCharge, 1000)
    const totalAccumulatedChargeInterval = setInterval(updateTotalAccumulatedCharge, 1000)
    const boardStatusInterval = setInterval(updateBoardStatus, 2000)
    const boardConnectivityInterval = setInterval(updateBoardConnectivity, 5000) // Check every 5 seconds
    const statsInterval = setInterval(updateStatsValues, 5000) // Refresh stats every 5 seconds

    return () => {
      clearInterval(beamCurrentInterval)
      clearInterval(roiInterval)
      clearInterval(bandwidthInterval)
      clearInterval(accumulatedChargeInterval)
      clearInterval(totalAccumulatedChargeInterval)
      clearInterval(boardStatusInterval)
      clearInterval(boardConnectivityInterval)
      clearInterval(statsInterval)
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
      if (isRunning && startTime) {
        const initialCurrent = parseFloat(localStorage.getItem('initialBeamCurrent') || '0')
        setBeamCurrentChange(Math.abs(currentData - initialCurrent))
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

  const updateStatsValues = async () => {
    try {
      for (const path of paths.filter(p => p.enabled)) {
        try {
          const data = await getStatsMetricLastValue(path.path)
          if (data && data.value !== undefined) {
            setCurrentValue(path.path, data.value, data.timestamp)
          }
        } catch (error) {
          console.error(`Failed to fetch value for ${path.path}:`, error)
        }
      }
    } catch (error) {
      console.error('Failed to update stats values:', error)
    }
  }

  const formatTime = (seconds: number) => {
    return `${seconds} seconds`
  }

  return (
    <ScrollArea className="h-[420px] rounded-md border p-4">
      <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-6 md:gap-8 lg:grid-cols-4">
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
              <div className="text-2xl font-bold">{isRunning ? "Running" : "Stopped"}</div>
              <p className="text-xs text-muted-foreground">
                {isRunning ? `Started ${formatTime(timer)} ago` : "Stopped"}
              </p>
            </CardContent>
          </Card>
        )}

        {/* Current Device Connection Status Card */}
        {settings.showStatus && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                {currentModuleName}
              </CardTitle>
              <BatteryCharging className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{isConnectedCurrent ? "Connected" : "Disconnected"}</div>
              <p className="text-xs text-muted-foreground">
                {currentModuleType === 'tetramm' ? `IP: ${ipCurrent} Port: ${portCurrent}` : 'Serial Port'}
              </p>
            </CardContent>
          </Card>
        )}

        {/* Board Status Cards */}
        {settings.showStatus && boards.map((board) => {
          const status = boardStatus[board.id];
          const connectivity = boardConnectivity[board.id];
          const isOk = !status || !status.failed;
          const isConnected = connectivity?.connected ?? false;
          const isReady = connectivity?.ready ?? false;
          
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
          
          return (
            <Card key={`board-status-${board.id}`}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">
                  Board {board.id}
                </CardTitle>
                <div className="flex items-center gap-2">
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
              <CardContent>
                <div className={`text-2xl font-bold ${displayColor}`}>
                  {displayText}
                </div>
                <p className="text-xs text-muted-foreground">
                  {board.name} • {board.dpp} - {isConnected ? 'Connected' : 'Disconnected'}
                </p>
              </CardContent>
            </Card>
          )
        })}

        {/* Beam Current Card */}
        {settings.showCurrent && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Beam Current
              </CardTitle>
              <Thermometer className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{beamCurrent.toFixed(2)} uA</div>
              <p className="text-xs text-muted-foreground">
                {beamCurrentChange > 0 ? `+${beamCurrentChange.toFixed(2)}` : beamCurrentChange.toFixed(2)} uA from Start
              </p>
            </CardContent>
          </Card>
        )}

        {/* Accumulated Charge Card */}
        {settings.showCurrent && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Accumulated Charge
              </CardTitle>
              <Thermometer className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{accumulatedCharge.toFixed(2)} uC</div>
              <p className="text-xs text-muted-foreground">
                Total Charge Accumulated
              </p>
            </CardContent>
          </Card>
        )}

        {/* Total Accumulated Charge Card */}
        {settings.showCurrent && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Total Accumulated Charge
              </CardTitle>
              <Database className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {totalAccumulatedCharge > 1000000 ? 
                  `${(totalAccumulatedCharge/1000000).toFixed(2)} C` : 
                  `${totalAccumulatedCharge.toFixed(2)} uC`}
              </div>
              <p className="text-xs text-muted-foreground">
                Total Charge Accumulated since Last Reset
              </p>
            </CardContent>
          </Card>
        )}

        {/* File Bandwidth Card */}
        {settings.showXDAQ && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                File Bandwidth
              </CardTitle>
              <HardDrive className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {fileBandwidth < 0.1 ? (
                <div className="text-2xl font-bold">{(fileBandwidth*1024).toFixed(2)} KB/s</div>
              ) : (
                <div className="text-2xl font-bold">{fileBandwidth.toFixed(2)} MB/s</div>
              )}
              <p className="text-xs text-muted-foreground">
                Data Writing Speed
              </p>
            </CardContent>
          </Card>
        )}

        {/* ROI Cards */}
        {settings.showROIs && 
          roiCards.map((cardData) => (
            <Card key={`${cardData.histogramId}_${cardData.roi.id}`}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <div className="flex flex-col">
                  <CardTitle className="text-sm font-medium">
                    {cardData.histogramLabel}
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">
                    Board {cardData.boardId} • Channel {cardData.channel}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <div 
                    className="w-3 h-3 rounded-full" 
                    style={{ backgroundColor: cardData.roi.color }}
                  />
                  <BarChart className="h-4 w-4 text-muted-foreground" />
                </div>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{cardData.roi.integral.toFixed(0)}</div>
                <div className="flex flex-col gap-1">
                  <p className="text-xs text-muted-foreground">
                    ROI: {cardData.roi.low} - {cardData.roi.high}
                  </p>
                </div>
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
                    ? (Number(currentValues[path.path].value)).toFixed(2)
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
  )
}