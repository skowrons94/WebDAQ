'use client'

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { getBoardConfiguration, getRunStatus, getCurrentRunNumber, getCoincHistogram, getRoiHistogramSum, getRoiIntegralCoinc } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useToast } from "@/components/ui/use-toast"
import { loadJSROOT } from '@/lib/load-jsroot'
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { useTheme } from 'next-themes'
import { Settings } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog"

// Types
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

type ROIDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  histoId: string;
  currentValues: { low: number; high: number };
  onSave: (histoId: string, low: number, high: number) => void;
}

// ROI Settings Dialog Component
const ROISettingsDialog = ({ isOpen, onClose, histoId, currentValues, onSave }: ROIDialogProps) => {
  const [low, setLow] = useState(currentValues.low);
  const [high, setHigh] = useState(currentValues.high);

  useEffect(() => {
    setLow(currentValues.low);
    setHigh(currentValues.high);
  }, [currentValues]);

  const handleSave = () => {
    onSave(histoId, low, high);
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>ROI Settings</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="roi-low">Low ROI</Label>
            <Input
              id="roi-low"
              type="number"
              value={low}
              onChange={(e) => setLow(Number(e.target.value))}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="roi-high">High ROI</Label>
            <Input
              id="roi-high"
              type="number"
              value={high}
              onChange={(e) => setHigh(Number(e.target.value))}
            />
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button onClick={handleSave}>Save Changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// Main Dashboard Component
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
  const [activeDialog, setActiveDialog] = useState<string | null>(null)
  const histogramRefs = useRef<{ [key: string]: HTMLDivElement | null }>({})
  const { toast } = useToast()
  const { theme } = useTheme()

  // Initial setup
  useEffect(() => {
    fetchCachedROIs()
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

  // JSROOT theme handling
  useEffect(() => {
    if (jsrootLoaded) {
      window.JSROOT.settings.DarkMode = theme === 'dark'
      const updateInterval = setInterval(() => {
        setUpdateTrigger(prev => prev + 1)
      }, 2000)
      return () => clearInterval(updateInterval)
    }
  }, [jsrootLoaded, theme])

  // API calls
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
      const response = await fetch('/api/cache/sum')
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

  // Histogram initialization
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

  // ROI handling
  const initializeROIValues = useCallback(() => {
    const initialROIValues: ROIValues = {}
    boards.forEach(board => {
      const histoId = `board${board.id}`
      initialROIValues[histoId] = { low: 0, high: 0, integral: 0 }
    })
    setRoiValues(prevValues => ({
      ...initialROIValues,
      ...prevValues
    }))
  }, [boards])

  useEffect(() => {
    if (boards.length > 0) {
      initializeROIValues()
    }
  }, [boards, initializeROIValues])

  // Histogram updates
  const updateHistograms = useCallback(async () => {
    for (const board of boards) {
      const histoId = `board${board.id}`
      const histoElement = histogramRefs.current[histoId]
      if (histoElement && window.JSROOT) {
        try {
          const histogramData = await getCoincHistogram(board.id)
          const histogram = window.JSROOT.parse(histogramData)
          await drawHistogramWithROI(histoElement, histogram, histoId, board.id)
        } catch (error) {
          console.error(`Failed to fetch sum histogram for ${histoId}:`, error)
          toast({
            title: "Error",
            description: `Failed to update sum histogram for ${board.name}`,
            variant: "destructive",
          })
        }
      }
    }
  }, [boards, isLogScale])

  const updateROIIntegrals = useCallback(async () => {
    const updatedIntegrals = { ...integrals }
    for (const board of boards) {
      const histoId = `board${board.id}`
      const { low, high } = roiValues[histoId] || { low: 0, high: 0 }
      try {
        const integral = await getRoiIntegralCoinc(board.id, low, high)
        updatedIntegrals[histoId] = integral
      } catch (error) {
        console.error(`Failed to get ROI sum integral for ${histoId}:`, error)
      }
    }
    setIntegrals(updatedIntegrals)
  }, [boards, roiValues])

  // ROI cache management
  const updateROICache = async (roiVal: ROIValues) => {
    try {
      await fetch('/api/cache/sum', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(roiVal),
      })
      setUnsavedChanges(false)
      setRoiValues(roiVal)
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

  // Event handlers
  const handleROIChange = async (histoId: string, low: number, high: number) => {
    const updatedRoiValues = {
      ...roiValues,
      [histoId]: { ...roiValues[histoId], low, high }
    }
    setRoiValues(updatedRoiValues)
    setUnsavedChanges(true)
    // Update the cache immediately
    await updateROICache(updatedRoiValues)
    // Clean the histogram JSROOT object
    const histoElement = histogramRefs.current[histoId]
    if (histoElement) {
      const blankHist = createBlankHistogram(histoId)
      if (blankHist) {
        window.JSROOT.redraw(histoElement, blankHist, "hist")
      }
    }
  }

  const drawHistogramWithROI = async (element: HTMLDivElement, histogram: any, histoId: string, boardId: string) => {
    if (window.JSROOT) {
      const canv = window.JSROOT.create('TCanvas');

      // Make histogram blue fill with alpha of 0.3
      histogram.fLineColor = 4;
      histogram.fFillColor = 4;
      histogram.fFillStyle = 3001;

      canv.fName = 'c1';
      canv.fPrimitives.Add(histogram, 'histo');

      const { low, high } = roiValues[histoId] || { low: 0, high: 0 }

      const roiObj = await getRoiHistogramSum(boardId, low, high)
      const roiHistogram = window.JSROOT.parse(roiObj)

      roiHistogram.fLineColor = 2;
      roiHistogram.fFillColor = 2;
      roiHistogram.fFillStyle = 3001;

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

  const handleDialogOpen = (histoId: string) => {
    setActiveDialog(histoId);
  };

  const handleDialogClose = () => {
    setActiveDialog(null);
  };

  return (
    <div className="flex flex-col min-h-screen bg-background text-foreground">
      <main className="flex-1 container mx-auto p-4">
        <div className="flex justify-between items-center mb-4">
          <h1 className="text-2xl font-bold">Histogram Dashboard</h1>
        </div>
        {boards.map((board) => {
          const histoId = `board${board.id}`
          const roi = roiValues[histoId] || { low: 0, high: 0 }
          const integral = integrals[histoId]

          return (
            <Card key={board.id} className="mb-6">
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>{board.name} (ID: {board.id})</CardTitle>
                <Button onClick={toggleLogScale} variant="outline">
                  {isLogScale ? "Linear" : "Logarithmic"}
                </Button>
              </CardHeader>
              <CardContent>
                <div className="relative">
                  <div className="flex items-center gap-2 mb-2">
                    <h3 className="text-lg font-semibold">
                      ROI ({roi.low} - {roi.high})
                      {integral !== undefined && ` Integral: ${integral}`}
                    </h3>
                    
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDialogOpen(histoId)}
                      className="h-8 w-8"
                    >
                      <Settings className="h-4 w-4" />
                    </Button>
                  </div>

                  <div
                    ref={el => { histogramRefs.current[histoId] = el }}
                    className="w-full h-80 border rounded-lg shadow-md mb-2"
                  />

                  <ROISettingsDialog
                    isOpen={activeDialog === histoId}
                    onClose={handleDialogClose}
                    histoId={histoId}
                    currentValues={roi}
                    onSave={handleROIChange}
                  />
                </div>
              </CardContent>
            </Card>
          )
        })}
      </main>
    </div>
  )
}