'use client'

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { getBoardConfiguration, getRunStatus, getCurrentRunNumber, getHistogram, getRoiHistogram, getRoiIntegral } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useToast } from "@/components/ui/use-toast"
import { loadJSROOT } from '@/lib/load-jsroot'
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useTheme } from 'next-themes'
import { Settings, Grid2X2, Rows2 } from 'lucide-react'
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
  const initialFetchDone = useRef(false)
  const [layout, setLayout] = useState<'grid' | 'rows'>('grid')

  // Initial setup
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

  // Add this useEffect to handle wheel events on histograms
  useEffect(() => {
    if (!jsrootLoaded || boards.length === 0) return;

    const preventScroll = (e) => {
      e.preventDefault();
      e.stopPropagation();
      return false;
    };

    // Get all histogram elements and add non-passive wheel event listeners
    const histoElements = Object.values(histogramRefs.current).filter(el => el !== null);
    histoElements.forEach(el => {
      if (el) {
        el.addEventListener('wheel', preventScroll, { passive: false });
      }
    });

    // Clean up event listeners on unmount
    return () => {
      histoElements.forEach(el => {
        if (el) {
          el.removeEventListener('wheel', preventScroll);
        }
      });
    };
  }, [jsrootLoaded, boards, updateTrigger]); // Include updateTrigger to refresh when new refs are added

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
      for (let i = 0; i < parseInt(board.chan); i++) {
        const histoId = `board${board.id}_channel${i}`
        initialROIValues[histoId] = { low: 0, high: 0, integral: 0 }
      }
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
    const updatedIntegrals = { ...integrals }
    for (const board of boards) {
      for (let i = 0; i < parseInt(board.chan); i++) {
        const histoId = `board${board.id}_channel${i}`
        const { low, high } = roiValues[histoId] || { low: 0, high: 0 }
        try {
          const integral = await getRoiIntegral(board.id, i.toString(), low, high)
          updatedIntegrals[histoId] = integral
        } catch (error) {
          console.error(`Failed to get ROI integral for ${histoId}:`, error)
        }
      }
    }
    setIntegrals(updatedIntegrals)
  }, [boards, roiValues])

  // ROI cache management
  const updateROICache = async (roiVal: ROIValues) => {
    try {
      await fetch('/api/cache', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(roiVal),
      })
      setUnsavedChanges(false)
      await setRoiValues(roiVal)
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
    //setRoiValues(prev => ({
    //  ...prev,
    //  [histoId]: { ...prev[histoId], low, high }
    //}))
    roiValues[histoId] = { low, high, integral: 0 }
    setUnsavedChanges(true)
    // Update the cache immediately
    updateROICache(roiValues)
    // Clean the histogram JSROOT object
    const histoElement = histogramRefs.current[histoId]
    if (histoElement) {
      const blankHist = createBlankHistogram(histoId)
    }
  }

  const drawHistogramWithROI = async (element: HTMLDivElement, histogram: any, histoId: string, chan: string, id: string) => {
    if (window.JSROOT) {
      const canv = window.JSROOT.create('TCanvas');

      // Make histogram blue fill with alpha of 0.3
      histogram.fLineColor = 4;
      histogram.fFillColor = 4;
      histogram.fFillStyle = 3001;

      canv.fName = 'c1';
      canv.fPrimitives.Add(histogram, 'histo');

      const { low, high } = roiValues[histoId] || { low: 0, high: 0 }

      console.log('Drawing histogram with ROI:', histoId, low, high)
      const roiObj = await getRoiHistogram(id, chan, low, high)
      const roiHistogram = window.JSROOT.parse(roiObj)

      roiHistogram.fLineColor = 2;
      roiHistogram.fFillColor = 2;
      roiHistogram.fFillStyle = 3001;

      canv.fPrimitives.Add(roiHistogram, 'histo');

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

  // Update effects
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

  const setLogScale = (value: boolean) => {
    setIsLogScale(value)
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
          <ToggleGroup type="single" value={layout} onValueChange={(value) => setLayout(value as 'grid' | 'rows')}>
            <ToggleGroupItem value="grid"><Grid2X2 className="h-4 w-4" /> </ToggleGroupItem>
            <ToggleGroupItem value="rows"><Rows2 className="h-4 w-4" /> </ToggleGroupItem>
          </ToggleGroup>
        </div>
        {boards.map((board) => (
          <Card key={board.id} className="mb-6">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>{board.name} (ID: {board.id})</CardTitle>
{/*               <Button onClick={toggleLogScale} variant="outline">
                {isLogScale ? "Linear" : "Logarithmic"}
              </Button> */}
                <ToggleGroup type="single" value={isLogScale ? 'logaritmic' : 'linear'} onValueChange={(value) => setLogScale(value === 'logaritmic')}>
                <ToggleGroupItem value="linear">Linear </ToggleGroupItem>
                <ToggleGroupItem value="logaritmic">Logaritmic </ToggleGroupItem>
              </ToggleGroup>
            </CardHeader>
            <CardContent>
              <div className={`grid ${layout === 'grid' ? 'grid-cols-1 md:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3' : 'grid-cols-1'} gap-6`}>
                {Array.from({ length: parseInt(board.chan) }).map((_, channelIndex) => {
                  const histoId = `board${board.id}_channel${channelIndex}`
                  const roi = roiValues[histoId] || { low: 0, high: 0 }
                  const integral = integrals[histoId]

                  return (
                    <div key={histoId} className="relative">
                        <div className="flex items-center ">
                        <h3 className="text-lg font-semibold">
                          Channel {channelIndex} - ROI ({roi.low} - {roi.high})
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
                        {integral !== undefined && (
                        <p className="text-lg font-medium gap-2 mb-2">
                          Integral: {integral}
                        </p>
                        )}

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