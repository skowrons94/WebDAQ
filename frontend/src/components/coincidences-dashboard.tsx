'use client'

/**
 * Online coincidences: the operator writes each gate as a sentence —
 *
 *   Spectrum of [channels] [in coincidence with | with a veto from] [partners]
 *   within ± [window] ns (at least [n] of them)
 *
 * — and watches, live, what it lets through: the gated spectrum of each
 * channel, the Δt spectrum to the partners (to choose the window, and to align
 * the channels in time with one click), and optionally the energy-energy matrix.
 *
 * Only channels on one clock can be compared: the channel picker greys out the
 * boards that do not share a clock with what is already picked, and says why.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  alignCoincGate, getBoardConfiguration, getCoincConfig, getCoincDt, getCoincMatrix,
  getCoincSpectrum, getCoincStatus, getIntervalHistogram, putCoincConfig, resetCoincidences,
  type CoincChannel, type CoincConfig, type CoincGate, type CoincStatus,
} from '@/lib/api'
import { RootPlot } from '@/components/root-plot'
import { boardLabel as sharedBoardLabel } from '@/lib/board-label'
import { formatHz } from '@/lib/format-rate'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NumericInput } from '@/components/ui/numeric-input'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { EmptyState } from '@/components/ui/empty-state'
import { ConfirmAction } from '@/components/ui/confirm-action'
import { useToast } from '@/components/ui/use-toast'
import { AlertTriangle, ChevronDown, Crosshair, GitMerge, Plus, RotateCcw, Save, Trash2, Undo2, X } from 'lucide-react'

type Board = { id: string; name: string; chan: number; dpp?: string; vendor?: string }

const REFRESH_MS = 2500

const key = (c: CoincChannel) => `${c.board}:${c.channel}`

function newGate(index: number): CoincGate {
  return {
    id: Math.random().toString(16).slice(2, 10),
    name: `Gate ${index}`,
    enabled: true,
    channels: [],
    partners: [],
    mode: 'coincidence',
    window_ns: 100,
    min_partners: 1,
    dt_range_ns: 1000,
    matrix: false,
  }
}

function formatCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} G`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} M`
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)} k`
  return n.toLocaleString()
}

// The site's one rate format (lib/format-rate.ts).
const formatRate = (r: number) => formatHz(r)

// ───────────────────────────────────────────────────────────── channel picking

function boardLabel(b: Board | undefined, id: string) {
  return sharedBoardLabel(b, id)
}

// The words of the axes, the same on every plot of the page. The server sends
// the gated spectrum on 0…N channels, or mapped to keV when the channel is
// calibrated (its axis then no longer starts at 0).
const COUNTS = 'Counts / bin'
const energyTitle = (h: any) => (h?.fXaxis && Number(h.fXaxis.fXmin) !== 0 ? 'Energy (keV)' : 'ADC channel')

function ChannelChips({ value, boards, onRemove, empty }: {
  value: CoincChannel[]
  boards: Board[]
  onRemove?: (c: CoincChannel) => void
  empty: string
}) {
  if (!value.length) return <span className="text-sm italic text-muted-foreground">{empty}</span>
  return (
    <span className="inline-flex flex-wrap gap-1">
      {value.map((c) => (
        // One chip never breaks between the board's name and its number.
        <Badge key={key(c)} variant="secondary" className={`gap-1 whitespace-nowrap font-normal ${onRemove ? 'py-0 pr-0' : ''}`}>
          {boardLabel(boards.find((b) => b.id === c.board), c.board)} · ch {c.channel}
          {onRemove && (
            // The × is small, its hit area is not: 32 px, enough for a finger.
            <button type="button" aria-label={`Remove channel ${c.channel}`} onClick={() => onRemove(c)}
                    className="-my-1 inline-flex h-8 w-8 items-center justify-center rounded-sm opacity-60 hover:opacity-100">
              <X className="h-3 w-3" />
            </button>
          )}
        </Badge>
      ))}
    </span>
  )
}

/** A grid of every channel of every board; boards on another clock are off. */
function ChannelPicker({ open, onOpenChange, title, boards, value, other, domains, onChange }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: string
  boards: Board[]
  value: CoincChannel[]
  other: CoincChannel[]            // the other side of the gate, for the clock check
  domains: Record<string, string>
  onChange: (v: CoincChannel[]) => void
}) {
  const [draft, setDraft] = useState<CoincChannel[]>(value)
  useEffect(() => { if (open) setDraft(value) }, [open, value])
  const picked = new Set(draft.map(key))
  const anchor = [...draft, ...other][0]
  const anchorDomain = anchor ? domains[anchor.board] : undefined

  const toggle = (c: CoincChannel) =>
    setDraft((d) => (picked.has(key(c)) ? d.filter((x) => key(x) !== key(c)) : [...d, c]))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Click channels to add or remove them. Only channels on one clock can be in
            coincidence: one board, or CAEN boards in a synchronised chain.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto">
          {boards.map((b) => {
            const foreign = anchorDomain !== undefined && domains[b.id] !== undefined && domains[b.id] !== anchorDomain
            return (
              <div key={b.id} role="group" aria-label={boardLabel(b, b.id)} className={foreign ? 'opacity-50' : ''}>
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <p className="whitespace-nowrap text-sm font-medium">{boardLabel(b, b.id)}</p>
                  {foreign && <p className="text-xs text-muted-foreground">Different clock from the channels already chosen</p>}
                </div>
                {/* Four across on a phone: eight buttons of a dialog's width
                    each cut off the last one. */}
                <div className="grid grid-cols-4 gap-1 sm:grid-cols-8">
                  {Array.from({ length: Number(b.chan) || 16 }, (_, ch) => {
                    const c = { board: b.id, channel: ch }
                    const on = picked.has(key(c))
                    return (
                      <Button key={ch} type="button" size="sm" variant={on ? 'default' : 'outline'}
                              className="min-w-0 px-0" disabled={foreign && !on} onClick={() => toggle(c)} aria-pressed={on}>
                        {ch}
                      </Button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setDraft([])}>Clear</Button>
          <Button onClick={() => { onChange(draft); onOpenChange(false) }}>Use {draft.length} channel{draft.length === 1 ? '' : 's'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ───────────────────────────────────────────────────────────── one gate

function GateEditor({ gate, boards, domains, problems, onChange, onDelete }: {
  gate: CoincGate
  boards: Board[]
  domains: Record<string, string>
  problems: string[]
  onChange: (g: CoincGate) => void
  onDelete: () => void
}) {
  const [picking, setPicking] = useState<'channels' | 'partners' | null>(null)
  const set = (patch: Partial<CoincGate>) => {
    const next = { ...gate, ...patch }
    // "At least n of them" cannot ask for more partners than there are.
    next.min_partners = Math.max(1, Math.min(next.min_partners, next.partners.length || 1))
    onChange(next)
  }
  const veto = gate.mode === 'anticoincidence'

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input value={gate.name} onChange={(e) => set({ name: e.target.value })} className="h-8 max-w-xs font-medium"
               aria-label="Gate name" />
        <div className="ml-auto flex items-center gap-2">
          <Label htmlFor={`en-${gate.id}`} className="text-sm text-muted-foreground">On</Label>
          <Switch id={`en-${gate.id}`} checked={gate.enabled} onCheckedChange={(v) => set({ enabled: v })} />
          <ConfirmAction title="Delete this gate?" description="It is removed when you save; its spectra are lost."
                         confirmLabel="Delete" onConfirm={onDelete}
                         trigger={<Button variant="ghost" size="icon" aria-label="Delete gate"><Trash2 className="h-4 w-4" /></Button>} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 rounded-md border bg-muted/30 p-3 text-sm leading-8">
        <span>Spectrum of</span>
        <ChannelChips value={gate.channels} boards={boards} empty="no channel"
                      onRemove={(c) => set({ channels: gate.channels.filter((x) => key(x) !== key(c)) })} />
        <Button size="sm" variant="outline" className="h-7" onClick={() => setPicking('channels')}>
          <Plus className="mr-1 h-3 w-3" />Channels
        </Button>
        <Select value={gate.mode} onValueChange={(v) => set({ mode: v as CoincGate['mode'] })}>
          <SelectTrigger className="h-7 w-auto gap-1"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="coincidence">in coincidence with</SelectItem>
            <SelectItem value="anticoincidence">with a veto from</SelectItem>
          </SelectContent>
        </Select>
        <ChannelChips value={gate.partners} boards={boards} empty="no partner"
                      onRemove={(c) => set({ partners: gate.partners.filter((x) => key(x) !== key(c)) })} />
        <Button size="sm" variant="outline" className="h-7" onClick={() => setPicking('partners')}>
          <Plus className="mr-1 h-3 w-3" />Partners
        </Button>
        <span>within ±</span>
        <NumericInput value={gate.window_ns} min={1} step={10} className="h-7 w-24"
                      onValueChange={(v) => v > 0 && set({ window_ns: v })} aria-label="Window in ns" />
        <span>ns</span>
        {!veto && (gate.partners.length > 1 || gate.min_partners > 1) && (
          <>
            <span>, at least</span>
            <NumericInput value={gate.min_partners} min={1} max={gate.partners.length} step={1} className="h-7 w-16"
                          onValueChange={(v) => v >= 1 && set({ min_partners: Math.round(v) })} aria-label="Minimum partners" />
            <span>of them</span>
          </>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {veto
          ? 'A hit is kept when none of the partners fires within the window around it — e.g. a Compton or cosmic veto.'
          : 'A hit is kept when a partner fires within the window around it (before or after).'}
      </p>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <label className="flex items-center gap-2">
          <Checkbox checked={gate.matrix} onCheckedChange={(v) => set({ matrix: v === true })} disabled={veto} />
          Energy–energy matrix
        </label>
        <span className="flex items-center gap-2">
          Δt plot range ±
          <NumericInput value={gate.dt_range_ns} min={1} step={100} className="h-7 w-24"
                        onValueChange={(v) => v > 0 && set({ dt_range_ns: v })} aria-label="Δt range in ns" />
          ns
        </span>
      </div>

      {problems.length > 0 && (
        <div className="space-y-1 rounded-md border border-warning/40 bg-warning/5 p-2 text-xs text-warning">
          {problems.map((p) => <p key={p} className="flex gap-1"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />{p}</p>)}
        </div>
      )}

      <ChannelPicker open={picking === 'channels'} onOpenChange={(o) => !o && setPicking(null)}
                     title="Channels whose spectrum is gated" boards={boards} value={gate.channels}
                     other={gate.partners} domains={domains} onChange={(v) => set({ channels: v })} />
      <ChannelPicker open={picking === 'partners'} onOpenChange={(o) => !o && setPicking(null)}
                     title={veto ? 'Veto channels' : 'Partner channels'} boards={boards} value={gate.partners}
                     other={gate.channels} domains={domains} onChange={(v) => set({ partners: v })} />
    </div>
  )
}

function GateResults({ gate, status, boards, onAligned }: {
  gate: CoincGate
  status: CoincStatus['gates'][number] | undefined
  boards: Board[]
  onAligned: (offsets: Record<string, number>) => void
}) {
  const { toast } = useToast()
  const [channel, setChannel] = useState<string>(key(gate.channels[0]))
  const [partner, setPartner] = useState<string>('*')
  const [logy, setLogy] = useState(false)
  // The Δt peak of real coincidences is a few bins wide in a range many times
  // the window: on a phone it was one line at 0. The plot opens on a few
  // windows around 0; "Full range" shows the whole Δt range.
  const [dtFull, setDtFull] = useState(false)
  const dtZoom = 3 * gate.window_ns
  const dtRange: [number, number] | null = !dtFull && dtZoom < gate.dt_range_ns ? [-dtZoom, dtZoom] : null
  useEffect(() => {
    if (!gate.channels.some((c) => key(c) === channel) && gate.channels[0]) setChannel(key(gate.channels[0]))
  }, [gate.channels, channel])
  const [bid, chs] = channel.split(':')
  const veto = gate.mode === 'anticoincidence'
  const label = (k: string) => {
    const [b, c] = k.split(':')
    return `${boardLabel(boards.find((x) => x.id === b), b)} · ch ${c}`
  }

  const align = async () => {
    try {
      const res = await alignCoincGate(gate.id)
      const moved = Object.entries(res.offsets_ns).map(([k, v]) => `${label(k)}: ${v > 0 ? '+' : ''}${v.toFixed(1)} ns`)
      toast({ title: 'Channels aligned in time', description: `${moved.join(', ')}. The gate starts over with the new offsets.` })
      onAligned(res.offsets_ns)
    } catch (e: any) {
      toast({ title: 'Could not align', description: e?.response?.data?.error ?? String(e), variant: 'destructive' })
    }
  }

  return (
    <div className="space-y-3 border-t pt-3">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
        <span><span className="text-muted-foreground">{veto ? 'Kept (not vetoed)' : 'In coincidence'}: </span>
          <span className="font-semibold tabular-nums">{status ? formatCount(status.passed) : '—'}</span>
          {status?.fraction != null && <span className="text-muted-foreground"> ({(100 * status.fraction).toFixed(1)} % of {formatCount(status.singles)})</span>}
        </span>
        <span><span className="text-muted-foreground">Rate: </span>
          <span className="font-semibold tabular-nums">{status ? formatRate(status.rate) : '—'}</span>
          {status && <span className="text-muted-foreground"> of {formatRate(status.singles_rate)}</span>}
        </span>
        {gate.channels.length > 1 && (
          <Select value={channel} onValueChange={setChannel}>
            <SelectTrigger className="ml-auto h-7 w-auto"><SelectValue /></SelectTrigger>
            <SelectContent>
              {gate.channels.map((c) => <SelectItem key={key(c)} value={key(c)}>{label(key(c))}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <div>
          <div className="mb-1 flex items-center justify-between">
            <p className="text-sm font-medium">{veto ? 'Vetoed spectrum' : 'Gated spectrum'} — {label(channel)}</p>
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              <Checkbox checked={logy} onCheckedChange={(v) => setLogy(v === true)} />Log
            </label>
          </div>
          <RootPlot fetch={() => getCoincSpectrum(gate.id, bid, Number(chs))} deps={[gate.id, channel]} logy={logy}
                    xTitle={energyTitle} yTitle={COUNTS} />
        </div>
        <div>
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium">Δt = t(partner) − t(channel)</p>
              {/* The plot range setting says ±1000 while the axis shows ±300:
                  say that the view is zoomed, and by how much. */}
              <p className="text-xs text-muted-foreground">
                {dtRange
                  ? `Zoomed to ±3 windows (±${dtZoom} ns) of the ±${gate.dt_range_ns} ns plot range`
                  : `Whole plot range, ±${gate.dt_range_ns} ns`}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {gate.partners.length > 1 && (
                <Select value={partner} onValueChange={setPartner}>
                  <SelectTrigger className="h-7 w-auto"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="*">All partners</SelectItem>
                    {gate.partners.map((p) => <SelectItem key={key(p)} value={key(p)}>{label(key(p))}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
              {dtZoom < gate.dt_range_ns && (
                <Button size="sm" variant="outline" className="h-7 pointer-coarse:h-10" aria-pressed={dtFull}
                        onClick={() => setDtFull((v) => !v)}
                        title={dtFull ? `Show ±${dtZoom} ns around 0` : `Show the whole ±${gate.dt_range_ns} ns`}>
                  {dtFull ? 'Around the window' : 'Full range'}
                </Button>
              )}
              <ConfirmAction
                title="Align the partners in time?"
                description={`Each partner's time offset is shifted so that its Δt peak against ${label(key(gate.channels[0]))} sits at 0. The gate's spectra start over.`}
                confirmLabel="Align" onConfirm={align} variant="default"
                trigger={<Button size="sm" variant="outline" className="h-7"><Crosshair className="mr-1 h-3 w-3" />Align in time</Button>} />
            </div>
          </div>
          <RootPlot fetch={() => getCoincDt(gate.id, bid, Number(chs), partner)} deps={[gate.id, channel, partner]}
                    xTitle="Δt (ns)" yTitle={COUNTS} xRange={dtRange} />
          <p className="mt-1 text-xs text-muted-foreground">
            Real coincidences make a peak; the flat floor is chance. Set the window to cover the peak.
          </p>
          {(status?.pairs_skipped ?? 0) > 0 && (
            <p className="mt-1 text-xs text-warning">
              {formatCount(status!.pairs_skipped)} pairs were too many to plot in one go and are missing here: narrow the Δt range.
            </p>
          )}
        </div>
        {gate.matrix && !veto && (
          <div className="xl:col-span-2">
            <p className="text-sm font-medium">Energy of {label(key(gate.channels[0]))} (x) against its partner (y)</p>
            {/* The matrix is filled with raw energies; only the 1-D spectra
                are mapped to keV. Said here so nobody reads keV off it. */}
            <p className="mb-1 text-xs text-muted-foreground">
              Both axes in ADC channels, not calibrated (the gated spectrum above is in keV when its channel is calibrated).
            </p>
            <RootPlot fetch={() => getCoincMatrix(gate.id)} deps={[gate.id]} twoD height={360}
                      xTitle={`${label(key(gate.channels[0]))} (ADC channel, uncalibrated)`} yTitle="Partner (ADC channel, uncalibrated)" />
          </div>
        )}
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────── page

export default function CoincidencesDashboard() {
  const { toast } = useToast()
  const [boards, setBoards] = useState<Board[]>([])
  const [saved, setSaved] = useState<CoincConfig | null>(null)
  const [draft, setDraft] = useState<CoincConfig | null>(null)
  const [status, setStatus] = useState<CoincStatus | null>(null)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [intervalChannel, setIntervalChannel] = useState<string>('')
  const [generation, setGeneration] = useState(0)    // bumps when gates start over

  const load = useCallback(async () => {
    try {
      const [b, cfg] = await Promise.all([getBoardConfiguration(), getCoincConfig()])
      setBoards((b.data ?? []).map((x: any) => ({ ...x, id: String(x.id) })))
      setSaved(cfg)
      setDraft(cfg)
      setLoadError(null)
    } catch (e: any) {
      setLoadError(e?.message ?? 'Could not load the coincidence settings')
    }
  }, [])
  useEffect(() => { load() }, [load])

  useEffect(() => {
    let alive = true
    const poll = async () => {
      try { const s = await getCoincStatus(); if (alive) setStatus(s) } catch { /* keep the last */ }
    }
    poll()
    const t = setInterval(poll, REFRESH_MS)
    return () => { alive = false; clearInterval(t) }
  }, [])

  useEffect(() => {
    if (!intervalChannel && boards[0]) setIntervalChannel(`${boards[0].id}:0`)
  }, [boards, intervalChannel])

  const dirty = useMemo(() => JSON.stringify(saved) !== JSON.stringify(draft), [saved, draft])
  const domains = status?.clock_domains ?? {}

  const save = async () => {
    if (!draft) return
    setSaving(true)
    try {
      const cfg = await putCoincConfig(draft)
      setSaved(cfg)
      setDraft(cfg)
      setGeneration((g) => g + 1)
      toast({ title: 'Coincidences saved', description: status?.running ? 'The gates start over with the new settings.' : 'They apply from the next run.' })
    } catch (e: any) {
      toast({ title: 'Not saved', description: e?.response?.data?.error ?? String(e), variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const reset = async () => {
    await resetCoincidences()
    setGeneration((g) => g + 1)
  }

  if (loadError) {
    return <EmptyState icon={AlertTriangle} title="Could not load the coincidences" action={<Button onClick={load}>Try again</Button>}>{loadError}</EmptyState>
  }
  if (!draft) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>

  const gateStatus = (id: string) => status?.gates.find((g) => g.id === id)
  const live = Boolean(status?.running)
  const late = status?.domains.reduce((n, d) => n + d.late, 0) ?? 0
  const memory = status?.domains.reduce((n, d) => n + d.memory_mb, 0) ?? 0
  const setGate = (i: number, g: CoincGate) => setDraft({ ...draft, gates: draft.gates.map((x, j) => (j === i ? g : x)) })
  const offsets = Object.entries(draft.offsets_ns)
  const [ivBoard, ivChannel] = intervalChannel.split(':')

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              {/* The page heading already says "Coincidences". */}
              <CardTitle className="flex items-center gap-2"><GitMerge className="h-5 w-5" />Gates</CardTitle>
              <CardDescription>
                Spectra of channels gated by other channels, built live during the run. The data files keep every
                hit, so nothing is lost if a gate is wrong.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {/* Collecting is the normal state during a run: green, not the rose of
                  an action or anything that reads as an error. */}
              <Badge variant="outline" className={live ? 'border-success text-success' : ''}>{live ? 'Collecting' : 'Idle — start a run'}</Badge>
              {live && <Badge variant="outline" title="Hits waiting to be compared">{memory.toFixed(1)} MB pending</Badge>}
              {late > 0 && <Badge variant="outline" className="border-warning text-warning"
                                  title="Hits that arrived after their time had been evaluated: raise the latency below">{formatCount(late)} late</Badge>}
              {(status?.dropped ?? 0) > 0 && <Badge variant="outline" className="border-warning text-warning"
                                                    title="Hits not collected in time and lost to the gates (the file has them)">{formatCount(status!.dropped)} hits not seen</Badge>}
              {(status?.skipped_blocks ?? 0) > 0 && <Badge variant="outline" className="border-warning text-warning"
                                                           title="Data blocks the online decoder skipped while behind: their hits are missing from the gates (the file has them)">{formatCount(status!.skipped_blocks)} blocks not decoded</Badge>}
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Button onClick={() => setDraft({ ...draft, gates: [...draft.gates, newGate(draft.gates.length + 1)] })}
                  disabled={draft.gates.length >= 16}>
            <Plus className="mr-1 h-4 w-4" />Add gate
          </Button>
          <Button variant="outline" onClick={reset} disabled={!live}><RotateCcw className="mr-1 h-4 w-4" />Clear spectra</Button>
          <div className="ml-auto flex gap-2">
            {dirty && <Button variant="ghost" onClick={() => setDraft(saved)}><Undo2 className="mr-1 h-4 w-4" />Discard</Button>}
            <Button onClick={save} disabled={!dirty || saving}><Save className="mr-1 h-4 w-4" />{saving ? 'Saving…' : 'Save'}</Button>
          </div>
        </CardContent>
      </Card>

      {draft.gates.length === 0 && (
        <EmptyState icon={GitMerge} title="No coincidence gate yet"
                    action={<Button onClick={() => setDraft({ ...draft, gates: [newGate(1)] })}><Plus className="mr-1 h-4 w-4" />Add a gate</Button>}>
          A gate keeps the hits of some channels that have (or, for a veto, do not have) a partner hit on other
          channels within a time window, and shows their spectrum.
        </EmptyState>
      )}

      {draft.gates.map((gate, i) => {
        const savedGate = saved?.gates.find((g) => g.id === gate.id)
        const unchanged = savedGate && JSON.stringify(savedGate) === JSON.stringify(gate)
        const problems = status?.problems[gate.id] ?? []
        return (
          <Card key={gate.id} className={gate.enabled ? '' : 'opacity-70'}>
            <CardContent className="space-y-3 pt-4">
              <GateEditor gate={gate} boards={boards} domains={domains} problems={unchanged ? problems : []}
                          onChange={(g) => setGate(i, g)}
                          onDelete={() => setDraft({ ...draft, gates: draft.gates.filter((_, j) => j !== i) })} />
              {unchanged && gate.enabled && gate.channels.length > 0 && gate.partners.length > 0 && problems.length === 0 && (
                <GateResults key={`${gate.id}-${generation}`} gate={gate} status={gateStatus(gate.id)} boards={boards}
                             onAligned={(offsets) => {
                               // Only the offsets changed on the server: keep any unsaved edits.
                               setSaved((c) => c && { ...c, offsets_ns: { ...c.offsets_ns, ...offsets } })
                               setDraft((c) => c && { ...c, offsets_ns: { ...c.offsets_ns, ...offsets } })
                               setGeneration((g) => g + 1)
                             }} />
              )}
              {!unchanged && <p className="text-xs text-muted-foreground">Save to build this gate.</p>}
            </CardContent>
          </Card>
        )
      })}

      <Collapsible>
        <Card>
          <CollapsibleTrigger asChild>
            <CardHeader className="cursor-pointer select-none pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <ChevronDown className="h-4 w-4" />Timing settings
              </CardTitle>
              <CardDescription>Per-channel time offsets and how long hits wait for slower boards.</CardDescription>
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Label htmlFor="latency">Wait for slower channels</Label>
                <NumericInput id="latency" value={draft.latency_ms} min={100} step={500} className="h-8 w-28"
                              onValueChange={(v) => v >= 100 && setDraft({ ...draft, latency_ms: Math.round(v) })} />
                <span className="text-muted-foreground">ms of data time. Raise it if hits show up as late (low-rate channels hold their events in the board longer).</span>
              </div>
              <div>
                <p className="mb-2 text-sm font-medium">Time offsets</p>
                {offsets.length === 0 ? (
                  <p className="text-sm text-muted-foreground">None. "Align in time" on a gate sets them from its Δt peaks.</p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {offsets.map(([k, v]) => {
                      const [b, c] = k.split(':')
                      return (
                        <div key={k} className="flex items-center gap-2 text-sm">
                          <span className="min-w-0 flex-1 truncate">{boardLabel(boards.find((x) => x.id === b), b)} · ch {c}</span>
                          <NumericInput value={v} step={1} className="h-8 w-24"
                                        onValueChange={(n) => setDraft({ ...draft, offsets_ns: { ...draft.offsets_ns, [k]: n } })} />
                          <span className="text-muted-foreground">ns</span>
                          <Button variant="ghost" size="icon" aria-label="Remove offset" onClick={() => {
                            const o = { ...draft.offsets_ns }; delete o[k]; setDraft({ ...draft, offsets_ns: o })
                          }}><X className="h-4 w-4" /></Button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">Time between hits</CardTitle>
              <CardDescription>
                A random source gives one smooth bump at 1/rate. A cut on its left is the dead time; a spike at short
                times is double triggering or ringing; sharp lines are a pulser or periodic noise.
              </CardDescription>
            </div>
            <Select value={intervalChannel} onValueChange={setIntervalChannel}>
              <SelectTrigger className="h-8 w-auto"><SelectValue placeholder="Channel" /></SelectTrigger>
              <SelectContent>
                {boards.flatMap((b) => Array.from({ length: Number(b.chan) || 16 }, (_, ch) => (
                  <SelectItem key={`${b.id}:${ch}`} value={`${b.id}:${ch}`}>{boardLabel(b, b.id)} · ch {ch}</SelectItem>
                )))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {intervalChannel && (
            <RootPlot fetch={() => getIntervalHistogram(ivBoard, Number(ivChannel))} deps={[intervalChannel]} logx
                      xTitle="Time between hits (ns)" yTitle={COUNTS} />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
