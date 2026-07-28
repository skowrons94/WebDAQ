"use client"

import { useState, useEffect, useMemo } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts"
import { getArrayDataCurrent } from '@/lib/api'
import useRunControlStore from '@/store/run-control-store'
import {
  currentUnit, maxMagnitude, formatTick, formatValue,
  CHART_MARGIN, yAxisLabel, xAxisLabel,
} from '@/lib/chart-format'

/** One plotted sample: wall-clock label plus the reading in µA. */
interface CurrentPoint {
  time: string
  value: number
}

// Converts raw data to chart format based on run state
const convertToChartData = (data: number[], startTime: Date | null): CurrentPoint[] => {
  const now = new Date()

  return data.map((value, index) => {
    // If running (with startTime), calculate time since start
    // Otherwise, calculate time from now going back
    const timePoint = startTime
      ? new Date(startTime.valueOf() + index * 1000)
      : new Date(now.valueOf() - (data.length - index) * 1000)

    return {
      time: timePoint.toISOString().substr(11, 8),
      value: value
    }
  })
}

export default function CurrentGraph() {
  const [data, setData] = useState<CurrentPoint[]>([])
  const [startTime, setStartTime] = useState<Date | null>(null)
  const isRunning = useRunControlStore((state) => state.isRunning)

  // Effect to set/clear start time when run state changes
  useEffect(() => {
    if (isRunning) {
      setStartTime(new Date())
    } else {
      setStartTime(null)
    }
  }, [isRunning])

  useEffect(() => {
    const fetchData = async () => {
      try {
        let newData = await getArrayDataCurrent()

        // If not running, only show last 2 minutes (120 seconds) of data
        if (!isRunning && newData.length > 120) {
          newData = newData.slice(-120)
        }

        const chartData = convertToChartData(newData, startTime)
        setData(chartData)
      } catch (error) {
        console.error("Error fetching current data:", error)
      }
    }

    fetchData() // Fetch initial data

    const intervalId = setInterval(fetchData, 1000) // Update every second

    return () => clearInterval(intervalId) // Clean up on unmount
  }, [isRunning, startTime]) // Add isRunning to the dependency array

  // Get theme colors from CSS variables for dark mode compatibility
  const getThemeColors = () => {
    const isDarkMode = document.documentElement.classList.contains('dark')
    return {
      text: isDarkMode ? 'hsl(var(--foreground))' : 'hsl(var(--foreground))',
      background: isDarkMode ? 'hsl(var(--card))' : 'hsl(var(--card))',
      gridLines: isDarkMode ? 'hsl(var(--border))' : 'hsl(var(--border))',
      lineColor: 'hsl(var(--primary))',
      tooltipBg: isDarkMode ? 'hsl(var(--popover))' : 'hsl(var(--popover))',
      tooltipBorder: isDarkMode ? 'hsl(var(--border))' : 'hsl(var(--border))'
    }
  }

  // Get initial colors
  const [themeColors, setThemeColors] = useState(getThemeColors())

  // Update colors when theme changes
  useEffect(() => {
    const updateColors = () => setThemeColors(getThemeColors())

    // Update on theme change
    const observer = new MutationObserver(mutations => {
      mutations.forEach(mutation => {
        if (mutation.attributeName === 'class') {
          updateColors()
        }
      })
    })

    observer.observe(document.documentElement, { attributes: true })

    return () => observer.disconnect()
  }, [])

  // The log is in µA, but the beam may be nanoamps or milliamps. Pick the unit
  // from the data so the axis shows short numbers instead of "0.0004" or
  // "12000" — long tick labels are what makes them collide.
  const { scale, unit } = useMemo(
    () => currentUnit(maxMagnitude(data.map(d => d.value))),
    [data],
  )
  const scaled = useMemo(
    () => data.map(d => ({ ...d, value: d.value * scale })),
    [data, scale],
  )

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-baseline gap-2">
          Current on Target
          <span className="text-sm font-normal text-muted-foreground">({unit})</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={scaled} margin={CHART_MARGIN}>
              <CartesianGrid strokeDasharray="3 3" stroke={themeColors.gridLines} />
              <XAxis
                dataKey="time"
                stroke={themeColors.text}
                tick={{ fill: themeColors.text, fontSize: 11 }}
                // Timestamps are wide; thin them out rather than letting recharts
                // stack every label along the axis.
                minTickGap={48}
                interval="preserveStartEnd"
                label={xAxisLabel("Time")}
              />
              <YAxis
                stroke={themeColors.text}
                tick={{ fill: themeColors.text, fontSize: 11 }}
                tickFormatter={formatTick}
                // Reserve a fixed gutter so the rotated title never lands on the
                // tick labels, however wide those get.
                width={64}
                label={yAxisLabel(`Current (${unit})`)}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: themeColors.tooltipBg,
                  border: `1px solid ${themeColors.tooltipBorder}`,
                  fontSize: 12,
                }}
                labelStyle={{ color: themeColors.text }}
                itemStyle={{ color: themeColors.text }}
                formatter={(v: number) => [formatValue(v, unit), "Current"]}
              />
              <Line
                type="monotone"
                dataKey="value"
                name="Current"
                stroke={themeColors.lineColor}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )
}