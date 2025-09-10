'use client'

import { useState, useEffect } from 'react'
import {
  AlertTriangle,
  PlayCircle,
  Plug,
  RefreshCw,
  StopCircle,
  Wifi,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select"
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
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useToast } from '@/components/ui/use-toast'
import {
  startRun,
  stopRun,
  setSaveData,
  setLimitDataSize,
  setDataSizeLimit,
  setRunNumber,
  checkRunDirectoryExists,
  getStartTime,
  activateWaveform,
  deactivateWaveform,
  getDataCurrent,
  startAcquisitionCurrent,
  stopAcquisitionCurrent,
  addRunMetadata,
  reset,
  resetDeviceCurrent,
  resetTotalAccumulatedCharge,
  setIpPortCurrent,
  connectCurrent,
  getCurrentRunNumber,
  getRunMetadataAll,
  refreshBoardConnections,
} from '@/lib/api'
import useRunControlStore from '@/store/run-control-store'

interface RunControlButtonsProps {
  saveData: boolean
  limitFileSize: boolean
  fileSizeLimit: string
  runNumber: number | null
  isRunning: boolean
  waveformsEnabled: boolean
  ipCurrent: string
  portCurrent: string
  onStartTimeChange: (startTime: string | null) => void
  onIsRunningChange: (isRunning: boolean) => void
  onRunNumberChange: (runNumber: number) => void
}

/**
 * RunControlButtons Component
 * 
 * Handles experiment control actions including starting/stopping runs,
 * resetting systems, and managing run metadata. Contains the main
 * experiment control logic and user interface elements.
 */
