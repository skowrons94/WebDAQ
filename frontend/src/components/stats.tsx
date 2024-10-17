'use client'

import { useState, useEffect, useCallback } from 'react'
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

  const fetchBoardConfiguration = useCallback(async () => {
    try {
      const response = await getBoardConfiguration()
      console.log('Board configuration:', response.data)
      setBoards(response.data)
    } catch (error) {
      console.error('Failed to fetch board configuration:', error)
    }
  }, [])

  const fetchStats = useCallback(async () => {
    if (boards.length === 0) {
      console.log('No boards available, skipping stats fetch')
      return
    }

    try {
      const [terminalVoltageResult, extractionVoltageResult, columnCurrentResult, ...boardRatesResults] = await Promise.allSettled([
        getTerminalVoltage(),
        getExtractionVoltage(),
        getColumnCurrent(),
        ...boards.flatMap(board => 
          Array.from({ length: parseInt(board.chan) }, (_, i) => 
            getBoardRates(board.id, board.name, i.toString())
          )
        )
      ])

      const newStats: StatData[] = []

      if (terminalVoltageResult.status === 'fulfilled') {
        newStats.push({ name: 'Terminal Voltage', value: terminalVoltageResult.value[0]?.[1] ?? null, unit: 'V' })
      } else {
        console.error('Failed to fetch Terminal Voltage:', terminalVoltageResult.reason)
      }

      if (extractionVoltageResult.status === 'fulfilled') {
        newStats.push({ name: 'Extraction Voltage', value: extractionVoltageResult.value[0]?.[1] ?? null, unit: 'V' })
      } else {
        console.error('Failed to fetch Extraction Voltage:', extractionVoltageResult.reason)
      }

      if (columnCurrentResult.status === 'fulfilled') {
        newStats.push({ name: 'Column Current', value: columnCurrentResult.value[0]?.[1] ?? null, unit: 'µA' })
      } else {
        console.error('Failed to fetch Column Current:', columnCurrentResult.reason)
      }

      boards.forEach((board, boardIndex) => {
        Array.from({ length: parseInt(board.chan) }, (_, channelIndex) => {
          const rateResult = boardRatesResults[boardIndex * parseInt(board.chan) + channelIndex]
          if (rateResult.status === 'fulfilled') {
            newStats.push({
              name: `${board.name} Channel ${channelIndex}`,
              value: rateResult.value[0]?.[1] ?? null,
              unit: 'Hz'
            })
          } else {
            console.error(`Failed to fetch rate for ${board.name} Channel ${channelIndex}:`, rateResult.reason)
            newStats.push({
              name: `${board.name} Ch${channelIndex}`,
              value: null,
              unit: 'Hz'
            })
          }
        })
      })

      setStats(newStats)
    } catch (error) {
      console.error('Failed to fetch stats:', error)
    }
  }, [boards])

  useEffect(() => {
    fetchBoardConfiguration()
  }, [fetchBoardConfiguration])

  useEffect(() => {
    if (boards.length > 0) {
      fetchStats()
      const interval = setInterval(fetchStats, 10000)
      return () => clearInterval(interval)
    }
  }, [boards, fetchStats])

  return (
    
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 p-4 md:gap-8 md:p-8">
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