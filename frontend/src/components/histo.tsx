'use client'

import { useState, useEffect, useRef } from 'react'
import { getBoardConfiguration, getRunStatus, getCurrentRunNumber } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import Script from 'next/script'

declare global {
  interface Window {
    JSROOT: any;
  }
}

type BoardData = {
  id: string;
  name: string;
  vme: string;
  link_type: string;
  link_num: string;
  dpp: string;
  chan: string;
}

export function HistogramsPage() {
  const [boards, setBoards] = useState<BoardData[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [runNumber, setRunNumber] = useState<number | null>(null)
  const [jsrootLoaded, setJsrootLoaded] = useState(false)
  const histogramRefs = useRef<{[key: string]: HTMLDivElement | null}>({})

  useEffect(() => {
    fetchBoardConfiguration()
    fetchRunStatus()
    const interval = setInterval(() => {
      fetchRunStatus()
      if (jsrootLoaded && isRunning) {
        updateHistograms()
      }
    }, 1000)
    return () => clearInterval(interval)
  }, [jsrootLoaded])

  const fetchBoardConfiguration = async () => {
    try {
      const response = await getBoardConfiguration()
      setBoards(response.data)
    } catch (error) {
      console.error('Failed to fetch board configuration:', error)
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
    }
  }

  const updateHistograms = async () => {
    for (const board of boards) {
      for (let i = 0; i < parseInt(board.chan); i++) {
        const histoId = `board${board.id}_channel${i}`
        const histoElement = histogramRefs.current[histoId]
        if (histoElement) {
          let histogram
          if (isRunning && runNumber !== null) {
            try {
              const response = await fetch(`/data/run${runNumber}/${histoId}.root`)
              if (response.ok) {
                const buffer = await response.arrayBuffer()
                histogram = await window.JSROOT.openFile(buffer)
                histogram = await histogram.readObject(`${histoId};1`)
              } else {
                histogram = createRandomHistogram(histoId)
              }
            } catch (error) {
              console.error(`Failed to fetch histogram for ${histoId}:`, error)
              histogram = createRandomHistogram(histoId)
            }
          } else {
            histogram = createRandomHistogram(histoId)
          }
          window.JSROOT.redraw(histoElement, histogram, "hist")
        }
      }
    }
  }

  const createRandomHistogram = (name: string) => {
    const hist = window.JSROOT.createHistogram("TH1F", 100)
    hist.fName = name
    hist.fTitle = `Random Histogram for ${name}`
    for (let i = 0; i < 1000; ++i) {
      hist.Fill(Math.random() * 100)
    }
    return hist
  }

  return (
    <div className="container mx-auto p-4">
      <Script
        src="https://root.cern/js/latest/scripts/JSRoot.core.js"
        onLoad={() => setJsrootLoaded(true)}
      />
      <h1 className="text-2xl font-bold mb-4">LUNA Histograms</h1>
      <div className="mb-4">
        <p>Run Status: {isRunning ? 'Running' : 'Stopped'}</p>
        <p>Run Number: {runNumber !== null ? runNumber : 'N/A'}</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {boards.map(board => (
          <Card key={board.id}>
            <CardHeader>
              <CardTitle>{board.name} (ID: {board.id})</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-2">
                {Array.from({ length: parseInt(board.chan) }).map((_, channelIndex) => {
                  const histoId = `board${board.id}_channel${channelIndex}`
                  return (
                    <div
                      key={histoId}
                      ref={el => histogramRefs.current[histoId] = el}
                      className="w-full h-48 border"
                    ></div>
                  )
                })}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}