'use client'

/**
 * Trapezoid energy scale: Trapezoid Rescaling and Fine Gain for DPP-PHA
 * channels, worked out instead of guessed.
 *
 * From the shaping times: the energy is about C · A · k · M · FG / 2^SHF
 * (lib/trapezoid-scale), so the rise and decay times and the largest pulse
 * give the values that put that pulse at a chosen fraction of the 15-bit
 * scale, good to about 10 %. From a measured peak: the energy is exactly
 * linear in FG and 2^-SHF, so where a line sits now and where it should be
 * give exact values, as exact as the peak position is known. Applying saves
 * both registers to the board's configuration, like the rest of this page,
 * for the next run.
 *
 * "Apply to all" works each channel out from its own registers: from the
 * shaping times with its own rise, decay and decimation; from a peak by
 * multiplying its own scale by the same factor. One value written to every
 * channel would be wrong wherever the channels differ.
 */

import { useEffect, useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { NumericInput } from '@/components/ui/numeric-input'
import { ConfirmAction } from '@/components/ui/confirm-action'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getRawHistogram } from '@/lib/api'
import { loadJSROOT } from '@/lib/load-jsroot'
import {
  DECAY_UNITS_MAX, DEFAULT_TARGET_FRACTION, ENERGY_FULL_SCALE, RISE_UNITS_MAX, adcBitsFor,
  filterGain, inputRangeMv, lsbToMv, measuredOn, mvToLsb, nsPerUnitFor, peakRatio, predictEnergy,
  samplesPerUnitFor, scaleFactor, scaleFromShaping, scaleTimes, shapingChanged, verdict,
  type Scale, type ScaleResult, type Shaping,
} from '@/lib/trapezoid-scale'

/** The registers of one channel that set its energy scale. */
export interface ChannelEnergyRegs {
  riseUnits: number
  decayUnits: number
  /** DPP Algorithm Control (0x1n80): rescaling [5:0], decimation [9:8], decimation gain [11:10]. */
  algoCtrl: number
  fineGain: number
  /** Input Dynamic Range (0x1n28), when the firmware has it. */
  dynamicRange?: number
}

/**
 * The settings a measured peak is compared with. 'run': the registers the
 * running run started with (what made the live spectrum); 'saved': the saved
 * configuration, between runs.
 */
export interface ScaleReference {
  source: 'run' | 'saved'
  run: number | null
  regs: Record<number, ChannelEnergyRegs | null>
}

const shfOf = (algo: number) => algo & 0x3f
const decOf = (algo: number) => (algo >>> 8) & 0x3
const decGainOf = (algo: number) => (algo >>> 10) & 0x3

const hex = (v: number) => `0x${v.toString(16).toUpperCase()}`
/** A fine gain as the DAQ page shows it, decimal, with the hex beside it. */
const fgText = (v: number) => `${v.toLocaleString('en-US')} (${hex(v)})`
const NBSP = ' '

/** A number of channels as people read it: 2,898, or 4.0 × 10¹⁰ when huge. */
function fmtEnergy(e: number): string {
  if (!Number.isFinite(e)) return '—'
  if (Math.abs(e) < 1e6) return Math.round(e).toLocaleString('en-US')
  const exp = Math.floor(Math.log10(Math.abs(e)))
  const sup = String(exp).split('').map(d => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(d)]).join('')
  return `${(e / 10 ** exp).toFixed(1)}${NBSP}×${NBSP}10${sup}`
}

function pct(e: number): string {
  const f = (100 * e) / ENERGY_FULL_SCALE
  return `${f >= 10 ? Math.round(f) : f.toPrecision(2)}${NBSP}%`
}

/** Decimals worth showing for a peak known to ±err. */
const peakDigits = (err: number | null) => err === null || !Number.isFinite(err) ? 1 : err >= 1 ? 0 : err >= 0.1 ? 1 : 2
/** A fitted position rounded to what it is known to, so the field shows no noise digits. */
const roundPeak = (x: number, err: number | null) => Number(x.toFixed(peakDigits(err)))

