'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { getBoardConfiguration, getTerminalVoltage, getExtractionVoltage, getColumnCurrent, getBoardRates } from '@/lib/api'

type BoardData = {
  id: string;
  name: string;
  vme: string;
  link_type: string;
  link_num: string;
  dpp: string;
  chan: string;
}

type StatData = {
  name: string;
  value: number | null;
  unit: string;
}

export function Stats() {
  const [boards, setBoards] = useState<BoardData[]>([])
  const [stats, setStats] = useState<StatData[]>([])

  useEffect(() => {
    fetchBoardConfiguration()
    const interval = setInterval(fetchStats, 1000)
    return () => clearInterval(interval)
  }, [])

  const fetchBoardConfiguration = async () => {
    try {
      const response = await getBoardConfiguration()
      console.log(response)
      setBoards(response.data)
      console.log(boards)
    } catch (error) {
      console.error('Failed to fetch board configuration:', error)
    }
  }

  const fetchStats = async () => {
    try {
      const [terminalVoltage, extractionVoltage, columnCurrent, ...boardRates] = await Promise.all([
        getTerminalVoltage(),
        getExtractionVoltage(),
        getColumnCurrent(),
        ...boards.flatMap(board => 
          Array.from({ length: parseInt(board.chan) }, (_, i) => 
            getBoardRates(board.id, board.name, i.toString())
          )
        )
      ])

      const newStats: StatData[] = [
        { name: 'Terminal Voltage', value: terminalVoltage[0]?.[1] ?? null, unit: 'V' },
        { name: 'Extraction Voltage', value: extractionVoltage[0]?.[1] ?? null, unit: 'V' },
        { name: 'Column Current', value: columnCurrent[0]?.[1] ?? null, unit: 'µA' },
        ...boards.flatMap((board, boardIndex) => 
          Array.from({ length: parseInt(board.chan) }, (_, channelIndex) => ({
            name: `${board.name} Ch${channelIndex}`,
            value: boardRates[boardIndex * parseInt(board.chan) + channelIndex][0]?.[1] ?? null,
            unit: 'Hz'
          }))
        )
      ]

      setStats(newStats)
    } catch (error) {
      console.error('Failed to fetch stats:', error)
    }
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
      {stats.map((stat, index) => (
        <Card key={index}>
          <CardHeader>
            <CardTitle className="text-sm font-medium">{stat.name}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stat.value !== null ? `${stat.value.toFixed(2)} ${stat.unit}` : 'N/A'}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}