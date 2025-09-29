'use client'

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { getBoardConfiguration, getRunStatus, getCurrentRunNumber, getWaveform1, getWaveform2, getBoardSettings, setSetting } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
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

interface RegisterData {
  name: string
  value_dec: number
  value_hex: string
  channel: number
  address: string
}

interface BoardSettings {
  [reg_name: string]: RegisterData
}

interface WaveformConfig {
  dualTrace: boolean
  trace1Type: string
  trace2Type: string
}

// Trace type options for different board types
const PHA_TRACE1_OPTIONS = [
  { value: 0, label: "Input" },
  { value: 1, label: "RC-CR" },
  { value: 2, label: "RC-CR2" },
  { value: 3, label: "Trapezoid" }
]

const PHA_TRACE2_OPTIONS = [
  { value: 0, label: "Input" },
  { value: 1, label: "Threshold" },
  { value: 2, label: "Trapezoid - Baseline" },
  { value: 3, label: "Baseline" }
]

const PSD_TRACE1_OPTIONS = [
  { value: 0, label: "Input" },
  { value: 1, label: "CFD" },
  { value: 2, label: "Input" },
  { value: 3, label: "Reserved" }
]

const PSD_TRACE2_OPTIONS = [
  { value: 0, label: "Baseline" },
  { value: 1, label: "Baseline" },
  { value: 2, label: "CFD" },
  { value: 3, label: "Reserved" }
]

