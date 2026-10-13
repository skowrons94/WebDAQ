'use client'

import {
  useState,
  useEffect,
  useRef,
  type CSSProperties,
} from 'react'
import { useToast } from '@/components/ui/use-toast'
import {
  getSaveData,
  getLimitDataSize,
  getDataSizeLimit,
  getIpCurrent,
  getPortCurrent,
} from '@/lib/api'
import { useRunStatus } from '@/hooks/use-run-status'
import { useElapsed } from '@/components/run-status-indicator'
import {
  useVisualizationStore,
  type BeamPanelPlacement,
} from '@/store/visualization-settings-store'
import { CardHolder } from '@/components/card-holder'
import { RunControlButtons } from '@/components/run-control-buttons'
import { DAQState } from '@/components/daq-state'
import { BeamControlPanel } from '@/components/beam-control-panel'
import { cn } from '@/lib/utils'

/**
 * RunControl Component (Refactored)
 * 
 * Main component that orchestrates the experiment control interface.
 * This refactored version splits the functionality into smaller,
 * focused components for better maintainability and flexibility.
 * 
 * Components:
 * - CardHolder: Status cards showing system metrics
 * - RunControlButtons: Experiment start/stop controls and metadata
 * - DAQState: Acquisition parameters display and configuration
 * - BeamControlPanel: Movable live beam current, charge, and history
 */
export function RunControl() {
  const { toast } = useToast()
  // Run state, start time and run number come from the app's one run-status
  // poller (hooks/use-run-status.ts): the overview, the header, the run bar and
  // /alerts all read the same values.
  const runStatus = useRunStatus()
  const isRunning = runStatus.isRunning
  const startTime = runStatus.startTime
  const runNumber = runStatus.runNumber
  const timer = useElapsed(isRunning, startTime)
  const setRunNumberState = runStatus.setRunNumber
  const setIsRunning = runStatus.setIsRunning
  const setStartTime = runStatus.setStartTime
  const settings = useVisualizationStore((state) => state.settings)
  const updateVisualizationSettings = useVisualizationStore((state) => state.updateSettings)
  const currentEnabled = settings.currentEnabled !== false
  const beamVisible = currentEnabled && settings.showCurrent !== false
  const beamPlacement = settings.beamPanelPlacement ?? 'beside-controls'
  const statusPanelRef = useRef<HTMLDivElement>(null)
  const [statusPanelRenderedHeight, setStatusPanelRenderedHeight] = useState<number | null>(null)

  // Core DAQ state
  const [saveData, setSaveDataState] = useState(false)
  const [limitFileSize, setLimitFileSize] = useState(false)
  const [fileSizeLimit, setFileSizeLimit] = useState("")

  // TetrAMM connection state
  const [ipCurrent, setIpCurrent] = useState<string>('')
  const [portCurrent, setPortCurrent] = useState<string>('')

  // Initialize component with data from backend
  useEffect(() => {
    fetchInitialData()
  }, [])

  useEffect(() => {
    const node = statusPanelRef.current
    if (!node || typeof ResizeObserver === 'undefined') return

    const updateHeight = () => {
      setStatusPanelRenderedHeight(node.getBoundingClientRect().height)
    }
    updateHeight()

    const observer = new ResizeObserver(updateHeight)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  /**
   * Fetches initial configuration and status from backend
   */

  const fetchInitialData = async () => {
    try {
      const [
        saveDataStatus,
        limitFileSizeStatus,
        fileSizeLimitData,
        ipCurrentData,
        portCurrentData
      ] = await Promise.all([
        getSaveData(),
        getLimitDataSize(),
        getDataSizeLimit(),
        getIpCurrent(),
        getPortCurrent()
      ])

      setSaveDataState(saveDataStatus)
      setLimitFileSize(limitFileSizeStatus)
      setFileSizeLimit(fileSizeLimitData.toString())
      setIpCurrent(ipCurrentData)
      setPortCurrent(portCurrentData)
    } catch (error) {
      console.error('Failed to fetch initial data:', error)
      toast({
        title: "Error",
        description: "Failed to fetch initial data. Please try again.",
        variant: "destructive",
      })
    }
  }

  const setBeamPlacement = (placement: BeamPanelPlacement) => {
    updateVisualizationSettings({ beamPanelPlacement: placement })
  }

  const beamSlot = (
    placement: BeamPanelPlacement,
    className?: string,
    style?: CSSProperties,
  ) => beamVisible && beamPlacement === placement ? (
    <div style={style} className={cn('h-full min-h-0 min-w-0', className)}>
      <BeamControlPanel
        placement={beamPlacement}
        onPlacementChange={setBeamPlacement}
      />
    </div>
  ) : null

  return (
    <div className="flex flex-col bg-background text-foreground">
      <main className="flex flex-1 flex-col gap-4 p-4 md:gap-6 md:p-2">
          {beamSlot('top')}

          <div className={cn(
            'grid items-start gap-4 md:gap-6',
            beamPlacement === 'status' &&
              'xl:grid-cols-[minmax(0,3fr)_minmax(26rem,2fr)]',
          )}>
            <div ref={statusPanelRef} className="min-w-0">
              <CardHolder
                isRunning={isRunning}
                timer={timer}
                startTime={startTime}
                runNumber={runNumber}
                expandForBeam={beamPlacement === 'status'}
                onRunNumberChange={setRunNumberState}
                onSaveDataChange={setSaveDataState}
              />
            </div>
            {beamSlot(
              'status',
              'h-full',
              beamPlacement === 'status' && statusPanelRenderedHeight !== null
                ? { height: statusPanelRenderedHeight }
                : undefined,
            )}
          </div>

          {beamSlot('below-status')}

          <div className={cn(
            'grid items-stretch gap-4 md:gap-6',
            beamPlacement === 'beside-controls' &&
              'xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]',
          )}>
            <div className={cn(
              'order-2 grid h-full gap-4 xl:order-1',
              beamPlacement === 'beside-controls'
                ? 'grid-rows-[auto_1fr]'
                : 'xl:grid-cols-[minmax(0,2fr)_minmax(22rem,1fr)] xl:items-start',
            )}>
              <RunControlButtons
                elapsed={timer}
                saveData={saveData}
                limitFileSize={limitFileSize}
                fileSizeLimit={fileSizeLimit}
                runNumber={runNumber}
                isRunning={isRunning}
                ipCurrent={ipCurrent}
                portCurrent={portCurrent}
                onStartTimeChange={setStartTime}
                onIsRunningChange={setIsRunning}
                onRunNumberChange={setRunNumberState}
              />

              <DAQState
                runNumber={runNumber}
                saveData={saveData}
                limitFileSize={limitFileSize}
                fileSizeLimit={fileSizeLimit}
                ipCurrent={ipCurrent}
                portCurrent={portCurrent}
                isRunning={isRunning}
                onSaveDataChange={setSaveDataState}
                onLimitFileSizeChange={setLimitFileSize}
                onFileSizeLimitChange={setFileSizeLimit}
                onRunNumberChange={setRunNumberState}
                onIpCurrentChange={setIpCurrent}
                onPortCurrentChange={setPortCurrent}
                stretch={beamPlacement === 'beside-controls'}
              />
            </div>

            {beamSlot('beside-controls', 'order-1 h-full xl:order-2')}
          </div>
      </main>
    </div>
  )
}
