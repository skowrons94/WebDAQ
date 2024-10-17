'use client'

import React, { useEffect, useRef, useState } from 'react'
import { getHistogram } from '@/lib/api'
import { loadJSROOT } from '@/lib/load-jsroot'
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

interface HistogramProps {
  histogramName: string
  boardName: string
  channelNumber: number
  width?: number
  height?: number
}

export default function JSROOTHistogram({ 
  histogramName, 
  boardName, 
  channelNumber, 
  width = 400, 
  height = 300 
}: HistogramProps) {
  const histogramRef = useRef<HTMLDivElement>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lowROI, setLowROI] = useState<number>(0)
  const [highROI, setHighROI] = useState<number>(100)
  const [histogramObj, setHistogramObj] = useState<any>(null)

  useEffect(() => {
    const fetchAndDrawHistogram = async () => {
      try {
        setIsLoading(true)
        setError(null)

        // Load JSROOT
        await loadJSROOT()

        // Fetch histogram data
        const histogramData = await getHistogram("0", "0")
        
        if (histogramRef.current && window.JSROOT) {
          // Clear any existing content
          histogramRef.current.innerHTML = ''
          
          // Parse the JSON data
          const obj = window.JSROOT.parse(histogramData)
          setHistogramObj(obj)
          
          // Draw the histogram
          await drawHistogram(obj)
        } else {
          throw new Error('JSROOT not loaded or histogram container not found')
        }
      } catch (error) {
        console.error('Error fetching or drawing histogram:', error)
        setError('Failed to load or draw histogram')
      } finally {
        setIsLoading(false)
      }
    }

    fetchAndDrawHistogram()
  }, [histogramName, boardName, channelNumber, width, height])

  useEffect(() => {
    if (histogramObj) {
      drawHistogram(histogramObj)
    }
  }, [lowROI, highROI])

  const drawHistogram = async (obj: any) => {
    if (histogramRef.current && window.JSROOT) {
      // Draw the main histogram
      let painter = await window.JSROOT.redraw(histogramRef.current, obj, 'hist')
      
      // Draw ROI
      if (painter && painter.draw_g) {
        const roiObj = window.JSROOT.createHistogram("TH1F", 100)
        roiObj.fXaxis.fXmin = obj.fXaxis.fXmin
        roiObj.fXaxis.fXmax = obj.fXaxis.fXmax
        for (let i = 1; i <= 100; i++) {
          const x = roiObj.fXaxis.fXmin + (roiObj.fXaxis.fXmax - roiObj.fXaxis.fXmin) * (i - 0.5) / 100
          if (x >= lowROI && x <= highROI) {
            roiObj.setBinContent(i, obj.getBinContent(i))
          }
        }
        roiObj.fLineColor = 2 // Red color
        roiObj.fFillColor = 2 // Red color
        roiObj.fFillStyle = 3001 // Transparent fill
        await window.JSROOT.redraw(painter.draw_g, roiObj, 'hist same')
      }
    }
  }

  return (
    <div className="flex flex-col items-center">
      <h2 className="text-xl font-semibold mb-2" id={`histogram-title-${boardName}-${channelNumber}`}>
        {boardName} - Channel {channelNumber}
      </h2>
      {isLoading && <p>Loading histogram...</p>}
      {error && <p className="text-red-500">{error}</p>}
      <div 
        ref={histogramRef} 
        style={{ 
          width: `${width}px`, 
          height: `${height}px`, 
          display: isLoading ? 'none' : 'block',
        }} 
        aria-labelledby={`histogram-title-${boardName}-${channelNumber}`}
      />
      <div className="flex gap-4 mt-4">
        <div className="flex flex-col">
          <Label htmlFor="lowROI">Low ROI</Label>
          <Input
            id="lowROI"
            type="number"
            value={lowROI}
            onChange={(e) => setLowROI(Number(e.target.value))}
            className="w-24"
          />
        </div>
        <div className="flex flex-col">
          <Label htmlFor="highROI">High ROI</Label>
          <Input
            id="highROI"
            type="number"
            value={highROI}
            onChange={(e) => setHighROI(Number(e.target.value))}
            className="w-24"
          />
        </div>
      </div>
    </div>
  )
}