'use client'

import React, { useEffect, useRef, useState } from 'react'
import { getHistogram } from '@/lib/api'
import { loadJSROOT } from '@/lib/load-jsroot'

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
          
          // Draw the histogram
          let painter = await window.JSROOT.redraw(histogramRef.current, obj, 'hist')
          console.log('Object type in painter', painter);
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
    </div>
  )
}