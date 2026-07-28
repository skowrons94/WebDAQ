"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts"
import { useTheme } from "next-themes"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { Activity, AlertTriangle, Cpu, HardDrive } from "lucide-react"
import { getExperimentStats, getBoardConfiguration, getRunStatus } from "@/lib/api"
import {
  rateUnit, maxMagnitude, formatTick, formatValue,
  CHART_MARGIN, LEGEND_PROPS, yAxisLabel, xAxisLabel,
} from "@/lib/chart-format"

// Shape returned by GET /experiment/stats — present only while a run is active.
interface ChannelRate {
  board: number
  channel: number
  event_rate: number
  pileup_rate: number
  lost_rate: number
  satu_rate: number
}
interface BoardRate {
  name: string
  write_rate: number       // bytes/s
  failed: boolean
  board_failures: number
  channels: ChannelRate[]
}
// What the board configuration says, which exists whether or not a run is on.
interface ConfiguredBoard {
  id: string
  name: string
  dpp: string
  chan: number | string
}

const METRICS = [
  { key: "event_rate", label: "Events", yLabel: "Events per Second" },
  { key: "pileup_rate", label: "Pile-up", yLabel: "Pile-ups per Second" },
  { key: "lost_rate", label: "Lost", yLabel: "Lost Events per Second" },
  { key: "satu_rate", label: "Saturation", yLabel: "Saturations per Second" },
] as const
type MetricKey = (typeof METRICS)[number]["key"]

const MAX_POINTS = 60          // rolling history (~2 min at 2 s poll)
const POLL_MS = 2000

// Categorical series colours, in fixed order, validated for colour-vision
// deficiency against both surfaces (worst adjacent CVD ΔE 9.1 light / 8.4 dark).
// Six is the ceiling here: past it hues stop being tellable apart, so the UI
// caps how many channels can be plotted at once rather than inventing more.
const SERIES_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"]
const SERIES_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300"]
const MAX_PLOTTED_CHANNELS = SERIES_LIGHT.length

function formatRate(value: number): string {
  if (!Number.isFinite(value)) return "—"
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)} M/s`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)} k/s`
  return `${value.toFixed(0)} /s`
}

