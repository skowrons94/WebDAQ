"use client"

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { ReloadIcon } from "@radix-ui/react-icons"
import { useToast } from "@/components/ui/use-toast"
import { getBoardConfiguration, getSetting, setSetting } from '@/lib/api'

interface BoardData {
  id: string
  name: string
  vme: string
  link_type: string
  link_num: string
  dpp: string
  chan: string
}

interface Setting {
  address: string
  name: string
  value: string
}

interface ChannelSettings {
  [key: string]: Setting
}

export default function Dashboard() {
  const [boards, setBoards] = useState<BoardData[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { toast } = useToast()

  const fetchBoardConfiguration = async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await getBoardConfiguration()
      setBoards(response.data)
    } catch (err) {
      setError('Failed to load boards data')
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
      <h1 className="text-3xl font-bold mb-6">Boards Dashboard</h1>
      <Button onClick={fetchBoardConfiguration} className="mb-4">Refresh Boards Data</Button>
      <Tabs defaultValue={boards[0]?.id}>
        <TabsList>
          {boards.map((board) => (
            <TabsTrigger key={board.id} value={board.id}>
              Board {board.id}
            </TabsTrigger>
          ))}
        </TabsList>
        {boards.map((board) => (
          <TabsContent key={board.id} value={board.id}>
            <BoardComponent boardData={board} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}

function BoardComponent({ boardData }: { boardData: BoardData }) {
  const [settings, setSettings] = useState<ChannelSettings[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { toast } = useToast()

  const settingsToFetch = [
    { name: "Trigger Threshold", address: "0x106c" },
    { name: "Trapezoid Rise Time", address: "0x105c" },
    { name: "Trapezoid Flat Top", address: "0x1060" },
    { name: "DC Offset", address: "0x1098" },
    { name: "Input Rise Time", address: "0x1058" }
  ]

  useEffect(() => {
    const fetchSettings = async () => {
      setLoading(true)
      setError(null)
      //const response = await getSetting(boardData.id, settingsToFetch[0].address)
      //console.log(response)
      try {
        const channelSettings: ChannelSettings[] = []
        for (let i = 0; i < parseInt(boardData.chan); i++) {
          const channelOffset = i * 0x100
          const channelSettingsObj: ChannelSettings = {}
          for (const setting of settingsToFetch) {
            const address = (parseInt(setting.address, 16) + channelOffset).toString(16)
            const response = await getSetting(boardData.id, address)
            channelSettingsObj[setting.name] = {
              address,
              name: setting.name,
              value: response
            }
          }
          channelSettings.push(channelSettingsObj)
        }
        setSettings(channelSettings)
      } catch (err) {
        setError('Failed to load settings data')
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
  }, [boardData])

  const handleSettingChange = (channel: number, settingName: string, value: string) => {
    setSettings(prev => {
      const newSettings = [...prev]
      newSettings[channel] = { 
        ...newSettings[channel], 
        [settingName]: { ...newSettings[channel][settingName], value } 
      }
      return newSettings
    })
  }

  const handleSave = async (channel: number) => {
    for (const [key, setting] of Object.entries(settings[channel])) {
      try {
        await setSetting(boardData.id, setting.address, setting.value)
        toast({
          title: "Success",
          description: `Updated ${key} for channel ${channel}`,
        })
      } catch (error) {
        toast({
          title: "Error",
          description: `Failed to update ${key} for channel ${channel}`,
          variant: "destructive",
        })
      }
    }
  }

  const handleApplyToAll = (settingName: string) => {
    const valueToApply = settings[0][settingName].value
    console.log(valueToApply, settingName)
    setSettings(prev => prev.map(channelSettings => ({
      ...channelSettings,
      [settingName]: { ...channelSettings[settingName], value: valueToApply }
    })))
  }

  if (loading) {
    return <div>Loading settings...</div>
  }

  if (error) {
    return <div>Error: {error}</div>
  }

  return (
    <div>
      <h2 className="text-2xl font-bold mb-4">{boardData.name} - Board {boardData.id}</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {settings.map((channelSettings, channel) => (
          <Card key={channel}>
            <CardHeader>
              <CardTitle>Channel {channel}</CardTitle>
            </CardHeader>
            <CardContent>
              {Object.entries(channelSettings).map(([key, setting]) => (
                <div key={key} className="mb-4">
                  <Label htmlFor={`${channel}-${key}`}>{setting.name}</Label>
                  <Input
                    id={`${channel}-${key}`}
                    value={setting.value}
                    onChange={(e) => handleSettingChange(channel, key, e.target.value)}
                  />
                </div>
              ))}
              <div className="flex justify-between mt-4">
                <Button onClick={() => handleSave(channel)}>Save</Button>
                <Button variant="outline" onClick={() => handleApplyToAll('Trigger Threshold')}>
                  Apply Threshold to All
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}