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
import { useToast } from '@/components/ui/use-toast'
import {
  getSaveData,
  setSaveData,
  getLimitDataSize,
  setLimitDataSize,
  getDataSizeLimit,
  setDataSizeLimit,
  setRunNumber,
  getWaveformStatus,
  activateWaveform,
  deactivateWaveform,
  setIpPortCurrent,
  getIpCurrent,
  getPortCurrent,
  getConnectedCurrent,
  getCurrentModuleType,
  getAutoRestart,
  setAutoRestart,
} from '@/lib/api'

interface DAQStateProps {
  runNumber: number | null
  saveData: boolean
  limitFileSize: boolean
  fileSizeLimit: string
  waveformsEnabled: boolean
  ipCurrent: string
  portCurrent: string
  isConnectedCurrent: boolean
  isRunning: boolean
  onSaveDataChange: (checked: boolean) => void
  onLimitFileSizeChange: (checked: boolean) => void
  onFileSizeLimitChange: (value: string) => void
  onRunNumberChange: (value: number) => void
  onWaveformsChange: (checked: boolean) => void
  onIpCurrentChange: (value: string) => void
  onPortCurrentChange: (value: string) => void
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
  waveformsEnabled,
  ipCurrent,
  portCurrent,
  isConnectedCurrent,
  isRunning,
  onSaveDataChange,
  onLimitFileSizeChange,
  onFileSizeLimitChange,
  onRunNumberChange,
  onWaveformsChange,
  onIpCurrentChange,
  onPortCurrentChange,
}: DAQStateProps) {
  const { toast } = useToast()
  const [showParametersDialog, setShowParametersDialog] = useState(false)
  const [currentModuleType, setCurrentModuleType] = useState<string>('tetramm')
  const [currentModuleName, setCurrentModuleName] = useState<string>('TetrAMM')
  const [autoRestartEnabled, setAutoRestartEnabled] = useState(false)
  const [autoRestartDelay, setAutoRestartDelay] = useState(30)

  useEffect(() => {
    const fetchModuleType = async () => {
      try {
        const response = await getCurrentModuleType()
        setCurrentModuleType(response.module_type)
        setCurrentModuleName(response.module_type === 'rbd9103' ? 'RBD 9103' : 'TetrAMM')
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
  const handleRunNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value)
    if (!isNaN(value)) {
      onRunNumberChange(value)
      setRunNumber(value)
    }
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
   * Handles waveform recording toggle with API call
   */
  const handleWaveformsChange = async (checked: boolean) => {
    try {
      if (checked) {
        await activateWaveform()
      } else {
        await deactivateWaveform()
      }
      onWaveformsChange(checked)
    } catch (error) {
      console.error('Failed to change waveform status:', error)
      toast({
        title: "Error",
        description: "Failed to change waveform status. Please try again.",
        variant: "destructive",
      })
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
    <Card>
      <CardHeader className="flex flex-row items-center flex-wrap gap-2">
        <div className="grid gap-1">
          <CardTitle className="text-lg sm:text-xl">Acquisition Parameters</CardTitle>
          <CardDescription className="text-xs sm:text-sm">
            Current settings for the DAQ
          </CardDescription>
        </div>
        <Button 
          onClick={() => setShowParametersDialog(true)} 
          className="ml-auto" 
          size="sm"
        >
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
              {/* Run Number Row */}
              <TableRow>
                <TableCell className="text-xs sm:text-sm py-2">Run Number</TableCell>
                <TableCell className="text-xs sm:text-sm py-2">
                  {runNumber !== null ? runNumber : ''}
                </TableCell>
                <TableCell className="text-xs sm:text-sm py-2">
                  <Badge variant="outline" className="text-xs">Autoincrement</Badge>
                </TableCell>
              </TableRow>
              
              {/* Save Data Row */}
              <TableRow>
                <TableCell className="text-xs sm:text-sm py-2">Save Data</TableCell>
                <TableCell className="text-xs sm:text-sm py-2"></TableCell>
                <TableCell className="text-xs sm:text-sm py-2">
                  <Badge variant="outline" className="text-xs">
                    {saveData ? 'Enabled' : 'Disabled'}
                  </Badge>
                </TableCell>
              </TableRow>
              
              {/* File Size Limit Row */}
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
              
              {/* Waveforms Row */}
              <TableRow>
                <TableCell className="text-xs sm:text-sm py-2">Waveforms</TableCell>
                <TableCell className="text-xs sm:text-sm py-2"></TableCell>
                <TableCell className="text-xs sm:text-sm py-2">
                  <Badge variant="outline" className="text-xs">
                    {waveformsEnabled ? 'Enabled' : 'Disabled'}
                  </Badge>
                </TableCell>
              </TableRow>
              
              {/* Current Device Address Row */}
              <TableRow>
                <TableCell className="text-xs sm:text-sm py-2">{currentModuleName} Address</TableCell>
                <TableCell className="text-xs sm:text-sm py-2">
                  <div className="block sm:hidden">...</div>
                  <div className="hidden sm:block">
                    {currentModuleType === 'tetramm' ? `${ipCurrent}:${portCurrent}` : 'Serial Port'}
                  </div>
                </TableCell>
                <TableCell className="text-xs sm:text-sm py-2">
                  <Badge
                    variant={isConnectedCurrent ? "outline" : "destructive"}
                    className="text-xs"
                  >
                    {isConnectedCurrent ? 'Connected' : 'Disconnected'}
                  </Badge>
                </TableCell>
              </TableRow>

              {/* Auto-Restart Row */}
              <TableRow>
                <TableCell className="text-xs sm:text-sm py-2">Auto-Restart</TableCell>
                <TableCell className="text-xs sm:text-sm py-2">
                  {autoRestartEnabled ? `${autoRestartDelay}s delay` : ''}
                </TableCell>
                <TableCell className="text-xs sm:text-sm py-2">
                  <Badge
                    variant={autoRestartEnabled ? "outline" : "secondary"}
                    className="text-xs"
                  >
                    {autoRestartEnabled ? 'Enabled' : 'Disabled'}
                  </Badge>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </CardContent>

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
                value={runNumber !== null ? runNumber : ''}
                onChange={handleRunNumberChange}
                disabled={isRunning}
              />
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
            
            {/* Waveforms Checkbox */}
            <div className="flex items-center space-x-2">
              <Checkbox
                id="waveforms"
                checked={waveformsEnabled}
                onCheckedChange={handleWaveformsChange}
                disabled={isRunning}
              />
              <Label htmlFor="waveforms">Waveforms</Label>
            </div>
            
            {/* Current Device Configuration */}
            {currentModuleType === 'tetramm' && (
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
            {currentModuleType === 'rbd9103' && (
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
    </Card>
  )
}