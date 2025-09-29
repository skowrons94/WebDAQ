'use client'

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { getBoardConfiguration, getRunStatus, getCurrentRunNumber, getPsd } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { useToast } from "@/components/ui/use-toast"
import { loadJSROOT } from '@/lib/load-jsroot'
import { useVisualizationStore } from '@/store/visualization-settings-store'

type BoardData = {
  id: string;
  name: string;
  vme: string;
  link_type: string;
  link_num: string;
  dpp: string;
  chan: string;
}

export default function PSDDashboard() {
  const [boards, setBoards] = useState<BoardData[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [runNumber, setRunNumber] = useState<number | null>(null)
  const [jsrootLoaded, setJsrootLoaded] = useState(false)
  const [updateTrigger, setUpdateTrigger] = useState(0)
  const histogramRefs = useRef<{[key: string]: HTMLDivElement | null}>({})
  const { toast } = useToast()
  const initialFetchDone = useRef(false)
  const { settings, updateBoardChannelSelection, clearAllSelections } = useVisualizationStore()
  const [storeReady, setStoreReady] = useState(false)

  useEffect(() => {
    // Wait for store to be hydrated
    if (settings && settings.selectedBoardsChannelsPSD !== undefined) {
      setStoreReady(true)
    }
  }, [settings])

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
    const board = boards.find((b: BoardData) => b.id === boardId)
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

  const hasAnySelections = storeReady && settings?.selectedBoardsChannelsPSD && settings.selectedBoardsChannelsPSD.length > 0
  const totalSelectedChannels = storeReady && settings?.selectedBoardsChannelsPSD ?
    settings.selectedBoardsChannelsPSD.reduce((total, board) => total + board.channels.length, 0) : 0

  return (
    <div className="flex flex-col min-h-screen bg-background text-foreground">
      <main className="flex-1 container mx-auto p-4">
        <div className="mb-4 flex justify-between items-center">
          <div className="text-sm text-muted-foreground">
            {totalSelectedChannels > 0 ?
              `${totalSelectedChannels} channel(s) selected across ${settings?.selectedBoardsChannelsPSD?.length || 0} board(s)` :
              'No channels selected - only board names shown'
            }
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleShowAllChannels}
            >
              Show All Channels
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleHideAllChannels}
            >
              Hide All Channels
            </Button>
            {hasAnySelections && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => clearAllSelections('PSD')}
                className="text-destructive hover:text-destructive"
              >
                Clear All Selections
              </Button>
            )}
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
                <CardTitle className="flex justify-between items-center">
                  <span>{board.name} (ID: {board.id}) - PSD Histograms</span>
                  <div className="text-sm text-muted-foreground">
                    Status: {isRunning ? 'Running' : 'Stopped'}
                    {runNumber && ` | Run: ${runNumber}`}
                  </div>
                </CardTitle>
                <div className="flex flex-col space-y-4 mt-4">
                  <div className="flex items-center space-x-4">
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id={`select-all-${board.id}`}
                        checked={isAllSelected}
                        onCheckedChange={(checked: boolean) => handleSelectAllChannels(board.id, checked)}
                      />
                      <Label htmlFor={`select-all-${board.id}`} className="text-sm font-medium">
                        Select All Channels
                      </Label>
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {selectedChannels.length > 0 ? `${selectedChannels.length}/${board.chan} channels selected` : `All ${board.chan} channels shown`}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {allChannels.map(channelIndex => (
                      <div key={channelIndex} className="flex items-center space-x-1">
                        <Checkbox
                          id={`channel-${board.id}-${channelIndex}`}
                          checked={isChannelSelected(board.id, channelIndex)}
                          onCheckedChange={(checked: boolean) => handleChannelToggle(board.id, channelIndex, checked)}
                        />
                        <Label htmlFor={`channel-${board.id}-${channelIndex}`} className="text-xs">
                          Ch {channelIndex}
                        </Label>
                      </div>
                    ))}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {channelsToShow.length > 0 ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                    {channelsToShow.map((channelIndex: number) => {
                      const histoId = `board${board.id}_channel${channelIndex}`
                      return (
                        <div key={histoId} className="relative">
                          <h3 className="text-lg font-semibold mb-2">Channel {channelIndex}</h3>
                          <div
                            ref={(el: HTMLDivElement | null) => { histogramRefs.current[histoId] = el }}
                            className="w-full h-80 border rounded-lg shadow-sm"
                          ></div>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <div className="text-center text-muted-foreground py-8">
                    No channels selected for this board. Use the checkboxes above to select channels to visualize.
                  </div>
                )}
              </CardContent>
            </Card>
          )
        })}
      </main>
    </div>
  )
}