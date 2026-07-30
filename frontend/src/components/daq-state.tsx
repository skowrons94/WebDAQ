'use client'

import { useState, useEffect } from 'react'
import { Cog } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useToast } from '@/components/ui/use-toast'
import {
  getSaveData,
  setSaveData,
  getLimitDataSize,
  setLimitDataSize,
  getDataSizeLimit,
  setDataSizeLimit,
  setRunNumber,
  setIpPortCurrent,
  getIpCurrent,
  getPortCurrent,
  getConnectedCurrent,
  getCurrentModuleType,
  getAutoRestart,
  setAutoRestart,
} from '@/lib/api'
import { useVisualizationStore } from '@/store/visualization-settings-store'

interface DAQStateProps {
  runNumber: number | null
  saveData: boolean
  limitFileSize: boolean
  fileSizeLimit: string
  ipCurrent: string
  portCurrent: string
  isRunning: boolean
  onSaveDataChange: (checked: boolean) => void
  onLimitFileSizeChange: (checked: boolean) => void
  onFileSizeLimitChange: (value: string) => void
  onRunNumberChange: (value: number) => void
  onIpCurrentChange: (value: string) => void
  onPortCurrentChange: (value: string) => void
  stretch?: boolean
}

/**
 * DAQState Component
 * 
 * Displays current DAQ acquisition parameters in a table format
 * and provides a settings dialog for adjusting these parameters.
 * Shows run number, data saving settings, file size limits,
 * waveform recording status, and TetrAMM connection details.
 */
