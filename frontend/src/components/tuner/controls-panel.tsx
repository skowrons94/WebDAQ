'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Calculator, Zap } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import {
  GROUP_TITLES,
  baseAddress,
  controlsFor,
  dcOffsetReading,
  fromDisplay,
  getBits,
  rawHint,
  setBits,
  toDisplay,
  unitLabel,
  type BoardTiming,
  type ControlSpec,
} from '@/components/tuner/units'

export interface RegisterData {
  name: string
  value_dec: number
  value_hex: string
  channel: number
  address: string
}
export type BoardSettings = Record<string, RegisterData>

/** The register key (e.g. "reg_1168") of a control on a channel, or null. */
export function findRegKey(settings: BoardSettings, channel: number, address: number): string | null {
  for (const [k, r] of Object.entries(settings)) {
    if (r.channel === channel && baseAddress(r.address) === address) return k
  }
  return null
}

/** The value a control shows: the pending (unsaved) register value wins. */
export function controlValue(spec: ControlSpec, raw: number): number {
  return spec.bits ? getBits(raw, spec.bits) : raw
}

interface Props {
  dpp: string
  channel: number
  timing: BoardTiming
  settings: BoardSettings
  /** Unsaved register values, keyed by register key. */
  pending: Record<string, number>
  onChange: (regKey: string, newRaw: number) => void
  online: boolean
  isOnlineTunable: (regKey: string) => boolean
  /** Measured baseline from the input trace, to compare with the DC offset estimate. */
  measuredBaseline?: number | null
  /** True while a value is typed but not yet committed. */
  onTyping?: (typing: boolean) => void
  /** The energy-scale calculator for this channel (DAQ page), shown beside rescaling and fine gain. */
  scaleHref?: string
}

/**
 * The channel's controls for its firmware, grouped along the signal chain,
 * each in its physical unit with what it does (P1). Changes are staged in
 * `pending` and written with "Save all".
 */
