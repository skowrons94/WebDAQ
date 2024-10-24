"use client"

import { useState, useEffect } from 'react'
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useToast } from "@/components/ui/use-toast"
import { getBoardConfiguration, getCalib, setCalib } from '@/lib/api'

type BoardData = {
  id: string
  name: string
  chan: string
}

type CalibrationData = {
  a: string
  b: string
}

export default function CalibrationDashboard() {
  const [boards, setBoards] = useState<BoardData[]>([])
  const [calibrations, setCalibrations] = useState<Record<string, CalibrationData[]>>({})
  const { toast } = useToast()

  useEffect(() => {
    fetchBoardConfiguration()
  }, [])

  async function fetchBoardConfiguration() {
    try {
      const response = await getBoardConfiguration()
      setBoards(response.data)
      fetchCalibrationData(response.data)
    } catch (error) {
      console.error('Failed to fetch board configuration:', error)
      toast({
        title: "Error",
        description: "Failed to fetch board configuration. Please try again.",
        variant: "destructive",
      })
    }
  }

  async function fetchCalibrationData(boards: BoardData[]) {
    const calibData: Record<string, CalibrationData[]> = {}
    for (const board of boards) {
      calibData[board.id] = []
      for (let i = 0; i < parseInt(board.chan); i++) {
        try {
          const response = await getCalib(board.name, board.id, i.toString())
          if (response.data.status === 'success') {
            calibData[board.id][i] = { a: response.data.a, b: response.data.b }
          } else {
            calibData[board.id][i] = { a: '0', b: '0' } // Default values if not found
          }
        } catch (error) {
          console.error(`Failed to fetch calibration for board ${board.id} channel ${i}:`, error)
          calibData[board.id][i] = { a: '0', b: '0' } // Default values on error
        }
      }
    }
    setCalibrations(calibData)
  }

  async function handleCalibrationUpdate(boardId: string, boardName: string, channel: string, a: string, b: string) {
    try {
      await setCalib(boardName, boardId, channel, a, b)
      toast({
        title: "Success",
        description: `Updated calibration for board ${boardId} channel ${channel}`,
      })
      // Update local state
      setCalibrations(prev => ({
        ...prev,
        [boardId]: prev[boardId].map((calib, idx) => 
          idx.toString() === channel ? { a, b } : calib
        )
      }))
    } catch (error) {
      console.error('Failed to update calibration:', error)
      toast({
        title: "Error",
        description: "Failed to update calibration. Please try again.",
        variant: "destructive",
      })
    }
  }

  return (
    <div className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">Calibration Dashboard</h1>
      {boards.map((board) => (
        <Card key={board.id} className="mb-4">
          <CardHeader>
            <CardTitle>{board.name} (ID: {board.id})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {Array.from({ length: parseInt(board.chan) }, (_, i) => i).map((channel) => (
                <div key={channel} className="space-y-2">
                  <h3 className="font-semibold">Channel {channel}</h3>
                  <div className="flex space-x-2">
                    <div>
                      <Label htmlFor={`a-${board.id}-${channel}`}>A</Label>
                      <Input
                        id={`a-${board.id}-${channel}`}
                        value={calibrations[board.id]?.[channel]?.a || ''}
                        onChange={(e) => {
                          const newValue = e.target.value
                          setCalibrations(prev => ({
                            ...prev,
                            [board.id]: prev[board.id].map((calib, idx) => 
                              idx === channel ? { ...calib, a: newValue } : calib
                            )
                          }))
                        }}
                      />
                    </div>
                    <div>
                      <Label htmlFor={`b-${board.id}-${channel}`}>B</Label>
                      <Input
                        id={`b-${board.id}-${channel}`}
                        value={calibrations[board.id]?.[channel]?.b || ''}
                        onChange={(e) => {
                          const newValue = e.target.value
                          setCalibrations(prev => ({
                            ...prev,
                            [board.id]: prev[board.id].map((calib, idx) => 
                              idx === channel ? { ...calib, b: newValue } : calib
                            )
                          }))
                        }}
                      />
                    </div>
                  </div>
                  <Button 
                    onClick={() => handleCalibrationUpdate(
                      board.id, 
                      board.name, 
                      channel.toString(), 
                      calibrations[board.id][channel].a, 
                      calibrations[board.id][channel].b
                    )}
                  >
                    Update
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}