export function RunControlButtons({
  saveData,
  limitFileSize,
  fileSizeLimit,
  runNumber,
  isRunning,
  waveformsEnabled,
  ipCurrent,
  portCurrent,
  onStartTimeChange,
  onIsRunningChange,
  onRunNumberChange,
}: RunControlButtonsProps) {
  const { toast } = useToast()
  const setIsRunningStore = useRunControlStore((state) => state.setIsRunning)
  const setStartTimeStore = useRunControlStore((state) => state.setStartTime)

  // Dialog states
  const [showOverrideDialog, setShowOverrideDialog] = useState(false)
  const [showVoltagesDialog, setShowVoltagesDialog] = useState(false)

  // Run metadata states
  const [targetName, setTargetName] = useState<string>('')
  const [runType, setRunType] = useState<string>('')
  const [tv, setTv] = useState<string>("0")
  const [pv, setPv] = useState<string>("0")
  const [voltagesModified, setVoltagesModified] = useState<boolean>(false)

  // Fetch last run metadata on component mount
  useEffect(() => {
    fetchLastRunMetadata()
  }, [])

  /**
   * Fetches metadata from the most recent run to pre-populate form fields
   */
  const fetchLastRunMetadata = async () => {
    try {
      const metadata = await getRunMetadataAll();
      if (metadata.data && metadata.data.length > 0) {
        const lastRun = metadata.data[0];
        setTargetName(lastRun.target_name || '');
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

  /**
   * Initiates the run start process with validation and confirmation dialogs
   */
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

  /**
   * Core run start process that configures all systems and starts data acquisition
   */
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

      // Configure acquisition parameters
      await setSaveData(saveData)
      await setLimitDataSize(limitFileSize)
      if (limitFileSize) {
        await setDataSizeLimit(parseInt(fileSizeLimit))
      }

      // Configure waveform recording
      if (waveformsEnabled) {
        await activateWaveform()
      } else {
        await deactivateWaveform()
      }

      // Start current measurement if data saving is enabled
      if (saveData) {
        await startAcquisitionCurrent(String(runNumber))
      }

      // Store initial beam current for comparison
      const initialCurrent = await getDataCurrent()
      localStorage.setItem('initialBeamCurrent', initialCurrent.toString())

      // Start the actual DAQ run
      await startRun()

      // Update states and store run metadata
      const newStartTime = await getStartTime()
      onIsRunningChange(true)
      onStartTimeChange(newStartTime)
      setIsRunningStore(true)
      setStartTimeStore(newStartTime)
      
      if (saveData) {
        await addRunMetadata(runNumber, targetName, tv, pv, runType)
      }
      
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

  /**
   * Stops the current run and all associated data acquisition
   */
  const handleStopRun = async () => {
    try {
      onStartTimeChange(null)
      toast({
        title: 'Stopping Run...',
        description: 'Please wait while the run is being stopped.',
      })

      // Stop DAQ and current measurement
      await stopRun()
      if (saveData) {
        await stopAcquisitionCurrent()
      }

      toast({
        title: 'Run Stopped',
        description: 'The experiment run has been stopped successfully.',
      })

      // Update states
      onIsRunningChange(false)
      setIsRunningStore(false)
      setStartTimeStore(null)
      setVoltagesModified(false)

      // Update run number for next run
      const newRunNumber = await getCurrentRunNumber()
      onRunNumberChange(newRunNumber)
    } catch (error) {
      console.error('Failed to stop run:', error)
      toast({
        title: 'Error',
        description: 'Failed to stop the run. Please try again.',
        variant: 'destructive',
      })
    }
  }

  /**
   * Resets XDAQ components and current measurement device
   */
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

  /**
   * Resets the total accumulated charge counter
   */
  const handleResetTotalAccumulatedCharge = async () => {
    try {
      await resetTotalAccumulatedCharge()
      toast({
        title: 'Success',
        description: 'Total accumulated charge has been reset.',
      })
    } catch (error) {
      console.error('Failed to reset total accumulated charge:', error)
      toast({
        title: 'Error',
        description: 'Failed to reset total accumulated charge. Please try again.',
        variant: 'destructive',
      })
    }
  }

  /**
   * Connects to TetrAMM current measurement device
   */
  const handleConnectTetrAMM = async () => {
    try {
      await setIpPortCurrent(ipCurrent, portCurrent)
      await connectCurrent()
      toast({
        title: 'Success',
        description: 'Connected to TetrAMM successfully.',
      })
    } catch (error) {
      console.error('Failed to connect to TetrAMM:', error)
      toast({
        title: 'Error',
        description: 'Failed to connect to TetrAMM. Please try again.',
        variant: 'destructive',
      })
    }
  }

  /**
   * Refreshes all persistent board connections
   */
  const handleRefreshBoardConnections = async () => {
    try {
      toast({
        title: 'Refreshing Connections...',
        description: 'Please wait while board connections are being refreshed.',
      })

      const response = await refreshBoardConnections()
      
      toast({
        title: 'Success',
        description: response.data.message,
      })
    } catch (error: any) {
      console.error('Failed to refresh board connections:', error)
      
      // Handle different response statuses
      if (error.response?.status === 400) {
        toast({
          title: 'Error',
          description: error.response.data.message,
          variant: 'destructive',
        })
      } else if (error.response?.status === 207) {
        // Partial success
        toast({
          title: 'Warning',
          description: error.response.data.message,
          variant: 'destructive',
        })
      } else {
        toast({
          title: 'Error',
          description: error.response?.data?.message || 'Failed to refresh board connections. Please try again.',
          variant: 'destructive',
        })
      }
    }
  }

  return (
    <Card>
      <CardHeader className="space-y-1 sm:space-y-0">
        <CardTitle className="text-lg sm:text-xl">Experiment Controls</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {/* Metadata Input Fields */}
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
            <Select value={runType} onValueChange={(value) => setRunType(value)} disabled={isRunning}>
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
            <Label htmlFor="tv">TV (kV)</Label>
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
            <Label htmlFor="pv">PV (kV)</Label>
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

        {/* Primary Control Buttons */}
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

        {/* Secondary Control Buttons */}
        <div className="grid grid-cols-1 gap-2 sm:flex sm:items-center sm:gap-4">
          <Button onClick={handleResetTotalAccumulatedCharge} className="w-full" variant="outline">
            <RefreshCw className="mr-2 h-4 w-4" />
            <span className="hidden md:inline">Reset Total Charge</span>
            <span className="inline md:hidden">Reset Charge</span>
          </Button>
          <Button onClick={handleConnectTetrAMM} className="w-full" variant="outline">
            <Plug className="mr-2 h-4 w-4" />
            <span className="hidden md:inline">Connect TetrAMM</span>
            <span className="inline md:hidden">Connect</span>
          </Button>
        </div>

        {/* System Reset Buttons */}
        <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center sm:gap-4">
          <Button onClick={handleReset} className="w-full" variant="outline">
            <AlertTriangle className="mr-2 h-4 w-4" />
            Reset
          </Button>
          <Button onClick={handleRefreshBoardConnections} className="w-full" variant="outline" disabled={isRunning}>
            <Wifi className="mr-2 h-4 w-4" />
            <span className="hidden md:inline">Refresh Boards</span>
            <span className="inline md:hidden">Refresh</span>
          </Button>
        </div>
      </CardContent>

      {/* Directory Override Confirmation Dialog */}
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

      {/* Voltage Confirmation Dialog */}
      <AlertDialog open={showVoltagesDialog} onOpenChange={setShowVoltagesDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Keep same accelerator voltages?</AlertDialogTitle>
            <AlertDialogDescription>
              The voltages for the current run are the same as the last run. Do you want to keep them?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Discard</AlertDialogCancel>
            <AlertDialogAction onClick={() => { 
              startRunProcess(); 
              setVoltagesModified(false); 
            }}>
              Keep
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}