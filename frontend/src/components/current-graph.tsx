"use client"

import { useState, useEffect, useMemo, useRef, type ReactNode } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts"
import { getCurrentHistory } from '@/lib/api'
import useRunControlStore from '@/store/run-control-store'
import { cn } from '@/lib/utils'
import {
  currentUnit, maxMagnitude, formatTick, formatValue,
  CHART_MARGIN, yAxisLabel, xAxisLabel,
} from '@/lib/chart-format'

/** One plotted sample: wall-clock label plus the reading in µA. */
interface CurrentPoint {
  timestamp: number
  value: number
}

const STOPPED_WINDOWS = [
  { seconds: 30, label: "30s" },
  { seconds: 60, label: "1m" },
  { seconds: 120, label: "2m" },
  { seconds: 300, label: "5m" },
] as const
const MAX_CHART_POINTS = 20000

const clockLabel = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })

const downsample = (points: CurrentPoint[]): CurrentPoint[] => {
  if (points.length <= MAX_CHART_POINTS) return points
  const lastIndex = points.length - 1
  return Array.from({ length: MAX_CHART_POINTS }, (_, index) =>
    points[Math.round((index * lastIndex) / (MAX_CHART_POINTS - 1))])
}

const mergeSamples = (
  previous: CurrentPoint[],
  samples: [number, number][],
): CurrentPoint[] => {
  const byTimestamp = new Map(previous.map(point => [point.timestamp, point]))
  samples.forEach(([timestampSeconds, value]) => {
    const timestamp = timestampSeconds * 1000
    byTimestamp.set(timestamp, { timestamp, value })
  })
  return downsample(
    Array.from(byTimestamp.values()).sort((a, b) => a.timestamp - b.timestamp),
  )
}

interface CurrentGraphProps {
  title?: string
  description?: string | null
  summary?: ReactNode
  headerActions?: ReactNode
  compact?: boolean
  className?: string
  fillHeight?: boolean
}

export default function CurrentGraph({
  title = "Current on Target",
  description,
  summary,
  headerActions,
  compact = false,
  className,
  fillHeight = false,
}: CurrentGraphProps = {}) {
  const [data, setData] = useState<CurrentPoint[]>([])
  const [stoppedWindow, setStoppedWindow] = useState(30)
  const latestRunSampleRef = useRef<number | null>(null)
  const isRunning = useRunControlStore((state) => state.isRunning)
  const startTime = useRunControlStore((state) => state.startTime)

  useEffect(() => {
    let cancelled = false
    latestRunSampleRef.current = null
    setData([])

    const fetchData = async () => {
      try {
        if (isRunning) {
          if (!startTime) return
          const runStartSeconds = new Date(startTime).getTime() / 1000
          const history = await getCurrentHistory({
            // On first load this reconstructs the run from the controller's
            // timestamped buffer. Later polls ask only for new samples.
            since: latestRunSampleRef.current ?? runStartSeconds,
            maxPoints: MAX_CHART_POINTS,
          })
          if (cancelled) return
          setData(previous => mergeSamples(previous, history.samples))
          const newest = history.samples.at(-1)?.[0]
          if (newest !== undefined) {
            latestRunSampleRef.current = newest + 1e-6
          }
        } else {
          const history = await getCurrentHistory({
            seconds: stoppedWindow,
            maxPoints: MAX_CHART_POINTS,
          })
          if (cancelled) return
          setData(history.samples.map(([timestamp, value]) => ({
            timestamp: timestamp * 1000,
            value,
          })))
        }
      } catch (error) {
        console.error("Error fetching current data:", error)
      }
    }

    fetchData() // Fetch initial data

    const intervalId = setInterval(fetchData, 1000) // Update every second

    return () => {
      cancelled = true
      clearInterval(intervalId)
    }
  }, [isRunning, startTime, stoppedWindow])

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

  const historyControl = isRunning ? (
    <Badge variant="outline" className="w-fit gap-1.5">
      <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
      Since run start
    </Badge>
  ) : (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Past</span>
      <ToggleGroup
        type="single"
        value={String(stoppedWindow)}
        onValueChange={(value) => value && setStoppedWindow(Number(value))}
        variant="outline"
        size="sm"
        aria-label="Current history time range"
      >
        {STOPPED_WINDOWS.map(option => (
          <ToggleGroupItem
            key={option.seconds}
            value={String(option.seconds)}
            aria-label={`Show the past ${option.label}`}
            className="h-7 px-2 text-xs"
          >
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )

  return (
    <Card className={cn(fillHeight && 'flex min-h-0 flex-col overflow-hidden', className)}>
      <CardHeader className="space-y-4 pb-2">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-baseline gap-2">
              {title}
              {!summary && (
                <span className="text-sm font-normal text-muted-foreground">({unit})</span>
              )}
            </CardTitle>
            {description !== null && (
              <p className="mt-1 text-xs text-muted-foreground">
                {description ?? (
                  isRunning ? "Live history from the start of this run" : "Live rolling history"
                )}
              </p>
            )}
          </div>
          {headerActions ?? (!summary ? historyControl : null)}
        </div>
        {summary}
        {summary && (
          <div className="flex flex-col gap-2 border-t pt-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-medium">Current on Target</span>
              <span className="text-xs text-muted-foreground">({unit})</span>
            </div>
            {historyControl}
          </div>
        )}
      </CardHeader>
      <CardContent className={cn(fillHeight && 'flex min-h-0 flex-1 flex-col overflow-hidden')}>
        <div className={fillHeight
          ? "min-h-0 flex-1"
          : compact ? "h-52 sm:h-56" : "h-64"}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={scaled} margin={CHART_MARGIN}>
              <CartesianGrid strokeDasharray="3 3" stroke={themeColors.gridLines} />
              <XAxis
                dataKey="timestamp"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                stroke={themeColors.text}
                tick={{ fill: themeColors.text, fontSize: 11 }}
                tickFormatter={clockLabel}
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
                labelFormatter={(label) => clockLabel(Number(label))}
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
