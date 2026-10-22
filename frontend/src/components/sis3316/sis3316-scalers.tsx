"use client"

// Live time, run totals, temperature and counter inputs of an SIS3316, and the
// settings card that marks a channel as a counter input. Everything comes from
// GET /sis3316/<id>/counters (the 'run' block) and the board's settings; see
// server/native/sis3316daq/sis3316daq/scalers.py for the definitions.

import { useEffect, useRef, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Plus, Trash2 } from 'lucide-react'
import { getSis3316Counters, getSis3316Settings, type Sis3316Settings } from '@/lib/api'

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

// A narrow no-break space before the %, so "0.96 %" never wraps on a phone.
const pct = (f: number | null | undefined, digits = 2) =>
  f === null || f === undefined ? "—" : `${(100 * f).toFixed(digits)}\u202F%`

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
          : v.toLocaleString('en-US', { maximumFractionDigits: a >= 100 ? 0 : 3 })
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

/** A counter input set on a channel that is switched off: the server leaves it
 *  out of the run block, so it comes from the settings. */
export type OffCounter = { channel: number; name: string }

// Above this the board runs warmer than the SIS3316 manual advises.
const HOT_C = 50

export function LiveTimePanel({ run, offCounters = [] }: {
  run: ScalerRun | null | undefined
  offCounters?: OffCounter[]
}) {
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
  const hot = temp !== null && temp > HOT_C
  const range = run.summary?.temperature_c?.min != null
    ? `${run.summary.temperature_c.min.toFixed(1)}–${run.summary.temperature_c.max?.toFixed(1)} °C in the run` : ""
  const off = offCounters.filter((o) => !run.counters.some((c) => c.channel === o.channel))
  return (
    <Card>
      <CardHeader>
        <CardTitle>Live time {run.running ? "" : "of the last run"}</CardTitle>
        <CardDescription>Share of each channel&apos;s triggers that found the board ready to record.</CardDescription>
        <details className="text-sm">
          <summary className="cursor-pointer py-1 text-muted-foreground">What does this mean?</summary>
          <p className="mt-1 text-muted-foreground">
            Live = 1 − dead-time triggers / internal triggers, per channel, from the board&apos;s own
            counters. It is the live-time fraction for randomly timed signals; pile-up inside an event,
            vetoed and external triggers are not dead time here. The first readout bank of a run and the
            bank after a settings change are not in the counts.
          </p>
        </details>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Tile label={run.running ? "Run time" : "Run length"}
                value={duration(run.running ? run.elapsed_s : run.summary?.duration_s)}
                sub={`counted ${duration(run.counted_s)}`} />
          <Tile label="Temperature" value={temp === null ? "—" : `${temp.toFixed(1)} °C`}
                tone={hot ? "warning" : undefined}
                sub={[range, hot ? `Above ${HOT_C} °C, the manual's limit: check the crate's cooling/fans` : ""]
                  .filter(Boolean).join(" · ") || undefined} />
          <Tile label="Lowest live time" value={worst ? pct(worst.live_fraction) : "—"}
                sub={worst ? `channel ${worst.channel}` : "no triggers yet"}
                tone={worst && (worst.live_fraction ?? 1) < LOW_LIVE ? "warning" : undefined} />
          <Tile label="Dead-time triggers"
                value={enabled.reduce((n, c) => n + Number(c.deadtime || 0), 0).toLocaleString('en-US')}
                sub="all channels, since the start" />
        </div>

        {run.counters.length + off.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {run.counters.map((c) => (
              <div key={c.channel} className="rounded-md border p-3 min-w-0">
                <p className="text-sm font-medium break-words">{c.name}
                  <span className="text-xs font-normal text-muted-foreground"> · ch {c.channel}</span></p>
                <p className="text-2xl font-semibold font-mono tabular-nums break-words">{quantity(c.total, c.unit)}</p>
                <p className="text-xs text-muted-foreground break-words">
                  {c.counts.toLocaleString('en-US')} pulses × {c.scale}{c.unit ? ` ${c.unit}` : ""}
                  {c.rate !== null ? ` · ${quantity(c.rate, c.unit ? `${c.unit}/s` : "/s")}` : ""}
                </p>
              </div>
            ))}
            {off.map((c) => (
              <div key={c.channel} className="rounded-md border border-dashed p-3 min-w-0">
                <p className="text-sm font-medium break-words">{c.name}
                  <span className="text-xs font-normal text-muted-foreground"> · ch {c.channel}</span></p>
                <p className="text-2xl font-semibold text-muted-foreground">channel off</p>
                <p className="text-xs text-muted-foreground break-words">
                  Switched off in the settings: it counts nothing until it is on.
                </p>
              </div>
            ))}
          </div>
        )}

        {mismatches.length > 0 && (
          <Alert variant="destructive">
            <AlertTitle>Hit counter and events written differ</AlertTitle>
            <AlertDescription>
              {mismatches.map((m) => `ch ${m.channel}: ${m.hits.toLocaleString('en-US')} hits, ${m.events.toLocaleString('en-US')} events`).join("; ")}.
              Events may be missing from the run files. If the run was saved, a note was added to it.
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
                    <TableCell className={`text-right font-mono whitespace-nowrap ${(c.live_fraction ?? 1) < LOW_LIVE ? "text-warning" : ""}`}>{pct(c.live_fraction)}</TableCell>
                    <TableCell className="text-right font-mono whitespace-nowrap">{pct(c.dead_fraction)}</TableCell>
                    {run.running && <TableCell className="text-right font-mono whitespace-nowrap hidden sm:table-cell">{pct(c.interval_dead_fraction)}</TableCell>}
                    <TableCell className="text-right font-mono whitespace-nowrap hidden sm:table-cell">{Number(c.internal).toLocaleString('en-US')}</TableCell>
                    <TableCell className="text-right font-mono whitespace-nowrap">{Number(c.events).toLocaleString('en-US')}</TableCell>
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

/** Counter inputs set on switched-off channels, from the saved settings (the
 *  counters route only lists enabled channels). Re-read now and then, since the
 *  settings can change in another tab. */
export function useOffCounterInputs(boardId: string, everyMs = 15000) {
  const [off, setOff] = useState<OffCounter[]>([])
  useEffect(() => {
    let cancelled = false
    const load = () => getSis3316Settings(boardId).then((res) => {
      if (cancelled) return
      const st = res.settings
      const list: OffCounter[] = []
      for (let ch = 0; ch < 16; ch++) {
        const e = { ...(st.channel_defaults as unknown as Over), ...((st.channels[String(ch)] ?? {}) as Over) }
        if (e.counter_input && !e.enabled) list.push({ channel: ch, name: counterName(e.counter_name, ch) })
      }
      setOff(list)
    }).catch(() => { /* the panel simply shows no switched-off inputs */ })
    load()
    const t = setInterval(load, everyMs)
    return () => { cancelled = true; clearInterval(t) }
  }, [boardId, everyMs])
  return off
}

// ── Settings: counter inputs ─────────────────────────────────────────────────

const COUNTER_KEYS = ["counter_input", "counter_name", "counter_scale", "counter_unit"] as const
type Over = Record<string, unknown>

// The server cuts names and units to these lengths (settings.py).
const NAME_MAX = 40
const UNIT_MAX = 16

/** The name the server reports a counter input under: its own, or "Counter ch N". */
export function counterName(name: unknown, ch: number): string {
  return String(name ?? "").trim() || `Counter ch ${ch}`
}

/** The counter's Graphite path element, by the rule of metric_name() in
 *  scalers.py: two names that give the same one would write to one series. */
function metricName(name: string, ch: number): string {
  const m = name.replace(/[µμ]/g, "u").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "")
  return m || `ch_${ch}`
}

const SCALE_RE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i

/** The typed per-pulse value as a number, or null when it is not one. A decimal
 *  comma is accepted, since that is how many of us write numbers. */
function parseScale(raw: string): number | null {
  const t = raw.trim().replace(",", ".")
  if (!SCALE_RE.test(t)) return null
  const v = Number(t)
  return Number.isFinite(v) ? v : null
}

type Check = { name?: string; scale?: string; scaleWarning?: string }

const effectiveOf = (draft: Sis3316Settings, ch: number): Over =>
  ({ ...(draft.channel_defaults as unknown as Over), ...((draft.channels[String(ch)] ?? {}) as Over) })

/** Per counter-input channel: what keeps the draft from being saved (name,
 *  scale) and what is only worth a warning. While a per-pulse value does not
 *  parse, the draft holds the typed text, so it can never be saved as a number
 *  the operator did not mean. */
function checkCounters(draft: Sis3316Settings): Record<number, Check> {
  const chans = Array.from({ length: 16 }, (_, i) => i).filter((ch) => !!effectiveOf(draft, ch).counter_input)
  const metrics = new Map<string, number[]>()
  for (const ch of chans) {
    const m = metricName(counterName(effectiveOf(draft, ch).counter_name, ch), ch).toLowerCase()
    metrics.set(m, [...(metrics.get(m) ?? []), ch])
  }
  const out: Record<number, Check> = {}
  for (const ch of chans) {
    const e = effectiveOf(draft, ch)
    const c: Check = {}
    const scale = e.counter_scale ?? 1
    if (typeof scale === "string") {
      c.scale = scale.trim() === ""
        ? `Channel ${ch}: enter the quantity per pulse (1 to count pulses).`
        : `Channel ${ch}: "${scale}" is not a number.`
    } else if (typeof scale !== "number" || !Number.isFinite(scale)) {
      c.scale = `Channel ${ch}: the quantity per pulse is not a number.`
    } else if (scale === 0) {
      c.scale = `Channel ${ch}: the quantity per pulse cannot be 0 — every total would read 0.`
    } else if (scale < 0) {
      c.scaleWarning = `Channel ${ch}: a negative quantity per pulse makes the total count down. Is that meant?`
    }
    const name = counterName(e.counter_name, ch)
    const others = (metrics.get(metricName(name, ch).toLowerCase()) ?? []).filter((o) => o !== ch)
    if (others.length) {
      c.name = `Channel ${ch}: "${name}" clashes with channel ${others.join(", ")} — both would be `
             + `"${metricName(name, ch)}" in Graphite. Give each counter its own name.`
    }
    out[ch] = c
  }
  return out
}

/** What keeps the counter inputs of a settings draft from being saved, one line each. */
export function counterInputProblems(draft: Sis3316Settings): string[] {
  return Object.values(checkCounters(draft)).flatMap((c) => [c.scale, c.name].filter((x): x is string => !!x))
}

/** Marks channels as counter inputs (name, scale, unit) in the settings draft. */
export function CounterInputsCard({ draft, setDraft }: {
  draft: Sis3316Settings
  setDraft: (s: Sis3316Settings) => void
}) {
  // The per-pulse text as typed, per channel: the draft gets a number only when
  // it parses, and the field never rewrites what is being typed.
  const [raw, setRaw] = useState<Record<number, string>>({})
  const [editing, setEditing] = useState<number | null>(null)
  const [focusName, setFocusName] = useState<number | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (focusName === null) return
    listRef.current?.querySelector<HTMLInputElement>(`#cnt-name-${focusName}`)?.focus()
    setFocusName(null)
  }, [focusName])

  const eff = (ch: number): Over => effectiveOf(draft, ch)
  const counterChannels = Array.from({ length: 16 }, (_, i) => i).filter((ch) => !!eff(ch).counter_input)
  const free = Array.from({ length: 16 }, (_, i) => i).filter((ch) => !counterChannels.includes(ch))
  const checks = checkCounters(draft)

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
  const forgetRaw = (ch: number) => setRaw((r) => { const n = { ...r }; delete n[ch]; return n })
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
    setRaw((r) => { const n = { ...r }; if (from in n) n[to] = n[from]; delete n[from]; return n })
  }
  const add = () => {
    const ch = free.find((c) => !!eff(c).enabled) ?? free[0]
    write(ch, { counter_input: true, counter_name: "", counter_scale: 1, counter_unit: "" })
    forgetRaw(ch)
    setFocusName(ch)
  }

  // What the per-pulse field shows: the typed text while it still stands for
  // the draft's value (Discard or a reload from the server replace it).
  const scaleText = (ch: number): string => {
    const v = eff(ch).counter_scale ?? 1
    const r = raw[ch]
    if (r !== undefined && (typeof v === "string" ? r === v : parseScale(r) === v)) return r
    return String(v)
  }
  const setScale = (ch: number, text: string) => {
    setRaw((r) => ({ ...r, [ch]: text }))
    update(ch, "counter_scale", parseScale(text) ?? text)
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
      <CardContent className="space-y-3" ref={listRef}>
        {counterChannels.length === 0 && (
          <p className="text-sm text-muted-foreground">No channel is a counter input.</p>
        )}
        {counterChannels.map((ch) => {
          const e = eff(ch)
          const c = checks[ch] ?? {}
          const name = String(e.counter_name ?? "")
          const unit = String(e.counter_unit ?? "")
          // A scale error shows once the field is left, not at every keystroke
          // of "0.25"; the save is refused either way.
          const scaleError = editing === ch ? undefined : c.scale
          const notes: { id: string; text: string; tone: "error" | "warning" | "muted" }[] = []
          if (c.name) notes.push({ id: `cnt-name-err-${ch}`, text: c.name, tone: "error" })
          else if (!name.trim()) notes.push({ id: `cnt-name-err-${ch}`, text: `No name: it will be called "Counter ch ${ch}".`, tone: "muted" })
          if (name.length >= NAME_MAX - 5) notes.push({ id: `cnt-name-len-${ch}`, text: `Name: ${name.length} of ${NAME_MAX} characters${name.length >= NAME_MAX ? " (the limit)" : ""}.`, tone: name.length >= NAME_MAX ? "warning" : "muted" })
          if (scaleError) notes.push({ id: `cnt-scale-err-${ch}`, text: scaleError, tone: "error" })
          else if (c.scaleWarning) notes.push({ id: `cnt-scale-err-${ch}`, text: c.scaleWarning, tone: "warning" })
          if (unit.length >= UNIT_MAX - 3) notes.push({ id: `cnt-unit-len-${ch}`, text: `Unit: ${unit.length} of ${UNIT_MAX} characters${unit.length >= UNIT_MAX ? " (the limit)" : ""}.`, tone: unit.length >= UNIT_MAX ? "warning" : "muted" })
          if (!e.enabled) notes.push({ id: `cnt-off-${ch}`, text: `Channel ${ch} is switched off: it counts nothing until it is on.`, tone: "warning" })
          const describedBy = (prefix: string) =>
            notes.filter((n) => n.id.startsWith(prefix)).map((n) => n.id).join(" ") || undefined
          return (
            <div key={ch} className="rounded-md border p-3 space-y-3">
              <div className="grid gap-3 grid-cols-2 sm:grid-cols-[1fr_8rem_7rem_6rem_auto] sm:items-end">
                <div className="space-y-1.5 col-span-2 sm:col-span-1">
                  <Label htmlFor={`cnt-name-${ch}`}>Name</Label>
                  <Input id={`cnt-name-${ch}`} value={name} maxLength={NAME_MAX}
                         className={c.name ? "border-destructive" : ""}
                         aria-invalid={!!c.name} aria-describedby={describedBy(`cnt-name-`)}
                         placeholder="Beam charge" onChange={(ev) => update(ch, "counter_name", ev.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`cnt-ch-${ch}`}>Channel</Label>
                  <Select value={String(ch)} onValueChange={(v) => move(ch, Number(v))}>
                    <SelectTrigger id={`cnt-ch-${ch}`}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {[ch, ...free].sort((a, b) => a - b).map((c) => <SelectItem key={c} value={String(c)}>Channel {c}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`cnt-scale-${ch}`}>Per pulse</Label>
                  <Input id={`cnt-scale-${ch}`} type="text" inputMode="decimal" autoComplete="off"
                         className={`font-mono ${scaleError ? "border-destructive" : ""}`} value={scaleText(ch)}
                         aria-invalid={!!scaleError} aria-describedby={describedBy(`cnt-scale-`)}
                         onFocus={() => setEditing(ch)}
                         onBlur={() => {
                           setEditing(null)
                           // Show "0,25" as the 0.25 that will be saved.
                           const t = scaleText(ch), v = parseScale(t)
                           if (v !== null && t.includes(",")) setRaw((r) => ({ ...r, [ch]: String(v) }))
                         }}
                         onChange={(ev) => setScale(ch, ev.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`cnt-unit-${ch}`}>Unit</Label>
                  <Input id={`cnt-unit-${ch}`} value={unit} maxLength={UNIT_MAX}
                         aria-describedby={describedBy(`cnt-unit-`)}
                         placeholder="pC" onChange={(ev) => update(ch, "counter_unit", ev.target.value)} />
                </div>
                <Button variant="outline" className="self-end" onClick={() => { write(ch, null); forgetRaw(ch) }}
                        aria-label={`Remove counter input on channel ${ch}`}>
                  <Trash2 className="mr-1.5 h-4 w-4" />Remove
                </Button>
              </div>
              {notes.length > 0 && (
                <div className="space-y-1">
                  {notes.map((n) => (
                    <p key={n.id} id={n.id} role={n.tone === "error" ? "alert" : undefined}
                       className={`text-xs break-words ${n.tone === "error" ? "text-destructive" : n.tone === "warning" ? "text-warning" : "text-muted-foreground"}`}>
                      {n.text}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )
        })}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" disabled={!free.length} onClick={add}>
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
