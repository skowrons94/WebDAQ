"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ReloadIcon } from "@radix-ui/react-icons"
import { useToast } from "@/components/ui/use-toast"
import { getBoardConfiguration, getBoardSettings, setSetting, updateJSON } from "@/lib/api"

// Define which settings are shown in basic mode (change these names to customize visible settings)
const BASIC_GENERAL_SETTINGS = [
  "Record Length",
  "Acquistion Control",
  "Front Panel TRG-OUT (GPO) Enable Mask",
  "Channel Enable Mask",
  "Board ID",
  "Aggregate Number per BLT"
]

const BASIC_CHANNEL_SETTINGS = [
  "Number of Events per Aggregate",
  "Pre Trigger",
  "RC-CR2 Smoothing Factor",
  "Input Rise Time",
  "Trapezoid Rise Time",
  "Trapezoid Flat Top",
  "Decay Time",
  "Trigger Threshold",
  "Peaking Time",
  "Trigger Hold-Off Width",
  "DC Offset",
  "Fine Gain",
  "Input Dynamic Range",
  "CFD Settings",
  "Short Gate",
  "Long Gate",
  "Gate Offset",
  "Threshold for the PSD",
  "PUR-GAP Threshold",
]

interface BoardData {
  id: string
  name: string
  vme: string
  link_type: string
  link_num: string
  dpp: string
  chan: string
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

export default function Dashboard() {
  const [boards, setBoards] = useState<BoardData[]>([])
  const [selectedBoardId, setSelectedBoardId] = useState<string>("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { toast } = useToast()

  const fetchBoardConfiguration = async () => {
    updateJSON()
    setLoading(true)
    setError(null)
    try {
      const response = await getBoardConfiguration()
      setBoards(response.data)
      // Auto-select the first board if none selected
      if (response.data.length > 0 && !selectedBoardId) {
        setSelectedBoardId(response.data[0].id)
      }
    } catch (err) {
      setError("Failed to load boards data")
      toast({
        title: "Error",
        description: "Failed to fetch board configuration. Please try again.",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchBoardConfiguration()
  }, [])

  if (loading) {
    return (
      <div className="flex justify-center items-center h-screen">
        <ReloadIcon className="mr-2 h-4 w-4 animate-spin" />
        Loading boards data...
      </div>
    )
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }

  const selectedBoard = boards.find(board => board.id === selectedBoardId)

  return (
    <div className="container mx-auto p-4">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">CAEN Dashboard</h1>
        <Button onClick={fetchBoardConfiguration}>Refresh Boards Data</Button>
      </div>

      {/* Board Selection */}
      <div className="mb-6">
        <Label htmlFor="board-select" className="text-lg font-semibold">
          Select Board
        </Label>
        <Select value={selectedBoardId} onValueChange={setSelectedBoardId}>
          <SelectTrigger className="w-full max-w-md">
            <SelectValue placeholder="Select a board..." />
          </SelectTrigger>
          <SelectContent>
            {boards.map((board) => (
              <SelectItem key={board.id} value={board.id}>
                {board.name} (ID: {board.id})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Board Settings */}
      {selectedBoard && (
        <BoardComponent boardData={selectedBoard} />
      )}
    </div>
  )
}

function BoardComponent({ boardData }: { boardData: BoardData }) {
  const [settings, setSettings] = useState<BoardSettings>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [modifiedSettings, setModifiedSettings] = useState<Set<string>>(new Set())
  const [binaryMode, setBinaryMode] = useState(false)
  const [advancedMode, setAdvancedMode] = useState(false)
  const [selectedChannel, setSelectedChannel] = useState<string>("0")
  const { toast } = useToast()

  useEffect(() => {
    const fetchSettings = async () => {
      setLoading(true)
      setError(null)
      try {
        const response = await getBoardSettings(boardData.id)
        setSettings(response)

        // Auto-select first channel if none selected
        const channelList = Object.values(response as BoardSettings)
          .filter((reg: RegisterData) => Number.parseInt(reg.address, 16) <= 0x7000)
          .map((reg: RegisterData) => reg.channel)
          .filter((channel, index, arr) => arr.indexOf(channel) === index)
          .sort((a, b) => a - b)

        if (channelList.length > 0 && !selectedChannel) {
          setSelectedChannel(channelList[0].toString())
        }
      } catch (err) {
        setError("Failed to load settings data")
        toast({
          title: "Error",
          description: "Failed to fetch settings. Please try again.",
          variant: "destructive",
        })
      } finally {
        setLoading(false)
      }
    }

    fetchSettings()
  }, [boardData.id])

  const handleSettingChange = (regName: string, value: string) => {
    const numValue = Number.parseInt(value)
    if (isNaN(numValue) || numValue < 0 || numValue > 4294967295) {
      return // Invalid value, don't update
    }

    setSettings((prev) => ({
      ...prev,
      [regName]: {
        ...prev[regName],
        value_dec: numValue,
        value_hex: `0x${numValue.toString(16).toUpperCase()}`,
      },
    }))

    setModifiedSettings((prev) => new Set(prev).add(regName))
  }

  const formatBinary = (value: number) => {
    return value.toString(2).padStart(32, '0')
  }

  const isRegisterAccessible = (hexValue: string) => {
    // Remove '0x' prefix and check if all characters are 'F' or 'f'
    const cleanHex = hexValue.replace('0x', '').toUpperCase()
    return !cleanHex.match(/^F+$/)
  }

  const handleBitToggle = (regName: string, bitIndex: number) => {
    const currentValue = settings[regName].value_dec
    // Use unsigned right shift to handle bit 31 correctly
    const bitMask = bitIndex === 31 ? 0x80000000 : (1 << bitIndex)
    const newValue = (currentValue ^ bitMask) >>> 0 // Use unsigned right shift to ensure positive result
    
    setSettings((prev) => ({
      ...prev,
      [regName]: {
        ...prev[regName],
        value_dec: newValue,
        value_hex: `0x${newValue.toString(16).toUpperCase()}`,
      },
    }))

    setModifiedSettings((prev) => new Set(prev).add(regName))
  }

  const renderBinaryEditor = (regName: string, registerData: RegisterData) => {
    const binaryString = formatBinary(registerData.value_dec)
    
    return (
      <div className="space-y-2">
        <div className="grid grid-cols-8 gap-1 text-xs font-mono">
          {/* Bit position labels */}
          {Array.from({ length: 32 }, (_, i) => 31 - i).map((bitPos) => (
            <div key={bitPos} className="text-center text-muted-foreground">
              {bitPos}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-8 gap-1">
          {/* Clickable bits */}
          {Array.from({ length: 32 }, (_, i) => {
            const bitIndex = 31 - i
            const bitValue = binaryString[i]
            return (
              <Button
                key={bitIndex}
                variant={bitValue === '1' ? 'default' : 'outline'}
                size="sm"
                className="h-8 w-full text-xs font-mono p-0"
                onClick={() => handleBitToggle(regName, bitIndex)}
              >
                {bitValue}
              </Button>
            )
          })}
        </div>
        <div className="grid grid-cols-4 gap-1 text-xs font-mono text-muted-foreground">
          {/* Nibble grouping for easier reading */}
          {Array.from({ length: 8 }, (_, i) => {
            const start = i * 4
            const nibble = binaryString.slice(start, start + 4)
            return (
              <div key={i} className="text-center">
                {nibble}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  const handleSave = async (regName: string) => {
    try {
      await setSetting(boardData.id, regName, settings[regName].value_dec.toString())
      setModifiedSettings((prev) => {
        const newSet = new Set(prev)
        newSet.delete(regName)
        return newSet
      })
      toast({
        title: "Success",
        description: `Setting "${settings[regName].name}" updated successfully`,
      })
    } catch (error) {
      toast({
        title: "Error",
        description: `Failed to update setting "${settings[regName].name}"`,
        variant: "destructive",
      })
    }
  }

  const handleSaveAll = async () => {
    const promises = Array.from(modifiedSettings).map((regName) => setSetting(boardData.id, regName, settings[regName].value_dec.toString()))
    try {
      await Promise.all(promises)
      setModifiedSettings(new Set())
      toast({
        title: "Success",
        description: "All modified settings updated successfully",
      })
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to update some settings",
        variant: "destructive",
      })
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center py-8">
        <ReloadIcon className="mr-2 h-4 w-4 animate-spin" />
        Loading settings...
      </div>
    )
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }

  // Group settings by channel and common settings, filtering out inaccessible registers
  const channelSettings: { [channel: number]: { [regName: string]: RegisterData } } = {}
  const commonSettings: { [regName: string]: RegisterData } = {}

  Object.entries(settings).forEach(([regName, registerData]: [string, RegisterData]) => {
    // Skip registers with all 'F' values (inaccessible)
    if (!isRegisterAccessible(registerData.value_hex)) {
      return
    }

    const address = Number.parseInt(registerData.address, 16)

    if (address > 0x7000) {
      commonSettings[regName] = registerData
    } else {
      const channel = registerData.channel
      if (!channelSettings[channel]) {
        channelSettings[channel] = {}
      }
      channelSettings[channel][regName] = registerData
    }
  })

  const channels = Object.keys(channelSettings)
    .map(Number)
    .sort((a, b) => a - b)

  // Filter settings based on advanced mode
  const filterSettings = (settingsObj: { [regName: string]: RegisterData }, isChannelSettings: boolean) => {
    if (advancedMode) {
      return settingsObj
    }

    const basicList = isChannelSettings ? BASIC_CHANNEL_SETTINGS : BASIC_GENERAL_SETTINGS
    const filtered: { [regName: string]: RegisterData } = {}

    Object.entries(settingsObj).forEach(([regName, registerData]: [string, RegisterData]) => {
      if (basicList.some(basicName => registerData.name.includes(basicName))) {
        filtered[regName] = registerData
      }
    })

    return filtered
  }

  return (
    <div className="space-y-6">
      {/* Control Panel */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">
          Settings for {boardData.name}
        </h3>
        <div className="flex items-center space-x-4">
          <div className="flex items-center space-x-2">
            <Label htmlFor="advanced-mode">Advanced Mode</Label>
            <Switch
              id="advanced-mode"
              checked={advancedMode}
              onCheckedChange={setAdvancedMode}
            />
          </div>
          <div className="flex items-center space-x-2">
            <Label htmlFor="binary-mode">Binary Mode</Label>
            <Switch
              id="binary-mode"
              checked={binaryMode}
              onCheckedChange={setBinaryMode}
            />
          </div>
        </div>
      </div>

      {/* Tabs for General and Channel Settings */}
      <Tabs defaultValue="general" className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="general">General Settings</TabsTrigger>
          <TabsTrigger value="channels">Channel Settings</TabsTrigger>
        </TabsList>

        {/* General Settings Tab */}
        <TabsContent value="general" className="space-y-4">
          {Object.keys(commonSettings).length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>
                  General Settings
                  {!advancedMode && <span className="text-sm text-muted-foreground ml-2">(Basic Mode)</span>}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {Object.entries(filterSettings(commonSettings, false)).map(([regName, registerData]) => (
                    <div key={regName} className="space-y-2">
                      <Label htmlFor={regName}>
                        {registerData.name}
                        {modifiedSettings.has(regName) && <span className="text-orange-500 ml-1">*</span>}
                      </Label>
                      {binaryMode ? (
                        <div className="space-y-2">
                          {renderBinaryEditor(regName, registerData)}
                          <div className="flex justify-end">
                            <Button size="sm" onClick={() => handleSave(regName)} disabled={!modifiedSettings.has(regName)}>
                              Save
                            </Button>
                          </div>
                          <div className="text-xs text-muted-foreground">
                            <div>Dec: {registerData.value_dec} | Hex: {registerData.value_hex} | Address: {registerData.address}</div>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="flex gap-2">
                            <Input
                              id={regName}
                              type="number"
                              min="0"
                              max="4294967295"
                              value={registerData.value_dec}
                              onChange={(e) => handleSettingChange(regName, e.target.value)}
                              className={modifiedSettings.has(regName) ? "border-orange-500" : ""}
                            />
                            <Button size="sm" onClick={() => handleSave(regName)} disabled={!modifiedSettings.has(regName)}>
                              Save
                            </Button>
                          </div>
                          <div className="text-xs text-muted-foreground space-y-1">
                            <div>Hex: {registerData.value_hex} | Address: {registerData.address}</div>
                            <div className="font-mono break-all">Bin: {formatBinary(registerData.value_dec)}</div>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : (
            <div className="text-center text-muted-foreground py-8">
              No general settings available for this board.
            </div>
          )}
        </TabsContent>

        {/* Channel Settings Tab */}
        <TabsContent value="channels" className="space-y-4">
          {channels.length > 0 ? (
            <>
              {/* Channel Selection */}
              <div className="flex items-center space-x-4">
                <Label htmlFor="channel-select">Select Channel:</Label>
                <Select value={selectedChannel} onValueChange={setSelectedChannel}>
                  <SelectTrigger className="w-48">
                    <SelectValue placeholder="Select channel..." />
                  </SelectTrigger>
                  <SelectContent>
                    {channels.map((channel) => (
                      <SelectItem key={channel} value={channel.toString()}>
                        Channel {channel}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Selected Channel Settings */}
              {selectedChannel && channelSettings[parseInt(selectedChannel)] && (
                <Card>
                  <CardHeader>
                    <CardTitle>
                      Channel {selectedChannel} Settings
                      {!advancedMode && <span className="text-sm text-muted-foreground ml-2">(Basic Mode)</span>}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {Object.entries(filterSettings(channelSettings[parseInt(selectedChannel)], true)).map(([regName, registerData]) => (
                        <div key={regName} className="space-y-2">
                          <Label htmlFor={`${selectedChannel}-${regName}`}>
                            {registerData.name}
                            {modifiedSettings.has(regName) && <span className="text-orange-500 ml-1">*</span>}
                          </Label>
                          {binaryMode ? (
                            <div className="space-y-2">
                              {renderBinaryEditor(regName, registerData)}
                              <div className="flex justify-end">
                                <Button size="sm" onClick={() => handleSave(regName)} disabled={!modifiedSettings.has(regName)}>
                                  Save
                                </Button>
                              </div>
                              <div className="text-xs text-muted-foreground">
                                <div>Dec: {registerData.value_dec} | Hex: {registerData.value_hex} | Address: {registerData.address}</div>
                              </div>
                            </div>
                          ) : (
                            <>
                              <div className="flex gap-2">
                                <Input
                                  id={`${selectedChannel}-${regName}`}
                                  type="number"
                                  min="0"
                                  max="4294967295"
                                  value={registerData.value_dec}
                                  onChange={(e) => handleSettingChange(regName, e.target.value)}
                                  className={modifiedSettings.has(regName) ? "border-orange-500" : ""}
                                />
                                <Button size="sm" onClick={() => handleSave(regName)} disabled={!modifiedSettings.has(regName)}>
                                  Save
                                </Button>
                              </div>
                              <div className="text-xs text-muted-foreground space-y-1">
                                <div>Hex: {registerData.value_hex} | Address: {registerData.address}</div>
                                <div className="font-mono break-all">Bin: {formatBinary(registerData.value_dec)}</div>
                              </div>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </>
          ) : (
            <div className="text-center text-muted-foreground py-8">
              No channel settings available for this board.
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Save All Button */}
      {modifiedSettings.size > 0 && (
        <div className="flex justify-center">
          <Button onClick={handleSaveAll} className="bg-green-600 hover:bg-green-700">
            Save All Modified Settings ({modifiedSettings.size})
          </Button>
        </div>
      )}
    </div>
  )
}