export default function WaveformDashboard() {
  const [boards, setBoards] = useState<BoardData[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [runNumber, setRunNumber] = useState<number | null>(null)
  const [jsrootLoaded, setJsrootLoaded] = useState(false)
  const [updateTrigger, setUpdateTrigger] = useState(0)
  const [selectedWaveform, setSelectedWaveform] = useState<{[boardId: string]: number}>({})
  const [boardSettings, setBoardSettings] = useState<{[boardId: string]: BoardSettings}>({})
  const [waveformConfigs, setWaveformConfigs] = useState<{[boardId: string]: WaveformConfig}>({})
  const histogramRefs = useRef<{[key: string]: HTMLDivElement | null}>({})
  const { toast } = useToast()
  const initialFetchDone = useRef(false)
  const { settings, updateBoardChannelSelection, clearAllSelections } = useVisualizationStore()
  const [storeReady, setStoreReady] = useState(false)

  useEffect(() => {
    // Wait for store to be hydrated
    if (settings && settings.selectedBoardsChannelsWaveform !== undefined) {
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

      // Initialize waveform selection for each board
      const initialWaveforms: {[boardId: string]: number} = {}
      response.data.forEach((board: BoardData) => {
        initialWaveforms[board.id] = 1 // Default to waveform 1
      })
      setSelectedWaveform(initialWaveforms)

      // Fetch board settings for waveform configuration
      await fetchAllBoardSettings(response.data)
    } catch (error) {
      console.error('Failed to fetch board configuration:', error)
      toast({
        title: "Error",
        description: "Failed to fetch board configuration. Please try again.",
        variant: "destructive",
      })
    }
  }

  const fetchAllBoardSettings = async (boardList: BoardData[]) => {
    const settingsPromises = boardList.map(async (board) => {
      try {
        const settings = await getBoardSettings(board.id)
        return { boardId: board.id, settings }
      } catch (error) {
        console.error(`Failed to fetch settings for board ${board.id}:`, error)
        return { boardId: board.id, settings: {} }
      }
    })

    const results = await Promise.all(settingsPromises)
    const newBoardSettings: {[boardId: string]: BoardSettings} = {}
    const newWaveformConfigs: {[boardId: string]: WaveformConfig} = {}

    results.forEach(({ boardId, settings }) => {
      newBoardSettings[boardId] = settings
      newWaveformConfigs[boardId] = parseWaveformConfig(settings)
    })

    setBoardSettings(newBoardSettings)
    setWaveformConfigs(newWaveformConfigs)
  }

  const parseWaveformConfig = (settings: BoardSettings): WaveformConfig => {
    // Look for "Board Configuration" register
    const boardConfigReg = Object.values(settings).find(
      (reg): reg is RegisterData => (reg as RegisterData).name?.includes("Board Configuration")
    )

    if (!boardConfigReg) {
      return {
        dualTrace: false,
        trace1Type: "Input",
        trace2Type: "Input"
      }
    }

    const value = boardConfigReg.value_dec
    const dualTrace = (value & (1 << 11)) !== 0

    // Find the board type from settings to determine PHA vs PSD
    const isPSD = Object.values(settings).some((reg): reg is RegisterData =>
      (reg as RegisterData).name?.toLowerCase().includes('psd')
    )

    const bits12_13 = (value >> 12) & 0x3
    const bits14_15 = (value >> 14) & 0x3

    let trace1Type: string
    let trace2Type: string

    if (isPSD) {
      // PSD waveform types
      switch (bits12_13) {
        case 0: trace1Type = "Input"; break
        case 1: trace1Type = "CFD"; break
        case 2: trace1Type = "Input"; break
        case 3: trace1Type = "Reserved"; break
        default: trace1Type = "Input"
      }

      switch (bits14_15) {
        case 0: trace2Type = "Baseline"; break
        case 1: trace2Type = "Baseline"; break
        case 2: trace2Type = "CFD"; break
        case 3: trace2Type = "Reserved"; break
        default: trace2Type = "Baseline"
      }
    } else {
      // PHA waveform types
      switch (bits12_13) {
        case 0: trace1Type = "Input"; break
        case 1: trace1Type = "RC-CR"; break
        case 2: trace1Type = "RC-CR2"; break
        case 3: trace1Type = "Trapezoid"; break
        default: trace1Type = "Input"
      }

      switch (bits14_15) {
        case 0: trace2Type = "Input"; break
        case 1: trace2Type = "Threshold"; break
        case 2: trace2Type = "Trapezoid - Baseline"; break
        case 3: trace2Type = "Baseline"; break
        default: trace2Type = "Input"
      }
    }

    return {
      dualTrace,
      trace1Type,
      trace2Type
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

  const getSelectedChannels = useCallback((boardId: string): number[] => {
    if (!storeReady || !settings?.selectedBoardsChannelsWaveform) return []
    const selection = settings.selectedBoardsChannelsWaveform.find((sel: { boardId: string; channels: number[] }) => sel.boardId === boardId)
    return selection ? selection.channels : []
  }, [storeReady, settings?.selectedBoardsChannelsWaveform])

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

    updateBoardChannelSelection('Waveform', boardId, newSelection)
  }, [getSelectedChannels, updateBoardChannelSelection])

  const handleSelectAllChannels = useCallback((boardId: string, checked: boolean) => {
    const board = boards.find((b: BoardData) => b.id === boardId)
    if (!board) return

    const allChannels = Array.from({ length: parseInt(board.chan) }, (_, i) => i)
    updateBoardChannelSelection('Waveform', boardId, checked ? allChannels : [])
  }, [boards, updateBoardChannelSelection])

  const handleShowAllChannels = useCallback(() => {
    boards.forEach((board: BoardData) => {
      const allChannels = Array.from({ length: parseInt(board.chan) }, (_, i) => i)
      updateBoardChannelSelection('Waveform', board.id, allChannels)
    })
  }, [boards, updateBoardChannelSelection])

  const handleHideAllChannels = useCallback(() => {
    boards.forEach((board: BoardData) => {
      updateBoardChannelSelection('Waveform', board.id, [])
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
            const waveformNum = selectedWaveform[board.id] || 1
            const histogramData = waveformNum === 1
              ? await getWaveform1(board.id, channelIndex.toString())
              : await getWaveform2(board.id, channelIndex.toString())
            const histogram = window.JSROOT.parse(histogramData)
            window.JSROOT.redraw(histoElement, histogram, "colz")
          } catch (error) {
            console.error(`Failed to fetch histogram for ${histoId}:`, error)
            toast({
              title: "Error",
              description: `Failed to update histogram for ${board.name} - Channel ${channelIndex}`,
              variant: "destructive",
            })
          }
        }
      }
    }
  }, [boards, selectedWaveform, getSelectedChannels, toast])

  useEffect(() => {
    if (jsrootLoaded && boards.length > 0) {
      updateHistograms()
    }
  }, [jsrootLoaded, boards, updateTrigger, selectedWaveform])

  const handleWaveformSwitch = (boardId: string, waveformNum: number) => {
    setSelectedWaveform(prev => ({
      ...prev,
      [boardId]: waveformNum
    }))
  }

  const handleDualTraceToggle = async (boardId: string, enabled: boolean) => {
    try {
      const settings = boardSettings[boardId]
      const boardConfigReg = Object.values(settings).find(
        (reg): reg is RegisterData => (reg as RegisterData).name?.includes("Board Configuration")
      )

      if (!boardConfigReg) {
        toast({
          title: "Error",
          description: "Board Configuration register not found",
          variant: "destructive",
        })
        return
      }

      // Find the register name key
      const regName = Object.keys(settings).find(key => settings[key] === boardConfigReg)
      if (!regName) return

      // Toggle bit 11 (dual trace)
      let newValue = boardConfigReg.value_dec
      if (enabled) {
        newValue |= (1 << 11) // Set bit 11
      } else {
        newValue &= ~(1 << 11) // Clear bit 11
        // Also switch to waveform 1 if dual trace is disabled
        setSelectedWaveform(prev => ({
          ...prev,
          [boardId]: 1
        }))
      }

      // Update the register
      await setSetting(boardId, regName, newValue.toString())

      // Update local state
      const updatedSettings = {
        ...settings,
        [regName]: {
          ...boardConfigReg,
          value_dec: newValue,
          value_hex: `0x${newValue.toString(16).toUpperCase()}`
        }
      }

      setBoardSettings(prev => ({
        ...prev,
        [boardId]: updatedSettings
      }))

      setWaveformConfigs(prev => ({
        ...prev,
        [boardId]: parseWaveformConfig(updatedSettings)
      }))

      toast({
        title: "Success",
        description: `Dual Trace ${enabled ? 'enabled' : 'disabled'} for ${boards.find(b => b.id === boardId)?.name}`,
      })
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to update Dual Trace setting",
        variant: "destructive",
      })
    }
  }

  const handleTraceTypeChange = async (boardId: string, traceNumber: 1 | 2, newValue: number) => {
    try {
      const settings = boardSettings[boardId]
      const boardConfigReg = Object.values(settings).find(
        (reg): reg is RegisterData => (reg as RegisterData).name?.includes("Board Configuration")
      )

      if (!boardConfigReg) {
        toast({
          title: "Error",
          description: "Board Configuration register not found",
          variant: "destructive",
        })
        return
      }

      // Find the register name key
      const regName = Object.keys(settings).find(key => settings[key] === boardConfigReg)
      if (!regName) return

      let newRegValue = boardConfigReg.value_dec

      // Update the appropriate bits based on trace number
      if (traceNumber === 1) {
        // Clear bits 12-13 and set new value
        newRegValue = (newRegValue & ~(0x3 << 12)) | (newValue << 12)
      } else {
        // Clear bits 14-15 and set new value
        newRegValue = (newRegValue & ~(0x3 << 14)) | (newValue << 14)
      }

      // Update the register
      await setSetting(boardId, regName, newRegValue.toString())

      // Update local state
      const updatedSettings = {
        ...settings,
        [regName]: {
          ...boardConfigReg,
          value_dec: newRegValue,
          value_hex: `0x${newRegValue.toString(16).toUpperCase()}`
        }
      }

      setBoardSettings(prev => ({
        ...prev,
        [boardId]: updatedSettings
      }))

      setWaveformConfigs(prev => ({
        ...prev,
        [boardId]: parseWaveformConfig(updatedSettings)
      }))

      const boardName = boards.find((b: BoardData) => b.id === boardId)?.name
      toast({
        title: "Success",
        description: `Trace ${traceNumber} updated for ${boardName}`,
      })
    } catch (error) {
      toast({
        title: "Error",
        description: `Failed to update Trace ${traceNumber} setting`,
        variant: "destructive",
      })
    }
  }

  const getTraceOptions = (boardId: string, traceNumber: 1 | 2) => {
    const settings = boardSettings[boardId]
    if (!settings) return []

    const isPSD = Object.values(settings).some((reg): reg is RegisterData =>
      (reg as RegisterData).name?.toLowerCase().includes('psd')
    )

    if (traceNumber === 1) {
      return isPSD ? PSD_TRACE1_OPTIONS : PHA_TRACE1_OPTIONS
    } else {
      return isPSD ? PSD_TRACE2_OPTIONS : PHA_TRACE2_OPTIONS
    }
  }


  const getCurrentTraceValue = (boardId: string, traceNumber: 1 | 2) => {
    const settings = boardSettings[boardId]
    if (!settings) return 0

    const boardConfigReg = Object.values(settings).find(
      (reg): reg is RegisterData => (reg as RegisterData).name?.includes("Board Configuration")
    )
    if (!boardConfigReg) return 0

    const value = boardConfigReg.value_dec
    if (traceNumber === 1) {
      return (value >> 12) & 0x3
    } else {
      return (value >> 14) & 0x3
    }
  }

  const hasAnySelections = storeReady && settings?.selectedBoardsChannelsWaveform && settings.selectedBoardsChannelsWaveform.length > 0
  const totalSelectedChannels = storeReady && settings?.selectedBoardsChannelsWaveform ?
    settings.selectedBoardsChannelsWaveform.reduce((total: number, board: { boardId: string; channels: number[] }) => total + board.channels.length, 0) : 0

  return (
    <div className="flex flex-col min-h-screen bg-background text-foreground">
      <main className="flex-1 container mx-auto p-4">
        <div className="mb-4 flex justify-between items-center">
          <div className="text-sm text-muted-foreground">
            {totalSelectedChannels > 0 ?
              `${totalSelectedChannels} channel(s) selected across ${settings?.selectedBoardsChannelsWaveform?.length || 0} board(s)` :
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
                onClick={() => clearAllSelections('Waveform')}
                className="text-destructive hover:text-destructive"
              >
                Clear All Selections
              </Button>
            )}
          </div>
        </div>
        {boards.map((board: BoardData) => {
          const config = waveformConfigs[board.id]
          const selectedChannels = getSelectedChannels(board.id)
          const allChannels = Array.from({ length: parseInt(board.chan) }, (_, i) => i)
          const channelsToShow = selectedChannels // Only show explicitly selected channels
          const isAllSelected = selectedChannels.length === allChannels.length && selectedChannels.length > 0

          return (
            <Card key={board.id} className="mb-6">
              <CardHeader>
                <CardTitle className="flex justify-between items-center">
                  <span>{board.name} (ID: {board.id})</span>
                  <div className="flex items-center space-x-4">
                    <div className="flex items-center space-x-2">
                      <Button
                        size="sm"
                        variant={selectedWaveform[board.id] === 1 ? "default" : "outline"}
                        onClick={() => handleWaveformSwitch(board.id, 1)}
                      >
                        Waveform 1
                      </Button>
                      {config && config.dualTrace && (
                        <Button
                          size="sm"
                          variant={selectedWaveform[board.id] === 2 ? "default" : "outline"}
                          onClick={() => handleWaveformSwitch(board.id, 2)}
                        >
                          Waveform 2
                        </Button>
                      )}
                    </div>
                  </div>
                </CardTitle>
                {config && (
                  <div className="text-sm text-muted-foreground space-y-2">
                    <div className="flex items-center space-x-4">
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          checked={config.dualTrace}
                          onCheckedChange={(checked: boolean) => handleDualTraceToggle(board.id, checked)}
                        />
                        <Label className="text-sm cursor-pointer" onClick={() => handleDualTraceToggle(board.id, !config.dualTrace)}>
                          Dual Trace
                        </Label>
                      </div>
                    </div>
                    <div className="flex items-center space-x-4">
                      <div className="flex items-center space-x-2">
                        <Label className="text-sm min-w-16">Trace 1:</Label>
                        <Select
                          value={getCurrentTraceValue(board.id, 1).toString()}
                          onValueChange={(value: string) => handleTraceTypeChange(board.id, 1, parseInt(value))}
                        >
                          <SelectTrigger className="w-48 h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {getTraceOptions(board.id, 1).map((option) => (
                              <SelectItem key={option.value} value={option.value.toString()}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {config.dualTrace && (
                        <div className="flex items-center space-x-2">
                          <Label className="text-sm min-w-16">Trace 2:</Label>
                          <Select
                            value={getCurrentTraceValue(board.id, 2).toString()}
                            onValueChange={(value: string) => handleTraceTypeChange(board.id, 2, parseInt(value))}
                          >
                            <SelectTrigger className="w-48 h-8 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {getTraceOptions(board.id, 2).map((option) => (
                                <SelectItem key={option.value} value={option.value.toString()}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                    </div>
                  </div>
                )}
                <div className="flex flex-col space-y-4 mt-4">
                  <div className="flex items-center space-x-4">
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id={`select-all-wave-${board.id}`}
                        checked={isAllSelected}
                        onCheckedChange={(checked: boolean) => handleSelectAllChannels(board.id, checked)}
                      />
                      <Label htmlFor={`select-all-wave-${board.id}`} className="text-sm font-medium">
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
                          id={`wave-channel-${board.id}-${channelIndex}`}
                          checked={isChannelSelected(board.id, channelIndex)}
                          onCheckedChange={(checked: boolean) => handleChannelToggle(board.id, channelIndex, checked)}
                        />
                        <Label htmlFor={`wave-channel-${board.id}-${channelIndex}`} className="text-xs">
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