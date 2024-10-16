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
  getStartTime
} from '@/lib/api'
import { set } from 'react-hook-form'

export function RunControl() {
  const clearToken = useAuthStore((state) => state.clearToken)
  const router = useRouter()
  const { toast } = useToast()

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

  useEffect(() => {
    fetchInitialData()
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
      updateTimer() // Update immediately
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
        startTimeData
      ] = await Promise.all([
        getCoincidenceWindow(),
        getMultiplicity(),
        getSaveData(),
        getLimitDataSize(),
        getDataSizeLimit(),
        getCurrentRunNumber(),
        getRunStatus(),
        getStartTime()
      ])

      setCoincidenceTime(coincidenceTimeData.toString())
      setMultiplicityBox(multiplicityData.toString())
      setSaveDataBox(saveDataStatus)
      setLimitFileSize(limitFileSizeStatus)
      setFileSizeLimit(fileSizeLimitData.toString())
      setRunNumberState(currentRunNumber)
      setIsRunning(runStatus)
      setStartTime(startTimeData)
    } catch (error) {
      console.error('Failed to fetch initial data:', error)
      toast({
        title: "Error",
        description: "Failed to fetch initial data. Please try again.",
        variant: "destructive",
      })
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
      setSaveData(saveData)
      console.log('saveData:', saveData)
      console.log('getSaveData:', await getSaveData())
      if (directoryExists) {
        setShowOverrideDialog(true)
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
    try {
      toast({
        title: 'Starting Run...',
        description: `Please wait while the run ${runNumber} is being started.`,
      })
      // Set all variables before starting the run
      await setCoincidenceWindow(parseInt(coincidenceTime))
      console.log('multiplicity:', parseInt(multiplicity))
      await setMultiplicity(parseInt(multiplicity))
      await setSaveData(saveData)
      await setLimitDataSize(limitFileSize)
      if (limitFileSize) {
        await setDataSizeLimit(parseInt(fileSizeLimit))
      }

      // Start the run
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
      await stopRun()
      toast({
        title: 'Run Stopped',
        description: 'The experiment run has been stopped successfully.',
      })
      setIsRunning(false)

      // Increment run number
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

  return (
    <div className="flex flex-col bg-background text-foreground">
        <main className="flex flex-1 flex-col gap-4 p-4 md:gap-8 md:p-8">
        <div className="grid gap-4 md:grid-cols-2 md:gap-8 lg:grid-cols-4">
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
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Beam Current
              </CardTitle>
              <Thermometer className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">250 uA</div>
              <p className="text-xs text-muted-foreground">
                +0.5 uA from start
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                ROI 1 counts
              </CardTitle>
              <BarChart className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">1,234</div>
              <p className="text-xs text-muted-foreground">
                +56 in last 5 minutes
              </p>
            </CardContent>
          </Card>
          <Card>
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
          </Card>
        </div>
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
                <Button className="w-full" variant="outline" disabled>
                  <AlertTriangle className="mr-2 h-4 w-4" />
                  Emergency Shutdown
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
                    <TableCell>Multiplycity</TableCell>
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

function MoonStarIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9" />
      <path d="M20 3v4" />
      <path d="M22 5h-4" />
    </svg>
  )
}