/** A peak position with its uncertainty, to the precision it has. */
function fmtPeak(x: number, err: number | null): string {
  if (err === null || !Number.isFinite(err)) return x.toLocaleString('en-US', { maximumFractionDigits: 1 })
  const digits = peakDigits(err)
  const f = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  return `${f(x)}${NBSP}±${NBSP}${f(err)}`
}

/**
 * One line saying where an energy sits on the scale. `tone`: 'bad' (red) only
 * when energies come out as 0 or are lost at the top; 'warn' when the
 * spectrum is squeezed into the bottom; otherwise neutral.
 */
function describe(e: number): { text: string; tone: 'bad' | 'warn' | 'ok' } {
  switch (verdict(e)) {
    case 'overflow':
      return { text: `≈ ${fmtEnergy(e)}, far beyond ${ENERGY_FULL_SCALE.toLocaleString('en-US')}: the trapezoid overflows and every energy comes out 0`, tone: 'bad' }
    case 'above':
      return { text: `≈ ${fmtEnergy(e)} (${pct(e)} of the scale): the largest pulses come out as 0 or at the top`, tone: 'bad' }
    case 'squeezed':
      return { text: `≈ ${fmtEnergy(e)}, ${pct(e)} of the scale: the spectrum is squeezed at the bottom`, tone: 'warn' }
    default:
      return { text: `≈ ${fmtEnergy(e)}, ${pct(e)} of the scale`, tone: 'ok' }
  }
}

const toneClass = { bad: 'text-destructive', warn: 'text-warning', ok: 'text-muted-foreground' } as const

/** What the registers cannot reach, in words. */
function limitText(limit: ScaleResult['limit']): string {
  return limit === 'max-gain'
    ? 'The target cannot be reached: even rescaling 0 with the largest fine gain gives less. These are the nearest values.'
    : 'The target cannot be reached: even rescaling 63 with fine gain 1 gives more. These are the nearest values.'
}

interface FoundPeak { x: number; err: number | null }

