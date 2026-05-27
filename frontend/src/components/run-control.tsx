'use client'

import { useState, useEffect } from 'react'
import { useToast } from '@/components/ui/use-toast'
import {
  getSaveData,
  getLimitDataSize,
  getDataSizeLimit,
  getCurrentRunNumber,
  getRunStatus,
  getStartTime,
  getIpCurrent,
  getPortCurrent,
  getConnectedCurrent,
} from '@/lib/api'
import useRunControlStore from '@/store/run-control-store'
import { useVisualizationStore } from '@/store/visualization-settings-store'
import { CardHolder } from '@/components/card-holder'
import { RunControlButtons } from '@/components/run-control-buttons'
import { DAQState } from '@/components/daq-state'
import { CurrentPlot } from '@/components/current-plot'

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
 * - CurrentPlot: Real-time current measurement visualization
 */
export function RunControl() {
  const { toast } = useToast()
  const setIsRunningStore = useRunControlStore((state) => state.setIsRunning)
  const setStartTimeStore = useRunControlStore((state) => state.setStartTime)
  const currentEnabled = useVisualizationStore((state) => state.settings.currentEnabled !== false)

  // Core DAQ state
  const [saveData, setSaveDataState] = useState(false)
  const [limitFileSize, setLimitFileSize] = useState(false)
  const [fileSizeLimit, setFileSizeLimit] = useState("")
  const [runNumber, setRunNumberState] = useState<number | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [timer, setTimer] = useState(0)
  const [startTime, setStartTime] = useState<string | null>(null)

  // TetrAMM connection state
  const [isConnectedCurrent, setIsConnectedCurrent] = useState(false)
  const [ipCurrent, setIpCurrent] = useState<string>('')
  const [portCurrent, setPortCurrent] = useState<string>('')

  // Initialize component with data from backend
  useEffect(() => {
    fetchInitialData()
    
    // Set up polling intervals for status updates
    const statusInterval = setInterval(fetchRunStatus, 5000)

    return () => {
      clearInterval(statusInterval)
    }
  }, [])

  // Timer management for run duration display
  useEffect(() => {
    let interval: NodeJS.Timeout | null = null
    if (isRunning && startTime) {
      const updateTimer = () => {
        const start = new Date(startTime).getTime()
        const now = new Date().getTime()
        // start_time is a timezone-aware ISO string, so this is correct across
        // time zones. Clamp at 0 so the timer never shows a negative value from
        // small clock skew between server and client.
        const elapsed = Math.max(0, Math.floor((now - start) / 1000))
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

  // Sync local state with global store
  useEffect(() => {
    setIsRunningStore(isRunning)
    setStartTimeStore(startTime)
  }, [isRunning, startTime, setIsRunningStore, setStartTimeStore])

  /**
   * Fetches initial configuration and status from backend
   */

  const fetchInitialData = async () => {
    try {
      const [
        saveDataStatus,
        limitFileSizeStatus,
        fileSizeLimitData,
        currentRunNumber,
        runStatus,
        startTimeData,
        ipCurrentData,
        portCurrentData,
        isConnected
      ] = await Promise.all([
        getSaveData(),
        getLimitDataSize(),
        getDataSizeLimit(),
        getCurrentRunNumber(),
        getRunStatus(),
        getStartTime(),
        getIpCurrent(),
        getPortCurrent(),
        getConnectedCurrent()
      ])

      setSaveDataState(saveDataStatus)
      setLimitFileSize(limitFileSizeStatus)
      setFileSizeLimit(fileSizeLimitData.toString())
      setRunNumberState(currentRunNumber)
      setIsRunning(runStatus)
      setStartTime(startTimeData)
      setIpCurrent(ipCurrentData)
      setPortCurrent(portCurrentData)
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

  /**
   * Polls backend for current run status and run number
   */

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

  return (
    <div className="flex flex-col bg-background text-foreground">
      <main className="flex flex-1 flex-col gap-4 p-4 md:gap-8 md:p-2">
        {/* Status Cards Section */}
        <CardHolder
          isRunning={isRunning}
          timer={timer}
          startTime={startTime}
          runNumber={runNumber}
        />

        {/* Control and Configuration Section */}
        <div className="grid gap-4 md:gap-8 xl:grid-cols-2">
          {/* Experiment Controls */}
          <RunControlButtons
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

          {/* Acquisition Parameters */}
          <DAQState
            runNumber={runNumber}
            saveData={saveData}
            limitFileSize={limitFileSize}
            fileSizeLimit={fileSizeLimit}
            ipCurrent={ipCurrent}
            portCurrent={portCurrent}
            isConnectedCurrent={isConnectedCurrent}
            isRunning={isRunning}
            onSaveDataChange={setSaveDataState}
            onLimitFileSizeChange={setLimitFileSize}
            onFileSizeLimitChange={setFileSizeLimit}
            onRunNumberChange={setRunNumberState}
            onIpCurrentChange={setIpCurrent}
            onPortCurrentChange={setPortCurrent}
          />
        </div>

        {/* Current Measurement Visualization */}
        {currentEnabled && <CurrentPlot />}
      </main>
    </div>
  )
}