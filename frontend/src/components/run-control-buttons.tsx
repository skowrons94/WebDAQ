'use client'

import { useState, useEffect } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  PlayCircle,
  Plug,
  RefreshCw,
  StopCircle,
  Wifi,
  Wrench,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select"
import { ConfirmAction } from "@/components/ui/confirm-action"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useToast } from '@/components/ui/use-toast'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  startRun,
  setSaveData,
  setLimitDataSize,
  setDataSizeLimit,
  setRunNumber,
  checkRunDirectoryExists,
  getStartTime,
  startAcquisitionCurrent,
  addRunMetadata,
  reset,
  resetDeviceCurrent,
  resetTotalAccumulatedCharge,
  setIpPortCurrent,
  connectCurrent,
  getCurrentModuleType,
  getCurrentRunNumber,
  getRunMetadataAll,
  refreshBoardConnections,
  startStatsRun,
  getTotalAccumulatedCharge,
} from '@/lib/api'
import useRunControlStore from '@/store/run-control-store'
import { useVisualizationStore } from '@/store/visualization-settings-store'
import { useGrafanaAlertsStore } from '@/store/grafana-alerts-store'
import { unpauseAlertNonBlocking } from '@/lib/grafana-api'
import { stopRunSequence } from '@/lib/run-actions'
import { refreshRunStatus } from '@/hooks/use-run-status'
import { formatElapsed } from '@/components/run-status-indicator'

