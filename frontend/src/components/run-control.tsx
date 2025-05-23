'use client'

import { useState, useEffect, useRef } from 'react'
import {
  Activity,
  AlertTriangle,
  BarChart3,
  BarChart,
  ChevronDown,
  CircleUser,
  Cog,
  Database,
  FlaskConical,
  Menu,
  PlayCircle,
  Power,
  Search,
  StopCircle,
  Thermometer,
  CircleGauge,
  HardDrive,
  Network,
  RefreshCw,
  Plug,
  BatteryCharging,
  DoorOpen,
  DoorClosed
} from "lucide-react"
import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import useAuthStore from '@/store/auth-store'
import { useRouter } from 'next/navigation'
import { useToast } from '@/components/ui/use-toast'
import {
  startRun,
  stopRun,
  getSaveData,
  setSaveData,
  getLimitDataSize,
  setLimitDataSize,
  getDataSizeLimit,
  setDataSizeLimit,
  getCurrentRunNumber,
  setRunNumber,
  checkRunDirectoryExists,
  getRunStatus,
  getStartTime,
  activateWaveform,
  deactivateWaveform,
  getWaveformStatus,
  getRoiIntegral,
  getFileBandwidth,
  reset,
  resetDeviceCurrent,
  getDataCurrent,
  startAcquisitionCurrent,
  stopAcquisitionCurrent,
  getAccumulatedCharge,
  getMetricData, 
  getTotalAccumulatedCharge,
  resetTotalAccumulatedCharge,
  setIpPortCurrent,
  getIpCurrent,
  getPortCurrent,
  connectCurrent,
  getConnectedCurrent,
  openFaraday,
  closeFaraday,
  addRunMetadata,
  getRunMetadataAll,
  getDataCollimator1,
  getDataCollimator2
} from '@/lib/api'
import { useVisualizationStore } from '@/store/visualization-settings-store'
import { useMetricsStore } from '@/store/metrics-store'
import useRunControlStore from '@/store/run-control-store'
import CurrentGraph from "@/components/current-graph"

import { string } from 'zod'
import { set } from 'react-hook-form'


type BoardData = {
  id: string;
  name: string;
  vme: string;
  link_type: string;
  link_num: string;
  dpp: string;
  chan: string;
}

type ROIValues = {
  [key: string]: { low: number; high: number; integral: number };
}

type roi = { low: number; high: number; integral: number }

