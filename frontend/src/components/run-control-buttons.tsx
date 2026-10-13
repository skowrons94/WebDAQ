'use client'

import { useState, useEffect, useRef } from 'react'
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
  AlertDialog,
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
  getSaveData,
} from '@/lib/api'
import useRunControlStore from '@/store/run-control-store'
import { useVisualizationStore } from '@/store/visualization-settings-store'
import { useGrafanaAlertsStore } from '@/store/grafana-alerts-store'
import { unpauseAlertNonBlocking } from '@/lib/grafana-api'
import { forceResetSequence, stopRunSequence } from '@/lib/run-actions'
import { noteRunAction } from '@/hooks/use-run-status'
import { StopRunBody } from '@/components/stop-run-body'

interface RunControlButtonsProps {
  /** Seconds since the run started, for the Stop confirmation. */
  elapsed?: number
  saveData: boolean
  /** Told when Start switches saving on, so the overview agrees at once. */
  onSaveDataChange?: (save: boolean) => void
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
  onSaveDataChange,
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
  const [stopping, setStopping] = useState(false)
  const [starting, setStarting] = useState(false)
  // Also a ref: a double click lands before React re-renders the disabled
  // button, so the guard must not wait for state.
  const startingRef = useRef(false)
  const setStartBusy = (busy: boolean) => { startingRef.current = busy; setStarting(busy) }
  // Saving was off at Start: the operator chooses before anything is sent.
  const [savingOffOpen, setSavingOffOpen] = useState(false)
  // The saving setting this start was confirmed with (used by startRunProcess,
  // also when it runs later from the overwrite dialog).
  const pendingSave = useRef(saveData)
  const turnOnRef = useRef<HTMLButtonElement>(null)
  // The last Stop failed while the run still shows as going: offer the forced
  // reset. Shared with the phone run bar (store), cleared once the DAQ stops.
  const stopFailed = useRunControlStore((st) => st.stopFailed)
  const setStopFailed = (v: boolean) => useRunControlStore.getState().update({ stopFailed: v })
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
    // One start at a time, from the first click on (also during the saving read).
    if (startingRef.current) return
    if (runNumber === null) {
      toast({
        title: 'Error',
        description: 'Run number is not set. Please set a run number before starting.',
        variant: 'destructive',
      })
      return
    }
    setStartBusy(true)
    // Saving may have been switched off from anywhere (the Tuner, another
    // computer): ask the server, not this page's copy. Off is never started
    // silently: the operator chooses, with "turn it on" as the default.
    let serverSave = saveData
    try {
      serverSave = Boolean(await Promise.race([
        getSaveData(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('deadline')), 4000)),
      ]))
    } catch {
      // No answer: use the page's copy; an "off" still gets the question below.
    }
    if (!serverSave) {
      // The (modal) dialog decides; its buttons take the guard again.
      setStartBusy(false)
      setSavingOffOpen(true)
      return
    }
    await beginStart(true)
  }

  /** From the saving-off dialog: the operator's choice, once. */
  const startFromDialog = (save: boolean) => {
    setSavingOffOpen(false)
    if (startingRef.current) return
    setStartBusy(true)
    void beginStart(save)
  }

  /** From the overwrite dialog: guarded like Start itself. */
  const startAfterOverwrite = async () => {
    if (startingRef.current) return
    setStartBusy(true)
    try {
      await startRunProcess()
    } finally {
      setStartBusy(false)
    }
  }

  /** Set up and start with the saving setting the operator confirmed. */
  const beginStart = async (save: boolean) => {
    pendingSave.current = save
    setStartBusy(true)
    try {
      await setRunNumber(runNumber!)
      const directoryExists = await checkRunDirectoryExists()
      await setSaveData(save)
      onSaveDataChange?.(save)

      // Only confirm when the run directory already exists (would be overwritten).
      if (directoryExists) {
        setStartBusy(false)
        setShowOverrideDialog(true)
        return
      }

      await startRunProcess()
    } catch (error) {
      console.error('Failed to start run:', (error as Error)?.message ?? error)
      const serverMessage =
        (error as { response?: { data?: { message?: string } } })?.response?.data?.message
      toast({
        title: 'Error',
        description: serverMessage
          ? `Failed to start the run: ${serverMessage}`
          : 'Failed to start the run. Please check all parameters and try again.',
        variant: 'destructive',
      })
    } finally {
      setStartBusy(false)
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

    const saveData = pendingSave.current
    try {
      toast({
        title: 'Starting run…',
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

      // The run is on: say so now, and make the shared poller ignore any
      // answer to a poll sent before the start (it would show Stopped again).
      onIsRunningChange(true)
      setIsRunningStore(true)
      noteRunAction()
      const newStartTime = await getStartTime().catch(() => null)
      if (typeof newStartTime === 'string') {
        onStartTimeChange(newStartTime)
        setStartTimeStore(newStartTime)
      }

      if (saveData) {
        await addRunMetadata(runNumber, targetName, tv, pv, runType)
      }

      // Activate (unpause) Grafana alerts selected for auto-management
      autoManageUids.forEach((uid) => unpauseAlertNonBlocking(uid))

      toast({
        title: sideEffects.length ? 'Run started (with warnings)' : 'Run started',
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
    // One stop at a time: a second confirmation during a slow stop_run would
    // repeat the teardown (and could advance the run number twice).
    if (stopping) return
    setStopping(true)
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

      setStopFailed(false)
      // Update run number for next run
      const newRunNumber = await getCurrentRunNumber()
      onRunNumberChange(newRunNumber)
    } catch (error) {
      console.error('Failed to stop run:', (error as Error)?.message ?? error)
      // The run may be stuck as "running" on the server. Offer the forced
      // reset (below the Stop button), which Reset acquisition otherwise is
      // not during a run.
      setStopFailed(true)
      toast({
        title: 'The run is still going',
        description: 'Failed to stop the run. Try again; if it keeps failing, use "Force reset acquisition".',
        variant: 'destructive',
      })
    } finally {
      setStopping(false)
    }
  }

  /**
   * Last resort after a failed Stop: the server's reset tears the CAEN
   * acquisition down and clears the running flag whatever state it is in.
   * The current log and stats.csv are closed too, as a Stop would.
   */
  const handleForceReset = async () => {
    try {
      const { warnings, nextRun } = await forceResetSequence(runNumber, saveData)
      onIsRunningChange(false)
      onStartTimeChange(null)
      if (nextRun !== null) onRunNumberChange(nextRun)
      toast({
        title: 'Acquisition reset',
        description: [
          `The DAQ is stopped. Run ${runNumber ?? ''} may be incomplete: check it in the Logbook.`,
          nextRun !== null ? `The next run is ${nextRun}.` : '',
          warnings.length ? `Also: ${warnings.join('; ')}.` : '',
        ].filter(Boolean).join(' '),
        variant: warnings.length ? 'destructive' : undefined,
      })
    } catch (error) {
      console.error('Force reset failed:', (error as Error)?.message ?? error)
      toast({ title: 'Reset failed', description: 'The acquisition could not be reset. See Troubleshoot, or stop the server.', variant: 'destructive' })
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
            <Label htmlFor="tv">Terminal voltage (kV)</Label>
            <Input
              id="tv"
              type="text"
              value={tv}
              onChange={(e) => setTv(e.target.value)}
              disabled={isRunning}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="pv">Probe voltage (kV)</Label>
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
            disabled={isRunning || starting}
          >
            <PlayCircle className="mr-2 h-4 w-4" />
            Start Run
          </Button>
          <ConfirmAction
            trigger={
              <Button
                variant={isRunning ? 'destructive' : 'outline'}
                className="w-full"
                disabled={!isRunning || stopping}
              >
                <StopCircle className="mr-2 h-4 w-4" />
                Stop Run
              </Button>
            }
            title={runNumber !== null ? `Stop run ${runNumber}?` : 'Stop the run?'}
            description={<StopRunBody elapsed={elapsed} saving={saveData} />}
            confirmLabel={runNumber !== null ? `Stop run ${runNumber}` : 'Stop run'}
            onConfirm={handleStopRun}
          />
        </div>

        {/* Not a block — a run can start without them — but the Logbook entry
            would read "Untitled run" / "Unspecified run type". */}
        {!isRunning && (!targetName.trim() || !runType) && (
          <p className="-mt-2 text-xs text-muted-foreground" role="note">
            {!targetName.trim() && !runType
              ? 'No run name or run type: the Logbook entry will be untitled and of unspecified type.'
              : !runType
                ? 'No run type: the Logbook entry will say "Unspecified run type".'
                : 'No run name: the Logbook entry will say "Untitled run".'}
          </p>
        )}

        {stopFailed && isRunning && (
          <div className="rounded-md border border-destructive bg-destructive/10 p-3" role="alert">
            <p className="mb-2 text-sm font-semibold text-destructive">The run did not stop.</p>
            <p className="mb-3 text-xs text-muted-foreground">
              Try Stop Run again first. If the DAQ is stuck, force a reset.
            </p>
            <ConfirmAction
              trigger={
                <Button type="button" variant="destructive" className="w-full">
                  <AlertTriangle className="mr-2 h-4 w-4" />
                  Force reset acquisition
                </Button>
              }
              title="Force a reset of the acquisition?"
              description={
                <>
                  <p className="font-semibold text-destructive">
                    Use this only when Stop Run keeps failing.
                  </p>
                  <p>
                    The CAEN acquisition is torn down and the server&apos;s running flag is
                    cleared, whatever state they are in; the current log and stats.csv are
                    closed. The run{runNumber !== null ? ` ${runNumber}` : ''} may be incomplete: its last
                    data may be missing, and it may not be closed in the Logbook. The
                    auto-managed Grafana alerts are paused, and with saving on the run number
                    moves on{runNumber !== null ? ` to ${runNumber + 1}` : ''}, so the next Start does not overwrite it.
                  </p>
                </>
              }
              confirmLabel="Force reset acquisition"
              onConfirm={handleForceReset}
            />
          </div>
        )}

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

      {/* Saving is off on the server: never start such a run silently.
          "Turn saving on and start" is the default (focused) choice. */}
      <AlertDialog open={savingOffOpen} onOpenChange={setSavingOffOpen}>
        <AlertDialogContent
          className="w-[calc(100%-2rem)] max-w-md rounded-lg"
          onOpenAutoFocus={(e) => { e.preventDefault(); turnOnRef.current?.focus() }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Start run {runNumber}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p className="flex items-start gap-2 rounded-md border border-destructive bg-destructive/10 p-3 font-semibold text-destructive">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  Data saving is OFF: this run will not be written to disk.
                </p>
                <p className="text-muted-foreground">
                  Saving may have been switched off by the Tuner or from another computer.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 sm:gap-0">
            <AlertDialogCancel className="pointer-coarse:min-h-11">Cancel</AlertDialogCancel>
            <Button
              variant="outline"
              className="border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => startFromDialog(false)}
            >
              Start without saving
            </Button>
            <Button
              ref={turnOnRef}
              variant="success"
              onClick={() => startFromDialog(true)}
            >
              Turn saving on and start
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
        onConfirm={startAfterOverwrite}
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
