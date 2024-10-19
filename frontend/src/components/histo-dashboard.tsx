'use client'

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { getBoardConfiguration, getRunStatus, getCurrentRunNumber, getHistogram, getRoiHistogram, getRoiIntegral } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useToast } from "@/components/ui/use-toast"
import { loadJSROOT } from '@/lib/load-jsroot'
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { useTheme } from 'next-themes'

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

type Integrals = {
  [key: string]: number;
}

export default function HistogramDashboard() {
  const [boards, setBoards] = useState<BoardData[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [runNumber, setRunNumber] = useState<number | null>(null)
  const [jsrootLoaded, setJsrootLoaded] = useState(false)
  const [updateTrigger, setUpdateTrigger] = useState(0)
  const [roiValues, setRoiValues] = useState<ROIValues>({})
  const [unsavedChanges, setUnsavedChanges] = useState(false)
  const [integrals, setIntegrals] = useState<Integrals>({})
  const [isLogScale, setIsLogScale] = useState(false)
  const histogramRefs = useRef<{[key: string]: HTMLDivElement | null}>({})
  const { toast } = useToast()
  const initialFetchDone = useRef(false)
  const { theme } = useTheme()

  useEffect(() => {
    fetchCachedROIs()
  }, [])

  useEffect(() => {
    fetchBoardConfiguration()
    fetchRunStatus()
    const statusInterval = setInterval(fetchRunStatus, 5000)

    loadJSROOT()
      .then(() => {
        setJsrootLoaded(true)
        setTimeout(initializeBlankHistograms, 0)
      })
      .catch((error) => {
        console.error('Failed to load JSROOT:', error)
        toast({
          title: "Error",
          description: "Failed to load JSROOT. Some features may not work correctly.",
          variant: "destructive",
        })
      })

    return () => clearInterval(statusInterval)
  }, [])

  useEffect(() => {
    if (jsrootLoaded) {
      window.JSROOT.settings.DarkMode = theme === 'dark'
      const updateInterval = setInterval(() => {
        setUpdateTrigger(prev => prev + 1)
      }, 2000)
      return () => clearInterval(updateInterval)
    }
  }, [jsrootLoaded, theme])

  const fetchBoardConfiguration = async () => {
    try {
      const response = await getBoardConfiguration()
      setBoards(response.data)
    } catch (error) {
      console.error('Failed to fetch board configuration:', error)
      toast({
        title: "Error",
        description: "Failed to fetch board configuration. Please try again.",
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
      setRunNumber(runNumberResponse)
    } catch (error) {
      console.error('Failed to fetch run status:', error)
      toast({
        title: "Error",
        description: "Failed to fetch run status. Please try again.",
        variant: "destructive",
      })
    }
  }

  const fetchCachedROIs = async () => {
    try {
      const response = await fetch('/api/cache')
      const data = await response.json()
      if (data && data.roiValues) {
        setRoiValues(data.roiValues)
      } else {
        initializeROIValues()
      }
    } catch (error) {
      console.error('Failed to fetch cached ROIs:', error)
      initializeROIValues()
    }
  }

  const createBlankHistogram = useCallback((name: string) => {
    if (window.JSROOT) {
      const hist = window.JSROOT.createHistogram("TH1F", 100)
      hist.fName = name
      hist.fTitle = `Histogram for ${name}`
      return hist
    }
    return null
  }, [])

  const initializeBlankHistograms = useCallback(() => {
    if (window.JSROOT) {
      Object.keys(histogramRefs.current).forEach(histoId => {
        const histoElement = histogramRefs.current[histoId]
        if (histoElement) {
          const blankHist = createBlankHistogram(histoId)
          if (blankHist) {
            window.JSROOT.redraw(histoElement, blankHist, "hist")
          }
        }
      })
    }
  }, [createBlankHistogram])

  const initializeROIValues = useCallback(() => {
    const initialROIValues: ROIValues = {}
    boards.forEach(board => {
      for (let i = 0; i < parseInt(board.chan); i++) {
        const histoId = `board${board.id}_channel${i}`
        initialROIValues[histoId] = { low: 0, high: 32768, integral: 0 }
      }
    })
    setRoiValues(prevValues => ({
      ...initialROIValues,
      ...prevValues // This ensures we keep any existing values
    }))
  }, [boards])

  useEffect(() => {
    if (boards.length > 0) {
      initializeROIValues()
    }
  }, [boards, initializeROIValues])

  const updateHistograms = useCallback(async () => {
    console.log('Updating histograms...')
    for (const board of boards) {
      for (let i = 0; i < parseInt(board.chan); i++) {
        const histoId = `board${board.id}_channel${i}`
        const histoElement = histogramRefs.current[histoId]
        if (histoElement && window.JSROOT) {
          try {
            const histogramData = await getHistogram(board.id, i.toString())
            const histogram = window.JSROOT.parse(histogramData)
            await drawHistogramWithROI(histoElement, histogram, histoId, i.toString(), board.id)
          } catch (error) {
            console.error(`Failed to fetch histogram for ${histoId}:`, error)
            toast({
              title: "Error",
              description: `Failed to update histogram for ${board.name} - Channel ${i}`,
              variant: "destructive",
            })
          }
        }
      }
    }
  }, [boards, isLogScale])

  const updateROIIntegrals = useCallback(async () => {
    console.log('Updating ROI integrals...')
    const updatedIntegrals = { ...integrals }
    for (const board of boards) {
      for (let i = 0; i < parseInt(board.chan); i++) {
        const histoId = `board${board.id}_channel${i}`
        const { low, high } = roiValues[histoId] || { low: 0, high: 32768 }
        try {
          const integral = await getRoiIntegral(board.id, i.toString(), low, high)
          updatedIntegrals[histoId] = integral
        } catch (error) {
          console.error(`Failed to get ROI integral for ${histoId}:`, error)
        }
      }
    }
    setIntegrals(updatedIntegrals)
  }, [boards])

  const updateROICache = async (roiValues: ROIValues) => {
    try {
      await fetch('/api/cache', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(roiValues),
      })
      setUnsavedChanges(false)
      toast({
        title: "Success",
        description: "ROI values have been saved.",
      })
    } catch (error) {
      console.error('Failed to update ROI cache:', error)
      toast({
        title: "Error",
        description: "Failed to save ROI values. Please try again.",
        variant: "destructive",
      })
    }
  }

  const handleROIChange = async (histoId: string, type: 'low' | 'high', value: number) => {
    setRoiValues(prev => ({
      ...prev,
      [histoId]: { ...prev[histoId], [type]: value }
    }))
    setUnsavedChanges(true)
  }

  const drawHistogramWithROI = async (element: HTMLDivElement, histogram: any, histoId: string, chan: string, id: string) => {
    if (window.JSROOT) {
      const canv = window.JSROOT.create('TCanvas');

      canv.fName = 'c1';
      canv.fPrimitives.Add(histogram, 'histo');

      const { low, high } = roiValues[histoId] || { low: 0, high: 32768 }
      console.log( low, high )

      const roiObj = await getRoiHistogram(id, chan, low, high)
      const roiHistogram = window.JSROOT.parse(roiObj)

      canv.fPrimitives.Add(roiHistogram, 'histo');

      // Set logarithmic scale if isLogScale is true
      if (isLogScale) {
        canv.fLogx = 0;
        canv.fLogy = 1;
        canv.fLogz = 0;
      } else {
        canv.fLogx = 0;
        canv.fLogy = 0;
        canv.fLogz = 0;
      }

      await window.JSROOT.redraw(element, canv)
    }
  }

  useEffect(() => {
    if (jsrootLoaded && boards.length > 0) {
      updateHistograms()
      updateROIIntegrals()
    }
  }, [jsrootLoaded, boards, updateTrigger, updateHistograms, updateROIIntegrals, isLogScale])

  const handleSaveChanges = () => {
    updateROICache(roiValues)
  }

  const toggleLogScale = () => {
    setIsLogScale(!isLogScale)
  }

  return (
    <div className="flex flex-col min-h-screen bg-background text-foreground">
      <main className="flex-1 container mx-auto p-4">
        <div className="flex justify-between items-center mb-4">
          <h1 className="text-2xl font-bold">Histogram Dashboard</h1>
          <Button onClick={handleSaveChanges} disabled={!unsavedChanges}>
            Save Changes
          </Button>
        </div>
        {boards.map((board) => (
          <Card key={board.id} className="mb-6">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>{board.name} (ID: {board.id})</CardTitle>
              <Button onClick={toggleLogScale} variant="outline">
                {isLogScale ? "Linear" : "Logarithmic"}
              </Button>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                {Array.from({ length: parseInt(board.chan) }).map((_, channelIndex) => {
                  const histoId = `board${board.id}_channel${channelIndex}`
                  return (
                    <div key={histoId} className="relative">
                      <h3 className="text-lg font-semibold mb-2">Channel {channelIndex}</h3>
                      <div
                        ref={el => { histogramRefs.current[histoId] = el }}
                        className="w-full h-80 border rounded-lg shadow-sm mb-2"
                      ></div>
                      <div className="flex flex-col items-center gap-3">
                        <div className="flex gap-4">
                          <div className="flex flex-col gap-2">
                            <Label htmlFor={`${histoId}-low`}>Low ROI</Label>
                            <Input
                              id={`${histoId}-low`}
                              type="number"
                              value={roiValues[histoId]?.low ?? 0}
                              onChange={(e) => handleROIChange(histoId, 'low', Number(e.target.value))}
                              className="w-24"
                            />
                          </div>
                          <div className="flex flex-col gap-2">
                            <Label htmlFor={`${histoId}-high`}>High ROI</Label>
                            <Input
                              id={`${histoId}-high`}
                              type="number"
                              value={roiValues[histoId]?.high ?? 32768}
                              onChange={(e) => handleROIChange(histoId, 'high', Number(e.target.value))}
                              className="w-24"
                            />
                          </div>
                        </div>
                        <div className="text-sm font-medium">
                          Integral: {integrals[histoId] || 'N/A'}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>
        ))}
      </main>
    </div>
  )
}