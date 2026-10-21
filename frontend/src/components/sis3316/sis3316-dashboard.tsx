"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useToast } from "@/components/ui/use-toast"
import { RefreshCw, RotateCcw, Save, Trash2 } from 'lucide-react'
import { useRunStatus } from '@/hooks/use-run-status'
import { loadJSROOT } from '@/lib/load-jsroot'
import {
  clearSis3316OnboardHistograms, getSis3316Counters, getSis3316Info, getSis3316Maw,
  getSis3316OnboardHistogram, getSis3316Settings, setSis3316Settings,
  type Sis3316BoardSettings, type Sis3316ChannelSettings, type Sis3316Info, type Sis3316Settings,
} from '@/lib/api'

type BoardProps = { board: { id: string; name: string; link_num: string } }

const CHANNELS = Array.from({ length: 16 }, (_, i) => i)

function errorText(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: { error?: string; message?: string } } })?.response?.data
  return data?.error ?? data?.message ?? fallback
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v))
}

// ── ROOT plot ────────────────────────────────────────────────────────────────

/** Draws a ROOT JSON histogram returned by `fetcher`, refetching on `refreshKey`. */
function RootPlot({ fetcher, refreshKey, height = 320 }: {
  fetcher: () => Promise<unknown>; refreshKey: unknown; height?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        await loadJSROOT()
        const data = await fetcher()
        if (cancelled || !ref.current) return
        const obj = window.JSROOT.parse(data)
        await window.JSROOT.redraw(ref.current, obj, "hist")
        setError(null)
      } catch (e) {
        if (!cancelled) setError(errorText(e, "Could not draw this histogram"))
      }
    })()
    return () => { cancelled = true }
  }, [fetcher, refreshKey])
  return (
    <div>
      {error && <p className="text-sm text-destructive mb-2">{error}</p>}
      <div ref={ref} style={{ width: "100%", height }} />
    </div>
  )
}

function useTicker(enabled: boolean, ms: number): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const t = setInterval(() => setTick((n) => n + 1), ms)
    return () => clearInterval(t)
  }, [enabled, ms])
  return tick
}

