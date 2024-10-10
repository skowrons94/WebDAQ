'use client'

import { useState, useEffect } from 'react'
import Link from "next/link"
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
  checkRunDirectoryExists
} from '@/lib/api'

export function RunControl() {
  const clearToken = useAuthStore((state) => state.clearToken)
  const router = useRouter()
  const { toast } = useToast()

  const [coincidenceTime, setCoincidenceTime] = useState("")
  const [multiplicity, setMultiplicity] = useState("")
  const [saveData, setSaveData] = useState(false)
  const [limitFileSize, setLimitFileSize] = useState(false)
  const [fileSizeLimit, setFileSizeLimit] = useState("")
  const [runNumber, setRunNumberState] = useState<number | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [timer, setTimer] = useState(0)
  const [showOverrideDialog, setShowOverrideDialog] = useState(false)

  useEffect(() => {
    fetchInitialData()
  }, [])

  useEffect(() => {
    let interval: NodeJS.Timeout | null = null
    if (isRunning) {
      interval = setInterval(() => {
        setTimer((prevTimer) => prevTimer + 1)
      }, 1000)
    } else if (!isRunning && timer !== 0) {
      if (interval) clearInterval(interval)
    }
    return () => {
      if (interval) clearInterval(interval)
    }
  }, [isRunning, timer])

  const fetchInitialData = async () => {
    try {
      const [
        coincidenceTimeData,
        multiplicityData,
        saveDataStatus,
        limitFileSizeStatus,
        fileSizeLimitData,
        currentRunNumber
      ] = await Promise.all([
        getCoincidenceWindow(),
        getMultiplicity(),
        getSaveData(),
        getLimitDataSize(),
        getDataSizeLimit(),
        getCurrentRunNumber()
      ])

      setCoincidenceTime(coincidenceTimeData.toString())
      setMultiplicity(multiplicityData.toString())
      setSaveData(saveDataStatus)
      setLimitFileSize(limitFileSizeStatus)
      setFileSizeLimit(fileSizeLimitData.toString())
      setRunNumberState(currentRunNumber)
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
      const directoryExists = await checkRunDirectoryExists( )
      console.log(directoryExists)
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
      // Set all variables before starting the run
      await setCoincidenceWindow(parseInt(coincidenceTime))
      await setMultiplicity(multiplicity)
      await setSaveData(saveData)
      await setLimitDataSize(limitFileSize)
      if (limitFileSize) {
        await setDataSizeLimit(parseInt(fileSizeLimit))
      }

      // Start the run
      await startRun()
      setIsRunning(true)
      setTimer(0)
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
      await stopRun()
      setIsRunning(false)
      toast({
        title: 'Run Stopped',
        description: 'The experiment run has been stopped successfully.',
      })

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
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const remainingSeconds = seconds % 60
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`
  }

  const handleCoincidenceTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setCoincidenceTime(e.target.value)
  }

  const handleMultiplicityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setMultiplicity(e.target.value)
  }

  const handleSaveDataChange = (checked: boolean) => {
    setSaveData(checked)
  }

  const handleLimitFileSizeChange = (checked: boolean) => {
    setLimitFileSize(checked)
  }

  const handleFileSizeLimitChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFileSizeLimit(e.target.value)
  }

  const handleRunNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value)
    setRunNumberState(value)
  }

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      <header className="bg-card p-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-4">
          <MoonStarIcon className="w-6 h-6" />
          <h1 className="text-xl font-bold">LUNA Run Control Interface</h1>
        </div>
        <nav className="flex items-center gap-4">
          <Link href="#" className="text-sm font-medium hover:underline" prefetch={false}>
            Run Control
          </Link>
          <Link href="/board" className="text-sm font-medium hover:underline">
            Boards
          </Link>
          <Link href="/plots" className="text-sm font-medium hover:underline" prefetch={false}>
            Plots
          </Link>
          <Link href="#" className="text-sm font-medium hover:underline" prefetch={false}>
            Metadata
          </Link>
          <Link href="/json" className="text-sm font-medium hover:underline" prefetch={false}>
            JSON
          </Link>
          <Link href="http://lunaserver:3000" className="text-sm font-medium hover:underline" prefetch={false}>
            Grafana
          </Link>
          <Button variant="secondary" onClick={handleLogout}>Logout</Button>
        </nav>
      </header>
      <main className="flex-1 grid grid-cols-2 gap-4 p-6">
        <section className="bg-card p-4 rounded-lg shadow-sm">
          <h2 className="text-lg font-bold mb-4">Run Control</h2>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Button onClick={handleStartRun} className="w-full" disabled={isRunning}>Start</Button>
              <Button onClick={handleStopRun} variant="secondary" className="w-full" disabled={!isRunning}>
                Stop
              </Button>
            </div>
            <div className="flex flex-col gap-2">
              <div className="bg-muted p-2 rounded-md flex items-center justify-center text-2xl font-bold">
                {isRunning ? "Running" : "Stopped"}
              </div>
              <div className="bg-muted p-2 rounded-md flex items-center justify-center text-2xl font-bold">
                {formatTime(timer)}
              </div>
            </div>
          </div>
          <Separator className="my-4" />
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="runNumber">Run Number</Label>
              <Input
                id="runNumber"
                type="number"
                value={runNumber !== null ? runNumber : ''}
                onChange={handleRunNumberChange}
                disabled={isRunning}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="coincidenceTime">Coincidence Time (ns)</Label>
              <Input
                id="coincidenceTime"
                type="number"
                value={coincidenceTime}
                onChange={handleCoincidenceTimeChange}
                disabled={isRunning}
              />
            </div>
            <div className="flex flex-col gap-2">
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
        </section>
        <section className="bg-card p-4 rounded-lg shadow-sm">
          <h2 className="text-lg font-bold mb-4">Metadata</h2>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="sample-id">Sample ID</Label>
              <Input id="sample-id" type="text" defaultValue="123" />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="operator">Operator</Label>
              <Input id="operator" type="text" defaultValue="Name" />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="timestamp">Timestamp</Label>
              <Input id="timestamp" type="datetime-local" defaultValue="2023-06-30T12:34:56" />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="notes">Notes</Label>
              <Textarea id="notes" rows={3} defaultValue="This is a sample note." />
            </div>
          </div>
          <Separator className="my-4" />
          <div className="flex justify-end gap-2">
            <Button variant="secondary">Export</Button>
            <Button>Save</Button>
          </div>
        </section>
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
            <AlertDialogAction  onClick={startRunProcess}>Override</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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