export function DAQState({
  runNumber,
  saveData,
  limitFileSize,
  fileSizeLimit,
  ipCurrent,
  portCurrent,
  isRunning,
  onSaveDataChange,
  onLimitFileSizeChange,
  onFileSizeLimitChange,
  onRunNumberChange,
  onIpCurrentChange,
  onPortCurrentChange,
  stretch = false,
}: DAQStateProps) {
  const { toast } = useToast()
  const currentEnabled = useVisualizationStore((state) => state.settings.currentEnabled !== false)
  const [showParametersDialog, setShowParametersDialog] = useState(false)
  const [currentModuleType, setCurrentModuleType] = useState<string>('tetramm')
  const [autoRestartEnabled, setAutoRestartEnabled] = useState(false)
  const [autoRestartDelay, setAutoRestartDelay] = useState(30)
  // What is in the box while it is being typed in, kept apart from the run
  // number the DAQ actually holds. See commitRunNumber.
  const [runNumberDraft, setRunNumberDraft] = useState<string>(
    runNumber !== null ? String(runNumber) : '')

  useEffect(() => {
    setRunNumberDraft(runNumber !== null ? String(runNumber) : '')
  }, [runNumber])

  useEffect(() => {
    const fetchModuleType = async () => {
      try {
        const response = await getCurrentModuleType()
        setCurrentModuleType(response.module_type)
      } catch (error) {
        console.error('Failed to fetch module type:', error)
      }
    }
    fetchModuleType()
  }, [])

  useEffect(() => {
    const fetchAutoRestart = async () => {
      try {
        const response = await getAutoRestart()
        setAutoRestartEnabled(response.enabled)
        setAutoRestartDelay(response.delay)
      } catch (error) {
        console.error('Failed to fetch auto-restart setting:', error)
      }
    }
    fetchAutoRestart()
  }, [])

  /**
   * Handles run number input changes with validation
   */
  // Typing is local; only a finished edit reaches the server. Committing on
  // every keystroke meant that typing "846" walked the run number through 8 and
  // 84 — and left it there if the field lost focus mid-number. The server log
  // shows exactly that happening.
  const handleRunNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setRunNumberDraft(e.target.value)
  }

  const commitRunNumber = () => {
    const value = parseInt(runNumberDraft, 10)
    if (isNaN(value) || value < 0) {
      // Nothing usable was typed: put the field back to what the DAQ holds.
      setRunNumberDraft(runNumber !== null ? String(runNumber) : '')
      return
    }
    if (value === runNumber) return
    onRunNumberChange(value)
    setRunNumber(value)
  }

  /**
   * Handles save data checkbox changes
   */
  const handleSaveDataChange = (checked: boolean) => {
    onSaveDataChange(checked)
    setSaveData(checked)
  }

  /**
   * Handles file size limit checkbox changes
   */
  const handleLimitFileSizeChange = (checked: boolean) => {
    onLimitFileSizeChange(checked)
    setLimitDataSize(checked)
  }

  /**
   * Handles file size limit value changes
   */
  const handleFileSizeLimitChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    onFileSizeLimitChange(value)
    const numValue = parseInt(value)
    if (!isNaN(numValue)) {
      setDataSizeLimit(numValue)
    }
  }

  /**
   * Handles TetrAMM IP address changes
   */
  const handleIpCurrent = async (value: string) => {
    if (currentModuleType === 'tetramm') {
      onIpCurrentChange(value)
      await setIpPortCurrent(value, portCurrent)
    }
  }

  /**
   * Handles TetrAMM port changes
   */
  const handlePortCurrent = async (value: string) => {
    if (currentModuleType === 'tetramm') {
      onPortCurrentChange(value)
      await setIpPortCurrent(ipCurrent, value)
    }
  }

  /**
   * Handles auto-restart on board failure toggle
   */
  const handleAutoRestartChange = async (checked: boolean) => {
    try {
      await setAutoRestart(checked, autoRestartDelay)
      setAutoRestartEnabled(checked)
      toast({
        title: checked ? 'Auto-Restart Enabled' : 'Auto-Restart Disabled',
        description: checked
          ? `Runs will automatically restart ${autoRestartDelay}s after board failure`
          : 'Runs will not automatically restart on board failure',
      })
    } catch (error) {
      console.error('Failed to change auto-restart setting:', error)
      toast({
        title: "Error",
        description: "Failed to change auto-restart setting. Please try again.",
        variant: "destructive",
      })
    }
  }

  /**
   * Handles auto-restart delay changes
   */
  const handleAutoRestartDelayChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value)
    if (!isNaN(value) && value >= 5) {
      setAutoRestartDelay(value)
      if (autoRestartEnabled) {
        try {
          await setAutoRestart(autoRestartEnabled, value)
        } catch (error) {
          console.error('Failed to update auto-restart delay:', error)
        }
      }
    }
  }

  return (
    <>
      <Card className={stretch ? 'h-full' : undefined}>
        <CardHeader className="flex flex-row flex-wrap items-center gap-3 pb-3">
          <div className="grid gap-1">
            <CardTitle className="text-base">Acquisition setup</CardTitle>
          </div>
          <Button
            onClick={() => setShowParametersDialog(true)}
            className="ml-auto"
            variant="outline"
            size="sm"
          >
            <Cog className="mr-2 h-4 w-4" />
            Adjust
          </Button>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2 pt-0">
          <Badge variant={saveData ? 'default' : 'secondary'}>
            Saving {saveData ? 'enabled' : 'disabled'}
          </Badge>
          <Badge variant="outline">
            {limitFileSize ? `${fileSizeLimit} MB limit` : 'No size limit'}
          </Badge>
          <Badge variant={autoRestartEnabled ? 'default' : 'secondary'}>
            Auto-restart {autoRestartEnabled ? `${autoRestartDelay}s` : 'off'}
          </Badge>
        </CardContent>
      </Card>

      {/* Parameters Adjustment Dialog */}
      <Dialog open={showParametersDialog} onOpenChange={setShowParametersDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adjust Acquisition Parameters</DialogTitle>
            <DialogDescription>
              Set the acquisition parameters for the DAQ.
            </DialogDescription>
          </DialogHeader>
          
          <div className="flex flex-col gap-4">
            {/* Run Number Input */}
            <div className="grid grid-cols-1 items-center gap-4">
              <Label htmlFor="runNumber">Run Number</Label>
              <Input
                id="runNumber"
                type="number"
                min={0}
                value={runNumberDraft}
                onChange={handleRunNumberChange}
                onBlur={commitRunNumber}
                onKeyDown={(e) => { if (e.key === 'Enter') commitRunNumber() }}
                disabled={isRunning}
              />
              {isRunning && (
                <p className="text-xs text-muted-foreground">
                  This is the run being taken. It can only be changed once the DAQ is stopped.
                </p>
              )}
            </div>
            
            {/* Save Data Checkbox */}
            <div className="flex items-center space-x-2">
              <Checkbox
                id="saveData"
                checked={saveData}
                onCheckedChange={handleSaveDataChange}
                disabled={isRunning}
              />
              <Label htmlFor="saveData">Save Data</Label>
            </div>
            
            {/* Limit File Size Checkbox */}
            <div className="flex items-center space-x-2">
              <Checkbox
                id="limitFileSize"
                checked={limitFileSize}
                onCheckedChange={handleLimitFileSizeChange}
                disabled={isRunning}
              />
              <Label htmlFor="limitFileSize">Limit File Size</Label>
            </div>
            
            {/* File Size Limit Input (conditional) */}
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
            
            {/* Current Device Configuration */}
            {currentEnabled && currentModuleType === 'tetramm' && (
              <>
                {/* TetrAMM IP Input */}
                <div className="flex flex-col gap-4">
                  <Label htmlFor="ipCurrent">TetrAMM IP</Label>
                  <Input
                    id="ipCurrent"
                    type="text"
                    value={ipCurrent}
                    onChange={(e) => handleIpCurrent(e.target.value)}
                  />
                </div>
                
                {/* TetrAMM Port Input */}
                <div className="flex flex-col gap-4">
                  <Label htmlFor="portCurrent">TetrAMM Port</Label>
                  <Input
                    id="portCurrent"
                    type="text"
                    value={portCurrent}
                    onChange={(e) => handlePortCurrent(e.target.value)}
                  />
                </div>
              </>
            )}
            {currentEnabled && currentModuleType === 'rbd9103' && (
              <div className="flex flex-col gap-4">
                <Label>Current Device: RBD 9103</Label>
                <p className="text-sm text-muted-foreground">
                  RBD 9103 settings are configured in the device settings page.
                </p>
              </div>
            )}

            {/* Auto-Restart on Board Failure */}
            <div className="border-t pt-4 mt-2">
              <div className="flex items-center space-x-2 mb-4">
                <Checkbox
                  id="autoRestart"
                  checked={autoRestartEnabled}
                  onCheckedChange={handleAutoRestartChange}
                />
                <Label htmlFor="autoRestart">Auto-Restart on Board Failure</Label>
              </div>
              <p className="text-sm text-muted-foreground mb-4">
                When enabled, if a board reports &quot;Generic Failure&quot; or &quot;PLL Lock&quot; error,
                the run will automatically stop and restart with the next run number.
              </p>

              {autoRestartEnabled && (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="autoRestartDelay">Restart Delay (seconds)</Label>
                  <Input
                    id="autoRestartDelay"
                    type="number"
                    min={5}
                    value={autoRestartDelay}
                    onChange={handleAutoRestartDelayChange}
                  />
                  <p className="text-xs text-muted-foreground">
                    Time to wait before stopping and restarting the run (minimum 5 seconds)
                  </p>
                </div>
              )}
            </div>
          </div>
          
          <DialogFooter>
            <Button type="submit" onClick={() => setShowParametersDialog(false)}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
