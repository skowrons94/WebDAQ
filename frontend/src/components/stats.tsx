'use client'

import { useState, useEffect, useCallback } from 'react'
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts"

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle
} from "@/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartConfig
} from "@/components/ui/chart"

import {
  getBoardConfiguration,
  getTerminalVoltage,
  getExtractionVoltage,
  getColumnCurrent,
  getBoardRates
} from '@/lib/api'

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
  data: { time: string, value: number }[];
  unit: string;
}

export function Stats() {
  const [boards, setBoards] = useState<BoardData[]>([])
  const [stats, setStats] = useState<StatData[]>([])

  const fetchBoardConfiguration = useCallback(async () => {
    try {
      const response = await getBoardConfiguration()
      setBoards(response.data)
    } catch (error) {
      console.error('Failed to fetch board configuration:', error)
    }
  }, [])

  const fetchStats = useCallback(async () => {
    if (boards.length === 0) {
      return
    }

    try {
      const from = '-90000s'
      const until = 'now'

      const [
        terminalVoltageResult,
        extractionVoltageResult,
        columnCurrentResult,
        ...boardRatesResults
      ] = await Promise.allSettled([
        getTerminalVoltage(from, until),
        getExtractionVoltage(from, until),
        getColumnCurrent(from, until),
        ...boards.flatMap(board =>
          Array.from({ length: parseInt(board.chan) }, (_, i) =>
            getBoardRates(board.id, board.name, i.toString(), from, until)
          )
        )
      ])

      const newStats: StatData[] = []

      if (terminalVoltageResult.status === 'fulfilled') {
        newStats.push({
          name: 'Terminal Voltage',
          data: terminalVoltageResult.value.map((item: any) => ({ time: item[0], value: item[1] })),
          unit: 'V'
        })
      }

      if (extractionVoltageResult.status === 'fulfilled') {
        newStats.push({
          name: 'Extraction Voltage',
          data: extractionVoltageResult.value.map((item: any) => ({ time: item[0], value: item[1] })),
          unit: 'V'
        })
      }

      if (columnCurrentResult.status === 'fulfilled') {
        newStats.push({
          name: 'Column Current',
          data: columnCurrentResult.value.map((item: any) => ({ time: item[0], value: item[1] })),
          unit: 'µA'
        })
      }

      boards.forEach((board, boardIndex) => {
        Array.from({ length: parseInt(board.chan) }, (_, channelIndex) => {
          const rateResult = boardRatesResults[boardIndex * parseInt(board.chan) + channelIndex]
          if (rateResult.status === 'fulfilled') {
            newStats.push({
              name: `${board.name} Channel ${channelIndex}`,
              data: rateResult.value.map((item: any) => ({ time: item[0], value: item[1] })),
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
    <div className="grid md:grid-cols-2 lg:grid-cols-2 xl:grid-cols-5 gap-4 p-2 ">
      {stats.map((stat, index) => (
        <Card key={index}>
          <CardHeader>
            <CardTitle className="text-sm font-medium">{stat.name}</CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer className='min-h-[200px] w-full' config={getChartConfig(stat)}>
              <AreaChart
                accessibilityLayer
                data={stat.data}
                margin={{ left: 12, right: 12 }}
                >
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="time"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  tickFormatter={(value) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                />
                <ChartTooltip
                  cursor={false}
                  content={<ChartTooltipContent indicator="dot" />}
                />
                <Area
                  dataKey="value"
                  type="natural"
                  fill="var(--color-value)"
                  fillOpacity={0.4}
                  stroke="var(--color-value)"
                  isAnimationActive={true}
                  animationDuration={400}
                />
              </AreaChart>
            </ChartContainer>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

const getChartConfig = (stat: StatData): ChartConfig => ({
  value: {
    label: `${stat.name} (${stat.unit})`,
    color: "hsl(var(--chart-5))"
  }
})
