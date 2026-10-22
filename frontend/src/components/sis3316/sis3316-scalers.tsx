"use client"

// Live time, run totals, temperature and counter inputs of an SIS3316, and the
// settings card that marks a channel as a counter input. Everything comes from
// GET /sis3316/<id>/counters (the 'run' block) and the board's settings; see
// server/native/sis3316daq/sis3316daq/scalers.py for the definitions.

import { useEffect, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Plus, Trash2 } from 'lucide-react'
import { getSis3316Counters, type Sis3316Settings } from '@/lib/api'

// ── data ─────────────────────────────────────────────────────────────────────

export type ScalerChannel = Record<string, number | boolean | null | undefined> & {
  channel: number
  enabled: boolean
  events: number
  internal: number
  deadtime: number
  dead_fraction: number | null
  live_fraction: number | null
  trigger_rate?: number | null
  event_rate?: number
  interval_dead_fraction?: number | null
}

export type CounterInput = {
  channel: number
  name: string
  unit: string
  scale: number
  metric: string
  counts: number
  total: number
  rate: number | null
}

type Mismatch = { channel: number; hits: number; events: number; difference: number }

export type ScalerRun = {
  running: boolean
  elapsed_s: number | null
  counted_s: number
  uncounted_banks: number
  temperature_c: number | null
  names: string[]
  channels: ScalerChannel[]
  counters: CounterInput[]
  summary: null | {
    duration_s: number
    counted_s: number
    temperature_c: { last: number | null; min: number | null; max: number | null }
    integrity: { ok: boolean; mismatches: Mismatch[] }
  }
}

export type CountersResponse = {
  names: string[]
  channels: Record<string, number>[]
  source?: "run" | "board"
  run?: ScalerRun | null
}

/** The counters route, with the live-time block the server adds once a run started. */
export const fetchCounters = (boardId: string) =>
  getSis3316Counters(boardId) as Promise<CountersResponse>

// ── formatting ───────────────────────────────────────────────────────────────

const pct = (f: number | null | undefined, digits = 2) =>
  f === null || f === undefined ? "—" : `${(100 * f).toFixed(digits)} %`

function duration(s: number | null | undefined): string {
  if (s === null || s === undefined) return "—"
  const t = Math.round(s)
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60
  return h ? `${h} h ${m} min` : m ? `${m} min ${sec} s` : `${sec} s`
}

/** A scaled quantity with its unit, in a readable number of digits. */
function quantity(v: number | null | undefined, unit: string): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—"
  const a = Math.abs(v)
  const s = a !== 0 && (a >= 1e7 || a < 1e-3) ? v.toExponential(3)
          : v.toLocaleString(undefined, { maximumFractionDigits: a >= 100 ? 0 : 3 })
  return unit ? `${s} ${unit}` : s
}

// Below this live fraction the number is worth a second look.
const LOW_LIVE = 0.9

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "warning" }) {
  return (
    <div className="rounded-md border p-3 min-w-0">
      <p className="text-xs text-muted-foreground truncate" title={label}>{label}</p>
      <p className={`text-lg font-semibold font-mono tabular-nums break-words ${tone === "warning" ? "text-warning" : ""}`}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground break-words">{sub}</p>}
    </div>
  )
}

// ── Counters tab: live time ──────────────────────────────────────────────────

