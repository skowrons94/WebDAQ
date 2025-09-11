"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { ReloadIcon } from "@radix-ui/react-icons"
import { useToast } from "@/components/ui/use-toast"
import { getBoardConfiguration, getBoardSettings, setSetting, updateJSON } from "@/lib/api"

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

  return (
    <div className="container mx-auto p-4">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Boards Configuration</h1>
        <Button onClick={fetchBoardConfiguration}>Refresh Boards Data</Button>
      </div>
      <div className="space-y-6">
        {boards.map((board) => (
          <div key={board.id} className="border rounded-lg p-4">
            <h2 className="text-xl font-bold mb-4">
              {board.name} (ID: {board.id})
            </h2>
            <BoardComponent boardData={board} />
          </div>
        ))}
      </div>
    </div>
  )
}

function BoardComponent({ boardData }: { boardData: BoardData }) {
  const [settings, setSettings] = useState<BoardSettings>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [modifiedSettings, setModifiedSettings] = useState<Set<string>>(new Set())
  const { toast } = useToast()

  useEffect(() => {
    const fetchSettings = async () => {
      setLoading(true)
      setError(null)
      try {
        const response = await getBoardSettings(boardData.id)
        setSettings(response)
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
    return '0b' + value.toString(2).padStart(32, '0')
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

  // Group settings by channel and common settings
  const channelSettings: { [channel: number]: { [regName: string]: RegisterData } } = {}
  const commonSettings: { [regName: string]: RegisterData } = {}

  Object.entries(settings).forEach(([regName, registerData]) => {
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

  return (
    <div className="space-y-6">
      {/* Common Settings */}
      {Object.keys(commonSettings).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Common Settings</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {Object.entries(commonSettings).map(([regName, registerData]) => (
                <div key={regName} className="space-y-2">
                  <Label htmlFor={regName}>
                    {registerData.name}
                    {modifiedSettings.has(regName) && <span className="text-orange-500 ml-1">*</span>}
                  </Label>
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
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Channel Settings */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {channels.map((channel) => (
          <Card key={channel}>
            <CardHeader>
              <CardTitle>Channel {channel}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {Object.entries(channelSettings[channel]).map(([regName, registerData]) => (
                  <div key={regName} className="space-y-2">
                    <Label htmlFor={`${channel}-${regName}`}>
                      {registerData.name}
                      {modifiedSettings.has(regName) && <span className="text-orange-500 ml-1">*</span>}
                    </Label>
                    <div className="flex gap-2">
                      <Input
                        id={`${channel}-${regName}`}
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
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

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
