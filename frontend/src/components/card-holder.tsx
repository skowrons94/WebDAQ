'use client'

import { useState, useEffect, useRef } from 'react'
import {
  Activity,
  BarChart,
  BatteryCharging,
  Database,
  HardDrive,
  Thermometer,
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
import {
  getRoiIntegral,
  getFileBandwidth,
  getDataCurrent,
  getDataCollimator1,
  getDataCollimator2,
  getAccumulatedCharge,
  getTotalAccumulatedCharge,
  getConnectedCurrent,
  getIpCurrent,
  getPortCurrent,
  getMetricData,
} from '@/lib/api'

type ROI = {
  id: string;
  name: string;
  low: number;
  high: number;
  integral: number;
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

interface CardHolderProps {
  isRunning: boolean
  timer: number
  startTime: string | null
}

/**
 * CardHolder Component
 * 
 * Displays dashboard cards showing system status, current measurements,
 * ROI integrals, and custom metrics. Cards are conditionally shown based
 * on visualization settings.
 */
export function CardHolder({ isRunning, timer, startTime }: CardHolderProps) {
  const { settings } = useVisualizationStore()
  const { metrics } = useMetricsStore()
  const [visibleMetrics, setVisibleMetrics] = useState(() => metrics.filter(metric => metric.isVisible))

  // State for various measurements and data
  const [roiCards, setRoiCards] = useState<ROICardData[]>([])
  const [fileBandwidth, setFileBandwidth] = useState<number>(0)
  const [beamCurrent, setBeamCurrent] = useState<number>(0)
  const [beamCurrentChange, setBeamCurrentChange] = useState<number>(0)
  const [collimator1Current, setCollimator1Current] = useState<number>(0)
  const [collimator2Current, setCollimator2Current] = useState<number>(0)
  const [accumulatedCharge, setAccumulatedCharge] = useState<number>(0)
  const [totalAccumulatedCharge, setTotalAccumulatedCharge] = useState<number>(0)
  const [isConnectedCurrent, setIsConnectedCurrent] = useState(false)
  const [ipCurrent, setIpCurrent] = useState<string>('')
  const [portCurrent, setPortCurrent] = useState<string>('')
  const [metricValues, setMetricValues] = useState<{ [key: string]: number }>({})
  const intervalRefs = useRef<{ [key: string]: NodeJS.Timeout }>({})

  // Update visible metrics when metrics store changes
  useEffect(() => {
    setVisibleMetrics(metrics.filter(metric => metric.isVisible))
  }, [metrics])

  // Set up polling intervals for data updates
  useEffect(() => {
    const fetchInitialData = async () => {
      try {
        const [ip, port, isConnected] = await Promise.all([
          getIpCurrent(),
          getPortCurrent(),
          getConnectedCurrent()
        ])
        setIpCurrent(ip)
        setPortCurrent(port)
        setIsConnectedCurrent(isConnected)
      } catch (error) {
        console.error('Failed to fetch initial TetrAMM data:', error)
      }
    }

    fetchInitialData()

    // Set up intervals for real-time data updates
    const beamCurrentInterval = setInterval(updateBeamCurrent, 1000)
    const collimator1CurrentInterval = setInterval(updateCollimator1Current, 1000)
    const collimator2CurrentInterval = setInterval(updateCollimator2Current, 1000)
    const roiInterval = setInterval(updateROIData, 1000)
    const bandwidthInterval = setInterval(updateBandwidthData, 1000)
    const accumulatedChargeInterval = setInterval(updateAccumulatedCharge, 1000)
    const totalAccumulatedChargeInterval = setInterval(updateTotalAccumulatedCharge, 1000)

    return () => {
      clearInterval(beamCurrentInterval)
      clearInterval(collimator1CurrentInterval)
      clearInterval(collimator2CurrentInterval)
      clearInterval(roiInterval)
      clearInterval(bandwidthInterval)
      clearInterval(accumulatedChargeInterval)
      clearInterval(totalAccumulatedChargeInterval)
    }
  }, [])

  // Set up intervals for custom metrics
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
   * Updates ROI (Region of Interest) data by fetching from histogram-configs.json
   * and calculating integrals for each enabled ROI
   */
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

      // Process each histogram configuration
      for (const config of histogramConfigs) {
        // Only process visible histograms with ROIs
        if (!config.visible || !config.rois || config.rois.length === 0) {
          continue
        }

        // Process each ROI in the histogram
        for (const roi of config.rois) {
          if (!roi.enabled) continue

          try {
            // Get the integral value for this ROI
            const integral = await getRoiIntegral(
              config.boardId,
              config.channel.toString(),
              roi.low,
              roi.high
            )

            // Create card data with updated integral
            const cardData: ROICardData = {
              histogramId: config.id,
              histogramLabel: config.customLabel || config.label,
              boardId: config.boardId,
              channel: config.channel,
              roi: {
                ...roi,
                integral: integral
              }
            }

            newRoiCards.push(cardData)
          } catch (error) {
            console.error(`Failed to get ROI integral for ${config.id}, ROI ${roi.id}:`, error)
            
            // Still add the card but with previous integral value
            const cardData: ROICardData = {
              histogramId: config.id,
              histogramLabel: config.customLabel || config.label,
              boardId: config.boardId,
              channel: config.channel,
              roi: roi
            }

            newRoiCards.push(cardData)
          }
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

  const updateCollimator1Current = async () => {
    try {
      const currentData = await getDataCollimator1()
      setCollimator1Current(currentData)
    } catch (error) {
      console.error('Failed to update collimator 1 current:', error)
    }
  }

  const updateCollimator2Current = async () => {
    try {
      const currentData = await getDataCollimator2()
      setCollimator2Current(currentData)
    } catch (error) {
      console.error('Failed to update collimator 2 current:', error)
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

        {/* TetrAMM Connection Status Card */}
        {settings.showStatus && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                TetrAMM
              </CardTitle>
              <BatteryCharging className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{isConnectedCurrent ? "Connected" : "Disconnected"}</div>
              <p className="text-xs text-muted-foreground">
                {`IP: ${ipCurrent} Port: ${portCurrent}`}
              </p>
            </CardContent>
          </Card>
        )}

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

        {/* Collimator Upstream Current Card */}
        {settings.showCurrent && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Collimator Upstream
              </CardTitle>
              <Thermometer className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{collimator1Current.toFixed(2)} uA</div>
              <p className="text-xs text-muted-foreground">
                Current on the first collimator
              </p>
            </CardContent>
          </Card>
        )}

        {/* Collimator Downstream Current Card */}
        {settings.showCurrent && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Collimator Downstream
              </CardTitle>
              <Thermometer className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{collimator2Current.toFixed(2)} uA</div>
              <p className="text-xs text-muted-foreground">
                Current on the second collimator
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
                <div className="text-2xl font-bold">{cardData.roi.integral}</div>
                <p className="text-xs text-muted-foreground">
                  {cardData.roi.name}: {cardData.roi.low} - {cardData.roi.high}
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
      </div>
    </ScrollArea>
  )
}