function ChannelSelect({ value, onChange }: { value: number; onChange: (ch: number) => void }) {
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger className="w-36" aria-label="Channel"><SelectValue /></SelectTrigger>
      <SelectContent>
        {CHANNELS.map((ch) => <SelectItem key={ch} value={String(ch)}>Channel {ch + 1}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

// ── settings fields ──────────────────────────────────────────────────────────

type NumField = {
  key: keyof Sis3316BoardSettings
  label: string
  unit?: string
  hint: string
  fixedDuringRun?: boolean
}

const BOARD_FIELDS: NumField[] = [
  { key: "readout_interval_ms", label: "Readout interval", unit: "ms",
    hint: "Banks are swapped and read at least this often; earlier when a bank fills up." },
  { key: "trigger_gate_window", label: "Trigger gate window", unit: "samples",
    hint: "Length of the event window; the energy is taken inside it." },
  { key: "pre_trigger_delay", label: "Pre-trigger delay", unit: "samples",
    hint: "Samples kept before the trigger (max 2042 with this firmware)." },
  { key: "raw_samples", label: "Waveform samples", unit: "samples", fixedDuringRun: true,
    hint: "Raw samples saved per event (0 = no waveforms; max 32000)." },
  { key: "raw_start_index", label: "Waveform start", unit: "samples",
    hint: "First sample of the saved waveform within the event window." },
  { key: "pileup_window", label: "Pileup window", unit: "samples",
    hint: "A second trigger inside this window flags the event as pileup (0 = off)." },
  { key: "repileup_window", label: "Re-pileup window", unit: "samples",
    hint: "Window before the trigger checked for an earlier pulse (0 = off)." },
  { key: "maw_test_buffer_length", label: "Trapezoid trace length", unit: "samples", fixedDuringRun: true,
    hint: "Samples of the filter (MAW) output saved per event, for the Trapezoid tab (0 = none)." },
  { key: "maw_test_buffer_pretrigger", label: "Trapezoid trace pre-trigger", unit: "samples",
    hint: "Trapezoid samples kept before the trigger." },
  { key: "spectrum_bins", label: "Spectrum bins",
    hint: "Bins of the online energy spectra (bin = max energy / divider)." },
]

type ChannelColumn = {
  key: keyof Sis3316ChannelSettings
  label: string
  title: string
  kind: "bool" | "num" | "polarity" | "range" | "cfd"
  width?: string
}

const CHANNEL_COLUMNS: ChannelColumn[] = [
  { key: "enabled", label: "On", title: "Channel records events", kind: "bool" },
  { key: "invert", label: "Polarity", title: "Signal polarity (negative inverts the input)", kind: "polarity" },
  { key: "input_range", label: "Range", title: "Input range", kind: "range" },
  { key: "termination_50ohm", label: "50 Ω", title: "50 Ω termination (off = 1 kΩ)", kind: "bool" },
  { key: "dac_offset", label: "Offset", title: "Offset DAC (32768 = centred range)", kind: "num", width: "w-24" },
  { key: "trigger_threshold", label: "Threshold", title: "Trigger threshold, ADC counts of pulse height", kind: "num" },
  { key: "trigger_peaking", label: "Trig P", title: "Trigger filter peaking time, samples", kind: "num" },
  { key: "trigger_gap", label: "Trig G", title: "Trigger filter gap time, samples", kind: "num" },
  { key: "cfd", label: "CFD", title: "Constant-fraction timing of the trigger", kind: "cfd" },
  { key: "energy_peaking", label: "E P", title: "Energy filter peaking time, samples", kind: "num" },
  { key: "energy_gap", label: "E G", title: "Energy filter gap (flat top), samples", kind: "num" },
  { key: "tau_table", label: "τ table", title: "Decay-correction table (0-3)", kind: "num" },
  { key: "tau_factor", label: "τ factor", title: "Decay-correction factor (0 = off); table 0: τ ≈ 2097 µs / factor at 250 MHz", kind: "num" },
  { key: "histogram_divider", label: "Divider", title: "Spectrum bin = max energy / divider (also the on-board histogram)", kind: "num" },
]

function ChannelCell({ col, value, onChange, ranges, disabled }: {
  col: ChannelColumn; value: unknown; onChange: (v: unknown) => void; ranges: string[]; disabled?: boolean
}) {
  switch (col.kind) {
    case "bool":
      return <Switch checked={!!value} onCheckedChange={onChange} disabled={disabled} aria-label={col.title} />
    case "polarity":
      return (
        <Select value={value ? "neg" : "pos"} onValueChange={(v) => onChange(v === "neg")} disabled={disabled}>
          <SelectTrigger className="h-8 w-24" aria-label={col.title}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="pos">Positive</SelectItem>
            <SelectItem value="neg">Negative</SelectItem>
          </SelectContent>
        </Select>
      )
    case "range":
      return (
        <Select value={String(value)} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger className="h-8 w-20" aria-label={col.title}><SelectValue /></SelectTrigger>
          <SelectContent>{ranges.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
        </Select>
      )
    case "cfd":
      return (
        <Select value={String(value)} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger className="h-8 w-20" aria-label={col.title}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="off">Off</SelectItem>
            <SelectItem value="zero">Zero</SelectItem>
            <SelectItem value="50">50 %</SelectItem>
          </SelectContent>
        </Select>
      )
    default:
      return (
        <Input type="number" className={`h-8 ${col.width ?? "w-20"} font-mono`} value={String(value ?? "")}
               onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
               disabled={disabled} aria-label={col.title} />
      )
  }
}

function SettingsTab({ boardId }: { boardId: string }) {
  const { toast } = useToast()
  const running = useRunStatus((st) => st.isRunning)
  const [saved, setSaved] = useState<Sis3316Settings | null>(null)
  const [draft, setDraft] = useState<Sis3316Settings | null>(null)
  const [clocks, setClocks] = useState<number[]>([250])
  const [ranges, setRanges] = useState<string[]>(["5V", "2V", "1.9V"])
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await getSis3316Settings(boardId)
      setSaved(res.settings)
      setDraft(clone(res.settings))
      setClocks(res.clock_choices)
      setRanges(res.input_ranges)
    } catch (e) {
      toast({ title: "Error", description: errorText(e, "Could not load the settings."), variant: "destructive" })
    }
  }, [boardId, toast])

  useEffect(() => { load() }, [load])

  const dirty = useMemo(() => JSON.stringify(saved) !== JSON.stringify(draft), [saved, draft])

  if (!draft) return <p className="text-sm text-muted-foreground">Loading settings…</p>

  const effective = (ch: number): Sis3316ChannelSettings =>
    ({ ...draft.channel_defaults, ...(draft.channels[String(ch)] ?? {}) })

  const setBoard = (key: keyof Sis3316BoardSettings, value: number | boolean) =>
    setDraft({ ...draft, board: { ...draft.board, [key]: value } })

  const setDefault = (key: keyof Sis3316ChannelSettings, value: unknown) =>
    setDraft({ ...draft, channel_defaults: { ...draft.channel_defaults, [key]: value } })

  const setChannel = (ch: number, key: keyof Sis3316ChannelSettings, value: unknown) => {
    const over = { ...(draft.channels[String(ch)] ?? {}) } as Record<string, unknown>
    if (draft.channel_defaults[key] === value) delete over[key]
    else over[key] = value
    const channels = { ...draft.channels }
    if (Object.keys(over).length) channels[String(ch)] = over as Partial<Sis3316ChannelSettings>
    else delete channels[String(ch)]
    setDraft({ ...draft, channels })
  }

  const resetChannel = (ch: number) => {
    const channels = { ...draft.channels }
    delete channels[String(ch)]
    setDraft({ ...draft, channels })
  }

  async function save() {
    if (!draft) return
    setSaving(true)
    try {
      const res = await setSis3316Settings(boardId, draft)
      setSaved(res.settings)
      setDraft(clone(res.settings))
      toast(res.warning
        ? { title: "Saved, not applied", description: res.warning, variant: "destructive" }
        : { title: "Settings saved",
            description: res.online ? "Applied to the running acquisition at the next bank swap."
                                    : "They apply when the next run starts." })
    } catch (e) {
      toast({ title: "Not saved", description: errorText(e, "The settings were refused."), variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }

  const b = draft.board
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {running ? "A run is going: changes reach the board at the next bank swap. Waveform and trapezoid lengths and the clock are fixed until it stops."
                   : "Changes apply when the next run starts."}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setDraft(clone(saved))} disabled={!dirty || saving}>
            <RotateCcw className="mr-1.5 h-4 w-4" />Discard
          </Button>
          <Button onClick={save} disabled={!dirty || saving}>
            <Save className="mr-1.5 h-4 w-4" />{saving ? "Saving…" : "Save settings"}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Acquisition</CardTitle>
          <CardDescription>Board-wide: the same for all 16 channels.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Sample clock</Label>
              <Select value={String(b.sample_clock_mhz)} disabled={running}
                      onValueChange={(v) => setBoard("sample_clock_mhz", Number(v))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {clocks.map((c) => <SelectItem key={c} value={String(c)}>{c} MHz</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Internal oscillator. 1 sample = {(1000 / b.sample_clock_mhz).toFixed(1)} ns.</p>
            </div>
            {BOARD_FIELDS.map((f) => (
              <div key={String(f.key)} className="space-y-1.5">
                <Label htmlFor={`sis-${String(f.key)}`}>{f.label}{f.unit ? ` (${f.unit})` : ""}</Label>
                <Input id={`sis-${String(f.key)}`} type="number" className="font-mono"
                       value={String(b[f.key] ?? "")} disabled={running && f.fixedDuringRun}
                       onChange={(e) => setBoard(f.key, e.target.value === "" ? 0 : Number(e.target.value))} />
                <p className="text-xs text-muted-foreground">{f.hint}</p>
              </div>
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {([
              ["onboard_histograms", "On-board energy histograms", "The board also histograms every energy itself (On-board histograms tab)."],
              ["maw_test_buffer_energy", "Trapezoid trace shows the energy filter", "Off: the trigger filter instead."],
              ["nim_ti_as_trigger", "NIM input TI as external trigger", "Channels with external trigger on record on a TI pulse."],
              ["nim_ti_timestamp_clear", "NIM input TI clears the timestamp", "For synchronising timestamps with other hardware."],
            ] as [keyof Sis3316BoardSettings, string, string][]).map(([key, label, hint]) => (
              <div key={String(key)} className="flex items-start justify-between gap-4 rounded-md border p-3">
                <div>
                  <p className="text-sm font-medium">{label}</p>
                  <p className="text-xs text-muted-foreground">{hint}</p>
                </div>
                <Switch checked={!!b[key]} onCheckedChange={(v) => setBoard(key, v)} aria-label={label} />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Channels</CardTitle>
          <CardDescription>
            Every channel follows the Defaults row unless it is changed itself (changed values are
            highlighted). Thresholds are in ADC counts of pulse height; times in samples.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ch</TableHead>
                {CHANNEL_COLUMNS.map((c) => <TableHead key={String(c.key)} title={c.title}>{c.label}</TableHead>)}
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow className="bg-muted/40">
                <TableCell className="font-medium">Defaults</TableCell>
                {CHANNEL_COLUMNS.map((c) => (
                  <TableCell key={String(c.key)}>
                    <ChannelCell col={c} value={draft.channel_defaults[c.key]} ranges={ranges}
                                 onChange={(v) => setDefault(c.key, v)} />
                  </TableCell>
                ))}
                <TableCell />
              </TableRow>
              {CHANNELS.map((ch) => {
                const eff = effective(ch)
                const over = draft.channels[String(ch)] ?? {}
                return (
                  <TableRow key={ch}>
                    <TableCell className="font-medium">{ch + 1}</TableCell>
                    {CHANNEL_COLUMNS.map((c) => (
                      <TableCell key={String(c.key)}
                                 className={c.key in over ? "bg-amber-500/10" : undefined}>
                        <ChannelCell col={c} value={eff[c.key]} ranges={ranges}
                                     onChange={(v) => setChannel(ch, c.key, v)} />
                      </TableCell>
                    ))}
                    <TableCell>
                      <Button variant="ghost" size="sm" onClick={() => resetChannel(ch)}
                              disabled={!Object.keys(over).length} title="Back to the defaults">
                        <RotateCcw className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

// ── utilities ────────────────────────────────────────────────────────────────

function OnboardHistogramTab({ boardId }: { boardId: string }) {
  const { toast } = useToast()
  const [channel, setChannel] = useState(0)
  const [bins, setBins] = useState(16384)
  const [auto, setAuto] = useState(true)
  const [manual, setManual] = useState(0)
  const tick = useTicker(auto, 2000)
  const fetcher = useCallback(() => getSis3316OnboardHistogram(boardId, channel, bins),
                              [boardId, channel, bins])

  async function clear(all: boolean) {
    try {
      await clearSis3316OnboardHistograms(boardId, all ? undefined : [channel])
      setManual((n) => n + 1)
      toast({ title: "Cleared", description: all ? "All on-board histograms are empty." : `Channel ${channel + 1} is empty.` })
    } catch (e) {
      toast({ title: "Error", description: errorText(e, "Could not clear."), variant: "destructive" })
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>On-board energy histograms</CardTitle>
        <CardDescription>
          Built by the board itself for every hit (64K bins, bin = max energy / divider), independent of
          the software spectra. Cleared at every run start.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <ChannelSelect value={channel} onChange={setChannel} />
          <div className="space-y-1">
            <Label htmlFor="sis-bins">Bins shown</Label>
            <Input id="sis-bins" type="number" className="w-28" value={bins}
                   onChange={(e) => setBins(Math.max(2, Math.min(65536, Number(e.target.value) || 2)))} />
          </div>
          <div className="flex items-center gap-2 pb-2">
            <Switch checked={auto} onCheckedChange={setAuto} id="sis-auto" />
            <Label htmlFor="sis-auto">Refresh every 2 s</Label>
          </div>
          <Button variant="outline" onClick={() => setManual((n) => n + 1)}>
            <RefreshCw className="mr-1.5 h-4 w-4" />Refresh
          </Button>
          <Button variant="outline" onClick={() => clear(false)}><Trash2 className="mr-1.5 h-4 w-4" />Clear channel</Button>
          <Button variant="outline" onClick={() => clear(true)}><Trash2 className="mr-1.5 h-4 w-4" />Clear all</Button>
        </div>
        <RootPlot fetcher={fetcher} refreshKey={`${tick}-${manual}`} />
      </CardContent>
    </Card>
  )
}

function CountersTab({ boardId }: { boardId: string }) {
  const [data, setData] = useState<{ names: string[]; channels: Record<string, number>[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const tick = useTicker(true, 2000)
  useEffect(() => {
    getSis3316Counters(boardId).then((d) => { setData(d); setError(null) })
      .catch((e) => setError(errorText(e, "Could not read the counters.")))
  }, [boardId, tick])
  const labels: Record<string, string> = {
    internal: "Internal triggers", hit: "Hits recorded", deadtime: "Lost (dead time)",
    pileup: "Pileup", veto: "Vetoed", high_energy: "High-energy suppressed",
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Trigger statistic counters</CardTitle>
        <CardDescription>Counted by the board since the run started (latched at each bank swap).</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {data && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ch</TableHead>
                {data.names.map((n) => <TableHead key={n} className="text-right">{labels[n] ?? n}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.channels.map((row, ch) => (
                <TableRow key={ch}>
                  <TableCell className="font-medium">{ch + 1}</TableCell>
                  {data.names.map((n) => <TableCell key={n} className="text-right font-mono">{row[n].toLocaleString()}</TableCell>)}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

function TrapezoidTab({ boardId }: { boardId: string }) {
  const [channel, setChannel] = useState(0)
  const tick = useTicker(true, 2000)
  const fetcher = useCallback(() => getSis3316Maw(boardId, channel), [boardId, channel])
  return (
    <Card>
      <CardHeader>
        <CardTitle>Filter trace</CardTitle>
        <CardDescription>
          The last recorded output of the energy (or trigger) trapezoid filter — set a trapezoid trace
          length in Settings, then start a run. Use it to tune peaking, gap and the decay correction:
          the flat top should be flat.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ChannelSelect value={channel} onChange={setChannel} />
        <RootPlot fetcher={fetcher} refreshKey={tick} />
      </CardContent>
    </Card>
  )
}

function InfoTab({ boardId, host }: { boardId: string; host: string }) {
  const [info, setInfo] = useState<Sis3316Info | null>(null)
  const [error, setError] = useState<string | null>(null)
  const tick = useTicker(true, 5000)
  useEffect(() => {
    getSis3316Info(boardId).then((d) => { setInfo(d); setError(null) })
      .catch((e) => setError(errorText(e, `The SIS3316 at ${host} did not answer.`)))
  }, [boardId, host, tick])
  return (
    <Card>
      <CardHeader>
        <CardTitle>Board</CardTitle>
        <CardDescription>Read from the board over the network.</CardDescription>
      </CardHeader>
      <CardContent>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {info && (
          <dl className="grid max-w-xl grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Model</dt><dd>{info.model} ({info.adc_type})</dd>
            <dt className="text-muted-foreground">Serial number</dt><dd className="font-mono">{info.serial}</dd>
            <dt className="text-muted-foreground">IP / MAC address</dt><dd className="font-mono">{host} / {info.mac}</dd>
            <dt className="text-muted-foreground">VME FPGA firmware</dt><dd className="font-mono">{info.vme_fpga_firmware}</dd>
            <dt className="text-muted-foreground">ADC FPGA firmware</dt><dd className="font-mono">{info.adc_fpga_firmware?.join(", ")}</dd>
            <dt className="text-muted-foreground">UDP protocol</dt><dd>{info.udp_protocol}</dd>
            <dt className="text-muted-foreground">Hardware version</dt><dd>{info.hardware_version}</dd>
            <dt className="text-muted-foreground">Sample clock</dt><dd>{info.sample_clock_mhz} MHz</dd>
            <dt className="text-muted-foreground">Temperature</dt>
            <dd className={info.temperature_c > 50 ? "text-amber-600" : undefined}>
              {info.temperature_c.toFixed(1)} °C{info.temperature_c > 50 ? " — above the 50 °C Struck recommends" : ""}
            </dd>
          </dl>
        )}
      </CardContent>
    </Card>
  )
}

/** The DAQ page for an SIS3316: settings plus the board's own utilities. */
export function Sis3316Dashboard({ board }: BoardProps) {
  const id = String(board.id)
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Struck SIS3316 — board {id}</h2>
        <p className="text-sm text-muted-foreground">Ethernet, {board.link_num}</p>
      </div>
      <Tabs defaultValue="settings">
        <TabsList className="flex flex-wrap h-auto">
          <TabsTrigger value="settings">Settings</TabsTrigger>
          <TabsTrigger value="onboard">On-board histograms</TabsTrigger>
          <TabsTrigger value="counters">Counters</TabsTrigger>
          <TabsTrigger value="trapezoid">Filter trace</TabsTrigger>
          <TabsTrigger value="info">Board info</TabsTrigger>
        </TabsList>
        <TabsContent value="settings"><SettingsTab boardId={id} /></TabsContent>
        <TabsContent value="onboard"><OnboardHistogramTab boardId={id} /></TabsContent>
        <TabsContent value="counters"><CountersTab boardId={id} /></TabsContent>
        <TabsContent value="trapezoid"><TrapezoidTab boardId={id} /></TabsContent>
        <TabsContent value="info"><InfoTab boardId={id} host={board.link_num} /></TabsContent>
      </Tabs>
    </div>
  )
}