export function LiveTimePanel({ run }: { run: ScalerRun | null | undefined }) {
  if (!run) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Live time</CardTitle>
          <CardDescription>Shown from the first run after the server started.</CardDescription>
        </CardHeader>
      </Card>
    )
  }
  const enabled = run.channels.filter((c) => c.enabled)
  const withLive = enabled.filter((c) => c.live_fraction !== null)
  const worst = withLive.length
    ? withLive.reduce((a, c) => ((c.live_fraction ?? 1) < (a.live_fraction ?? 1) ? c : a)) : null
  const temp = run.temperature_c
  const mismatches = run.summary?.integrity?.mismatches ?? []
  return (
    <Card>
      <CardHeader>
        <CardTitle>Live time {run.running ? "" : "of the last run"}</CardTitle>
        <CardDescription>
          Live = 1 − dead-time triggers / internal triggers, per channel, from the board&apos;s own
          counters: the share of a channel&apos;s triggers that found the board ready to record. It is the
          live-time fraction for randomly timed signals; pile-up inside an event, vetoed and external
          triggers are not dead time here. The first readout bank of a run is not in the counts.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Tile label={run.running ? "Run time" : "Run length"}
                value={duration(run.running ? run.elapsed_s : run.summary?.duration_s)}
                sub={`counted ${duration(run.counted_s)}`} />
          <Tile label="Temperature" value={temp === null ? "—" : `${temp.toFixed(1)} °C`}
                tone={temp !== null && temp > 50 ? "warning" : undefined}
                sub={run.summary?.temperature_c?.min != null
                  ? `${run.summary.temperature_c.min.toFixed(1)}–${run.summary.temperature_c.max?.toFixed(1)} °C in the run`
                  : temp !== null && temp > 50 ? "above the 50 °C Struck recommends" : undefined} />
          <Tile label="Lowest live time" value={worst ? pct(worst.live_fraction) : "—"}
                sub={worst ? `channel ${worst.channel}` : "no triggers yet"}
                tone={worst && (worst.live_fraction ?? 1) < LOW_LIVE ? "warning" : undefined} />
          <Tile label="Dead-time triggers"
                value={enabled.reduce((n, c) => n + Number(c.deadtime || 0), 0).toLocaleString()}
                sub="all channels, since the start" />
        </div>

        {run.counters.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {run.counters.map((c) => (
              <div key={c.channel} className="rounded-md border p-3 min-w-0">
                <p className="text-sm font-medium break-words">{c.name}
                  <span className="text-xs font-normal text-muted-foreground"> · ch {c.channel}</span></p>
                <p className="text-2xl font-semibold font-mono tabular-nums break-words">{quantity(c.total, c.unit)}</p>
                <p className="text-xs text-muted-foreground break-words">
                  {c.counts.toLocaleString()} pulses × {c.scale}{c.unit ? ` ${c.unit}` : ""}
                  {c.rate !== null ? ` · ${quantity(c.rate, c.unit ? `${c.unit}/s` : "/s")}` : ""}
                </p>
              </div>
            ))}
          </div>
        )}

        {mismatches.length > 0 && (
          <Alert variant="destructive">
            <AlertTitle>Hit counter and events written differ</AlertTitle>
            <AlertDescription>
              {mismatches.map((m) => `ch ${m.channel}: ${m.hits.toLocaleString()} hits, ${m.events.toLocaleString()} events`).join("; ")}.
              Events may be missing from the run files; a note was added to the run.
            </AlertDescription>
          </Alert>
        )}

        {enabled.length === 0 ? (
          <p className="text-sm text-muted-foreground">No channel is switched on.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ch</TableHead>
                  <TableHead className="text-right">Live</TableHead>
                  <TableHead className="text-right">Dead</TableHead>
                  {run.running && <TableHead className="text-right hidden sm:table-cell" title="Dead share of the last stats interval">Dead now</TableHead>}
                  <TableHead className="text-right hidden sm:table-cell">Triggers</TableHead>
                  <TableHead className="text-right">Events</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {enabled.map((c) => (
                  <TableRow key={c.channel}>
                    <TableCell className="font-medium">{c.channel}</TableCell>
                    <TableCell className={`text-right font-mono ${(c.live_fraction ?? 1) < LOW_LIVE ? "text-warning" : ""}`}>{pct(c.live_fraction)}</TableCell>
                    <TableCell className="text-right font-mono">{pct(c.dead_fraction)}</TableCell>
                    {run.running && <TableCell className="text-right font-mono hidden sm:table-cell">{pct(c.interval_dead_fraction)}</TableCell>}
                    <TableCell className="text-right font-mono hidden sm:table-cell">{Number(c.internal).toLocaleString()}</TableCell>
                    <TableCell className="text-right font-mono">{Number(c.events).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** Polls the counters route; shared by the live-time panel and the raw counter table. */
export function useCounters(boardId: string, everyMs = 2000) {
  const [data, setData] = useState<CountersResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const load = () => fetchCounters(boardId)
      .then((d) => { if (!cancelled) { setData(d); setError(null) } })
      .catch((e) => {
        if (cancelled) return
        const r = (e as { response?: { data?: { error?: string } } })?.response?.data
        setError(r?.error ?? "Could not read the counters.")
      })
    load()
    const t = setInterval(load, everyMs)
    return () => { cancelled = true; clearInterval(t) }
  }, [boardId, everyMs])
  return { data, error }
}

// ── Settings: counter inputs ─────────────────────────────────────────────────

const COUNTER_KEYS = ["counter_input", "counter_name", "counter_scale", "counter_unit"] as const
type Over = Record<string, unknown>

/** Marks channels as counter inputs (name, scale, unit) in the settings draft. */
export function CounterInputsCard({ draft, setDraft }: {
  draft: Sis3316Settings
  setDraft: (s: Sis3316Settings) => void
}) {
  const defaults = draft.channel_defaults as unknown as Over
  const eff = (ch: number): Over => ({ ...defaults, ...((draft.channels[String(ch)] ?? {}) as Over) })
  const counterChannels = Array.from({ length: 16 }, (_, i) => i).filter((ch) => !!eff(ch).counter_input)
  const free = Array.from({ length: 16 }, (_, i) => i).filter((ch) => !counterChannels.includes(ch))

  // Counter fields live in the channel's own overrides, never in the defaults.
  const write = (ch: number, values: Over | null) => {
    const over: Over = { ...((draft.channels[String(ch)] ?? {}) as Over) }
    for (const k of COUNTER_KEYS) delete over[k]
    if (values) Object.assign(over, values)
    const channels = { ...draft.channels } as Record<string, Over>
    if (Object.keys(over).length) channels[String(ch)] = over
    else delete channels[String(ch)]
    setDraft({ ...draft, channels: channels as Sis3316Settings["channels"] })
  }
  const fields = (ch: number): Over => {
    const e = eff(ch)
    return { counter_input: true, counter_name: e.counter_name ?? "",
             counter_scale: e.counter_scale ?? 1, counter_unit: e.counter_unit ?? "" }
  }
  const update = (ch: number, key: string, value: unknown) => write(ch, { ...fields(ch), [key]: value })
  const move = (from: number, to: number) => {
    const f = fields(from)
    const channels = { ...draft.channels } as Record<string, Over>
    const strip = (c: number) => {
      const o: Over = { ...((channels[String(c)] ?? {}) as Over) }
      for (const k of COUNTER_KEYS) delete o[k]
      return o
    }
    const a = strip(from)
    if (Object.keys(a).length) channels[String(from)] = a
    else delete channels[String(from)]
    channels[String(to)] = { ...strip(to), ...f }
    setDraft({ ...draft, channels: channels as Sis3316Settings["channels"] })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Counter inputs</CardTitle>
        <CardDescription>
          A channel fed with logic pulses — a current integrator&apos;s output, a clock — counts them:
          every pulse over the trigger threshold, dead time or not, times the scale (e.g. 1 pulse = 10 pC
          of beam charge). Shown on the Counters tab, written to the run&apos;s sis3316_scalers.csv and
          summary, and sent to Graphite. The channel&apos;s events are still recorded.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {counterChannels.length === 0 && (
          <p className="text-sm text-muted-foreground">No channel is a counter input.</p>
        )}
        {counterChannels.map((ch) => {
          const e = eff(ch)
          return (
            <div key={ch} className="rounded-md border p-3 space-y-3">
              <div className="grid gap-3 grid-cols-2 sm:grid-cols-[1fr_8rem_7rem_6rem_auto] sm:items-end">
                <div className="space-y-1.5 col-span-2 sm:col-span-1">
                  <Label htmlFor={`cnt-name-${ch}`}>Name</Label>
                  <Input id={`cnt-name-${ch}`} value={String(e.counter_name ?? "")} maxLength={40}
                         placeholder="Beam charge" onChange={(ev) => update(ch, "counter_name", ev.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Channel</Label>
                  <Select value={String(ch)} onValueChange={(v) => move(ch, Number(v))}>
                    <SelectTrigger aria-label="Counter channel"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {[ch, ...free].sort((a, b) => a - b).map((c) => <SelectItem key={c} value={String(c)}>Channel {c}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`cnt-scale-${ch}`}>Per pulse</Label>
                  <Input id={`cnt-scale-${ch}`} type="number" className="font-mono" step="any"
                         value={String(e.counter_scale ?? 1)}
                         onChange={(ev) => update(ch, "counter_scale", ev.target.value === "" ? 1 : Number(ev.target.value))} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`cnt-unit-${ch}`}>Unit</Label>
                  <Input id={`cnt-unit-${ch}`} value={String(e.counter_unit ?? "")} maxLength={16}
                         placeholder="pC" onChange={(ev) => update(ch, "counter_unit", ev.target.value)} />
                </div>
                <Button variant="outline" className="self-end" onClick={() => write(ch, null)}
                        aria-label={`Channel ${ch} is no longer a counter input`}>
                  <Trash2 className="mr-1.5 h-4 w-4" />Remove
                </Button>
              </div>
              {!e.enabled && (
                <p className="text-xs text-warning">Channel {ch} is switched off: it counts nothing until it is on.</p>
              )}
            </div>
          )
        })}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" disabled={!free.length}
                  onClick={() => write(free.find((c) => !!eff(c).enabled) ?? free[0],
                                       { counter_input: true, counter_name: "", counter_scale: 1, counter_unit: "" })}>
            <Plus className="mr-1.5 h-4 w-4" />Add counter input
          </Button>
          <p className="text-xs text-muted-foreground">
            Cabling, polarity and threshold for NIM or TTL pulses: see doc/sis3316.md.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