interface RunControlButtonsProps {
  /** Seconds since the run started, for the Stop confirmation. */
  elapsed?: number
  saveData: boolean
  limitFileSize: boolean
  fileSizeLimit: string
  runNumber: number | null
  isRunning: boolean
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
  elapsed = 0,
  saveData,
  limitFileSize,
  fileSizeLimit,
  runNumber,
  isRunning,
  ipCurrent,
  portCurrent,
  onStartTimeChange,
  onIsRunningChange,
  onRunNumberChange,
}: RunControlButtonsProps) {
  const { toast } = useToast()
  const setIsRunningStore = useRunControlStore((state) => state.setIsRunning)
  const setStartTimeStore = useRunControlStore((state) => state.setStartTime)
  const currentEnabled = useVisualizationStore((state) => state.settings.currentEnabled !== false)
  const autoManageUids = useGrafanaAlertsStore((state) => state.autoManageUids)

  // Dialog states
  const [showOverrideDialog, setShowOverrideDialog] = useState(false)
  const [maintenanceOpen, setMaintenanceOpen] = useState(false)
  // Shown in the Reset total charge confirmation, so the operator sees what
  // is about to be zeroed.
  const [totalChargeNow, setTotalChargeNow] = useState<number | null>(null)

  // Run metadata states
  const [targetName, setTargetName] = useState<string>('')
  const [runType, setRunType] = useState<string>('')
  const [tv, setTv] = useState<string>("0")
  const [pv, setPv] = useState<string>("0")

  // Fetch last run metadata on component mount
  useEffect(() => {
    fetchLastRunMetadata()
    // Opened from the phone run bar ("Start…"): bring the controls into view.
    if (window.location.hash === '#run-control') {
      setTimeout(() => document.getElementById('run-control')?.scrollIntoView({ block: 'start' }), 300)
    }
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
      }
    } catch (error) {
      // No previous runs (empty database) is a normal state, not an error:
      // just leave the form fields at their defaults without alerting the user.
      console.error('Failed to fetch last run metadata:', error);
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
      
      // Only confirm when the run directory already exists (would be overwritten).
      if (directoryExists) {
        setShowOverrideDialog(true)
        return
      }

      await startRunProcess()
    } catch (error) {
      console.error('Failed to start run:', error)
      const serverMessage =
        (error as { response?: { data?: { message?: string } } })?.response?.data?.message
      toast({
        title: 'Error',
        description: serverMessage
          ? `Failed to start the run: ${serverMessage}`
          : 'Failed to start the run. Please check all parameters and try again.',
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

      // Waveform recording is configured per-board ahead of time (see the
      // board cards), so its persisted register state is used as-is here.

      // Start current measurement if data saving is enabled and current
      // acquisition has not been disabled in the settings.
      //
      // Neither of these may stop the run. They used to be awaited bare, so a
      // picoammeter that was connected but not sampling answered 4xx, threw,
      // and the DAQ was never started at all — the operator saw only "Failed to
      // start the run" and lost beam time to a monitor. A run without its
      // current log or its stats.csv is worth far more than no run.
      const sideEffects: string[] = []
      if (saveData) {
        if (currentEnabled) {
          try {
            await startAcquisitionCurrent(String(runNumber))
          } catch (error) {
            console.error('Current recording did not start:', error)
            sideEffects.push('beam current is not being recorded')
          }
        }
        try {
          await startStatsRun(runNumber)
        } catch (error) {
          console.error('stats.csv did not start:', error)
          sideEffects.push('stats.csv is not being written')
        }
      }

      // (The dashboard takes its own reference for "since run start" from the
      // first reading of the run, so nothing needs to be stashed here: a value
      // in this browser's localStorage was useless to every other browser, and
      // wrong for a run started from the Tuner.)

      // Start the actual DAQ run
      await startRun()

      // Update states and store run metadata
      const newStartTime = await getStartTime()
      onIsRunningChange(true)
      onStartTimeChange(newStartTime)
      setIsRunningStore(true)
      setStartTimeStore(newStartTime)
      void refreshRunStatus()

      if (saveData) {
        await addRunMetadata(runNumber, targetName, tv, pv, runType)
      }

      // Activate (unpause) Grafana alerts selected for auto-management
      autoManageUids.forEach((uid) => unpauseAlertNonBlocking(uid))

      toast({
        title: sideEffects.length ? 'Run Started (with warnings)' : 'Run Started',
        description: sideEffects.length
          ? `Run ${runNumber} is acquiring, but ${sideEffects.join(' and ')}.`
          : `Run ${runNumber} started successfully with all parameters set.`,
        variant: sideEffects.length ? 'destructive' : undefined,
      })
    } catch (error) {
      console.error('Failed to start run:', error)
      const serverMessage =
        (error as { response?: { data?: { message?: string } } })?.response?.data?.message
      toast({
        title: 'Error',
        description: serverMessage
          ? `Failed to start the run: ${serverMessage}`
          : 'Failed to start the run. Please check all parameters and try again.',
        variant: 'destructive',
      })
    }
  }

  /**
   * Stops the current run and all associated data acquisition
   */
  const handleStopRun = async () => {
    try {
      toast({
        title: 'Stopping run…',
        description: 'Please wait while the run is being stopped.',
      })

      // Stop DAQ, then current measurement and stats.csv (lib/run-actions.ts,
      // shared with the phone run bar). The displayed state is cleared only
      // once the DAQ has really stopped: a failed stop leaves it running.
      const { warnings } = await stopRunSequence(saveData)

      onIsRunningChange(false)
      onStartTimeChange(null)
      setIsRunningStore(false)
      setStartTimeStore(null)

      toast({
        title: warnings.length ? 'Run stopped (with warnings)' : 'Run stopped',
        description: warnings.length
          ? `The DAQ is stopped, but ${warnings.join(' and ')}.`
          : 'The run has been stopped.',
        variant: warnings.length ? 'destructive' : undefined,
      })

      // Update run number for next run
      const newRunNumber = await getCurrentRunNumber()
      onRunNumberChange(newRunNumber)
    } catch (error) {
      console.error('Failed to stop run:', error)
      toast({
        title: 'The run is still going',
        description: 'Failed to stop the run. Please try again.',
        variant: 'destructive',
      })
    }
  }

  /**
   * Stops any running acquisition and resets the current measurement device.
   */
  const handleReset = async () => {
    try {
      toast({
        title: 'Resetting acquisition…',
        description: 'Please wait while the acquisition is reset.',
      })

      // reset() resolves to 0 on success and -1 on failure. The current
      // device is reset only after the DAQ reset succeeded. The button is
      // disabled during a run (as on Troubleshoot): the server's reset tears
      // the acquisition down without closing the run's current log or stats.
      const result = await reset()
      if (result === -1) {
        toast({
          title: 'Error',
          description: 'Failed to reset the acquisition.',
          variant: 'destructive',
        })
        return
      }
      if (currentEnabled) {
        await resetDeviceCurrent()
      }

      toast({
        title: 'Acquisition reset',
        description: 'The acquisition has been reset.',
      })
    } catch (error) {
      console.error('Failed to reset parameters:', error)
      toast({
        title: 'Error',
        description: 'Failed to reset the acquisition. Please try again.',
        variant: 'destructive',
      })
    }
  }

  const handleResetTotalAccumulatedCharge = async () => {
    try {
      await resetTotalAccumulatedCharge()
      toast({
        title: 'Total charge reset',
        description: 'The lifetime accumulated charge has been reset.',
      })
    } catch (error) {
      console.error('Failed to reset total accumulated charge:', error)
      toast({
        title: 'Error',
        description: 'Failed to reset total accumulated charge.',
        variant: 'destructive',
      })
    }
  }

  const handleConnectCurrentModule = async () => {
    try {
      const moduleType = await getCurrentModuleType()
      if (moduleType.module_type === 'tetramm') {
        await setIpPortCurrent(ipCurrent, portCurrent)
      }
      await connectCurrent()
      toast({
        title: 'Current module connected',
        description: 'The current module is ready for beam monitoring.',
      })
    } catch (error) {
      console.error('Failed to connect current module:', error)
      toast({
        title: 'Connection failed',
        description: 'Could not connect the current module.',
        variant: 'destructive',
      })
    }
  }

  const handleRefreshBoardConnections = async () => {
    try {
      const response = await refreshBoardConnections()
      toast({
        title: 'Board connections refreshed',
        description: response.data.message,
      })
    } catch (error: any) {
      console.error('Failed to refresh board connections:', error)
      toast({
        title: 'Refresh failed',
        description: error.response?.data?.message || 'Could not refresh board connections.',
        variant: 'destructive',
      })
    }
  }

  return (
    <Card id="run-control" className="scroll-mt-28">
      <CardHeader className="pb-4">
        <CardTitle>Run setup &amp; control</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {/* Metadata Input Fields */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="targetName">Run name</Label>
            <Input
              id="targetName"
              type="text"
              value={targetName}
              onChange={(e) => setTargetName(e.target.value)}
              disabled={isRunning}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="targetType">Run type</Label>
            <Select value={runType} onValueChange={(value) => setRunType(value)} disabled={isRunning}>
              <SelectTrigger id="targetType">
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
              onChange={(e) => setTv(e.target.value)}
              disabled={isRunning}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="pv">PV (kV)</Label>
            <Input
              id="pv"
              type="text"
              value={pv}
              onChange={(e) => setPv(e.target.value)}
              disabled={isRunning}
            />
          </div>
        </div>

        {/* Primary Control Buttons. Start is green and Stop red, never the
            brand rose, so the two cannot be mistaken for each other. Stop asks
            first: it ends the run for everyone. */}
        <div className="grid grid-cols-2 gap-3 border-t pt-4">
          <Button
            onClick={handleStartRun}
            className="w-full"
            variant={isRunning ? 'outline' : 'success'}
            disabled={isRunning}
          >
            <PlayCircle className="mr-2 h-4 w-4" />
            Start Run
          </Button>
          <ConfirmAction
            trigger={
              <Button
                variant={isRunning ? 'destructive' : 'outline'}
                className="w-full"
                disabled={!isRunning}
              >
                <StopCircle className="mr-2 h-4 w-4" />
                Stop Run
              </Button>
            }
            title={runNumber !== null ? `Stop run ${runNumber}?` : 'Stop the run?'}
            description={
              <>
                <p>
                  Acquisition ends for every board{elapsed > 0 ? ` after ${formatElapsed(elapsed)}` : ''}.
                  {saveData
                    ? ' The run is closed and its files are kept.'
                    : ' Data saving is off, so nothing from this run is on disk.'}
                </p>
                <p>Starting again makes a new run.</p>
              </>
            }
            confirmLabel={runNumber !== null ? `Stop run ${runNumber}` : 'Stop run'}
            onConfirm={handleStopRun}
          />
        </div>

        <Collapsible open={maintenanceOpen} onOpenChange={setMaintenanceOpen}>
          <div className="grid items-start gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" className="w-full justify-between px-2">
                <span className="flex items-center">
                  <Wrench className="mr-2 h-4 w-4" />
                  Maintenance
                </span>
                <ChevronDown className={`h-4 w-4 transition-transform ${
                  maintenanceOpen ? 'rotate-180' : ''
                }`} />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2 sm:col-span-2">
              <div className="grid gap-2 rounded-md border bg-muted/20 p-3 sm:grid-cols-2">
                <Button
                  type="button"
                  onClick={handleConnectCurrentModule}
                  variant="outline"
                >
                  <Plug className="mr-2 h-4 w-4" />
                  Connect current module
                </Button>
                <Button
                  type="button"
                  onClick={handleRefreshBoardConnections}
                  variant="outline"
                  disabled={isRunning}
                >
                  <Wifi className="mr-2 h-4 w-4" />
                  Refresh board connections
                </Button>
                <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 sm:col-span-2">
                  <p className="mb-3 text-xs text-muted-foreground">
                    {isRunning
                      ? 'Stop the run first: the acquisition cannot be reset while a run is going.'
                      : 'Reset the acquisition only when recovery is required.'}
                  </p>
                  <ConfirmAction
                    trigger={
                      <Button
                        type="button"
                        className="w-full"
                        variant="destructive"
                        disabled={isRunning}
                      >
                        <AlertTriangle className="mr-2 h-4 w-4" />
                        Reset acquisition
                      </Button>
                    }
                    title="Reset the acquisition?"
                    description={
                      <p>
                        The CAEN acquisition and board monitoring are torn down and the boards
                        are handed back to the probe layer, ready to start again
                        {currentEnabled ? '; the current module is reset and stops logging' : ''}.
                        Use it only to recover from a stuck acquisition. Saved runs are not touched.
                      </p>
                    }
                    confirmLabel="Reset acquisition"
                    onConfirm={handleReset}
                  />
                </div>
              </div>
            </CollapsibleContent>
            {/* Stays on the dashboard (operators use it), behind a confirmation. */}
            <ConfirmAction
              trigger={
                <Button
                  type="button"
                  variant="outline"
                  className="w-full sm:col-start-2 sm:row-start-1 sm:w-auto"
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Reset total charge
                </Button>
              }
              onOpenChange={(open) => {
                if (open) {
                  setTotalChargeNow(null)
                  getTotalAccumulatedCharge()
                    .then((v) => setTotalChargeNow(Number(v)))
                    .catch(() => setTotalChargeNow(null))
                }
              }}
              title="Reset the lifetime charge total?"
              description={
                <p>
                  The lifetime accumulated charge is set to zero and cannot be recovered.
                  The charge of the current run is not affected.
                </p>
              }
              confirmLabel="Reset total charge"
              onConfirm={handleResetTotalAccumulatedCharge}
            >
              <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                Total now:{' '}
                <span className="font-semibold tabular-nums">
                  {totalChargeNow === null || !Number.isFinite(totalChargeNow)
                    ? '…'
                    : formatMicroCoulomb(totalChargeNow)}
                </span>
              </p>
            </ConfirmAction>
          </div>
        </Collapsible>
      </CardContent>

      {/* Directory Override Confirmation Dialog */}
      <ConfirmAction
        open={showOverrideDialog}
        onOpenChange={setShowOverrideDialog}
        title={`Overwrite run ${runNumber}?`}
        description={
          <p>
            The directory for run {runNumber} already exists. Starting writes this run
            into it and overwrites the files of the earlier run {runNumber}.
          </p>
        }
        confirmLabel={`Overwrite and start run ${runNumber}`}
        onConfirm={startRunProcess}
      />
    </Card>
  )
}

/** µC → a readable charge (µC, mC or C). */
function formatMicroCoulomb(microCoulombs: number): string {
  const a = Math.abs(microCoulombs)
  if (a >= 1_000_000) return `${(microCoulombs / 1_000_000).toFixed(2)} C`
  if (a >= 1_000) return `${(microCoulombs / 1_000).toFixed(2)} mC`
  return `${microCoulombs.toFixed(2)} µC`
}
