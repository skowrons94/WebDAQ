'use client'

import { useState, useEffect, useRef } from 'react'
import { getBoardConfiguration, getRunStatus, getCurrentRunNumber } from '@/lib/api'
import { Card, CardContent } from "@/components/ui/card"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/use-toast"
import Script from 'next/script'
import Link from 'next/link'
import { MoonStarIcon } from 'lucide-react'

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

export default function HistogramsPage() {
  const [boards, setBoards] = useState<BoardData[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [runNumber, setRunNumber] = useState<number | null>(null)
  const [jsrootLoaded, setJsrootLoaded] = useState(false)
  const histogramRefs = useRef<{[key: string]: HTMLDivElement | null}>({})
  const { toast } = useToast()

  useEffect(() => {
    fetchBoardConfiguration()
    fetchRunStatus()
    const interval = setInterval(() => {
      fetchRunStatus()
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (jsrootLoaded && isRunning) {
      updateHistograms()
      const interval = setInterval(updateHistograms, 1000)
      return () => clearInterval(interval)
    }
  }, [jsrootLoaded, isRunning])

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
      hist.fill(Math.random() * 100)
    }
    return hist
  }

  return (
    <div className="flex flex-col min-h-screen bg-background text-foreground">
      <Script
        src="https://root.cern/js/latest/scripts/JSRoot.core.js"
        onLoad={() => setJsrootLoaded(true)}
      />

      <main className="flex-1 container mx-auto p-4">

        <Accordion type="multiple" className="w-full space-y-4">
          {boards.map((board) => (
            <AccordionItem value={`board-${board.id}`} key={board.id}>
              <AccordionTrigger className="text-lg font-semibold">
                {board.name} (ID: {board.id})
              </AccordionTrigger>
              <AccordionContent>
                <Card>
                  <CardContent>
                    <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
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
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </main>
    </div>
  )
}