export function TrapezoidScaleDialog({
  open, onOpenChange, boardId, boardName, channel, channels, enabled, onChannelChange,
  pageRegs, reference, onApply, onCloseAutoFocus,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  boardId: string
  boardName: string
  channel: number
  /** Channels that have the energy-scale registers. */
  channels: number[]
  /** Of those, the ones switched on. */
  enabled: number[]
  onChannelChange: (channel: number) => void
  /** Every channel's values as the page shows them (unsaved edits included). */
  pageRegs: Record<number, ChannelEnergyRegs | null>
  /** What a measured peak was taken with; null while it is read (or when it could not be). */
  reference: ScaleReference | null
  /** Save these values, per channel; resolves to whether it all saved. */
  onApply: (scales: Record<number, Scale>) => Promise<boolean>
  /** Where focus goes when the dialog closes (the opener). */
  onCloseAutoFocus?: (e: Event) => void
}) {
  const nsPerUnit = nsPerUnitFor(boardName) ?? 16
  const samplesPerUnit = samplesPerUnitFor(boardName)
  const nsPerSample = nsPerUnit / samplesPerUnit
  const adcBits = adcBitsFor(boardName)
  const current = pageRegs[channel] ?? null
  const rangeMv = inputRangeMv(current?.dynamicRange)
  const channelOff = !enabled.includes(channel)
  const allTargets = enabled.filter(ch => pageRegs[ch])

  const [mode, setMode] = useState<'shaping' | 'peak'>('shaping')
  // From the shaping times. Times in ns, as the rest of the page shows them.
  const [riseNs, setRiseNs] = useState(0)
  const [decayNs, setDecayNs] = useState(0)
  const [aMax, setAMax] = useState(2 ** adcBits)
  const [aUnit, setAUnit] = useState<'lsb' | 'mv'>('lsb')
  const [targetPct, setTargetPct] = useState(DEFAULT_TARGET_FRACTION * 100)
  // From a measured peak.
  const [eNow, setENow] = useState(0)
  const [eNowErr, setENowErr] = useState<number | null>(null)
  const [eWant, setEWant] = useState(Math.round(DEFAULT_TARGET_FRACTION * ENERGY_FULL_SCALE))
  const [refEdit, setRefEdit] = useState(false)
  const [ref, setRef] = useState<{ shf: number; fg: number; riseNs: number; decayNs: number } | null>(null)
  const [peaks, setPeaks] = useState<FoundPeak[] | null>(null)
  const [peakMsg, setPeakMsg] = useState<string | null>(null)
  const [findingPeaks, setFindingPeaks] = useState(false)
  const [applying, setApplying] = useState(false)
  const [confirm, setConfirm] = useState<number[] | null>(null)

  const refRegsOf = (ch: number): ChannelEnergyRegs | null => reference?.regs[ch] ?? pageRegs[ch] ?? null

  // Start from the channel's own values whenever the dialog opens, the
  // channel changes or the reference arrives; edits after that are the
  // operator's. A line position belongs to one channel: it is cleared too.
  useEffect(() => {
    if (!open || !current) return
    setRiseNs(current.riseUnits * nsPerUnit)
    setDecayNs(current.decayUnits * nsPerUnit)
    const s = refRegsOf(channel) ?? current
    setRef({ shf: shfOf(s.algoCtrl), fg: s.fineGain, riseNs: s.riseUnits * nsPerUnit, decayNs: s.decayUnits * nsPerUnit })
    setRefEdit(false)
    setENow(0)
    setENowErr(null)
    setPeaks(null)
    setPeakMsg(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, channel, current === null, reference])

  const shapingFrom = (r: ChannelEnergyRegs, rNs?: number, dNs?: number): Shaping => ({
    riseUnits: rNs !== undefined ? rNs / nsPerUnit : r.riseUnits,
    decayUnits: dNs !== undefined ? dNs / nsPerUnit : r.decayUnits,
    samplesPerUnit,
    decimation: decOf(r.algoCtrl),
    decimationGain: decGainOf(r.algoCtrl),
  })
  const decimation = current ? decOf(current.algoCtrl) : 0
  const decimationGain = current ? decGainOf(current.algoCtrl) : 0
  const ampLsbFor = (r: ChannelEnergyRegs | null) =>
    aUnit === 'mv' ? mvToLsb(aMax, inputRangeMv(r?.dynamicRange), adcBits) : aMax
  const ampLsb = ampLsbFor(current)
  const target = (targetPct / 100) * ENERGY_FULL_SCALE

  const todayScale: Scale | null = current ? { shf: shfOf(current.algoCtrl), fg: current.fineGain } : null
  const pageShaping = current ? shapingFrom(current) : null
  const shaping = current ? shapingFrom(current, riseNs, decayNs) : null

  const refShaping = ref && current ? shapingFrom(current, ref.riseNs, ref.decayNs) : null
  const peakShapingChanged = !!(refShaping && pageShaping && shapingChanged(refShaping, pageShaping))
  // The factor every channel's energy is multiplied by, from this channel's line.
  const lineRatio = eNow > 0 && eWant > 0 ? eWant / eNow : null

  /** The values for one channel in the current mode, worked out from its own registers. */
  const scaleForChannel = (ch: number): ScaleResult | null => {
    const r = pageRegs[ch]
    if (!r) return null
    if (mode === 'shaping') {
      const sh = ch === channel ? shaping : shapingFrom(r)
      const a = ampLsbFor(r)
      if (!sh || !(a > 0) || !(target > 0) || !(sh.riseUnits > 0) || !(sh.decayUnits > 0)) return null
      return scaleFromShaping(a, sh, target)
    }
    if (lineRatio === null) return null
    if (ch === channel) {
      if (!ref || !(ref.fg > 0) || !refShaping || !pageShaping) return null
      return scaleTimes({ shf: ref.shf, fg: ref.fg },
        peakRatio(eNow, eWant, peakShapingChanged ? refShaping : undefined, peakShapingChanged ? pageShaping : undefined))
    }
    const rr = refRegsOf(ch)
    if (!rr || !(rr.fineGain > 0)) return null
    const before = shapingFrom(rr), after = shapingFrom(r)
    const changed = shapingChanged(before, after)
    return scaleTimes({ shf: shfOf(rr.algoCtrl), fg: rr.fineGain },
      peakRatio(eNow, eWant, changed ? before : undefined, changed ? after : undefined))
  }

  const result = useMemo(() => scaleForChannel(channel),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, channel, pageRegs, reference, riseNs, decayNs, aMax, aUnit, targetPct, eNow, eWant, ref, peakShapingChanged])
  const perChannel = useMemo(() => Object.fromEntries(allTargets.map(ch => [ch, scaleForChannel(ch)])) as Record<number, ScaleResult | null>,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, channel, enabled, pageRegs, reference, riseNs, decayNs, aMax, aUnit, targetPct, eNow, eWant, ref, peakShapingChanged])
  const allReady = allTargets.length > 1 && allTargets.every(ch => perChannel[ch])
  const allLimited = allTargets.filter(ch => perChannel[ch]?.limit)
  const allSame = allReady && allTargets.every(ch =>
    perChannel[ch]!.shf === perChannel[allTargets[0]]!.shf && perChannel[ch]!.fg === perChannel[allTargets[0]]!.fg)

  const findPeaksLive = async () => {
    if (channelOff) {
      setPeaks([])
      setPeakMsg(`Channel ${channel} is off: it has no spectrum. Switch it on, or pick an enabled channel.`)
      return
    }
    setFindingPeaks(true)
    setPeakMsg(null)
    try {
      // One bin per channel (no display rebinning, no calibration).
      const data = await getRawHistogram(boardId, channel, 'energy')
      await loadJSROOT()
      const h = window.JSROOT.parse(data)
      const ax = h?.fXaxis, arr = h?.fArray
      const n = Number(ax?.fNbins) || 0
      if (!arr || n < 16) { setPeaks([]); setPeakMsg('No spectrum for this channel yet: start a run.'); return }
      const y = new Float64Array(n)
      let sum = 0
      for (let i = 0; i < n; i++) { y[i] = Number(arr[i + 1]) || 0; sum += y[i] }
      if (sum === 0) { setPeaks([]); setPeakMsg('The spectrum is empty (all energies 0?): use the shaping times instead.'); return }
      const { binCenters, findPeaks, fitPeak } = await import('@/lib/peak-fit')
      const x = binCenters(n, Number(ax.fXmin) || 0, Number(ax.fXmax) || n)
      // findPeaks looks on a coarse copy of the spectrum (≤ 1024 bins); each
      // candidate is then fitted on the full one, so the position is the
      // board's own to a fraction of a channel.
      const found: FoundPeak[] = findPeaks(x, y, 6).map(p => {
        const half = Math.max(1.5 * p.fwhm, 8 * (x[1] - x[0]))
        const fit = fitPeak(x, y, p.x - half, p.x + half)
        if (fit && Number.isFinite(fit.centroid) && Math.abs(fit.centroid - p.x) < half) {
          const err = Number.isFinite(fit.centroidErr) ? fit.centroidErr : null
          return { x: roundPeak(fit.centroid, err), err }
        }
        // No fit: the centroid of the counts within ±FWHM.
        let sw = 0, sx = 0
        for (let i = 0; i < n; i++) {
          if (Math.abs(x[i] - p.x) <= p.fwhm) { sw += y[i]; sx += y[i] * x[i] }
        }
        return { x: roundPeak(sw > 0 ? sx / sw : p.x, null), err: null }
      })
      // The biggest peak is offered first and filled in; the rest by position.
      const [first, ...rest] = found
      setPeaks(first ? [first, ...rest.sort((a, b) => a.x - b.x)] : [])
      if (first) { setENow(first.x); setENowErr(first.err) }
      else setPeakMsg('No clear peak in the spectrum yet.')
    } catch {
      setPeaks([])
      setPeakMsg('Could not read the live spectrum.')
    } finally {
      setFindingPeaks(false)
    }
  }

  const apply = async (targets: number[]) => {
    const scales: Record<number, Scale> = {}
    for (const ch of targets) {
      const sc = ch === channel ? result : perChannel[ch]
      if (!sc) return
      scales[ch] = { shf: sc.shf, fg: sc.fg }
    }
    setApplying(true)
    try {
      if (await onApply(scales)) onOpenChange(false)
    } finally {
      setApplying(false)
    }
  }

  const today = todayScale && pageShaping && ampLsb > 0 ? describe(predictEnergy(ampLsb, pageShaping, todayScale)) : null
  const predicted = result && ampLsb > 0 && shaping ? predictEnergy(ampLsb, shaping, result) : null
  const shapingDiffers = !!(current && (Math.round(riseNs / nsPerUnit) !== current.riseUnits || Math.round(decayNs / nsPerUnit) !== current.decayUnits))
  // Where the line lands with the values (the nearest ones when out of reach).
  const lineLands = mode === 'peak' && result && ref && lineRatio !== null
    ? eNow * (scaleFactor(result) / scaleFactor({ shf: ref.shf, fg: ref.fg }))
      * (peakShapingChanged && refShaping && pageShaping ? filterGain(pageShaping) / filterGain(refShaping) : 1)
    : null

  const refLabel = reference === null
    ? 'the values on this page'
    : reference.source === 'run'
      ? `the settings ${reference.run !== null ? `run ${reference.run}` : 'the run'} started with, which made the live spectrum`
      : 'the saved settings, which the next run uses; if the line comes from a run taken with other values, change them here'

  const confirmTargets = confirm ?? []
  const confirmWhere = confirmTargets.length === 1 ? `channel ${confirmTargets[0]}` : `${confirmTargets.length} channels`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Trapezoid energy scale</DialogTitle>
          <DialogDescription>
            Trapezoid rescaling and fine gain that put the pulses on the 15-bit energy scale
            (0–{ENERGY_FULL_SCALE.toLocaleString('en-US')}).
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="ts-channel" className="text-sm">Channel</Label>
          <Select value={String(channel)} onValueChange={v => onChannelChange(Number(v))}>
            <SelectTrigger id="ts-channel" className="h-9 w-36" aria-label="Channel">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {channels.map(ch => (
                <SelectItem key={ch} value={String(ch)}>
                  Channel {ch}{enabled.includes(ch) ? '' : ' (off)'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {todayScale && (
            <span className="text-xs text-muted-foreground">
              now: rescaling {todayScale.shf}, fine gain {fgText(todayScale.fg)}
            </span>
          )}
        </div>
        {current && channelOff && (
          <p className="-mt-2 text-xs text-warning">Channel {channel} is off: it takes no data until it is switched on.</p>
        )}

        {!current ? (
          <p className="text-sm text-muted-foreground">
            This channel has no trapezoid rise time, decay time, rescaling or fine gain register.
          </p>
        ) : (
          <Tabs value={mode} onValueChange={v => setMode(v as 'shaping' | 'peak')} className="min-w-0">
            <TabsList className="grid w-full grid-cols-2">
              {/* Short names on a phone, where both must fit side by side. */}
              <TabsTrigger value="shaping">
                <span className="sm:hidden">Shaping times</span>
                <span className="hidden sm:inline">From the shaping times</span>
              </TabsTrigger>
              <TabsTrigger value="peak">
                <span className="sm:hidden">Measured peak</span>
                <span className="hidden sm:inline">From a measured peak</span>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="shaping" className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="ts-rise">Trapezoid rise time (ns)</Label>
                  {/* Whole register units, within the 12-bit register: the
                      field shows the rounded value once it loses focus. */}
                  <NumericInput id="ts-rise" min={0} max={RISE_UNITS_MAX * nsPerUnit} step={nsPerUnit} value={riseNs}
                    onValueChange={v => setRiseNs(Math.max(0, Math.min(RISE_UNITS_MAX, Math.round(v / nsPerUnit))) * nsPerUnit)}
                    className="h-9" />
                  <p className="text-xs text-muted-foreground">
                    {Math.round(riseNs / nsPerUnit)} × {nsPerUnit}{NBSP}ns = {Math.round(riseNs / nsPerSample).toLocaleString('en-US')} samples
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ts-decay">Decay time (ns)</Label>
                  <NumericInput id="ts-decay" min={0} max={DECAY_UNITS_MAX * nsPerUnit} step={nsPerUnit} value={decayNs}
                    onValueChange={v => setDecayNs(Math.max(0, Math.min(DECAY_UNITS_MAX, Math.round(v / nsPerUnit))) * nsPerUnit)}
                    className="h-9" />
                  <p className="text-xs text-muted-foreground">
                    {Math.round(decayNs / nsPerUnit).toLocaleString('en-US')} × {nsPerUnit}{NBSP}ns = {Math.round(decayNs / nsPerSample).toLocaleString('en-US')} samples
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ts-amax">Largest pulse height</Label>
                  <div className="flex gap-2">
                    <NumericInput id="ts-amax" min={1} value={aMax} onValueChange={setAMax} className="h-9 min-w-0 flex-1" />
                    <Select
                      value={aUnit}
                      onValueChange={v => {
                        // Keep the same pulse when the unit changes.
                        const u = v as 'lsb' | 'mv'
                        if (u !== aUnit) setAMax(Math.round(u === 'mv' ? lsbToMv(aMax, rangeMv, adcBits) : mvToLsb(aMax, rangeMv, adcBits)))
                        setAUnit(u)
                      }}
                    >
                      <SelectTrigger className="h-9 w-24" aria-label="Pulse height unit"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="lsb">LSB</SelectItem>
                        <SelectItem value="mv">mV</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    The whole ADC range is {(2 ** adcBits).toLocaleString('en-US')}{NBSP}LSB = {rangeMv.toLocaleString('en-US')}{NBSP}mV.
                    A pulse only rises from the baseline, so a smaller value (your highest line) spreads the spectrum.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ts-target">Put it at (% of the scale)</Label>
                  <NumericInput id="ts-target" min={1} max={100} value={targetPct} onValueChange={setTargetPct} className="h-9" />
                  <p className="text-xs text-muted-foreground">
                    = channel {fmtEnergy(target)}. Below 100{NBSP}% to leave room for the ~10{NBSP}% the
                    estimate can be off.
                  </p>
                </div>
              </div>
              {(decimation > 0 || decimationGain > 0) && (
                <p className="text-xs text-warning">
                  Decimation {2 ** decimation}× with gain {2 ** decimationGain}× is taken into account
                  (times counted in decimated samples), but that has not been checked on a board.
                </p>
              )}
              {shapingDiffers && (
                <p className="text-xs text-muted-foreground">
                  Worked out for the times above; Apply sets only the rescaling and fine gain, so set
                  the same rise and decay times in the energy filter too.
                </p>
              )}
            </TabsContent>

            <TabsContent value="peak" className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="ts-enow">A line now sits at channel</Label>
                  <NumericInput id="ts-enow" min={1} value={eNow || ''} onValueChange={v => { setENow(v); setENowErr(null) }} className="h-9" placeholder="e.g. 1124" />
                  <Button type="button" variant="outline" size="sm" className="h-9" onClick={findPeaksLive} disabled={findingPeaks}>
                    {findingPeaks ? 'Looking…' : 'Find peaks in the live spectrum'}
                  </Button>
                  {peaks && peaks.length > 0 && (
                    <>
                      <p className="text-xs text-muted-foreground">Fitted positions; tap one to use it (the biggest is filled in).</p>
                      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Peaks found">
                        {peaks.map(p => (
                          <Button key={p.x} type="button" size="sm" variant={eNow === p.x ? 'default' : 'outline'}
                            aria-pressed={eNow === p.x}
                            className="h-9 px-2.5 text-xs tabular-nums" onClick={() => { setENow(p.x); setENowErr(p.err) }}>
                            {fmtPeak(p.x, p.err)}
                          </Button>
                        ))}
                      </div>
                    </>
                  )}
                  {peakMsg && <p className="text-xs text-muted-foreground">{peakMsg}</p>}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ts-ewant">Move it to channel</Label>
                  <NumericInput id="ts-ewant" min={1} max={ENERGY_FULL_SCALE} value={eWant} onValueChange={setEWant} className="h-9" />
                  <p className="text-xs text-muted-foreground">
                    {eWant > 0 ? `${pct(eWant)} of the scale. ` : ''}For the highest line of interest,
                    about 75{NBSP}% leaves room above it.
                  </p>
                </div>
              </div>
              {ref && (
                <div className="space-y-2 rounded-md border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p>
                      Measured with rescaling {ref.shf}, fine gain {fgText(ref.fg)}, rise {ref.riseNs.toLocaleString('en-US')}{NBSP}ns,
                      decay {ref.decayNs.toLocaleString('en-US')}{NBSP}ns
                      <span className="text-muted-foreground"> ({refLabel})</span>
                    </p>
                    <Button type="button" variant="ghost" size="sm" className="h-9" onClick={() => setRefEdit(e => !e)}>
                      {refEdit ? 'Done' : 'Change'}
                    </Button>
                  </div>
                  {refEdit && (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label htmlFor="ts-ref-shf" className="text-xs">Rescaling</Label>
                        <NumericInput id="ts-ref-shf" min={0} max={63} value={ref.shf} onValueChange={v => setRef({ ...ref, shf: Math.max(0, Math.min(63, Math.round(v))) })} className="h-9" />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="ts-ref-fg" className="text-xs">Fine gain</Label>
                        <NumericInput id="ts-ref-fg" min={1} max={65535} value={ref.fg} onValueChange={v => setRef({ ...ref, fg: Math.max(1, Math.min(65535, Math.round(v))) })} className="h-9" />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="ts-ref-rise" className="text-xs">Rise time (ns)</Label>
                        <NumericInput id="ts-ref-rise" min={0} max={RISE_UNITS_MAX * nsPerUnit} step={nsPerUnit} value={ref.riseNs}
                          onValueChange={v => setRef({ ...ref, riseNs: Math.max(0, Math.min(RISE_UNITS_MAX, Math.round(v / nsPerUnit))) * nsPerUnit })} className="h-9" />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="ts-ref-decay" className="text-xs">Decay time (ns)</Label>
                        <NumericInput id="ts-ref-decay" min={0} max={DECAY_UNITS_MAX * nsPerUnit} step={nsPerUnit} value={ref.decayNs}
                          onValueChange={v => setRef({ ...ref, decayNs: Math.max(0, Math.min(DECAY_UNITS_MAX, Math.round(v / nsPerUnit))) * nsPerUnit })} className="h-9" />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </TabsContent>
          </Tabs>
        )}

        {current && (
          <div className="space-y-2 rounded-md bg-muted p-3 text-sm" aria-live="polite">
            {result ? (
              <>
                <p className="text-base">
                  Set <span className="font-semibold">trapezoid rescaling {result.shf}</span> and{' '}
                  <span className="font-semibold">fine gain {result.fg.toLocaleString('en-US')}</span>
                  <span className="text-muted-foreground"> ({hex(result.fg)})</span>
                </p>
                {result.limit && <p className="text-destructive">{limitText(result.limit)}</p>}
                {mode === 'shaping' ? (
                  <>
                    {predicted !== null && (
                      <p>The largest pulse then lands {describe(predicted).text}, give or take 10{NBSP}%.</p>
                    )}
                    {today && (
                      <p className={toneClass[today.tone]}>
                        With the values now: {today.text}.
                      </p>
                    )}
                  </>
                ) : result.limit ? (
                  lineLands !== null && <p>The line then lands at about {fmtEnergy(lineLands)}.</p>
                ) : peakShapingChanged ? (
                  <p className="text-warning">
                    Approximate: the rise or decay time on the page differs from the one the peak was
                    measured with, so the line moves by the estimated rise × decay ratio as well.
                  </p>
                ) : (
                  <p className="text-muted-foreground">
                    Exact to the peak position{eNowErr !== null ? ` (${fmtPeak(eNow, eNowErr)})` : ''}: the
                    energy is proportional to the fine gain and halves with each step of rescaling.
                  </p>
                )}
              </>
            ) : (
              <p className="text-muted-foreground">
                {mode === 'shaping' ? 'Enter the times and the largest pulse.' : 'Enter where a line sits now and where it should go.'}
              </p>
            )}
            {mode === 'shaping' && !measuredOn(boardName) && (
              <p className="text-xs text-muted-foreground">
                The constant of the estimate was measured on a V1725S; check it on this model with a
                run and refine from the measured peak.
              </p>
            )}
            {allReady && result && (
              <details className="text-xs">
                <summary className="cursor-pointer py-1 text-muted-foreground">
                  For all {allTargets.length} enabled channels
                  {allSame ? ': the same values' : ': worked out per channel'}
                </summary>
                <p className="mt-1 text-muted-foreground">
                  {mode === 'shaping'
                    ? 'Each channel from its own rise time, decay time and decimation, for the same pulse and target.'
                    : `Each channel's own scale multiplied by the same factor (×${(lineRatio ?? 1).toPrecision(4)}), so its lines move as this channel's does.`}
                </p>
                <ul className="mt-1 grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                  {allTargets.map(ch => {
                    const sc = perChannel[ch]!
                    return (
                      <li key={ch} className={`tabular-nums ${sc.limit ? 'text-destructive' : ''}`}>
                        Channel {ch}: rescaling {sc.shf}, fine gain {sc.fg.toLocaleString('en-US')}
                        {sc.limit ? ' (out of reach)' : ''}
                      </li>
                    )
                  })}
                </ul>
                {allLimited.length > 0 && (
                  <p className="mt-1 text-destructive">
                    The target cannot be reached on channel{allLimited.length === 1 ? '' : 's'} {allLimited.join(', ')}.
                  </p>
                )}
              </details>
            )}
          </div>
        )}

        {/* The one channel is the main action; all channels is the
            exception, so it is the quieter button, on its own side. */}
        <DialogFooter className="gap-2 sm:justify-between">
          {allTargets.length > 1 ? (
            <Button
              variant="ghost"
              className="underline-offset-2 hover:underline max-sm:order-first"
              onClick={() => setConfirm(allTargets)}
              disabled={!allReady || applying}
            >
              Apply to all {allTargets.length} enabled channels
            </Button>
          ) : <span />}
          <Button onClick={() => setConfirm([channel])} disabled={!result || applying}>
            {applying ? 'Saving…' : `Apply to channel ${channel}`}
          </Button>
        </DialogFooter>
        <p className="-mt-2 text-xs text-muted-foreground">
          Saved to the board&apos;s configuration; applies at the next run. The peaks move: re-check the
          energy calibration afterwards.
        </p>

        <ConfirmAction
          open={confirm !== null}
          onOpenChange={o => { if (!o) setConfirm(null) }}
          title={`Change the energy scale of ${confirmWhere}?`}
          description={
            <>
              <p>
                Changing the gain moves every peak: the energy calibration of{' '}
                {confirmTargets.length === 1 ? 'this channel' : 'these channels'} no longer holds.
                Change it between campaigns or with the run coordinator.
              </p>
              <p>Saved to the configuration; it applies at the next run.</p>
            </>
          }
          confirmLabel={`Change ${confirmWhere}`}
          onConfirm={() => { const t = confirm ?? []; setConfirm(null); void apply(t) }}
        />
      </DialogContent>
    </Dialog>
  )
}
