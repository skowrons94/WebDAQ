"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ReloadIcon } from "@radix-ui/react-icons"
import { Boxes, CalendarClock, Database, FileText, Gauge, HardDrive, Zap } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { InfoTooltip } from "@/components/ui/info-tooltip"
import { MarkdownPreview, RunNotesEditor } from "@/components/run-notes-editor"
import {
  getRuns, getRunDetail, getRunCurrent, getConversionStatus, startConversion,
  type RunSummary, type RunDetail, type CurrentData, type ConversionStatus,
} from "@/lib/api"
import {
  currentUnit, maxMagnitude, formatTick, formatValue,
  CHART_MARGIN, LEGEND_PROPS, yAxisLabel, xAxisLabel,
} from "@/lib/chart-format"

/**
 * The Data dashboard — everything a finished run left behind, in one place.
 *
 * Pick a run and you get its record, the beam current it was taken with (with
 * the charge integrated from the full series), the exact board configuration it
 * ran, and a button to convert the raw .caendat into ROOT. This is the read
 * side of the FAIR story: the acquisition writes provenance, this reads it back.
 */

// ── Formatting helpers ───────────────────────────────────────────────────────

const formatBytes = (bytes: number): string => {
  if (!bytes) return "—"
  const units = ["B", "kB", "MB", "GB", "TB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

const formatDuration = (seconds: number | null): string => {
  if (seconds === null || seconds === undefined) return "—"
  if (seconds < 60) return `${seconds.toFixed(1)} s`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.round(seconds % 60)
  return h > 0 ? `${h} h ${m} min` : `${m} min ${s} s`
}

/** Local wall-clock: the server sends ISO without a zone deliberately. */
const formatTime = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString() : "—"

/** Charge in whichever unit keeps the number readable. */
const formatCharge = (uC: number): string => {
  const abs = Math.abs(uC)
  if (abs >= 1e3) return `${(uC / 1e3).toFixed(4)} mC`
  if (abs < 1e-1 && abs > 0) return `${(uC * 1e3).toFixed(3)} nC`
  return `${uC.toFixed(4)} µC`
}

const FLAG_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  good: "default", bad: "destructive", unknown: "secondary",
}

/** One label/value row. */
function Field({ label, value, hint }: { label: string; value?: React.ReactNode; hint?: string }) {
  const empty = value === undefined || value === null || value === ""
  return (
    <div className="flex justify-between gap-4 py-1 border-b border-border/40 last:border-0">
      <span className="text-xs text-muted-foreground shrink-0 flex items-center gap-1.5">
        {label}
        {hint && <InfoTooltip text={hint} />}
      </span>
      <span className={`text-xs text-right ${empty ? "text-muted-foreground" : ""}`}>
        {empty ? "—" : value}
      </span>
    </div>
  )
}

// ── Beam current ─────────────────────────────────────────────────────────────

// Distinct hues that stay legible in both themes.
const CHANNEL_COLOURS = ["#2563eb", "#16a34a", "#ea580c", "#9333ea", "#0891b2"]

function CurrentTab({ runNumber }: { runNumber: number }) {
  const [data, setData] = useState<CurrentData | null>(null)
  const [loading, setLoading] = useState(true)
  const { toast } = useToast()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    getRunCurrent(runNumber)
      .then(d => { if (!cancelled) setData(d) })
      .catch(error => {
        if (cancelled) return
        // A run with no data directory simply has no current log — that is a
        // normal state to report, not an error to raise.
        const status = (error as { response?: { status?: number } })?.response?.status
        if (status === 404) {
          setData({
            available: false, start_time: null, columns: [], samples: [],
            n_samples: 0, downsampled: false, integration: null,
          })
          return
        }
        toast({
          title: "Error", description: "Could not read the current log for this run.",
          variant: "destructive",
        })
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [runNumber, toast])

  // The log is in µA; scale to whatever unit keeps the axis readable.
  const { scale, unit } = useMemo(() => {
    if (!data?.samples?.length) return { scale: 1, unit: "µA" }
    return currentUnit(maxMagnitude(data.samples.flatMap(row => row.slice(1))))
  }, [data])

  // Recharts wants objects; the API sends rows to keep the payload small.
  const chartData = useMemo(() => {
    if (!data?.samples?.length) return []
    const channels = data.columns.slice(1)
    return data.samples.map(row => {
      const point: Record<string, number> = { t: row[0] }
      channels.forEach((name, i) => { point[name] = row[i + 1] * scale })
      return point
    })
  }, [data, scale])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <ReloadIcon className="mr-2 h-4 w-4 animate-spin" /> Reading current log…
      </div>
    )
  }

  if (!data?.available) {
    return (
      <Alert>
        <AlertTitle>No beam current recorded</AlertTitle>
        <AlertDescription>
          This run has no <span className="font-mono">current.txt</span>. The current is only
          logged when a TetrAMM or RBD 9103 is connected and acquiring while the run is saved.
        </AlertDescription>
      </Alert>
    )
  }

  const channels = data.columns.slice(1)

  return (
    <div className="space-y-6">
      {/* Integrated charge — the headline number */}
      <div>
        <h4 className="text-sm font-semibold mb-1">Integrated Charge</h4>
        <p className="text-xs text-muted-foreground mb-3">
          Trapezoidal integration of the measured current over{" "}
          {formatDuration(data.integration?.duration_s ?? null)}, computed on all{" "}
          {data.n_samples.toLocaleString()} samples.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {data.integration?.channels.map((c, i) => (
            <Card key={c.name}>
              <CardContent className="pt-4">
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: CHANNEL_COLOURS[i % CHANNEL_COLOURS.length] }}
                  />
                  <span className="text-xs text-muted-foreground">{c.name}</span>
                </div>
                <div className="text-lg font-semibold mt-1">{formatCharge(c.charge_uC)}</div>
                <div className="text-xs text-muted-foreground">
                  mean {c.mean_current_uA.toFixed(4)} µA
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      <Separator />

      {/* The current itself */}
      <div>
        <div className="flex items-baseline justify-between mb-3">
          <h4 className="text-sm font-semibold">Beam Current</h4>
          <span className="text-xs text-muted-foreground">
            {data.downsampled
              ? `showing ${chartData.length.toLocaleString()} of ${data.n_samples.toLocaleString()} samples`
              : `${data.n_samples.toLocaleString()} samples`}
          </span>
        </div>
        <div className="h-80 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={CHART_MARGIN}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="t" type="number" domain={["dataMin", "dataMax"]}
                tickFormatter={(v: number) => v.toFixed(0)}
                minTickGap={32}
                label={xAxisLabel("Time (s)")}
                tick={{ fontSize: 11 }}
              />
              <YAxis
                tickFormatter={formatTick}
                width={64}
                label={yAxisLabel(`Current (${unit})`)}
                tick={{ fontSize: 11 }}
              />
              <Tooltip
                labelFormatter={(v: number) => `t = ${Number(v).toFixed(2)} s`}
                formatter={(v: number, name: string) => [formatValue(v, unit), name]}
                contentStyle={{ fontSize: 12 }}
              />
              <Legend {...LEGEND_PROPS} />
              {channels.map((name, i) => (
                <Line
                  key={name} type="monotone" dataKey={name} dot={false} strokeWidth={1.5}
                  stroke={CHANNEL_COLOURS[i % CHANNEL_COLOURS.length]} isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
        {data.start_time && (
          <p className="text-xs text-muted-foreground mt-2">
            Logging started {data.start_time}; time is relative to that.
          </p>
        )}
      </div>
    </div>
  )
}

// ── Board configuration ──────────────────────────────────────────────────────

function BoardsTab({ detail }: { detail: RunDetail }) {
  const [filter, setFilter] = useState("")

  if (detail.board_info.length === 0 && detail.board_configs.length === 0) {
    return (
      <Alert>
        <AlertTitle>No board record</AlertTitle>
        <AlertDescription>
          This run predates board-provenance recording, or was taken without saving data.
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="space-y-6">
      {/* What the CAEN API reported at run start */}
      {detail.board_info.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {detail.board_info.map(b => (
            <Card key={b.board_id}>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                  {b.configured_name ?? b.model_name}
                  <Badge variant="outline" className="text-xs font-mono">{b.dpp_type}</Badge>
                  <Badge
                    variant={b.sync_role === "master" ? "default" : b.sync_role === "slave" ? "outline" : "secondary"}
                    className="text-xs"
                  >
                    {b.sync_role}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Field label="Model" value={`${b.model_name} (${b.model})`} />
                <Field label="Serial number" value={b.serial_number} />
                <Field label="Channels" value={`${b.channels} × ${b.adc_bits} bit`} />
                <Field label="ROC firmware" value={b.roc_firmware} />
                <Field label="AMC firmware" value={b.amc_firmware} />
                <Field label="DPP licence" value={b.license || undefined} />
                <Field label="Start mode" value={b.start_mode_name}
                  hint="Acquisition Control 0x8100 bits [1:0] — how this board's run was started." />
                <Field label="Sampling" value={b.ns_per_sample ? `${b.ns_per_sample} ns/sample` : undefined} />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* The complete register dumps stored next to the data */}
      {detail.board_configs.length > 0 && (
        <div>
          <div className="flex items-baseline justify-between gap-4 mb-1">
            <h4 className="text-sm font-semibold">Register Configuration</h4>
            <Input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Filter registers…"
              className="h-8 w-56 text-xs"
            />
          </div>
          <p className="text-xs text-muted-foreground mb-3">
            The exact register dump each board ran with, copied into the run directory at
            start. This is what makes the run reproducible.
          </p>
          <div className="space-y-4">
            {detail.board_configs.map(config => {
              const rows = Object.entries(config.registers)
                .filter(([key, r]) =>
                  !filter ||
                  r.name.toLowerCase().includes(filter.toLowerCase()) ||
                  key.toLowerCase().includes(filter.toLowerCase()) ||
                  r.address.toLowerCase().includes(filter.toLowerCase()))
                .sort((a, b) => a[1].address.localeCompare(b[1].address))
              return (
                <Card key={config.file}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-mono flex items-center gap-2">
                      {config.file}
                      <span className="text-xs font-sans font-normal text-muted-foreground">
                        {rows.length} of {config.n_registers} registers
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="max-h-80 overflow-auto">
                      <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-background">
                          <tr className="border-b text-muted-foreground">
                            <th className="text-left py-1.5 pr-3 font-medium">Register</th>
                            <th className="text-left py-1.5 pr-3 font-medium">Ch</th>
                            <th className="text-left py-1.5 pr-3 font-medium">Address</th>
                            <th className="text-right py-1.5 font-medium">Value</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map(([key, r]) => (
                            <tr key={key} className="border-b border-border/40 last:border-0">
                              <td className="py-1 pr-3">{r.name}</td>
                              <td className="py-1 pr-3 text-muted-foreground">{r.channel}</td>
                              <td className="py-1 pr-3 font-mono text-muted-foreground">{r.address}</td>
                              <td className="py-1 text-right font-mono">{r.value}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {rows.length === 0 && (
                        <p className="text-xs text-muted-foreground py-3">No register matches “{filter}”.</p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ── ROOT conversion ──────────────────────────────────────────────────────────

function ConvertTab({ detail, onConverted }: { detail: RunDetail; onConverted: () => void }) {
  const [status, setStatus] = useState<ConversionStatus | null>(null)
  const [starting, setStarting] = useState(false)
  const [tsUnit, setTsUnit] = useState("ps")
  const { toast } = useToast()

  const refresh = useCallback(async () => {
    try { setStatus(await getConversionStatus(detail.run_number)) } catch { /* transient */ }
  }, [detail.run_number])

  useEffect(() => { refresh() }, [refresh])

  // Poll only while a conversion is actually in flight.
  useEffect(() => {
    if (status?.state !== "running") return
    const id = setInterval(() => {
      refresh().then(() => { /* onConverted fires on the transition below */ })
    }, 2000)
    return () => clearInterval(id)
  }, [status?.state, refresh])

  // Refresh the run list once a conversion finishes, so the ROOT badge appears.
  useEffect(() => {
    if (status?.state === "done") onConverted()
  }, [status?.state, onConverted])

  const launch = async () => {
    setStarting(true)
    try {
      const result = await startConversion(detail.run_number,
        status?.capabilities?.ts_unit ? { ts_unit: tsUnit } : {})
      setStatus(result as ConversionStatus)
      toast({ title: "Conversion started", description: result?.message })
    } catch (error) {
      const message = (error as { response?: { data?: { message?: string } } })
        ?.response?.data?.message
      toast({
        title: "Cannot convert",
        description: message ?? "Could not start the conversion.",
        variant: "destructive",
      })
      refresh()
    } finally {
      setStarting(false)
    }
  }

  const running = status?.state === "running"
  const noConverter = status && !status.binary

  return (
    <div className="space-y-5">
      <div>
        <h4 className="text-sm font-semibold">Convert to ROOT</h4>
        <p className="text-xs text-muted-foreground mt-1 max-w-3xl">
          Runs RUReader over this run&apos;s <span className="font-mono">.caendat</span> files, in
          name order so a run split across files keeps its time order, and writes{" "}
          <span className="font-mono">run{detail.run_number}.root</span> next to them.
        </p>
      </div>

      {noConverter && (
        <Alert variant="destructive">
          <AlertTitle>RUReader is not installed</AlertTitle>
          <AlertDescription>
            Build it with <span className="font-mono">./install.sh</span>, or set{" "}
            <span className="font-mono">RUREADER_BIN</span> to its path.
          </AlertDescription>
        </Alert>
      )}

      {!detail.has_data && (
        <Alert>
          <AlertTitle>Nothing to convert</AlertTitle>
          <AlertDescription>
            This run has no <span className="font-mono">.caendat</span> files — it was taken
            with data saving switched off.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex items-end gap-4 flex-wrap">
        {status?.capabilities?.ts_unit && (
          <div className="space-y-1.5">
            <Label className="text-xs flex items-center gap-1.5">
              Timestamp unit
              <InfoTooltip text="Unit of the Timestamp branch in the ROOT tree. 'raw' keeps the board's bare counter." />
            </Label>
            <Select value={tsUnit} onValueChange={setTsUnit} disabled={running}>
              <SelectTrigger className="h-9 w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["ps", "ns", "us", "ms", "s", "raw"].map(u => (
                  <SelectItem key={u} value={u}>{u}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <Button onClick={launch} disabled={starting || running || !detail.has_data || !!noConverter}>
          {(starting || running) && <ReloadIcon className="mr-2 h-4 w-4 animate-spin" />}
          {running ? "Converting…" : detail.converted ? "Convert again" : "Convert to ROOT"}
        </Button>

        {status && (
          <Badge
            variant={
              status.state === "done" || status.converted ? "default"
                : status.state === "failed" ? "destructive"
                : status.state === "running" ? "outline" : "secondary"
            }
          >
            {status.state === "idle" && status.converted ? "converted" : status.state}
          </Badge>
        )}
      </div>

      {status?.outputs && status.outputs.length > 0 && (
        <div>
          <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            ROOT output
          </h5>
          {status.outputs.map(name => (
            <div key={name} className="text-xs font-mono">
              {detail.directory}/{name}
            </div>
          ))}
        </div>
      )}

      {status?.log && status.log.length > 0 && (
        <div>
          <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Converter output
            {status.returncode !== null && status.returncode !== undefined && (
              <span className="font-normal normal-case ml-2">exit code {status.returncode}</span>
            )}
          </h5>
          <pre className="max-h-72 overflow-auto rounded-md bg-muted/50 p-3 text-xs whitespace-pre-wrap">
            {status.log.join("\n")}
          </pre>
        </div>
      )}
    </div>
  )
}

// ── Overview ─────────────────────────────────────────────────────────────────

function OverviewTab({ detail }: { detail: RunDetail }) {
  const sw = detail.software_versions ?? {}
  const f = detail.files
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Run</CardTitle></CardHeader>
        <CardContent>
          <Field label="Run number" value={detail.run_number} />
          <Field label="Type" value={detail.run_type} />
          <Field label="Target" value={detail.target_name} />
          <Field label="Started" value={formatTime(detail.start_time)} />
          <Field label="Stopped" value={formatTime(detail.end_time)} />
          <Field label="Duration" value={formatDuration(detail.duration_s)} />
          <Field label="Terminal voltage" value={detail.terminal_voltage} />
          <Field label="Probe voltage" value={detail.probe_voltage} />
          <Field label="User ID" value={detail.user_id} />
          <Field
            label="Accumulated charge"
            value={detail.accumulated_charge !== null ? `${detail.accumulated_charge} µC` : undefined}
            hint="Recorded by the current module at run stop. The Beam Current tab re-integrates the logged series independently."
          />
          <Field label="Quality flag" value={<Badge variant={FLAG_VARIANT[detail.flag] ?? "secondary"}>{detail.flag}</Badge>} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Acquisition</CardTitle></CardHeader>
        <CardContent>
          <Field
            label="Synchronisation" value={detail.sync_mode}
            hint="'daisy-chain' means the boards were armed and started together, so their timestamps share one time origin."
          />
          <Field label="Boards" value={detail.board_info.length || undefined} />
          <Field label="WebDAQ" value={sw.webdaq} />
          <Field label="CaenDAQ" value={sw.caendaq ?? undefined} />
          <Field
            label="Acquisition mode" value={sw.acquisition_mode}
            hint="'mock' means the data was generated in test mode, not read from real boards."
          />
          <Field label="Python" value={sw.python} />
          <Field label="Platform" value={sw.platform} />
          <Separator className="my-2" />
          <Field label="Directory" value={<span className="font-mono">{detail.directory}</span>} />
          <Field label="Data files" value={`${f.data.length} (${formatBytes(f.data.reduce((s, x) => s + x.bytes, 0))})`} />
          <Field label="Board configs" value={f.board_config.length || undefined} />
          <Field label="Current log" value={f.current ? formatBytes(f.current.bytes) : undefined} />
          <Field label="ROOT output" value={f.root.length ? f.root.map(r => r.name).join(", ") : undefined} />
          <Field label="Total size" value={formatBytes(f.total_bytes)} />
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader className="pb-3"><CardTitle className="text-base">Notes</CardTitle></CardHeader>
        <CardContent>
          {detail.notes ? (
            <p className="text-sm whitespace-pre-wrap">{detail.notes}</p>
          ) : (
            <p className="text-sm text-muted-foreground">No notes recorded for this run.</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function SummaryMetric({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: React.ReactNode
  detail?: string
}) {
  return (
    <div className="min-w-0 rounded-xl border border-border/60 bg-background/70 p-3.5 shadow-sm">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Icon className="h-3.5 w-3.5 text-primary" />
        {label}
      </div>
      <div className="mt-1.5 truncate text-lg font-semibold tabular-nums">{value}</div>
      {detail && <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{detail}</div>}
    </div>
  )
}

function LogbookRunHeader({
  detail,
  action,
}: {
  detail: RunDetail
  action?: React.ReactNode
}) {
  const runTypeLabels: Record<string, string> = {
    longrun: "Long Run",
    background: "Background",
    calibration: "Calibration",
    scan: "Scan",
  }
  const runType = detail.run_type
    ? runTypeLabels[detail.run_type.toLowerCase()]
      ?? detail.run_type.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
    : "Unspecified run type"

  return (
    <section className="overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-muted/40 shadow-sm">
      <div className="p-5 sm:p-6">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div className="min-w-0">
            <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Logbook entry
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-3xl font-bold tracking-tight">Run {detail.run_number}</h1>
              <Badge variant={FLAG_VARIANT[detail.flag] ?? "secondary"}>{detail.flag}</Badge>
              {detail.sync_mode && <Badge variant="outline">{detail.sync_mode}</Badge>}
              {!detail.complete && <Badge variant="destructive">in progress</Badge>}
            </div>
            <p className="mt-2 text-base font-medium">
              {detail.target_name || "Untitled run"}
            </p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {runType} · started {formatTime(detail.start_time)}
            </p>
          </div>
          {action}
        </div>

        <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <SummaryMetric
            icon={CalendarClock}
            label="Duration"
            value={formatDuration(detail.duration_s)}
            detail={detail.complete ? "completed run" : "still in progress"}
          />
          <SummaryMetric
            icon={Zap}
            label="Accumulated charge"
            value={
              detail.accumulated_charge === null
                ? "—"
                : formatCharge(detail.accumulated_charge)
            }
            detail="recorded at run stop"
          />
          <SummaryMetric
            icon={HardDrive}
            label="Run footprint"
            value={formatBytes(detail.files.total_bytes)}
            detail="all saved run artifacts"
          />
          <SummaryMetric
            icon={Boxes}
            label="Digitizers"
            value={detail.board_info.length || "—"}
            detail={detail.board_info.map((board) => board.configured_name ?? board.model_name).join(", ") || "no board snapshot"}
          />
        </div>
      </div>
    </section>
  )
}

function LogbookOverviewTab({ detail }: { detail: RunDetail }) {
  const sw = detail.software_versions ?? {}
  const files = detail.files

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-3">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <FileText className="h-4 w-4 text-primary" />
            Notes
          </CardTitle>
        </CardHeader>
        <CardContent>
          <MarkdownPreview value={detail.notes ?? ""} compact />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <CalendarClock className="h-4 w-4 text-primary" />
            Timeline
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Field label="Started" value={formatTime(detail.start_time)} />
          <Field label="Stopped" value={formatTime(detail.end_time)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Gauge className="h-4 w-4 text-primary" />
            Run conditions
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Field label="Terminal voltage" value={detail.terminal_voltage} />
          <Field label="Probe voltage" value={detail.probe_voltage} />
          <Field label="Recorded by user" value={detail.user_id} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Database className="h-4 w-4 text-primary" />
            Data products
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Field label="Data files" value={`${files.data.length} (${formatBytes(files.data.reduce((sum, file) => sum + file.bytes, 0))})`} />
          <Field label="Current log" value={files.current ? formatBytes(files.current.bytes) : undefined} />
          <Field label="Board snapshots" value={files.board_config.length || undefined} />
          <Field label="ROOT output" value={files.root.length ? files.root.map((file) => file.name).join(", ") : undefined} />
          <Field label="Directory" value={<span className="font-mono">{detail.directory}</span>} />
        </CardContent>
      </Card>

      <Card className="lg:col-span-3">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Boxes className="h-4 w-4 text-primary" />
            Acquisition provenance
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-x-8 md:grid-cols-2 xl:grid-cols-5">
            <Field
              label="Mode"
              value={sw.acquisition_mode}
              hint="'mock' means the data was generated in test mode, not read from real boards."
            />
            <Field label="WebDAQ" value={sw.webdaq} />
            <Field label="CaenDAQ" value={sw.caendaq ?? undefined} />
            <Field label="Python" value={sw.python} />
            <Field label="Platform" value={sw.platform} />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// ── Shared run detail ────────────────────────────────────────────────────────

function RunDetailTabs({
  detail,
  onConverted,
  variant = "data",
  onNotesSaved,
  headerAction,
}: {
  detail: RunDetail
  onConverted: () => void
  variant?: "data" | "logbook"
  onNotesSaved?: (notes: string) => void
  headerAction?: React.ReactNode
}) {
  if (variant === "logbook") {
    return (
      <div className="space-y-5">
        <LogbookRunHeader detail={detail} action={headerAction} />

        <Tabs defaultValue="overview">
          <TabsList className="grid h-auto w-full grid-cols-3 gap-1 rounded-xl p-1 sm:grid-cols-5">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="notes">Notes</TabsTrigger>
            <TabsTrigger value="current">Beam Current</TabsTrigger>
            <TabsTrigger value="boards">Boards</TabsTrigger>
            <TabsTrigger value="convert">Convert</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-4">
            <LogbookOverviewTab detail={detail} />
          </TabsContent>
          <TabsContent
            value="notes"
            forceMount
            className="mt-4 data-[state=inactive]:hidden"
          >
            <RunNotesEditor
              runNumber={detail.run_number}
              notes={detail.notes}
              onSaved={onNotesSaved ?? (() => undefined)}
            />
          </TabsContent>
          <TabsContent value="current" className="mt-4">
            <CurrentTab runNumber={detail.run_number} />
          </TabsContent>
          <TabsContent value="boards" className="mt-4">
            <BoardsTab detail={detail} />
          </TabsContent>
          <TabsContent value="convert" className="mt-4">
            <ConvertTab detail={detail} onConverted={onConverted} />
          </TabsContent>
        </Tabs>
      </div>
    )
  }

  return (
    <>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <h2 className="text-lg font-semibold">Run {detail.run_number}</h2>
        <Badge variant={FLAG_VARIANT[detail.flag] ?? "secondary"}>{detail.flag}</Badge>
        {detail.sync_mode && <Badge variant="outline">{detail.sync_mode}</Badge>}
        {!detail.complete && <Badge variant="destructive">in progress</Badge>}
      </div>

      <Tabs defaultValue="overview">
        <TabsList className="grid w-full max-w-2xl grid-cols-4">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="current">Beam Current</TabsTrigger>
          <TabsTrigger value="boards">Boards</TabsTrigger>
          <TabsTrigger value="convert">Convert</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <OverviewTab detail={detail} />
        </TabsContent>
        <TabsContent value="current" className="mt-4">
          <CurrentTab runNumber={detail.run_number} />
        </TabsContent>
        <TabsContent value="boards" className="mt-4">
          <BoardsTab detail={detail} />
        </TabsContent>
        <TabsContent value="convert" className="mt-4">
          <ConvertTab detail={detail} onConverted={onConverted} />
        </TabsContent>
      </Tabs>
    </>
  )
}

/**
 * Standalone detail view used by a logbook entry route. Keeping this loader
 * here means the Data dashboard and the Logbook always render a run with the
 * same fields, plots and provenance controls.
 */
export function RunDetailView({ runNumber }: { runNumber: number }) {
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadDetail = useCallback(async () => {
    setLoading(true)
    try {
      setDetail(await getRunDetail(runNumber))
      setError(null)
    } catch (requestError) {
      const status = (requestError as { response?: { status?: number } })?.response?.status
      setDetail(null)
      setError(
        status === 404
          ? `Run ${runNumber} was not found in the logbook.`
          : `Could not load run ${runNumber}.`,
      )
    } finally {
      setLoading(false)
    }
  }, [runNumber])

  useEffect(() => { loadDetail() }, [loadDetail])

  if (loading && !detail) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <ReloadIcon className="mr-2 h-4 w-4 animate-spin" /> Loading run…
      </div>
    )
  }

  if (error || !detail) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Run unavailable</AlertTitle>
        <AlertDescription>{error ?? `Could not load run ${runNumber}.`}</AlertDescription>
      </Alert>
    )
  }

  const handleNotesSaved = (notes: string) => {
    setDetail((current) => current ? { ...current, notes } : current)
  }

  return (
    <RunDetailTabs
      detail={detail}
      onConverted={loadDetail}
      variant="logbook"
      onNotesSaved={handleNotesSaved}
      headerAction={
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={loadDetail}
          disabled={loading}
        >
          {loading && <ReloadIcon className="mr-2 h-4 w-4 animate-spin" />}
          Refresh
        </Button>
      }
    />
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function DataDashboard() {
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [loadingRuns, setLoadingRuns] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const { toast } = useToast()

  const loadRuns = useCallback(async () => {
    setLoadingRuns(true)
    try {
      const response = await getRuns()
      setRuns(response.runs)
      setError(null)
      // Land on the newest run that actually has something to look at.
      setSelected(prev => prev ?? (response.runs.find(r => r.has_data) ?? response.runs[0])?.run_number ?? null)
    } catch {
      setError("Could not load the list of runs.")
    } finally {
      setLoadingRuns(false)
    }
  }, [])

  useEffect(() => { loadRuns() }, [loadRuns])

  useEffect(() => {
    if (selected === null) { setDetail(null); return }
    let cancelled = false
    setLoadingDetail(true)
    getRunDetail(selected)
      .then(d => { if (!cancelled) setDetail(d) })
      .catch(() => {
        if (!cancelled) toast({
          title: "Error", description: `Could not load run ${selected}.`, variant: "destructive",
        })
      })
      .finally(() => { if (!cancelled) setLoadingDetail(false) })
    return () => { cancelled = true }
  }, [selected, toast])

  const visibleRuns = useMemo(() => {
    if (!search.trim()) return runs
    const q = search.toLowerCase()
    return runs.filter(r =>
      String(r.run_number).includes(q) ||
      (r.run_type ?? "").toLowerCase().includes(q) ||
      (r.target_name ?? "").toLowerCase().includes(q) ||
      (r.notes ?? "").toLowerCase().includes(q) ||
      r.flag.toLowerCase().includes(q))
  }, [runs, search])

  if (loadingRuns && runs.length === 0) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <ReloadIcon className="mr-2 h-4 w-4 animate-spin" /> Loading runs…
      </div>
    )
  }

  if (error) {
    return <Alert variant="destructive"><AlertTitle>Error</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Data</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Completed runs, the beam current they were taken with, the boards that took
            them, and conversion to ROOT.
          </p>
        </div>
        <Button variant="outline" onClick={loadRuns} disabled={loadingRuns}>
          {loadingRuns && <ReloadIcon className="mr-2 h-4 w-4 animate-spin" />} Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[20rem_1fr] gap-6 items-start">
        {/* Run picker */}
        <Card className="lg:sticky lg:top-4">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Runs</CardTitle>
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search run, target, type…"
              className="h-8 text-xs mt-2"
            />
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-[32rem] overflow-auto">
              {visibleRuns.length === 0 ? (
                <p className="text-sm text-muted-foreground px-6 pb-4">
                  {runs.length === 0 ? "No runs recorded yet." : "No run matches that search."}
                </p>
              ) : visibleRuns.map(run => (
                <button
                  key={run.run_number}
                  onClick={() => setSelected(run.run_number)}
                  className={`w-full text-left px-6 py-2.5 border-b border-border/40 last:border-0 transition-colors ${
                    selected === run.run_number ? "bg-muted" : "hover:bg-muted/50"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">Run {run.run_number}</span>
                    <div className="flex items-center gap-1">
                      {run.has_data && <Badge variant="outline" className="text-[10px] px-1 py-0">data</Badge>}
                      {run.has_current && <Badge variant="outline" className="text-[10px] px-1 py-0">I</Badge>}
                      {run.converted && <Badge className="text-[10px] px-1 py-0">root</Badge>}
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {run.target_name || run.run_type || "—"} · {formatDuration(run.duration_s)}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {formatTime(run.start_time)}
                  </div>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Detail */}
        <div>
          {loadingDetail && !detail ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <ReloadIcon className="mr-2 h-4 w-4 animate-spin" /> Loading run…
            </div>
          ) : !detail ? (
            <Alert>
              <AlertTitle>Select a run</AlertTitle>
              <AlertDescription>Pick a run on the left to explore it.</AlertDescription>
            </Alert>
          ) : (
            <RunDetailTabs detail={detail} onConverted={loadRuns} />
          )}
        </div>
      </div>
    </div>
  )
}
