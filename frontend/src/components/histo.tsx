'use client'

import { useState, useEffect, useRef, use } from 'react'
import { getBoardConfiguration, getRunStatus, getCurrentRunNumber, getHistogram } from '@/lib/api'
import { Card, CardContent } from "@/components/ui/card"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/use-toast"
import Script from 'next/script'
import Link from 'next/link'
import { MoonStarIcon } from 'lucide-react'
import { useTheme } from 'next-themes'
import { set } from 'react-hook-form'

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
  const histogramData = useRef<{[key: string]: any}>({})
  const { toast } = useToast()
  const initialFetchDone = useRef(false)
  const { theme, setTheme } = useTheme()

  useEffect(() => {
      if (typeof window.JSROOT === 'undefined') return

      window.JSROOT.settings.DarkMode = theme === 'dark'
      updateHistograms()
  }, [theme])

  useEffect(() => {
    fetchBoardConfiguration()
    fetchRunStatus()
    const interval = setInterval(() => {
      fetchRunStatus()
    }, 2000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (boards.length > 0 && !initialFetchDone.current) {
      initialFetchDone.current = true
      updateHistograms()
    }
  }, [jsrootLoaded, boards])

  useEffect(() => {
    if (isRunning) {
      const interval = setInterval(updateHistograms, 5000)
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
    console.log('Updating histograms...')
    for (const board of boards) {
      for (let i = 0; i < parseInt(board.chan); i++) {
        const histoId = `board${board.id}_channel${i}`
        const histoElement = histogramRefs.current[histoId]
        console.log(histoElement)
        if (histoElement) {
          let histogram
          try {
            const response = await getHistogram(board.id, i.toString())
            histogram = window.JSROOT.parse(response)
            histogramData.current[histoId] = histogram
          } catch (error) {
            console.error(`Failed to fetch histogram for ${histoId}:`, error)
            if (!histogramData.current[histoId]) {
              histogram = createBlankHistogram(histoId)
              histogramData.current[histoId] = histogram
            } else {
              histogram = histogramData.current[histoId]
            }
          }
          window.JSROOT.redraw(histoElement, histogram, "hist")
        }
      }
    }
  }

  const createBlankHistogram = (name: string) => {

    // window.JSROOT.settings.DarkMode = theme === 'dark'
    const hist = window.JSROOT.createHistogram("TH1F", 100)
    hist.fName = name
    hist.fTitle = `Histogram for ${name}`
    return hist
  }

  return (
    <div className="flex flex-col min-h-screen bg-background text-foreground">
      <Script
        src="https://root.cern/js/latest/scripts/JSRoot.core.js"
        crossOrigin='anonymous'
      />

      <main className="flex-1 container mx-auto p-4">
          {boards.map((board) => (
                <Card>
                  <CardContent>
                <div className="grid grid-cols-2 lg:grid-cols-2 xl:grid-cols-2 gap-4 p-4 md:p-8">
                      {Array.from({ length: parseInt(board.chan) }).map((_, channelIndex) => {
                      const histoId = `board${board.id}_channel${channelIndex}`
                      return (
                        <div
                        key={histoId}
                        ref={el => { histogramRefs.current[histoId] = el }}
                          className="w-full h-80 border"
                        ></div>
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