export function RunControl() {
  const clearToken = useAuthStore((state) => state.clearToken)
  const router = useRouter()
  const { toast } = useToast()
  const { settings } = useVisualizationStore()
  const { metrics } = useMetricsStore()
  const [visibleMetrics, setVisibleMetrics] = useState(() => metrics.filter(metric => metric.isVisible))

  const setIsRunningStore = useRunControlStore((state) => state.setIsRunning)
  const setStartTimeStore = useRunControlStore((state) => state.setStartTime)

  useEffect(() => {
    setVisibleMetrics(metrics.filter(metric => metric.isVisible))
  }, [metrics])

  const [saveData, setSaveDataBox] = useState(false)
  const [limitFileSize, setLimitFileSize] = useState(false)
  const [fileSizeLimit, setFileSizeLimit] = useState("")
  const [runNumber, setRunNumberState] = useState<number | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [timer, setTimer] = useState(0)
  const [startTime, setStartTime] = useState<string | null>(null)
  const [showOverrideDialog, setShowOverrideDialog] = useState(false)
  const [showVoltagesDialog, setShowVoltagesDialog] = useState(false)
  const [showParametersDialog, setShowParametersDialog] = useState(false)
  const [waveformsEnabled, setWaveformsEnabled] = useState(false)
  const [roiValues, setRoiValues] = useState<ROIValues>({})
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

  // Initial values are taken from the last run
  const [targetName, setTargetName] = useState<string>('')
  const [runType, setRunType] = useState<string>('')
  const [tv, setTv] = useState<string>("0")
  const [pv, setPv] = useState<string>("0")
  const [voltagesModified, setVoltagesModified] = useState<boolean>(false)

  

  useEffect(() => {
    fetchInitialData()
    fetchLastRunMetadata()
    const statusInterval = setInterval(fetchRunStatus, 5000)
    const beamCurrentInterval = setInterval(updateBeamCurrent, 1000)
    const collimator1CurrentInterval = setInterval(updateCollimator1Current, 1000)
    const collimator2CurrentInterval = setInterval(updateCollimator2Current, 1000)
    const roiInterval = setInterval(updateROIData, 1000)
    const bandwidthInterval = setInterval(updateBandwidthData, 1000)
    const accumulatedChargeInterval = setInterval(updateAccumulatedCharge, 1000)
    const totalAccumulatedChargeInterval = setInterval(updateTotalAccumulatedCharge, 1000)

    return () => {
      clearInterval(statusInterval)
      clearInterval(roiInterval)
      clearInterval(bandwidthInterval)
      clearInterval(beamCurrentInterval)
      clearInterval(accumulatedChargeInterval)
      clearInterval(totalAccumulatedChargeInterval)
    }
  }, [])

  useEffect(() => {
    let interval: NodeJS.Timeout | null = null
    if (isRunning && startTime) {
      const updateTimer = () => {
        const start = new Date(startTime).getTime()
        const now = new Date().getTime()
        const elapsed = Math.floor((now - start) / 1000)
        setTimer(elapsed)
      }
      updateTimer()
      interval = setInterval(updateTimer, 1000)
    } else if (!isRunning) {
      setTimer(0)
    }
    return () => {
      if (interval) clearInterval(interval)
    }
  }, [isRunning, startTime])

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

  useEffect(() => {
    setIsRunningStore(isRunning)
    setStartTimeStore(startTime)
  }, [isRunning, startTime])


  const clearMetricInterval = (metricId: string) => {
    if (intervalRefs.current[metricId]) {
      clearInterval(intervalRefs.current[metricId])
      delete intervalRefs.current[metricId]
    }
  }

  const fetchInitialData = async () => {
    try {
      const [
        saveDataStatus,
        limitFileSizeStatus,
        fileSizeLimitData,
        currentRunNumber,
        runStatus,
        startTimeData,
        waveformStatus,
        ipCurrent,
        portCurrent,
        isConnected
      ] = await Promise.all([
        getSaveData(),
        getLimitDataSize(),
        getDataSizeLimit(),
        getCurrentRunNumber(),
        getRunStatus(),
        getStartTime(),
        getWaveformStatus(),
        getIpCurrent(),
        getPortCurrent(),
        getConnectedCurrent()
      ])

      setSaveDataBox(saveDataStatus)
      setLimitFileSize(limitFileSizeStatus)
      setFileSizeLimit(fileSizeLimitData.toString())
      setRunNumberState(currentRunNumber)
      setIsRunning(runStatus)
      setStartTime(startTimeData)
      setWaveformsEnabled(waveformStatus)
      setIpCurrent(ipCurrent)
      setPortCurrent(portCurrent)
      setIsConnectedCurrent(isConnected)
    } catch (error) {
      console.error('Failed to fetch initial data:', error)
      toast({
        title: "Error",
        description: "Failed to fetch initial data. Please try again.",
        variant: "destructive",
      })
    }
  }


  const fetchLastRunMetadata = async () => {
    try {
      const metadata = await getRunMetadataAll();
      if (metadata.data && metadata.data.length > 0) {
        console.log(metadata.data[0]);
        const lastRun = metadata.data[0];
        setTargetName(lastRun.target_name || ''); // Use default if undefined
        setRunType(lastRun.run_type || '');
        setTv(lastRun.terminal_voltage || '0');
        setPv(lastRun.probe_voltage || '0');
        setVoltagesModified(false);
      }
    } catch (error) {
      console.error('Failed to fetch last run metadata:', error);
      toast({
        title: "Error",
        description: "Failed to fetch last run metadata.",
        variant: "destructive",
      });
    }
  };

  const fetchRunStatus = async () => {
    try {
      const [statusResponse, runNumberResponse] = await Promise.all([
        getRunStatus(),
        getCurrentRunNumber()
      ])
      setIsRunning(statusResponse)
      setRunNumberState(runNumberResponse)
    } catch (error) {
      console.error('Failed to fetch run status:', error)
    }
  }

  function extractBoardAndChannel(str: string) {
    const match = str.match(/board(\d+)_channel(\d+)/);
    if (match) {
      return {
        boardId: parseInt(match[1], 10),
        channelNumber: parseInt(match[2], 10)
      };
    }
    return null;
  }

  const updateROIData = async () => {
    try {
      const response = await fetch('/api/cache')
      const data = await response.json()

      for (const key in data.roiValues) {
        const boardData = extractBoardAndChannel(key)
        if (!boardData) {
          console.error('Failed to extract board and channel data:', key)
          continue
        }

        const roiTemp = data.roiValues[key]

        const integral = await getRoiIntegral(boardData.boardId.toString(), boardData.channelNumber.toString(), roiTemp.low, roiTemp.high)
        data.roiValues[key].integral = integral
        if (boardData.channelNumber === 0) {
          const newKey = `Pulser`
          data.roiValues[newKey] = data.roiValues[key]
          delete data.roiValues[key]
        }
        else if (boardData.channelNumber === 7) {
          const newKey = `Channel 7`
          data.roiValues[newKey] = data.roiValues[key]
          delete data.roiValues[key]
        }
        else {
          const newKey = `BGO ${boardData.channelNumber}`
          data.roiValues[newKey] = data.roiValues[key]
          delete data.roiValues[key]
        }
      }

      // Combine the two objects
      const roiValues = { ...data.roiValues }

      const filteredRoiValues: ROIValues = Object.fromEntries(
        Object.entries(roiValues).filter(([_, roi]) => {
          const roiValue = roi as roi;
          return !(roiValue.low === 0 && roiValue.high === 0);
        })
      ) as ROIValues;

      setRoiValues(filteredRoiValues)
    } catch (error) {
      console.error('Failed to update ROI data:', error)
    }
  }

  const updateBandwidthData = async () => {
    try {
      const [fileBW] = await Promise.all([
        getFileBandwidth(),
      ])
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

  const updateIsConnectedCurrent = async () => {
    try {
      const isConnected = await getConnectedCurrent()
      setIsConnectedCurrent(isConnected)
    } catch (error) {
      console.error('Failed to update current connection status:', error)
    }
  }

  const handleLogout = () => {
    clearToken()
    router.push('/')
  }

  const handleFCClose = async () => {
    try {
      await closeFaraday()
      toast({
        title: 'Success',
        description: 'Faraday Cup has been closed.',
      })
    } catch (error) {
      console.error('Failed to close Faraday Cup:', error)
      toast({
        title: 'Error',
        description: 'Failed to close Faraday Cup. Please try again.',
        variant: 'destructive',
      })
    }
  }

  const handleFCOpen = async () => {
    try {
      await openFaraday()
      toast({
        title: 'Success',
        description: 'Faraday Cup has been opened.',
      })
    } catch (error) {
      console.error('Failed to open Faraday Cup:', error)
      toast({
        title: 'Error',
        description: 'Failed to open Faraday Cup. Please try again.',
        variant: 'destructive',
      })
    }
  }

  const handleIpCurrent = async (value: string) => {
    setIpCurrent(value)
    await setIpPortCurrent(value, portCurrent)
  }

  const handlePortCurrent = async (value: string) => {
    setPortCurrent(value)
    await setIpPortCurrent(ipCurrent, value)
  }

  const handleStartRun = async () => {
    if (runNumber === null) {
      toast({
        title: 'Error',
        description: 'Run number is not set. Please set a run number before starting.',
        variant: 'destructive',
      })
      return
    }

    try {
      await setRunNumber(runNumber!)
      const directoryExists = await checkRunDirectoryExists()
      await setSaveData(saveData)
      if (directoryExists) {
        setShowOverrideDialog(true)
        return
      }
      if (!voltagesModified) {
        setShowVoltagesDialog(true)
        return
      }

      await startRunProcess()
    } catch (error) {
      console.error('Failed to start run:', error)
      toast({
        title: 'Error',
        description: 'Failed to start the run. Please check all parameters and try again.',
        variant: 'destructive',
      })
    }
  }

  const startRunProcess = async () => {
    if (runNumber === null) {
      toast({
        title: 'Error',
        description: 'Run number is not set. Please set a run number before starting.',
        variant: 'destructive',
      })
      return
    }

    try {
      toast({
        title: 'Starting Run...',
        description: `Please wait while the run ${runNumber} is being started.`,
      })
      await setSaveData(saveData)
      await setLimitDataSize(limitFileSize)
      if (limitFileSize) {
        await setDataSizeLimit(parseInt(fileSizeLimit))
      }
      if (waveformsEnabled) {
        await activateWaveform()
      } else {
        await deactivateWaveform()
      }

      // Try to close the FC cup
      //try {
      //  await closeFaraday()
      //} catch (error) {
      //  console.error('Failed to close Faraday Cup:', error)
      //}

      if( saveData ) {
        await startAcquisitionCurrent( String(runNumber) )
      }

      const initialCurrent = await getDataCurrent()
      localStorage.setItem('initialBeamCurrent', initialCurrent.toString())

      await startRun()

      // Try to open the FC cup
      //try {
      //  await openFaraday()
      //} catch (error) {
      //  console.error('Failed to close Faraday Cup:', error)
      //}

      const newStartTime = await getStartTime()
      setIsRunning(true)
      setStartTime(newStartTime)
      setIsRunningStore(true)
      setStartTimeStore(newStartTime)
      addRunMetadata(runNumber, targetName, tv, pv, runType)
      toast({
        title: 'Run Started',
        description: `Run ${runNumber} started successfully with all parameters set.`,
      })
    } catch (error) {
      console.error('Failed to start run:', error)
      toast({
        title: 'Error',
        description: 'Failed to start the run. Please check all parameters and try again.',
        variant: 'destructive',
      })
    }
  }

  const handleStopRun = async () => {
    try {
      setStartTime(null)
      toast({
        title: 'Stopping Run...',
        description: 'Please wait while the run is being stopped.',
      })

      // Try to close the FC cup
      //try {
      //  await closeFaraday()
      //} catch (error) {
      //  console.error('Failed to close Faraday Cup:', error)
      //}

      await stopRun()
      if (saveData) {
        await stopAcquisitionCurrent()
      }

      await stopRun()

      toast({
        title: 'Run Stopped',
        description: 'The experiment run has been stopped successfully.',
      })
      setIsRunning(false)
      setIsRunningStore(false)
      setStartTimeStore(null)
      setVoltagesModified(false)

      const newRunNumber = await getCurrentRunNumber()
      setRunNumberState(newRunNumber)
    } catch (error) {
      console.error('Failed to stop run:', error)
      toast({
        title: 'Error',
        description: 'Failed to stop the run. Please try again.',
        variant: 'destructive',
      })
    }
  }

  const handleReset = async () => {
    try {
      await resetDeviceCurrent()
      await reset()
      toast({
        title: 'XDAQ Reset',
        description: 'All the XDAQ components restarted.',
      })
    } catch (error) {
      console.error('Failed to reset parameters:', error)
      toast({
        title: 'Error',
        description: 'Failed to restart XDAQ. Please try again.',
        variant: 'destructive',
      })
    }
  }

  const handleResetTotalAccumulatedCharge = async () => {
    try {
      await resetTotalAccumulatedCharge()
      toast({
        title: 'Success',
        description: 'Total accumulated charge has been reset.',
      })
      updateTotalAccumulatedCharge()
    } catch (error) {
      console.error('Failed to reset total accumulated charge:', error)
      toast({
        title: 'Error',
        description: 'Failed to reset total accumulated charge. Please try again.',
        variant: 'destructive',
      })
    }
  }

  const formatTime = (seconds: number) => {
    // Return seconds for now
    return `${seconds} seconds`
  }

  const handleSaveDataChange = (checked: boolean) => {
    setSaveDataBox(checked)
    setSaveData(checked)
  }

  const handleLimitFileSizeChange = (checked: boolean) => {
    setLimitFileSize(checked)
    setLimitDataSize(checked)
  }

  const handleFileSizeLimitChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFileSizeLimit(e.target.value)
    setDataSizeLimit(parseInt(e.target.value))
  }

  const handleRunNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value)
    setRunNumberState(value)
    setRunNumber(value)
  }

  const handleIpPortChange = async () => {
    try {
      await setIpPortCurrent(ipCurrent, portCurrent)
      toast({
        title: 'Success',
        description: 'IP and Port have been updated.',
      })
      await connectCurrent()
      updateIsConnectedCurrent()
    } catch (error) {
      console.error('Failed to connect to TetrAMM:', error)
      toast({
        title: 'Error',
        description: 'Failed to connect to TetrAMM. Please try again.',
        variant: 'destructive',
      })
    }
  }

  const handleWaveformsChange = async (checked: boolean) => {
    try {
      if (checked) {
        await activateWaveform()
      } else {
        await deactivateWaveform()
      }
      setWaveformsEnabled(checked)
    } catch (error) {
      console.error('Failed to change waveform status:', error)
      toast({
        title: "Error",
        description: "Failed to change waveform status. Please try again.",
        variant: "destructive",
      })
    }
  }

  return (
    <div className="flex flex-col bg-background text-foreground">
      <main className="flex flex-1 flex-col gap-4 p-4 md:gap-8 md:p-2">
        <ScrollArea className="h-[420px] rounded-md border p-4">
        <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-6 md:gap-8 lg:grid-cols-4">
            {settings.showStatus && <Card>
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
            </Card>}
            {settings.showStatus && <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">
                  TetrAMM
                </CardTitle>
                <BatteryCharging className="h-4 w-4 text-muted-foreground" />
              </CardHeader>

              <CardContent>
                <div className="text-2xl font-bold">{isConnectedCurrent ? "Connected" : "Disconnected"}</div>
                <p className="text-xs text-muted-foreground">
                  {'IP: ' + ipCurrent + ' Port: ' + portCurrent}
                </p>
              </CardContent>
            </Card>}
            {settings.showCurrent && <Card>
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
            </Card>}
            {settings.showCurrent && <Card>
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
            </Card>}
            {settings.showCurrent && <Card>
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
            </Card>}
            {settings.showCurrent && <Card>
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
            </Card>}
            {settings.showCurrent && (
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">
                    Total Accumulated Charge
                  </CardTitle>
                  <Database className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                <div className="text-2xl font-bold">{totalAccumulatedCharge > 1000000 ? (totalAccumulatedCharge/1000000).toFixed(2) + " C" : totalAccumulatedCharge.toFixed(2) + " uC"}</div>
                  <p className="text-xs text-muted-foreground">
                    Total Charge Accumulated since Last Reset
                  </p>
                </CardContent>
              </Card>
            )}
            {settings.showXDAQ && <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">
                  File Bandwidth
                </CardTitle>
                <HardDrive className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                {fileBandwidth < 0.1 ? ( <div className="text-2xl font-bold">{(fileBandwidth*1024).toFixed(2)} KB/s</div> ) : <div className="text-2xl font-bold">{fileBandwidth.toFixed(2)} MB/s</div>} 
                <p className="text-xs text-muted-foreground">
                  Data Writing Speed
                </p>
              </CardContent>
            </Card>}
            {settings.showROIs && 
              Object.entries(roiValues).map(([histoId, roi]) => (
              <Card key={histoId}>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">
                  {histoId}
                </CardTitle>
                <BarChart className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                <div className="text-2xl font-bold">{roi.integral}</div>
                <p className="text-xs text-muted-foreground">
                  ROI: {roi.low} - {roi.high}
                </p>
                </CardContent>
              </Card>
              ))
            }
            {visibleMetrics.map(metric => (
              <Card key={metric.id}>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">
                    {metric.metricName.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')}
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
        </ScrollArea><div className="grid gap-4 md:gap-8 xl:grid-cols-2">
          {/* Card 1: Experiment Controls - Full width on mobile */}
          <Card>
            <CardHeader className="space-y-1 sm:space-y-0">
              <CardTitle className="text-lg sm:text-xl">Experiment Controls</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 mb-8">
                  <div className="flex flex-col gap-2">
                  <Label htmlFor="targetName">Target Name</Label>
                  <Input
                    id="targetName"
                    type="text"
                    value={targetName}
                    onChange={(e) => setTargetName(e.target.value)}
                    disabled={isRunning}
                  />
                  </div>
                  <div className="flex flex-col gap-2">
                  <Label htmlFor="targetType">Run Type</Label>
                  <Select value={runType} onValueChange={(value) => setRunType(value) } disabled={isRunning}>
                    <SelectTrigger id="framework">
                    <SelectValue placeholder="Select" />
                    </SelectTrigger>
                    <SelectContent position="popper">
                    <SelectItem value="longrun">Long Run</SelectItem>
                    <SelectItem value="scan">Scan</SelectItem>
                      <SelectItem value="background">Background</SelectItem>
                      <SelectItem value="calibration">Calibration</SelectItem>
                    </SelectContent>
                  </Select>
                  </div>
                  <div className="flex flex-col gap-2">
                  <Label htmlFor="tv">TV</Label>
                  <Input
                    id="tv"
                    type="text"
                    value={tv}
                    onChange={(e) => {
                      setTv(e.target.value)
                      setVoltagesModified(true)
                    }}
                    disabled={isRunning}
                  />
                  </div>
                    <div className="flex flex-col gap-2">
                    <Label htmlFor="pv">PV</Label>
                    <Input
                    id="pv"
                    type="text"
                    value={pv}
                    onChange={(e) => {
                      setPv(e.target.value)
                      setVoltagesModified(true)
                    }}
                    disabled={isRunning}
                    />
                    </div>
                </div>
              <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center sm:gap-4">
                <Button onClick={handleStartRun} className="w-full" disabled={isRunning}>
                  <PlayCircle className="mr-2 h-4 w-4" />
                  Start Run
                </Button>
                <Button onClick={handleStopRun} variant="outline" className="w-full" disabled={!isRunning}>
                  <StopCircle className="mr-2 h-4 w-4" />
                  Stop Run
                </Button>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:flex sm:items-center sm:gap-4">
                <Button onClick={handleResetTotalAccumulatedCharge} className="w-full" variant="outline">
                  <RefreshCw className="mr-2 h-4 w-4" />
                  <span className="hidden md:inline">Reset Total Charge</span>
                  <span className="inline md:hidden">Reset Charge</span>
                </Button>
                <Button onClick={handleIpPortChange} className="w-full" variant="outline">
                  <Plug className="mr-2 h-4 w-4" />
                  <span className="hidden md:inline">Connect TetrAMM</span>
                  <span className="inline md:hidden">Connect</span>
                </Button>
              </div>
              <div className="flex items-center gap-4">
                <Button onClick={handleReset} className="w-full" variant="outline">
                  <AlertTriangle className="mr-2 h-4 w-4" />
                  Reset
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Card 2: Acquisition Parameters - Full width on mobile */}
          <Card>
            <CardHeader className="flex flex-row items-center flex-wrap gap-2">
              <div className="grid gap-1">
                <CardTitle className="text-lg sm:text-xl">Acquisition Parameters</CardTitle>
                <CardDescription className="text-xs sm:text-sm">
                  Current settings for the DAQ
                </CardDescription>
              </div>
              <Button onClick={() => setShowParametersDialog(true)} className="ml-auto" size="sm">
                <Cog className="mr-2 h-4 w-4" />
                <span className="hidden sm:inline">Adjust</span>
              </Button>
            </CardHeader>
            <CardContent className="px-2 sm:px-6 overflow-auto">
              <div className="min-w-full overflow-x-auto">
                <Table className="w-full">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="whitespace-nowrap text-xs sm:text-sm w-1/3">Parameter</TableHead>
                      <TableHead className="whitespace-nowrap text-xs sm:text-sm w-1/3">Value</TableHead>
                      <TableHead className="whitespace-nowrap text-xs sm:text-sm w-1/3">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow>
                      <TableCell className="text-xs sm:text-sm py-2">Run Number</TableCell>
                      <TableCell className="text-xs sm:text-sm py-2">{runNumber !== null ? runNumber : ''}</TableCell>
                      <TableCell className="text-xs sm:text-sm py-2">
                        <Badge variant="outline" className="text-xs">Autoincrement</Badge>
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="text-xs sm:text-sm py-2">Save Data</TableCell>
                      <TableCell className="text-xs sm:text-sm py-2"></TableCell>
                      <TableCell className="text-xs sm:text-sm py-2">
                        <Badge variant="outline" className="text-xs">
                          {saveData ? 'Enabled' : 'Disabled'}
                        </Badge>
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="text-xs sm:text-sm py-2">Max File Size</TableCell>
                      <TableCell className="text-xs sm:text-sm py-2">
                        {limitFileSize ? `${fileSizeLimit} MB` : 'None'}
                      </TableCell>
                      <TableCell className="text-xs sm:text-sm py-2">
                        <Badge variant="outline" className="text-xs">
                          {limitFileSize ? 'Set' : 'Unset'}
                        </Badge>
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="text-xs sm:text-sm py-2">Waveforms</TableCell>
                      <TableCell className="text-xs sm:text-sm py-2"></TableCell>
                      <TableCell className="text-xs sm:text-sm py-2">
                        <Badge variant="outline" className="text-xs">
                          {waveformsEnabled ? 'Enabled' : 'Disabled'}
                        </Badge>
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="text-xs sm:text-sm py-2">TetrAMM Address</TableCell>
                        <TableCell className="text-xs sm:text-sm py-2">
                        <div className="block sm:hidden">...</div>
                        <div className="hidden sm:block">{`${ipCurrent}:${portCurrent}`}</div>
                        </TableCell>
                      <TableCell className="text-xs sm:text-sm py-2">
                      <Badge variant={isConnectedCurrent ? "outline" : "destructive"} className="text-xs">
                        {isConnectedCurrent ? 'Connected' : 'Disconnected'}
                      </Badge>
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </div>
        <div className=" gap-4 ">
        <CurrentGraph />
        </div>
      </main>
      {/* Override Dialog */}
      <AlertDialog open={showOverrideDialog} onOpenChange={setShowOverrideDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Override Existing Run?</AlertDialogTitle>
            <AlertDialogDescription>
              The directory for run number {runNumber} already exists. Do you want to override it?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={startRunProcess}>Override</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* Same voltages dialog */}
      <AlertDialog open={showVoltagesDialog} onOpenChange={setShowVoltagesDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Keep same acceleraotor voltages?</AlertDialogTitle>
            <AlertDialogDescription>
              The voltages for the current run are the same as the last run. Do you want to keep them?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Discard</AlertDialogCancel>
            <AlertDialogAction onClick={() => { startRunProcess(); setVoltagesModified(false); }}>Keep</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* Parameters Dialog */}
      <Dialog open={showParametersDialog} onOpenChange={setShowParametersDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adjust Acquisition Parameters</DialogTitle>
            <DialogDescription>
              Set the acquisition parameters for the DAQ.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 items-center gap-4">
              <Label htmlFor="runNumber">Run Number</Label>
              <Input
                id="runNumber"
                type="number"
                value={runNumber !== null ? runNumber : ''}
                onChange={handleRunNumberChange}
                disabled={isRunning}
              />
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="saveData"
                checked={saveData}
                onCheckedChange={handleSaveDataChange}
                disabled={isRunning}
              />
              <Label htmlFor="saveData">Save Data</Label>
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="limitFileSize"
                checked={limitFileSize}
                onCheckedChange={handleLimitFileSizeChange}
                disabled={isRunning}
              />
              <Label htmlFor="limitFileSize">Limit File Size</Label>
            </div>
            {limitFileSize && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="fileSizeLimit">File Size Limit (MB)</Label>
                <Input
                  id="fileSizeLimit"
                  type="number"
                  value={fileSizeLimit}
                  onChange={handleFileSizeLimitChange}
                  disabled={isRunning}
                />
              </div>
            )}
            <div className="flex items-center space-x-2">
              <Checkbox
                id="waveforms"
                checked={waveformsEnabled}
                onCheckedChange={handleWaveformsChange}
                disabled={isRunning}
              />
              <Label htmlFor="waveforms">Waveforms</Label>
            </div>
            <div className="flex flex-col gap-4">
              <Label htmlFor="ipCurrent">TetrAMM IP</Label>
              <Input
                id="ipCurrent"
                type="text"
                value={ipCurrent}
                onChange={(e) => handleIpCurrent(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-4">
              <Label htmlFor="portCurrent">TetrAMM Port</Label>
              <Input
                id="portCurrent"
                type="text"
                value={portCurrent}
                onChange={(e) => handlePortCurrent(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" onClick={() => setShowParametersDialog(false)}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}