"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts"
import { useTheme } from "next-themes"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { Activity, AlertTriangle, Cpu, HardDrive } from "lucide-react"
import {
  getExperimentStats, getBoardConfiguration, getRunStatus,
  getStatsSampling, setStatsSampling,
} from "@/lib/api"
import {
  rateUnit, byteRateUnit, maxMagnitude, formatTick, formatValue,
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

// Every rate on this page counts something different, so each metric carries the
// noun that names it: a bare "1.2 k/s" could be events, pile-ups or saturations,
// and the four sat side by side looking identical.
const METRICS = [
  { key: "event_rate", label: "Events", noun: "events", axis: "Events" },
  { key: "pileup_rate", label: "Pile-up", noun: "pile-ups", axis: "Pile-ups" },
  { key: "lost_rate", label: "Lost", noun: "lost", axis: "Lost events" },
  { key: "satu_rate", label: "Saturation", noun: "saturations", axis: "Saturations" },
] as const
type MetricKey = (typeof METRICS)[number]["key"]

const MAX_POINTS = 60          // rolling history: 60 points at the sampling cadence

// Sampling cadence choices offered on this page. This is NOT a UI-only poll
// rate: one caendaq tick samples the counters, differences them and pushes to
// Graphite, so the same number sets the refresh rate, the averaging window and
// the Graphite resolution. Short = responsive and noisy, long = smooth trends.
const SAMPLING_CHOICES = [
  { ms: 500, label: "0.5 s" },
  { ms: 1000, label: "1 s" },
  { ms: 2000, label: "2 s" },
  { ms: 5000, label: "5 s" },
  { ms: 10000, label: "10 s" },
  { ms: 30000, label: "30 s" },
  { ms: 60000, label: "60 s" },
] as const

const DEFAULT_SAMPLING_MS = 1000
// Never poll faster than the backend recomputes; below this the page just
// re-fetches values that cannot have changed.
const MIN_POLL_MS = 500
// The run state and the tiles are cheap, and stale ones are misleading: they are
// refreshed at least this often whatever the chart's cadence is.
const FAST_POLL_MS = 2000

function samplingLabel(ms: number): string {
  const known = SAMPLING_CHOICES.find((c) => c.ms === ms)
  if (known) return known.label
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)} s` : `${ms} ms`
}

// Categorical series colours, in fixed order, validated for colour-vision
// deficiency against both surfaces (worst adjacent CVD ΔE 9.1 light / 8.4 dark).
// Six is the ceiling here: past it hues stop being tellable apart, so the UI
// caps how many channels can be plotted at once rather than inventing more.
const SERIES_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"]
const SERIES_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300"]
const MAX_PLOTTED_CHANNELS = SERIES_LIGHT.length

/** A counting rate, always with its unit: "12 events/s", "1.2 k events/s". */
function formatRate(value: number, noun = ""): string {
  if (!Number.isFinite(value)) return "—"
  const tail = noun ? `${noun}/s` : "/s"
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)} M ${tail}`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)} k ${tail}`
  if (value >= 10) return `${value.toFixed(0)} ${tail}`
  if (value >= 0.1) return `${value.toFixed(1)} ${tail}`
  return `${value === 0 ? "0" : value.toPrecision(2)} ${tail}`
}

/** A data rate, scaled to whatever it actually is — including 0 B/s. */
function formatBytes(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) return "—"
  const { scale, unit } = byteRateUnit(bytesPerSecond)
  const scaled = bytesPerSecond * scale
  return `${scaled.toFixed(scaled >= 100 || unit === "B/s" ? 0 : scaled >= 10 ? 1 : 2)} ${unit}`
}

/** The history key for one channel's one metric. */
function seriesKey(channel: number, metric: MetricKey): string {
  return `ch${channel}_${metric}`
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
  // True while the last poll failed: the numbers on screen are the last known
  // ones, not current.
  const [unreachable, setUnreachable] = useState(false)
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

  // Sampling cadence, owned by the server (conf/stats.json) so it survives a
  // reload and applies to the next run too. Held in state here so the poll
  // interval below can follow it.
  const [samplingMs, setSamplingMs] = useState<number>(DEFAULT_SAMPLING_MS)
  const [savingSampling, setSavingSampling] = useState(false)

  useEffect(() => {
    let active = true
    getStatsSampling()
      .then((s) => {
        if (!active) return
        // Prefer what the running collector actually uses; fall back to the
        // stored setting when no run is active.
        setSamplingMs(s.active_interval_ms ?? s.stats_interval_ms)
      })
      .catch(() => { /* keep the default */ })
    return () => { active = false }
  }, [])

  const changeSampling = useCallback(async (ms: number) => {
    const previous = samplingMs
    setSamplingMs(ms)            // optimistic: the plot re-paces immediately
    setSavingSampling(true)
    try {
      const saved = await setStatsSampling(ms)
      // The server clamps, so adopt what it stored rather than what was asked.
      setSamplingMs(saved.active_interval_ms ?? saved.stats_interval_ms)
    } catch {
      setSamplingMs(previous)    // put the control back if it did not stick
    } finally {
      setSavingSampling(false)
    }
  }, [samplingMs])

  useEffect(() => {
    let active = true
    const poll = async () => {
      const [stats, running] = await Promise.all([
        getExperimentStats().then((r) => r as BoardRate[] | null).catch(() => null),
        getRunStatus().then((r) => Boolean(r)).catch(() => null),
      ])
      if (!active) return

      // A failed request is not news about the run: it used to be read as
      // "stopped", which threw away the whole trace and restarted the time axis.
      setUnreachable(running === null || stats === null)
      if (running !== null) setIsRunning(running)
      if (stats === null) return
      const boardRates: BoardRate[] = Array.isArray(stats) ? stats : []
      setRates(boardRates)

      const board = boardRates[boardIdx]
      if (board) {
        // Every metric is recorded, not just the one on screen: switching the
        // selector used to throw the trace away and leave the chart blank for a
        // minute, which looks like the rates stopped.
        const t = Math.round((Date.now() - startRef.current) / 1000)
        const row: Record<string, number | string> = { time: t }
        for (const channel of board.channels) {
          const values = channel as unknown as Record<string, number>
          for (const m of METRICS) {
            row[seriesKey(channel.channel, m.key)] = values[m.key] ?? 0
          }
        }
        setHistory((h) => [...h, row].slice(-MAX_POINTS))
      }
    }
    poll()
    // Poll at the cadence the backend evaluates at: polling faster only re-reads
    // a value that cannot have changed yet, and makes the chart draw flat steps.
    const id = setInterval(poll, Math.max(samplingMs, MIN_POLL_MS))
    return () => { active = false; clearInterval(id) }
  }, [boardIdx, samplingMs])

  // The run state and the headline numbers do not have to wait for the chart's
  // cadence: at 60 s the page would say "Stopped" for a minute after Start.
  useEffect(() => {
    if (Math.max(samplingMs, MIN_POLL_MS) <= FAST_POLL_MS) return
    let active = true
    const pollStatus = async () => {
      const [stats, running] = await Promise.all([
        getExperimentStats().then((r) => r as BoardRate[] | null).catch(() => null),
        getRunStatus().then((r) => Boolean(r)).catch(() => null),
      ])
      if (!active) return
      setUnreachable(running === null || stats === null)
      if (running !== null) setIsRunning(running)
      if (Array.isArray(stats)) setRates(stats)
    }
    const id = setInterval(pollStatus, FAST_POLL_MS)
    return () => { active = false; clearInterval(id) }
  }, [samplingMs])

  // A new run means new boards and a new time origin. A run that *stops* keeps
  // its trace on screen — that last minute is usually what you want to look at.
  useEffect(() => {
    if (!isRunning) return
    setHistory([])
    startRef.current = Date.now()
    loadBoards()
  }, [isRunning, loadBoards])

  // Changing the cadence changes what a point means, so start the trace over
  // rather than splicing 10 s averages onto 1 s ones. Changing the metric does
  // not: every metric is in the history already.
  useEffect(() => {
    setHistory([]); startRef.current = Date.now()
  }, [boardIdx, samplingMs])

  // One row per configured board, carrying its live rates when a run supplies
  // them. Board order matches: the acquisition adds boards sorted by id.
  // Rates are matched to boards by id. Matching by position silently showed one
  // board's rates under another's name whenever the two lists disagreed (a board
  // added or removed while the page was open).
  const boardRows = useMemo(() => configured.map((board, index) => {
    const byId = rates.find((r) => String((r as BoardRate & { board_id?: unknown })
      .board_id ?? '') === String(board.id))
    const byName = rates.filter((r) => r.name === board.name)
    // Older servers do not report board_id: fall back to position, but only when
    // the two lists line up in length, and only when the name agrees.
    const byPosition = rates.length === configured.length
      && rates[index]?.name === board.name ? rates[index] : undefined
    const live = byId ?? (byName.length === 1 ? byName[0] : byPosition) ?? null
    return {
      ...board,
      live,
      channelCount: Number(board.chan) || live?.channels.length || 0,
    }
  }), [configured, rates])

  // A board removed while the page was open must not leave the selection pointing
  // at somebody else.
  useEffect(() => {
    if (boardRows.length && boardIdx >= boardRows.length) setBoardIdx(0)
  }, [boardRows.length, boardIdx])

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
        const v = point[seriesKey(ch, metric)]
        if (typeof v === "number") values.push(v)
      }
    }
    // The noun goes into the unit, so the axis reads "k events/s".
    const noun = METRICS.find((m) => m.key === metric)?.noun ?? ""
    return rateUnit(maxMagnitude(values), `${noun} `)
  }, [history, selected, metric])

  // One key per plotted channel ("ch3"), scaled, so the chart and its legend do
  // not have to know which metric is on screen.
  const scaledHistory = useMemo(() => history.map((point) => {
    const next: Record<string, number | string> = { time: point.time }
    for (const ch of selected) {
      const v = point[seriesKey(ch, metric)]
      if (typeof v === "number") next[`ch${ch}`] = v * scale
    }
    return next
  }), [history, selected, scale, metric])

  const yLabel = useMemo(() => {
    const base = METRICS.find((m) => m.key === metric)?.axis ?? ""
    return `${base} (${unit})`
  }, [metric, unit])

  // Totals for the selected board, as headline numbers rather than a chart.
  const totals = useMemo(() => {
    const channels = activeBoard?.live?.channels ?? []
    const sum = (key: MetricKey) => channels.reduce((acc, c) => acc + (c[key] ?? 0), 0)
    return {
      event_rate: sum("event_rate"),
      pileup_rate: sum("pileup_rate"),
      lost_rate: sum("lost_rate"),
      satu_rate: sum("satu_rate"),
      write: activeBoard?.live?.write_rate ?? 0,
    }
  }, [activeBoard])

  const latest = history[history.length - 1]
  const currentOf = (channel: number) => {
    const value = latest?.[seriesKey(channel, metric)]
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
              aria-pressed={isActive}
              title={`Show the rates of board ${board.id}`}
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
                {boardEvents === null ? "—" : formatRate(boardEvents, "events")}
              </div>
              <div className="text-[11px] text-muted-foreground">
                all channels together
              </div>
              <div className="mt-1.5 flex items-center justify-between text-xs text-muted-foreground">
                <span>{board.dpp} · {board.channelCount} ch</span>
                <span>{live ? `${formatBytes(live.write_rate)} to file` : "idle"}</span>
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

      {/* Totals for the selected board: four counting rates, each naming what it
          counts, and the byte rate kept separate — it is a different quantity and
          used to sit in the same row looking like a fifth rate. */}
      {activeBoard && (
        <div className="space-y-3">
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
            {METRICS.map((m) => {
              const value = totals[m.key]
              const highlight = m.key !== "event_rate" && value > 0
              return (
                <Card key={m.key} className={metric === m.key ? "border-primary" : ""}>
                  <CardContent className="p-3">
                    <p className="text-xs text-muted-foreground">{m.axis}</p>
                    <p className={`text-lg font-semibold tabular-nums ${
                      highlight ? "text-amber-600 dark:text-amber-400" : ""}`}>
                      {activeBoard.live ? formatRate(value, m.noun) : "—"}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      board {activeBoard.id}, all channels
                    </p>
                  </CardContent>
                </Card>
              )
            })}
          </div>

          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 p-3 text-sm">
              <span className="flex items-center gap-2 text-muted-foreground">
                <HardDrive className="h-4 w-4" />
                Written to file
              </span>
              <span className="flex flex-wrap items-center gap-x-6 gap-y-1">
                <span>
                  <span className="text-muted-foreground">board {activeBoard.id}: </span>
                  <span className="font-semibold tabular-nums">
                    {activeBoard.live ? formatBytes(totals.write) : "—"}
                  </span>
                </span>
                <span>
                  <span className="text-muted-foreground">
                    all {rates.length || boardRows.length} board
                    {(rates.length || boardRows.length) === 1 ? "" : "s"}:{" "}
                  </span>
                  <span className="font-semibold tabular-nums">
                    {rates.length
                      ? formatBytes(rates.reduce((sum, b) => sum + b.write_rate, 0))
                      : "—"}
                  </span>
                </span>
              </span>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Rate plot */}
      <Card>
        <CardHeader className="flex flex-col gap-3 pb-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <CardTitle className="text-base">
              {METRICS.find((m) => m.key === metric)?.axis} per second
              {activeBoard ? ` · board ${activeBoard.id} (${activeBoard.name})` : ""}
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              {isRunning
                ? `Per channel, in ${unit.trim()} — last ${MAX_POINTS} points, one every `
                  + `${samplingLabel(samplingMs)}, averaged over that interval`
                : "No run in progress — rates start when a run does"}
            </p>
          </div>
          {/* Filters in one row above the plot, each saying what it changes. */}
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Plot
              </Label>
            <Select
              value={String(samplingMs)}
              onValueChange={(v) => changeSampling(Number(v))}
              disabled={savingSampling}
            >
              <SelectTrigger
                className="h-9 w-32"
                title="How often rates are evaluated. Also the window they are averaged over and the rate they reach Graphite."
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SAMPLING_CHOICES.map((c) => (
                  <SelectItem key={c.ms} value={String(c.ms)}>Every {c.label}</SelectItem>
                ))}
                {/* A value set elsewhere (or clamped by the server) still shows. */}
                {!SAMPLING_CHOICES.some((c) => c.ms === samplingMs) && (
                  <SelectItem value={String(samplingMs)}>
                    Every {samplingLabel(samplingMs)}
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Rate shown
              </Label>
              <Select value={metric} onValueChange={(v) => setMetric(v as MetricKey)}>
                <SelectTrigger className="h-9 w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {METRICS.map((m) => (
                    <SelectItem key={m.key} value={m.key}>{m.axis} per second</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Badge variant={unreachable ? "destructive" : isRunning ? "default" : "secondary"}
                   className="h-9 gap-1.5 px-3"
                   title={unreachable
                     ? "The last request to the DAQ server failed — these numbers are the last known ones"
                     : ""}>
              <Activity className="h-3.5 w-3.5" />
              {unreachable ? "No answer" : isRunning ? "Running" : "Stopped"}
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
                    {currentOf(channel) === null ? "—"
                      : formatRate(currentOf(channel)!,
                                   METRICS.find((m) => m.key === metric)?.noun)}
                  </span>
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

    </div>
  )
}
