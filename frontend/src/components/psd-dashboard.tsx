'use client'

import { useRunStatus } from '@/hooks/use-run-status'
import { useRunBadge } from '@/hooks/use-run-badge'
import { StatusBadge } from '@/components/ui/status-badge'
import React, { useState, useEffect, useRef, useCallback } from 'react'
import { getBoardConfiguration, getPsd } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { useToast } from "@/components/ui/use-toast"
import { loadJSROOT } from '@/lib/load-jsroot'
import { useVisualizationStore } from '@/store/visualization-settings-store'
import { useJsrootTheme } from '@/lib/jsroot-theme'

type BoardData = {
  id: string;
  name: string;
  vme: string;
  link_type: string;
  link_num: string;
  dpp: string;
  chan: string;
  vendor?: string;   // 'sis3316' for the Struck board, which has no PSD
}

export default function PSDDashboard() {
  const [boards, setBoards] = useState<BoardData[]>([])
  // From the app's shared run-status poller (hooks/use-run-status.ts).
  const isRunning = useRunStatus((s) => s.isRunning)
  const runBadge = useRunBadge()
  const runNumber = useRunStatus((s) => s.runNumber)
  const [jsrootLoaded, setJsrootLoaded] = useState(false)
  // Plots follow the light/dark theme like the rest of the page.
  useJsrootTheme(jsrootLoaded)
  const [updateTrigger, setUpdateTrigger] = useState(0)
  const histogramRefs = useRef<{[key: string]: HTMLDivElement | null}>({})
  const { toast } = useToast()
  const initialFetchDone = useRef(false)
  const { settings, updateBoardChannelSelection, hydrateFromServer, hydrated } = useVisualizationStore()
  const storeReady = hydrated

  useEffect(() => {
    hydrateFromServer()
  }, [hydrateFromServer])

  useEffect(() => {
    fetchBoardConfiguration()

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
      // Ids arrive as numbers; everything downstream compares them as strings.
      // The SIS3316 readout makes no PSD histograms, so its boards are not
      // listed here at all.
      setBoards((response.data ?? [])
        .filter((board: BoardData) => board.vendor !== 'sis3316')
        .map((board: BoardData) => ({
          ...board,
          id: String(board.id),
        })))
    } catch (error) {
      console.error('Failed to fetch board configuration:', error)
      toast({
        title: "Error",
        description: "Failed to fetch board configuration. Please try again.",
        variant: "destructive",
      })
    }
  }



  const createBlankHistogram = useCallback((name: string) => {
    if (window.JSROOT) {
      const hist = window.JSROOT.createHistogram("TH1F", 100)
      hist.fName = name
      hist.fTitle = `PSD Histogram for ${name}`
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

  const getSelectedChannels = useCallback((boardId: string): number[] => {
    if (!storeReady || !settings?.selectedBoardsChannelsPSD) return []
    const selection = settings.selectedBoardsChannelsPSD.find((sel: { boardId: string; channels: number[] }) => sel.boardId === boardId)
    return selection ? selection.channels : []
  }, [storeReady, settings?.selectedBoardsChannelsPSD])

  const isChannelSelected = useCallback((boardId: string, channel: number): boolean => {
    const selectedChannels = getSelectedChannels(boardId)
    return selectedChannels.includes(channel)
  }, [getSelectedChannels])

  const handleChannelToggle = useCallback((boardId: string, channel: number, checked: boolean) => {
    const currentSelection = getSelectedChannels(boardId)
    let newSelection: number[]

    if (checked) {
      newSelection = [...currentSelection, channel].sort((a, b) => a - b)
    } else {
      newSelection = currentSelection.filter((ch: number) => ch !== channel)
    }

    updateBoardChannelSelection('PSD', boardId, newSelection)
  }, [getSelectedChannels, updateBoardChannelSelection])

  const handleSelectAllChannels = useCallback((boardId: string, checked: boolean) => {
    const board = boards.find((b: BoardData) => String(b.id) === String(boardId))
    if (!board) return

    const allChannels = Array.from({ length: parseInt(board.chan) }, (_, i) => i)
    updateBoardChannelSelection('PSD', boardId, checked ? allChannels : [])
  }, [boards, updateBoardChannelSelection])

  const handleShowAllChannels = useCallback(() => {
    boards.forEach(board => {
      const allChannels = Array.from({ length: parseInt(board.chan) }, (_, i) => i)
      updateBoardChannelSelection('PSD', board.id, allChannels)
    })
  }, [boards, updateBoardChannelSelection])

  const handleHideAllChannels = useCallback(() => {
    boards.forEach(board => {
      updateBoardChannelSelection('PSD', board.id, [])
    })
  }, [boards, updateBoardChannelSelection])

  const updateHistograms = useCallback(async () => {
    for (const board of boards) {
      const selectedChannels = getSelectedChannels(board.id)
      // Only fetch data for explicitly selected channels
      if (selectedChannels.length === 0) continue

      for (const channelIndex of selectedChannels) {
        const histoId = `board${board.id}_channel${channelIndex}`
        const histoElement = histogramRefs.current[histoId]
        if (histoElement && window.JSROOT) {
          try {
            const histogramData = await getPsd(board.id, channelIndex.toString())
            const histogram = window.JSROOT.parse(histogramData)
            window.JSROOT.redraw(histoElement, histogram, "hist")
          } catch (error) {
            console.error(`Failed to fetch PSD histogram for ${histoId}:`, error)
            toast({
              title: "Error",
              description: `Failed to update PSD histogram for ${board.name} - Channel ${channelIndex}`,
              variant: "destructive",
            })
          }
        }
      }
    }
  }, [boards, getSelectedChannels, toast])

  useEffect(() => {
    if (jsrootLoaded && boards.length > 0) {
      updateHistograms()
    }
  }, [jsrootLoaded, boards, updateTrigger])

  // Counted over the boards on this page, so the line never disagrees with
  // the cards below it.
  const totalChannels = boards.reduce((total, board) => total + (parseInt(board.chan) || 0), 0)
  const totalSelectedChannels = boards.reduce((total, board) => total + getSelectedChannels(board.id).length, 0)

  return (
    <div className="flex flex-col min-h-screen bg-background text-foreground">
      <div className="flex-1 pb-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm text-muted-foreground">
            {boards.length === 0
              ? 'No board with PSD (the SIS3316 records none).'
              : `${totalSelectedChannels} of ${totalChannels} channels shown`}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={handleShowAllChannels} disabled={boards.length === 0}>
              Show all channels
            </Button>
            <Button variant="outline" size="sm" onClick={handleHideAllChannels} disabled={totalSelectedChannels === 0}>
              Hide all channels
            </Button>
          </div>
        </div>
        {boards.map((board: BoardData) => {
          const selectedChannels = getSelectedChannels(board.id)
          const allChannels = Array.from({ length: parseInt(board.chan) }, (_, i) => i)
          const channelsToShow = selectedChannels // Only show explicitly selected channels
          const isAllSelected = selectedChannels.length === allChannels.length && selectedChannels.length > 0

          return (
            <Card key={board.id} className="mb-6">
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center justify-between gap-2">
                  <span>{board.name} (ID: {board.id})</span>
                  <div className="flex items-center gap-2 text-sm font-normal text-muted-foreground">
                    <StatusBadge state={runBadge.state} label={runBadge.label} title={runBadge.title} />
                    {runNumber && <span>Run {runNumber}</span>}
                  </div>
                </CardTitle>
                <div className="flex flex-col space-y-4 mt-4">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id={`select-all-${board.id}`}
                        checked={isAllSelected}
                        onCheckedChange={(checked: boolean) => handleSelectAllChannels(board.id, checked)}
                      />
                      <Label htmlFor={`select-all-${board.id}`} className="text-sm font-medium">
                        Select all channels
                      </Label>
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {`${selectedChannels.length}/${board.chan} channels shown`}
                    </div>
                  </div>
                  {/* The same channel chips as the Waveforms page. */}
                  <div className="flex flex-wrap gap-1.5">
                    {allChannels.map(channelIndex => {
                      const shown = isChannelSelected(board.id, channelIndex)
                      return (
                        <button
                          key={channelIndex}
                          type="button"
                          aria-pressed={shown}
                          onClick={() => handleChannelToggle(board.id, channelIndex, !shown)}
                          title={`${shown ? 'Hide' : 'Show'} channel ${channelIndex}`}
                          className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors pointer-coarse:min-h-10 pointer-coarse:px-2.5 ${
                            shown ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-muted'
                          }`}
                        >
                          Ch {channelIndex}
                        </button>
                      )
                    })}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {channelsToShow.length > 0 ? (
                  <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 min-[1800px]:grid-cols-3">
                    {channelsToShow.map((channelIndex: number) => {
                      const histoId = `board${board.id}_channel${channelIndex}`
                      return (
                        <div key={histoId} className="relative">
                          <h3 className="text-base font-semibold mb-2">Channel {channelIndex}</h3>
                          <div
                            ref={(el: HTMLDivElement | null) => { histogramRefs.current[histoId] = el }}
                            className="w-full h-80 max-md:h-auto max-md:aspect-[4/3] border rounded-lg shadow-sm"
                          ></div>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <div className="text-center text-muted-foreground py-8">
                    No channel shown for this board. Click the channels above to show their PSD plots.
                  </div>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}