function formatBytes(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "0 MB/s"
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / 1024 / 1024).toFixed(2)} MB/s`
  return `${(bytesPerSecond / 1024).toFixed(0)} kB/s`
}

export default function RunStats() {
  const { resolvedTheme } = useTheme()
  const palette = resolvedTheme === "dark" ? SERIES_DARK : SERIES_LIGHT

  const [configured, setConfigured] = useState<ConfiguredBoard[]>([])
  const [rates, setRates] = useState<BoardRate[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [boardIdx, setBoardIdx] = useState(0)
  const [metric, setMetric] = useState<MetricKey>("event_rate")
  const [selected, setSelected] = useState<number[]>([])
  const [history, setHistory] = useState<Array<Record<string, number | string>>>([])
  const startRef = useRef<number>(Date.now())

  // The board list comes from the configuration, so the page has something to
  // show between runs: it used to render nothing at all until rates arrived,
  // which reads as a broken page rather than as "no run in progress".
  const loadBoards = useCallback(async () => {
    try {
      const response = await getBoardConfiguration()
      setConfigured((response.data ?? []).map((board: ConfiguredBoard) => ({
        ...board,
        id: String(board.id),
      })))
    } catch {
      /* leave whatever we had */
    }
  }, [])

  useEffect(() => { loadBoards() }, [loadBoards])

  useEffect(() => {
    let active = true
    const poll = async () => {
      const [stats, running] = await Promise.all([
        getExperimentStats().catch(() => []),
        getRunStatus().catch(() => false),
      ])
      if (!active) return

      setIsRunning(Boolean(running))
      const boardRates: BoardRate[] = Array.isArray(stats) ? stats : []
      setRates(boardRates)

      const board = boardRates[boardIdx]
      if (board) {
        const t = Math.round((Date.now() - startRef.current) / 1000)
        const row: Record<string, number | string> = { time: t }
        for (const channel of board.channels) {
          row[`ch${channel.channel}`] = (channel as unknown as Record<string, number>)[metric] ?? 0
        }
        setHistory((h) => [...h, row].slice(-MAX_POINTS))
      }
    }
    poll()
    const id = setInterval(poll, POLL_MS)
    return () => { active = false; clearInterval(id) }
  }, [boardIdx, metric])

  // A new run means new boards and a new time origin.
  useEffect(() => {
    setHistory([])
    startRef.current = Date.now()
    if (isRunning) loadBoards()
  }, [isRunning, loadBoards])

  useEffect(() => { setHistory([]); startRef.current = Date.now() }, [boardIdx, metric])

  // One row per configured board, carrying its live rates when a run supplies
  // them. Board order matches: the acquisition adds boards sorted by id.
  const boardRows = useMemo(() => configured.map((board, index) => ({
    ...board,
    live: rates[index] ?? null,
    channelCount: Number(board.chan) || rates[index]?.channels.length || 0,
  })), [configured, rates])

  const activeBoard = boardRows[boardIdx] ?? boardRows[0]
  const channelNumbers = useMemo(() => {
    if (activeBoard?.live) return activeBoard.live.channels.map((c) => c.channel)
    return Array.from({ length: activeBoard?.channelCount ?? 0 }, (_, i) => i)
  }, [activeBoard])

  // Start with the first few channels so the plot is never empty by default.
  useEffect(() => {
    setSelected((current) => {
      const stillThere = current.filter((ch) => channelNumbers.includes(ch))
      if (stillThere.length) return stillThere
      return channelNumbers.slice(0, 4)
    })
  }, [channelNumbers])

  // A channel keeps its colour for as long as it stays selected: assigning by
  // position would repaint every other line whenever one is toggled.
  const colourOf = useCallback((channel: number) => {
    const slot = selected.indexOf(channel)
    return palette[slot >= 0 ? slot % palette.length : 0]
  }, [selected, palette])

  const toggleChannel = (channel: number) => {
    setSelected((current) => current.includes(channel)
      ? current.filter((ch) => ch !== channel)
      : current.length >= MAX_PLOTTED_CHANNELS ? current : [...current, channel])
  }

  // Rates span orders of magnitude between a quiet detector and a hot one, so
  // choose /s, k/s or M/s from the data rather than printing six-digit ticks.
  const { scale, unit } = useMemo(() => {
    const values: number[] = []
    for (const point of history) {
      for (const ch of selected) {
        const v = point[`ch${ch}`]
        if (typeof v === "number") values.push(v)
      }
    }
    return rateUnit(maxMagnitude(values))
  }, [history, selected])

  const scaledHistory = useMemo(() => {
    if (scale === 1) return history
    return history.map((point) => {
      const next: Record<string, number | string> = { ...point }
      for (const ch of selected) {
        const v = point[`ch${ch}`]
        if (typeof v === "number") next[`ch${ch}`] = v * scale
      }
      return next
    })
  }, [history, selected, scale])

  const yLabel = useMemo(() => {
    const base = METRICS.find((m) => m.key === metric)?.yLabel ?? ""
    return `${base.replace(/\s*per Second$/i, "")} (${unit})`
  }, [metric, unit])

  // Totals for the selected board, as headline numbers rather than a chart.
  const totals = useMemo(() => {
    const channels = activeBoard?.live?.channels ?? []
    const sum = (key: MetricKey) => channels.reduce((acc, c) => acc + (c[key] ?? 0), 0)
    return {
      events: sum("event_rate"),
      pileup: sum("pileup_rate"),
      lost: sum("lost_rate"),
      satu: sum("satu_rate"),
      write: activeBoard?.live?.write_rate ?? 0,
    }
  }, [activeBoard])

  const latest = history[history.length - 1]
  const currentOf = (channel: number) => {
    const value = latest?.[`ch${channel}`]
    return typeof value === "number" ? value : null
  }

  return (
    <div className="space-y-4">
      {/* Boards — always listed, whether or not a run is in progress, and
          selectable so rates can be set up before pressing Start. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {boardRows.map((board, index) => {
          const isActive = index === boardIdx
          const live = board.live
          const boardEvents = live?.channels.reduce((s, c) => s + c.event_rate, 0) ?? null
          return (
            <button
              key={`${board.id}-${board.name}`}
              onClick={() => setBoardIdx(index)}
              className={`rounded-lg border p-3 text-left transition-colors ${
                isActive ? "border-primary bg-muted/50" : "hover:bg-muted/30"
              } ${live?.failed ? "border-red-500" : ""}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <Cpu className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm font-medium">{board.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">#{board.id}</span>
                </span>
                {live?.failed && (
                  <Badge variant="destructive" className="shrink-0 gap-1 text-[10px]">
                    <AlertTriangle className="h-3 w-3" />
                    {live.board_failures}
                  </Badge>
                )}
              </div>
              <div className="mt-2 text-xl font-semibold tabular-nums">
                {boardEvents === null ? "—" : formatRate(boardEvents)}
              </div>
              <div className="mt-0.5 flex items-center justify-between text-xs text-muted-foreground">
                <span>{board.dpp} · {board.channelCount} ch</span>
                <span>{live ? formatBytes(live.write_rate) : "idle"}</span>
              </div>
            </button>
          )
        })}

        {boardRows.length === 0 && (
          <Card className="sm:col-span-2 lg:col-span-3 xl:col-span-4">
            <CardContent className="flex flex-col items-center gap-2 py-8 text-center">
              <Cpu className="h-7 w-7 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No boards configured. Add one in Settings → Boards.
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Totals for the selected board. Headline numbers belong in tiles, not
          in a chart of five bars. */}
      {activeBoard && (
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
          {([
            ["Events", totals.events, formatRate],
            ["Pile-up", totals.pileup, formatRate],
            ["Lost", totals.lost, formatRate],
            ["Saturation", totals.satu, formatRate],
            ["Written", totals.write, formatBytes],
          ] as [string, number, (v: number) => string][]).map(([label, value, format]) => (
            <Card key={label}>
              <CardContent className="p-3">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="text-lg font-semibold tabular-nums">
                  {activeBoard.live ? format(value) : "—"}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Rate plot */}
      <Card>
        <CardHeader className="flex flex-col gap-3 pb-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <CardTitle className="text-base">
              {activeBoard ? `${activeBoard.name} · rates over time` : "Rates over time"}
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              {isRunning
                ? `Last ${Math.round((MAX_POINTS * POLL_MS) / 1000 / 60)} minutes, refreshed every ${POLL_MS / 1000}s`
                : "No run in progress — rates start when a run does"}
            </p>
          </div>
          {/* Filters in one row above the plot. */}
          <div className="flex flex-wrap items-center gap-2">
            <Select value={metric} onValueChange={(v) => setMetric(v as MetricKey)}>
              <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                {METRICS.map((m) => (
                  <SelectItem key={m.key} value={m.key}>{m.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Badge variant={isRunning ? "default" : "secondary"} className="h-9 gap-1.5 px-3">
              <Activity className="h-3.5 w-3.5" />
              {isRunning ? "Running" : "Stopped"}
            </Badge>
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          {/* Channel picker. Capped: past six lines nobody can tell the colours
              apart, so the cap is enforced instead of adding more hues. */}
          {channelNumbers.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {channelNumbers.map((channel) => {
                const on = selected.includes(channel)
                const full = !on && selected.length >= MAX_PLOTTED_CHANNELS
                return (
                  <Button
                    key={channel}
                    variant={on ? "secondary" : "ghost"}
                    size="sm"
                    disabled={full}
                    onClick={() => toggleChannel(channel)}
                    className="h-7 gap-1.5 px-2 text-xs"
                    title={full ? `At most ${MAX_PLOTTED_CHANNELS} channels at a time` : undefined}
                  >
                    <span
                      className="inline-block h-2 w-2 rounded-sm"
                      style={{ backgroundColor: on ? colourOf(channel) : "transparent",
                               border: on ? undefined : "1px solid currentColor" }}
                    />
                    ch {channel}
                  </Button>
                )
              })}
              {selected.length >= MAX_PLOTTED_CHANNELS && (
                <span className="ml-1 text-xs text-muted-foreground">
                  {MAX_PLOTTED_CHANNELS} channels max — deselect one to add another
                </span>
              )}
            </div>
          )}

          {history.length === 0 || selected.length === 0 ? (
            <div className="flex h-[340px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-center">
              <Activity className="h-7 w-7 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {!isRunning
                  ? "Rates appear here once a run starts."
                  : selected.length === 0
                    ? "Select a channel above to plot it."
                    : "Waiting for the first samples…"}
              </p>
              {!isRunning && activeBoard && (
                <p className="text-xs text-muted-foreground">
                  {activeBoard.name} is configured with {activeBoard.channelCount} channels.
                </p>
              )}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={340}>
              <LineChart data={scaledHistory} margin={CHART_MARGIN}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis
                  dataKey="time"
                  tick={{ fontSize: 11 }}
                  minTickGap={32}
                  interval="preserveStartEnd"
                  label={xAxisLabel("Time (s)")}
                />
                <YAxis
                  tick={{ fontSize: 11 }}
                  tickFormatter={formatTick}
                  width={64}
                  label={yAxisLabel(yLabel)}
                />
                <Tooltip
                  contentStyle={{ fontSize: 12 }}
                  formatter={(v: number, name: string) => [formatValue(v, unit), name]}
                  labelFormatter={(v) => `t = ${v} s`}
                />
                <Legend {...LEGEND_PROPS} />
                {selected.map((channel) => (
                  <Line
                    key={channel}
                    type="monotone"
                    dataKey={`ch${channel}`}
                    name={`Channel ${channel}`}
                    stroke={colourOf(channel)}
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}

          {/* The numbers behind the lines: three of these hues sit below 3:1
              against a light surface, so the values are written out rather than
              left to colour alone. */}
          {selected.length > 0 && activeBoard?.live && (
            <div className="flex flex-wrap gap-x-6 gap-y-1 border-t pt-2 text-xs">
              {selected.map((channel) => (
                <span key={channel} className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-2 w-2 rounded-sm"
                    style={{ backgroundColor: colourOf(channel) }}
                  />
                  <span className="text-muted-foreground">ch {channel}</span>
                  <span className="font-medium tabular-nums">
                    {currentOf(channel) === null ? "—" : formatRate(currentOf(channel)!)}
                  </span>
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* File throughput across every board — the one number that says whether
          the disk is keeping up. */}
      {rates.length > 0 && (
        <Card>
          <CardContent className="flex items-center justify-between gap-4 p-3">
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <HardDrive className="h-4 w-4" />
              Total written across {rates.length} board{rates.length === 1 ? "" : "s"}
            </span>
            <span className="text-sm font-semibold tabular-nums">
              {formatBytes(rates.reduce((sum, b) => sum + b.write_rate, 0))}
            </span>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
