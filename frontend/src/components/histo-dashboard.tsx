'use client'

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { getBoardConfiguration, getRunStatus, getCurrentRunNumber, getHistogram, getRoiHistogram, getRoiIntegral } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useToast } from "@/components/ui/use-toast"
import { loadJSROOT } from '@/lib/load-jsroot'
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

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

export default function HistogramDashboard() {
  const [boards, setBoards] = useState<BoardData[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [runNumber, setRunNumber] = useState<number | null>(null)
  const [jsrootLoaded, setJsrootLoaded] = useState(false)
  const [updateTrigger, setUpdateTrigger] = useState(0)
  const [roiValues, setRoiValues] = useState<ROIValues>({})
  const histogramRefs = useRef<{[key: string]: HTMLDivElement | null}>({})
  const { toast } = useToast()
  const initialFetchDone = useRef(false)

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
    if (jsrootLoaded && boards.length > 0) {
      if (!initialFetchDone.current) {
        initialFetchDone.current = true
        updateHistograms()
      }
    }
  }, [jsrootLoaded, boards])

  useEffect(() => {
    if (jsrootLoaded) {
      const updateInterval = setInterval(() => {
        setUpdateTrigger(prev => prev + 1)
      }, 2000)
      return () => clearInterval(updateInterval)
    }
  }, [jsrootLoaded])

  const fetchBoardConfiguration = async () => {
    try {
      const response = await getBoardConfiguration()
      setBoards(response.data)
      initializeROIValues(response.data)
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

  const initializeROIValues = (boards: BoardData[]) => {
    const initialROIValues: ROIValues = {}
    boards.forEach(board => {
      for (let i = 0; i < parseInt(board.chan); i++) {
        const histoId = `board${board.id}_channel${i}`
        initialROIValues[histoId] = { low: 0, high: 32768, integral: 0 }
      }
    })
    setRoiValues(initialROIValues)
  }

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
            
            // Calculate and update the integral
            const { low, high } = roiValues[histoId]
            const integral = await getRoiIntegral(board.id, i.toString(), low, high)
            setRoiValues(prev => ({
              ...prev,
              [histoId]: { ...prev[histoId], integral }
            }))
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
  }, [boards, roiValues])

  const handleROIChange = async (histoId: string, type: 'low' | 'high', value: number) => {
    const [boardId, channelStr] = histoId.split('_')
    const channelId = channelStr.replace('channel', '')
    const newRoiValues = {
      ...roiValues[histoId],
      [type]: value
    }
    setRoiValues(prev => ({
      ...prev,
      [histoId]: newRoiValues
    }))

    // Update the integral when ROI changes
    try {
      const integral = await getRoiIntegral(boardId.replace('board', ''), channelId, newRoiValues.low, newRoiValues.high)
      setRoiValues(prev => ({
        ...prev,
        [histoId]: { ...newRoiValues, integral }
      }))
    } catch (error) {
      console.error(`Failed to get ROI integral for ${histoId}:`, error)
    }
  }

  const drawHistogramWithROI = async (element: HTMLDivElement, histogram: any, histoId: string, chan: string, id: string) => {
    if (window.JSROOT) {

      const canv = window.JSROOT.create('TCanvas');

      canv.fName = 'c1';
      canv.fPrimitives.Add(histogram, 'histo');

      const { low, high } = roiValues[histoId]
      console.log( low, high )

      const roiObj = await getRoiHistogram(id, chan, low, high)
      const roiHistogram = window.JSROOT.parse(roiObj)

      canv.fPrimitives.Add(roiHistogram, 'histo');

      await window.JSROOT.redraw(element, canv)
    }
  }

  useEffect(() => {
    if (jsrootLoaded && boards.length > 0) {
      updateHistograms()
    }
  }, [jsrootLoaded, boards, updateTrigger])

  return (
    <div className="flex flex-col min-h-screen bg-background text-foreground">
      <main className="flex-1 container mx-auto p-4">
        {boards.map((board) => (
          <Card key={board.id} className="mb-6">
            <CardHeader>
              <CardTitle>{board.name} (ID: {board.id})</CardTitle>
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
                      <div className="flex flex-col items-center gap-2">
                        <div className="flex gap-4">
                          <div className="flex flex-col">
                            <Label htmlFor={`${histoId}-low`}>Low ROI</Label>
                            <Input
                              id={`${histoId}-low`}
                              type="number"
                              value={roiValues[histoId]?.low}
                              onChange={(e) => handleROIChange(histoId, 'low', Number(e.target.value))}
                              className="w-24"
                            />
                          </div>
                          <div className="flex flex-col">
                            <Label htmlFor={`${histoId}-high`}>High ROI</Label>
                            <Input
                              id={`${histoId}-high`}
                              type="number"
                              value={roiValues[histoId]?.high}
                              onChange={(e) => handleROIChange(histoId, 'high', Number(e.target.value))}
                              className="w-24"
                            />
                          </div>
                        </div>
                        <div className="text-sm font-medium">
                          Integral: {roiValues[histoId]?.integral.toFixed(2) || 'N/A'}
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