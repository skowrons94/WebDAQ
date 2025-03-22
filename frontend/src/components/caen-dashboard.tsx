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
import { getBoardConfiguration, 
         getSetting, 
         setSetting,
         getPolarity,
         setPolarity,
         updateJSON
        } from '@/lib/api'
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel"


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
    updateJSON()
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
      <div className="flex justify-between items-center mb-6">
      <h1 className="text-2xl font-bold">Boards Configuration</h1>
      <Button onClick={fetchBoardConfiguration}>Refresh Boards Data</Button>
      </div>
      <ul>
      {boards.map((board) => (
        <li key={board.id} className="mb-4">
        <h2 className="text-xl font-bold">{board.name} (ID: {board.id})</h2>
        <BoardComponent boardData={board} />
        </li>
      ))}
      </ul>
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
    { name: "RC-CR2 Smoothing Factor", address: "0x1054" },
    { name: "Input Rise Time", address: "0x1058" },
    { name: "DC Offset", address: "0x1098" },
    { name: "Trapezoid Rise Time", address: "0x105c" },
    { name: "Trapezoid Flat Top", address: "0x1060" },
    { name: "Trapezoid Decay Time", address: "0x1068" }
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
          // Fetch polarity
          const polarity = await getPolarity(boardData.id, i.toString())
          channelSettingsObj["Polarity"] = {
            address: "0x1080",
            name: "Polarity",
            value: polarity
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
      // IF polarity, set polarity
      if (key === "Polarity") {
        try {
          await setPolarity(boardData.id, channel.toString(), setting.value)
          toast({
            title: "Success",
            description: `Settings updated`,
          })
        } catch (error) {
          toast({
            title: "Error",
            description: `Failed to update settings`,
            variant: "destructive",
          })
        }
      }
      else {
        try {
          await setSetting(boardData.id, setting.address, setting.value)
          toast({
            title: "Success",
            description: `Settings updated`,
          })
        } catch (error) {
          toast({
            title: "Error",
            description: `Failed to update settings`,
            variant: "destructive",
          })
        }
      }
    }
  }

  if (loading) {
    return <div>Loading settings...</div>
  }

  if (error) {
    return <div>Error: {error}</div>
  }

  return (

      <div className="max-w-[800px] p-8 mx-auto">
        <Carousel>
          <CarouselContent>
            {settings.map((channelSettings, channel) => (
              <CarouselItem key={channel} >
                <Card>
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
                    <div className="flex flex-wrap justify-between mt-4">
                      <Button className="mb-2" onClick={() => handleSave(channel)}>Save</Button>
                    </div>
                  </CardContent>
                </Card>
              </CarouselItem>
            ))}
          </CarouselContent>
          <CarouselPrevious />
          <CarouselNext />
        </Carousel>
      </div>
  )
}