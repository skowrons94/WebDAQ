"use client"

import { useState, useEffect, useMemo, type ReactNode } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts"
import { getCurrentHistory } from '@/lib/api'
import useRunControlStore from '@/store/run-control-store'
import { cn } from '@/lib/utils'
import {
  currentUnit, maxMagnitude, formatTick, formatValue,
  CHART_MARGIN, yAxisLabel, xAxisLabel,
} from '@/lib/chart-format'

/**
 * One plotted point: a time bucket of the beam current, in µA.
 *
 * `value` is the bucket's mean and `low`/`high` its extremes. On a short window
 * a bucket holds one sample and the three are equal; on a three-day run each
 * holds thousands, and the extremes are the only thing keeping a beam trip
 * visible — averaging alone would smooth a two-second trip out of existence.
 */
interface CurrentPoint {
  timestamp: number
  value: number
  low: number
  high: number
}

const STOPPED_WINDOWS = [
  { seconds: 30, label: "30s" },
  { seconds: 60, label: "1m" },
  { seconds: 120, label: "2m" },
  { seconds: 300, label: "5m" },
] as const

/**
 * Points requested from the server, whatever the window's length.
 *
 * The card is at most ~1200 px wide, so beyond roughly this many points every
 * additional one lands on a pixel that is already drawn: it costs payload,
 * parse time and render time and changes nothing on screen. Holding the whole
 * run at full resolution in the browser instead is what made a three-day run
 * unusable — hundreds of thousands of points re-sorted and re-splined once a
 * second.
 */
const TARGET_BINS = 600

/** Poll bounds. See `refreshDelay`. */
const MIN_REFRESH_MS = 1000
const MAX_REFRESH_MS = 15000

/**
 * How long to wait before refetching.
 *
 * A plot cannot change faster than its own resolution: once a bucket spans
 * seven minutes, redrawing every second is 400 wasted requests and renders per
 * bucket. Pacing the poll to the bucket width means the dashboard gets *lighter*
 * as a run gets longer, which is exactly backwards from how it behaved before.
 */
const refreshDelay = (binWidthSeconds: number | null | undefined): number => {
  if (!binWidthSeconds || !Number.isFinite(binWidthSeconds)) return MIN_REFRESH_MS
  return Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, binWidthSeconds * 1000))
}

const clockLabel = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })

/** "7 min", "12 s" — the averaging window, for the operator's benefit. */
const describeResolution = (seconds: number): string => {
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)} h`
  if (seconds >= 60) return `${Math.round(seconds / 60)} min`
  return `${Math.max(1, Math.round(seconds))} s`
}

/**
 * Server rows to plot points. Binned rows are [time, mean, min, max]; raw rows
 * are [time, value], which collapse to a zero-width band.
 */
const toPoints = (samples: number[][]): CurrentPoint[] =>
  samples.map(([timestamp, value, low, high]) => ({
    timestamp: timestamp * 1000,
    value,
    low: low ?? value,
    high: high ?? value,
  }))

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
  const [binWidth, setBinWidth] = useState<number | null>(null)
  const [stoppedWindow, setStoppedWindow] = useState(30)
  const isRunning = useRunControlStore((state) => state.isRunning)
  const startTime = useRunControlStore((state) => state.startTime)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    setData([])
    setBinWidth(null)

    // The whole window is refetched each time rather than accumulated here.
    // The server reduces it to TARGET_BINS points with numpy — cheaper than the
    // browser merging and re-sorting a growing array, and it leaves no state to
    // drift out of step with the run.
    const fetchData = async () => {
      try {
        const history = isRunning
          ? (startTime
            ? await getCurrentHistory({
              since: new Date(startTime).getTime() / 1000,
              bins: TARGET_BINS,
            })
            : null)
          : await getCurrentHistory({ seconds: stoppedWindow, bins: TARGET_BINS })

        if (cancelled || !history) return
        setData(toPoints(history.samples))
        setBinWidth(history.bin_width_s ?? null)
        return history.bin_width_s
      } catch (error) {
        console.error("Error fetching current data:", error)
      }
      return null
    }

    // Chained rather than setInterval: a slow or stalled request must not queue
    // another behind it, which is its own way of wedging the page.
    const poll = async () => {
      const width = await fetchData()
      if (cancelled) return
      timer = setTimeout(poll, refreshDelay(width))
    }
    poll()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
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
    () => currentUnit(maxMagnitude(data.map(d => d.high))),
    [data],
  )
  const scaled = useMemo(
    () => data.map(d => ({
      timestamp: d.timestamp,
      value: d.value * scale,
      // Recharts draws an Area between the two ends of a [low, high] pair.
      range: [d.low * scale, d.high * scale] as [number, number],
    })),
    [data, scale],
  )

  // Only worth drawing where a bucket actually covers a spread of samples.
  const hasBand = useMemo(
    () => data.some(d => d.high > d.low),
    [data],
  )

  const resolutionNote = binWidth && binWidth >= 2
    ? `${describeResolution(binWidth)} average`
    : null

  const historyControl = isRunning ? (
    <div className="flex items-center gap-2">
      <Badge variant="outline" className="w-fit gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
        Since run start
      </Badge>
      {resolutionNote && (
        <span className="text-xs text-muted-foreground">{resolutionNote}</span>
      )}
    </div>
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
            <ComposedChart data={scaled} margin={CHART_MARGIN}>
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
                formatter={(v: number | number[], name: string) => (
                  Array.isArray(v)
                    ? [`${formatValue(v[0], unit)} – ${formatValue(v[1], unit)}`, "Range"]
                    : [formatValue(v, unit), name === "range" ? "Range" : "Current"]
                )}
                isAnimationActive={false}
              />
              {hasBand && (
                <Area
                  dataKey="range"
                  name="Range"
                  stroke="none"
                  fill={themeColors.lineColor}
                  fillOpacity={0.18}
                  isAnimationActive={false}
                  activeDot={false}
                />
              )}
              <Line
                // Linear, not monotone: a spline over hundreds of points is
                // solved on every render and is meaningless at this spacing,
                // where consecutive points are a pixel apart.
                type="linear"
                dataKey="value"
                name="Current"
                stroke={themeColors.lineColor}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )
}