export function ControlsPanel({
  dpp, channel, timing, settings, pending, onChange, online, isOnlineTunable, measuredBaseline, onTyping, scaleHref,
}: Props) {
  const specs = useMemo(() => controlsFor(dpp), [dpp])
  const rows = specs
    .map((spec) => ({ spec, key: findRegKey(settings, channel, spec.address) }))
    .filter((r): r is { spec: ControlSpec; key: string } => r.key !== null)

  // Typed text, until it is committed (blur or Enter).
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  useEffect(() => { setDrafts({}) }, [channel, dpp])
  // Tell the page while something is typed but not committed (Save all commits it).
  const typing = Object.keys(drafts).length > 0
  useEffect(() => { onTyping?.(typing) }, [typing]) // eslint-disable-line react-hooks/exhaustive-deps

  const rawOf = (key: string) => pending[key] ?? settings[key]?.value_dec ?? 0
  const valueOf = (spec: ControlSpec, key: string) => controlValue(spec, rawOf(key))
  const savedValueOf = (spec: ControlSpec, key: string) => controlValue(spec, settings[key]?.value_dec ?? 0)

  const commit = (spec: ControlSpec, key: string, fieldValue: number) => {
    if (!Number.isFinite(fieldValue)) return
    const base = rawOf(key)
    const next = spec.bits ? setBits(base, spec.bits, fieldValue) : fieldValue
    onChange(key, next)
  }

  const byId = (id: string) => rows.find((r) => r.spec.id === id)
  const negative = (() => {
    const r = byId('invert')
    return r ? valueOf(r.spec, r.key) === 1 : false
  })()

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No settings found for channel {channel}: the board&apos;s register file has none of the
        {dpp.toUpperCase().includes('PSD') ? ' DPP-PSD' : ' DPP-PHA'} registers.
      </p>
    )
  }

  const groups = Array.from(new Set(rows.map((r) => r.spec.group)))

  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <section key={g} aria-labelledby={`tuner-group-${g}`}>
          <h4 id={`tuner-group-${g}`} className="mb-2 text-xs font-semibold text-muted-foreground">
            {GROUP_TITLES[g]}
          </h4>
          <div className="space-y-2.5">
            {rows.filter((r) => r.spec.group === g).map(({ spec, key }) => {
              const id = `tuner-${spec.id}`
              const v = valueOf(spec, key)
              const changed = v !== savedValueOf(spec, key)
              const live = isOnlineTunable(key)
              const notes: { text: string; warn?: boolean }[] = []

              if (spec.unit === 'step' || spec.unit === 'sample') {
                const h = rawHint(v, spec.unit, timing)
                if (h) notes.push({ text: h })
              }
              if (spec.id === 'dc') {
                const r = dcOffsetReading(v, negative, timing)
                notes.push({ text: `baseline ≈ ${r.baseline} LSB, headroom ≈ ${r.headroom} LSB (${r.headroomPct} %) for ${negative ? 'negative' : 'positive'} pulses` })
                if (r.headroomPct < 15) notes.push({ text: 'Little headroom: large pulses will clip.', warn: true })
                if (measuredBaseline != null && Math.abs(measuredBaseline - r.baseline) > timing.adcMax * 0.1) {
                  notes.push({ text: `The trace shows the baseline at ${Math.round(measuredBaseline)} LSB: trust the trace.`, warn: true })
                }
              }
              if ((spec.id === 'rise' || spec.id === 'decay' || spec.id === 'finegain' || spec.id === 'rescale') && changed) {
                notes.push({ text: 'The energy gain depends on the rise and decay times, fine gain and rescaling: the peaks move, so check the calibration after this change.', warn: true })
              }
              if (spec.id === 'peaking') {
                const flat = byId('flat')
                if (flat && v >= valueOf(flat.spec, flat.key)) {
                  notes.push({ text: 'Longer than the flat top: the energy is sampled on the falling edge.', warn: true })
                }
              }
              if (spec.id === 'sgate') {
                const lg = byId('lgate')
                if (lg && v >= valueOf(lg.spec, lg.key)) notes.push({ text: 'The short gate must be shorter than the long gate.', warn: true })
              }

              const unit = unitLabel(spec.unit, timing)
              const control = (() => {
                if (spec.unit === 'bool') {
                  const on = spec.onValue ?? 1
                  return (
                    <Switch
                      id={id}
                      checked={v === on}
                      onCheckedChange={(c) => commit(spec, key, c ? on : on ^ 1)}
                    />
                  )
                }
                if (spec.unit === 'enum' && spec.options) {
                  const known = spec.options.some((o) => o.value === v)
                  return (
                    <Select value={known ? String(v) : ''} onValueChange={(s) => commit(spec, key, Number(s))}>
                      <SelectTrigger id={id} className="h-8 w-44 text-sm" aria-label={spec.label}>
                        <SelectValue placeholder={`Other (${v})`} />
                      </SelectTrigger>
                      <SelectContent>
                        {spec.options.map((o) => (
                          <SelectItem key={o.value} value={String(o.value)}>{o.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )
                }
                const shown = toDisplay(v, spec.unit, timing)
                return (
                  <div className="flex items-center gap-1.5">
                    <Input
                      id={id}
                      className="h-8 w-28 text-sm"
                      type="number"
                      inputMode="decimal"
                      step={unit.step}
                      min={0}
                      value={drafts[spec.id] ?? String(shown)}
                      onChange={(e) => setDrafts((d) => ({ ...d, [spec.id]: e.target.value }))}
                      onBlur={(e) => {
                        const text = e.target.value.trim()
                        setDrafts((d) => { const n = { ...d }; delete n[spec.id]; return n })
                        if (text === '') return
                        commit(spec, key, fromDisplay(Number(text), spec.unit, timing))
                      }}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                    />
                    {unit.label && <span className="w-6 text-xs text-muted-foreground">{unit.label}</span>}
                  </div>
                )
              })()

              return (
                <div key={spec.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <div className="flex w-full items-center gap-1.5 sm:w-52">
                    <Label htmlFor={id} className="text-sm">{spec.label}</Label>
                    {spec.help && <InfoTooltip text={spec.help} />}
                  </div>
                  {control}
                  {/* Rescaling and fine gain are worked out together, not tried
                      one step at a time: the calculator does both. */}
                  {scaleHref && (spec.id === 'rescale' || spec.id === 'finegain') && (
                    <Link href={scaleHref}
                      className="inline-flex min-h-9 items-center gap-1 text-xs font-medium text-primary underline-offset-2 hover:underline sm:min-h-0">
                      <Calculator className="h-3.5 w-3.5" aria-hidden="true" />
                      Energy-scale calculator
                    </Link>
                  )}
                  {online && (live ? (
                    <span className="flex items-center gap-1 text-xs text-success" title="Written to the board as soon as you save">
                      <Zap className="h-3 w-3" aria-hidden="true" />live
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground" title="Not safe to change while the board is acquiring: saved to the configuration, applied at the next run">
                      next run
                    </span>
                  ))}
                  {changed && (
                    <Badge variant="outline" className="border-warning text-xs text-warning">unsaved</Badge>
                  )}
                  {notes.length > 0 && (
                    <div className="w-full space-y-0.5 sm:pl-[13.75rem]">
                      {notes.map((n, i) => (
                        <p key={i} className={`flex items-center gap-1 text-xs ${n.warn ? 'font-medium text-warning' : 'text-muted-foreground'}`}>
                          {n.warn && <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />}
                          {n.text}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
