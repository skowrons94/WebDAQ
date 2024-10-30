'use client'

import { useState, useEffect } from 'react'
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
} from "lucide-react"
import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
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
  getCoincidenceWindow,
  setCoincidenceWindow,
  getMultiplicity,
  setMultiplicity,
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
  getOutputBandwidth,
  reset,
  resetDeviceCurrent,
  getDataCurrent,
  startAcquisitionCurrent,
  stopAcquisitionCurrent,
  getAccumulatedCharge,
  getRoiIntegralCoinc,
  getRoiIntegralAnti
} from '@/lib/api'
import { useVisualizationStore } from '@/store/visualization-settings-store'


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

  const [coincidenceTime, setCoincidenceTime] = useState("")
  const [multiplicity, setMultiplicityBox] = useState("")
  const [saveData, setSaveDataBox] = useState(false)
  const [limitFileSize, setLimitFileSize] = useState(false)
  const [fileSizeLimit, setFileSizeLimit] = useState("")
  const [runNumber, setRunNumberState] = useState<number | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [timer, setTimer] = useState(0)
  const [startTime, setStartTime] = useState<string | null>(null)
  const [showOverrideDialog, setShowOverrideDialog] = useState(false)
  const [showParametersDialog, setShowParametersDialog] = useState(false)
  const [waveformsEnabled, setWaveformsEnabled] = useState(false)
  const [roiValues, setRoiValues] = useState<ROIValues>({})
  const [fileBandwidth, setFileBandwidth] = useState<number>(0)
  const [outputBandwidth, setOutputBandwidth] = useState<number>(0)
  const [beamCurrent, setBeamCurrent] = useState<number>(0)
  const [beamCurrentChange, setBeamCurrentChange] = useState<number>(0)
  const [accumulatedCharge, setAccumulatedCharge] = useState<number>(0)

  useEffect(() => {
    fetchInitialData()
    const statusInterval = setInterval(fetchRunStatus, 5000)
    const beamCurrentInterval = setInterval(updateBeamCurrent, 1000)
    const roiInterval = setInterval(updateROIData, 1000)
    const bandwidthInterval = setInterval(updateBandwidthData, 1000)
    const accumulatedChargeInterval = setInterval(updateAccumulatedCharge, 1000)

    return () => {
      clearInterval(statusInterval)
      clearInterval(roiInterval)
      clearInterval(bandwidthInterval)
      clearInterval(beamCurrentInterval)
      clearInterval(accumulatedChargeInterval)
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

  const fetchInitialData = async () => {
    try {
      const [
        coincidenceTimeData,
        multiplicityData,
        saveDataStatus,
        limitFileSizeStatus,
        fileSizeLimitData,
        currentRunNumber,
        runStatus,
        startTimeData,
        waveformStatus
      ] = await Promise.all([
        getCoincidenceWindow(),
        getMultiplicity(),
        getSaveData(),
        getLimitDataSize(),
        getDataSizeLimit(),
        getCurrentRunNumber(),
        getRunStatus(),
        getStartTime(),
        getWaveformStatus()
      ])

      setCoincidenceTime(coincidenceTimeData.toString())
      setMultiplicityBox(multiplicityData.toString())
      setSaveDataBox(saveDataStatus)
      setLimitFileSize(limitFileSizeStatus)
      setFileSizeLimit(fileSizeLimitData.toString())
      setRunNumberState(currentRunNumber)
      setIsRunning(runStatus)
      setStartTime(startTimeData)
      setWaveformsEnabled(waveformStatus)
    } catch (error) {
      console.error('Failed to fetch initial data:', error)
      toast({
        title: "Error",
        description: "Failed to fetch initial data. Please try again.",
        variant: "destructive",
      })
    }
  }

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

        if (key === 'board0') {
          const integral = await getRoiIntegralCoinc(boardData.boardId.toString(), roiTemp.low, roiTemp.high)
          data.roiValues[key].integral = integral
          const newKey = `BGO Sum ${boardData.boardId}`
        }
        else {
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
      }

      // Now fetch from /api/cache/anti and add to existing roiValues
      const responseAnti = await fetch('/api/cache/anti')
      const dataAnti = await responseAnti.json()

      const keys = dataAnti.roiValues
      for (const key in keys) {
        const boardData = extractBoardAndChannel(key)
        if (!boardData) {
          console.error('Failed to extract board and channel data:', key)
          continue
        }
        const roiTemp = dataAnti.roiValues[key]
        const integral = await getRoiIntegralAnti(boardData.boardId.toString(), boardData.channelNumber.toString(), roiTemp.low, roiTemp.high)
        if( boardData.channelNumber === 0) {
          const newKey = `Pulser - Single`
          dataAnti.roiValues[key].integral = integral
          dataAnti.roiValues[newKey] = dataAnti.roiValues[key]
          delete dataAnti.roiValues[key]
        }
        else if (boardData.channelNumber === 7) {
          const newKey = `Channel 7 - Single`
          dataAnti.roiValues[key].integral = integral
        dataAnti.roiValues[newKey] = dataAnti.roiValues[key]
        delete dataAnti.roiValues[key]
        }
        else {
          const newKey = `BGO ${boardData.channelNumber} - Single`
          dataAnti.roiValues[key].integral = integral
        dataAnti.roiValues[newKey] = dataAnti.roiValues[key]
        delete dataAnti.roiValues[key]
        }
      }

      // Now fetch from /api/cache/sum and add to existing roiValues
      const responseSum = await fetch('/api/cache/sum')
      const dataSum = await responseSum.json()

      const roiTemp = dataSum.roiValues['board0']
      const integral = await getRoiIntegralCoinc('0', roiTemp.low, roiTemp.high)
      dataSum.roiValues['board0'].integral = integral
      const newKey = `BGO Sum`
      dataSum.roiValues[newKey] = dataSum.roiValues['board0']
      delete dataSum.roiValues['board0']

      // Combine the two objects
      const roiValues = { ...data.roiValues, ...dataAnti.roiValues, ...dataSum.roiValues }

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
      const [fileBW, outputBW] = await Promise.all([
        getFileBandwidth(),
        getOutputBandwidth()
      ])
      setFileBandwidth(fileBW)
      setOutputBandwidth(outputBW)
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

  const handleLogout = () => {
    clearToken()
    router.push('/')
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

      // If save data is on, startAcqusiitonCurrent
      if (saveData) {
        await startAcquisitionCurrent(runNumber.toString())
      }

      await startRunProcess()
      const initialCurrent = await getDataCurrent()
      localStorage.setItem('initialBeamCurrent', initialCurrent.toString())
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
    try {
      toast({
        title: 'Starting Run...',
        description: `Please wait while the run ${runNumber} is being started.`,
      })
      await setCoincidenceWindow(parseInt(coincidenceTime))
      await setMultiplicity(parseInt(multiplicity))
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

      await startRun()
      const newStartTime = await getStartTime()
      setIsRunning(true)
      setStartTime(newStartTime)
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
      if(saveData) {
        await stopAcquisitionCurrent()
      }
      await stopRun()
      toast({
        title: 'Run Stopped',
        description: 'The experiment run has been stopped successfully.',
      })
      setIsRunning(false)

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

  const formatTime = (seconds: number) => {
    if (seconds < 60) {
      return `${Math.floor(seconds / 10) * 10} seconds`
    } else if (seconds < 3600) {
      const minutes = Math.floor(seconds / 60)
      return `${minutes} minutes`
    } else {
      const hours = Math.floor(seconds / 3600)
      const minutes = Math.floor((seconds % 3600) / 60)
      return `${hours} hours and ${minutes} minutes`
    }
  }

  const handleCoincidenceTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setCoincidenceTime(e.target.value)
    setCoincidenceWindow(parseInt(e.target.value))
  }

  const handleMultiplicityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setMultiplicityBox(e.target.value)
    setMultiplicity(parseInt(e.target.value))
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
        <ScrollArea className="h-[320px] rounded-md border p-4">
        <div className="grid gap-4 md:grid-cols-2 md:gap-8 lg:grid-cols-4">
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
                  {beamCurrentChange > 0 ? `+${beamCurrentChange.toFixed(2)}` : beamCurrentChange.toFixed(2)} uA from start
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
                Total charge accumulated
              </p>
            </CardContent>
            </Card>}
            {settings.showXDAQ && <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">
                  XDAQ Bandwidth
                </CardTitle>
                <Network className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{outputBandwidth.toFixed(2)} MB/s</div>
                <p className="text-xs text-muted-foreground">
                  Output Bandwidth
                </p>
              </CardContent>
            </Card>}
            {settings.showXDAQ && <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">
                  File Bandwidth
                </CardTitle>
                <HardDrive className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{fileBandwidth.toFixed(2)} MB/s</div>
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
            {settings.showMetrics && <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">
                  BL1 Pressure
                </CardTitle>
                <CircleGauge className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">2.3e-7 mBar</div>
                <p className="text-xs text-muted-foreground">
                  -0.1e-7 mBar from start
                </p>
              </CardContent>
            </Card>}
          </div>
        </ScrollArea>
        <div className="grid gap-4 md:gap-8 lg:grid-cols-2 xl:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle>Experiment Controls</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="flex items-center gap-4">
                <Button onClick={handleStartRun} className="w-full" disabled={isRunning}>
                  <PlayCircle className="mr-2 h-4 w-4" />
                  Start Run
                </Button>
              </div>
              <div className="flex items-center gap-4">
                <Button onClick={handleStopRun} variant="outline" className="w-full" disabled={!isRunning}>
                  <StopCircle className="mr-2 h-4 w-4" />
                  Stop Run
                </Button>
              </div>
              <div className="flex items-center gap-4">
                <Button className="w-full" variant="outline" disabled>
                  <BarChart3 className="mr-2 h-4 w-4" />
                  View Live Data
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
          <Card className="xl:col-span-2">
            <CardHeader className="flex flex-row items-center">
              <div className="grid gap-2">
                <CardTitle>Acquisition Parameters</CardTitle>
                <CardDescription>
                  Current settings for the DAQ.
                </CardDescription>
              </div>
              <Button onClick={() => setShowParametersDialog(true)} className="ml-auto" size="sm">
                <Cog className="mr-2 h-4 w-4" />
                Adjust
              </Button>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Parameter</TableHead>
                    <TableHead>Value</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell>Run Number</TableCell>
                    <TableCell>{runNumber !== null ? runNumber : ''}</TableCell>
                    <TableCell>
                      <Badge variant="outline">Autoincrement</Badge>
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Coincidence Time</TableCell>
                    <TableCell>{coincidenceTime} ns</TableCell>
                    <TableCell>
                      <Badge variant="outline">Set</Badge>
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Multiplicity</TableCell>
                    <TableCell>{multiplicity}</TableCell>
                    <TableCell>
                      <Badge variant="outline">Set</Badge>
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Save data</TableCell>
                    <TableCell></TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {saveData ? 'Enabled' : 'Disabled'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Max File Size</TableCell>
                    <TableCell>
                      {limitFileSize ? `${fileSizeLimit} MB` : 'None'}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {limitFileSize ? 'Set' : 'Unset'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Waveforms</TableCell>
                    <TableCell></TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {waveformsEnabled ? 'Enabled' : 'Disabled'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      </main>
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
              <Label htmlFor="coincidenceTime">Run Number</Label>
              <Input
                id="runNumber"
                type="number"
                value={runNumber !== null ? runNumber : ''}
                onChange={handleRunNumberChange}
                disabled={isRunning}
              />
            </div>
            <div className="grid grid-cols-1 items-center gap-4">
              <Label htmlFor="coincidenceTime">Coincidence Time (ns)</Label>
              <Input
                id="coincidenceTime"
                type="number"
                value={coincidenceTime}
                onChange={handleCoincidenceTimeChange}
                disabled={isRunning}
              />
            </div>
            <div className="grid grid-cols-1 items-center gap-4">
              <Label htmlFor="multiplicity">Multiplicity</Label>
              <Input
                id="multiplicity"
                type="number"
                value={multiplicity}
                onChange={handleMultiplicityChange}
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