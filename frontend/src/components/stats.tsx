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
  getBoardRates,
  getStatsGraphiteConfig,
  setStatsGraphiteConfig
} from '@/lib/api'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useToast } from '@/components/ui/use-toast'

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
  const { toast } = useToast()
  const [boards, setBoards] = useState<BoardData[]>([])
  const [stats, setStats] = useState<StatData[]>([])
  const [graphiteHost, setGraphiteHost] = useState('localhost')
  const [graphitePort, setGraphitePort] = useState('80')
  const [showConfig, setShowConfig] = useState(false)

  const loadGraphiteConfig = async () => {
    try {
      console.log('Loading graphite config for stats...')
      const config = await getStatsGraphiteConfig()
      console.log('Graphite config loaded:', config)
      setGraphiteHost(config.graphite_host || 'localhost')
      setGraphitePort(String(config.graphite_port || 80))
    } catch (error) {
      console.error('Failed to load graphite config:', error)
    }
  }

  const handleSaveGraphiteConfig = async () => {
    try {
      await setStatsGraphiteConfig(graphiteHost, parseInt(graphitePort))
      toast({
        title: 'Success',
        description: 'Graphite server configuration updated'
      })
      await loadGraphiteConfig()
    } catch (error: any) {
      console.error('Error saving Graphite config:', error)
      toast({
        title: 'Error',
        description: error.response?.data?.error || 'Failed to save Graphite configuration',
        variant: 'destructive'
      })
    }
  }

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
    loadGraphiteConfig()
  }, [fetchBoardConfiguration])

  useEffect(() => {
    if (boards.length > 0) {
      fetchStats()
      const interval = setInterval(fetchStats, 10000)
      return () => clearInterval(interval)
    }
  }, [boards, fetchStats])

  return (
    <div className="space-y-4 p-2">
      {/* Graphite Server Configuration */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
          <div>
            <CardTitle className="text-sm font-medium">Graphite Server Configuration</CardTitle>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowConfig(!showConfig)}
          >
            {showConfig ? 'Hide' : 'Show'} Configuration
          </Button>
        </CardHeader>
        {showConfig && (
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="stats-graphite-host">Graphite Host</Label>
                <Input
                  id="stats-graphite-host"
                  value={graphiteHost}
                  onChange={(e) => setGraphiteHost(e.target.value)}
                  placeholder="localhost"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="stats-graphite-port">Graphite Port</Label>
                <Input
                  id="stats-graphite-port"
                  value={graphitePort}
                  onChange={(e) => setGraphitePort(e.target.value)}
                  placeholder="80"
                />
              </div>
            </div>
            <Button onClick={handleSaveGraphiteConfig} className="w-full">
              Save Graphite Configuration
            </Button>
          </CardContent>
        )}
      </Card>

      {/* Stats Grid */}
      <div className="grid md:grid-cols-2 lg:grid-cols-2 xl:grid-cols-5 gap-4">
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
    </div>
  )
}

const getChartConfig = (stat: StatData): ChartConfig => ({
  value: {
    label: `${stat.name} (${stat.unit})`,
    color: "hsl(var(--chart-5))"
  }
})
