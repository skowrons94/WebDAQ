'use client'

/**
 * Trapezoid energy scale: Trapezoid Rescaling and Fine Gain for one DPP-PHA
 * channel, worked out instead of guessed.
 *
 * From the shaping times: the energy is about C · A · k · M · FG / 2^SHF
 * (lib/trapezoid-scale), so the rise and decay times and the largest pulse
 * give the values that put that pulse at a chosen fraction of the 15-bit
 * scale, good to about 10 %. From a measured peak: the energy is exactly
 * linear in FG and 2^-SHF, so where a line sits now and where it should be
 * give exact values. Applying saves both registers to the board's
 * configuration, like the rest of this page, for the next run.
 */

import { useEffect, useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { NumericInput } from '@/components/ui/numeric-input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getRawHistogram } from '@/lib/api'
import { loadJSROOT } from '@/lib/load-jsroot'
import {
  DEFAULT_TARGET_FRACTION, ENERGY_FULL_SCALE, adcBitsFor, inputRangeMv, lsbToMv, measuredOn,
  mvToLsb, predictEnergy, samplesPerUnitFor, scaleFromPeak, scaleFromShaping, shapingChanged,
  verdict, type Scale, type Shaping,
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

const shfOf = (algo: number) => algo & 0x3f
const decOf = (algo: number) => (algo >>> 8) & 0x3
const decGainOf = (algo: number) => (algo >>> 10) & 0x3

const hex = (v: number) => `0x${v.toString(16).toUpperCase()}`

/** A number of channels as people read it: 2 898, or 4.0 × 10¹⁰ when huge. */
function fmtEnergy(e: number): string {
  if (!Number.isFinite(e)) return '—'
  if (Math.abs(e) < 1e6) return Math.round(e).toLocaleString('en-US').replace(/,/g, ' ')
  const exp = Math.floor(Math.log10(Math.abs(e)))
  const sup = String(exp).split('').map(d => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(d)]).join('')
  return `${(e / 10 ** exp).toFixed(1)} × 10${sup}`
}

function pct(e: number): string {
  const f = (100 * e) / ENERGY_FULL_SCALE
  return f >= 10 ? `${Math.round(f)} %` : `${f.toPrecision(2)} %`
}

/** One line saying where an energy sits on the scale and what that means. */
function describe(e: number): { text: string; bad: boolean } {
  switch (verdict(e)) {
    case 'overflow':
      return { text: `≈ ${fmtEnergy(e)}, far beyond ${ENERGY_FULL_SCALE}: the trapezoid overflows and every energy comes out 0`, bad: true }
    case 'above':
      return { text: `≈ ${fmtEnergy(e)} (${pct(e)} of the scale): the largest pulses come out as 0 or at the top`, bad: true }
    case 'squeezed':
      return { text: `≈ ${fmtEnergy(e)}, ${pct(e)} of the scale: the spectrum is squeezed at the bottom`, bad: true }
    case 'low':
      return { text: `≈ ${fmtEnergy(e)}, ${pct(e)} of the scale: most of the scale is unused`, bad: false }
    default:
      return { text: `≈ ${fmtEnergy(e)}, ${pct(e)} of the scale`, bad: false }
  }
}

export function TrapezoidScaleDialog({
  open, onOpenChange, boardId, boardName, channel, channels, onChannelChange,
  current, saved, onApply,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  boardId: string
  boardName: string
  channel: number
  channels: number[]
  onChannelChange: (channel: number) => void
  /** The channel's values as the page shows them (unsaved edits included). */
  current: ChannelEnergyRegs | null
  /** The values saved in the configuration: what the last run used. */
  saved: ChannelEnergyRegs | null
  /** Save the scale to these channels; resolves to whether it all saved. */
  onApply: (scale: Scale, channels: number[]) => Promise<boolean>
}) {
  const nsPerUnit = boardName.includes('1730') ? 8 : boardName.includes('1724') ? 10 : 16
  const samplesPerUnit = samplesPerUnitFor(boardName)
  const nsPerSample = nsPerUnit / samplesPerUnit
  const adcBits = adcBitsFor(boardName)
  const rangeMv = inputRangeMv(current?.dynamicRange)

  const [mode, setMode] = useState<'shaping' | 'peak'>('shaping')
  // From the shaping times. Times in ns, as the rest of the page shows them.
  const [riseNs, setRiseNs] = useState(0)
  const [decayNs, setDecayNs] = useState(0)
  const [aMax, setAMax] = useState(2 ** adcBits)
  const [aUnit, setAUnit] = useState<'lsb' | 'mv'>('lsb')
  const [targetPct, setTargetPct] = useState(DEFAULT_TARGET_FRACTION * 100)
  // From a measured peak.
  const [eNow, setENow] = useState(0)
  const [eWant, setEWant] = useState(Math.round(DEFAULT_TARGET_FRACTION * ENERGY_FULL_SCALE))
  const [refEdit, setRefEdit] = useState(false)
  const [ref, setRef] = useState<{ shf: number; fg: number; riseNs: number; decayNs: number } | null>(null)
  const [peaks, setPeaks] = useState<number[] | null>(null)
  const [peakMsg, setPeakMsg] = useState<string | null>(null)
  const [findingPeaks, setFindingPeaks] = useState(false)
  const [applying, setApplying] = useState(false)

  // Start from the channel's own values whenever the dialog opens or the
  // channel changes; edits after that are the operator's.
  useEffect(() => {
    if (!open || !current) return
    setRiseNs(current.riseUnits * nsPerUnit)
    setDecayNs(current.decayUnits * nsPerUnit)
    const s = saved ?? current
    setRef({ shf: shfOf(s.algoCtrl), fg: s.fineGain, riseNs: s.riseUnits * nsPerUnit, decayNs: s.decayUnits * nsPerUnit })
    setPeaks(null)
    setPeakMsg(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, channel, current === null, saved === null])

  const decimation = current ? decOf(current.algoCtrl) : 0
  const decimationGain = current ? decGainOf(current.algoCtrl) : 0
  const shapingOf = (rNs: number, dNs: number): Shaping => ({
    riseUnits: rNs / nsPerUnit, decayUnits: dNs / nsPerUnit, samplesPerUnit, decimation, decimationGain,
  })
  const shaping = shapingOf(riseNs, decayNs)
  const ampLsb = aUnit === 'mv' ? mvToLsb(aMax, rangeMv, adcBits) : aMax
  const target = (targetPct / 100) * ENERGY_FULL_SCALE

  const todayScale: Scale | null = current ? { shf: shfOf(current.algoCtrl), fg: current.fineGain } : null
  const pageShaping = current ? shapingOf(current.riseUnits * nsPerUnit, current.decayUnits * nsPerUnit) : null

  const fromShaping = useMemo<Scale | null>(() => {
    if (!(ampLsb > 0) || !(target > 0) || !(riseNs > 0) || !(decayNs > 0)) return null
    return scaleFromShaping(ampLsb, shaping, target)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ampLsb, target, riseNs, decayNs, decimation, decimationGain])

  const refShaping = ref ? shapingOf(ref.riseNs, ref.decayNs) : null
  const peakShapingChanged = !!(refShaping && pageShaping && shapingChanged(refShaping, pageShaping))
  const fromPeak = useMemo<Scale | null>(() => {
    if (!ref || !(eNow > 0) || !(eWant > 0) || !(ref.fg > 0)) return null
    return peakShapingChanged && refShaping && pageShaping
      ? scaleFromPeak({ shf: ref.shf, fg: ref.fg }, eNow, eWant, refShaping, pageShaping)
      : scaleFromPeak({ shf: ref.shf, fg: ref.fg }, eNow, eWant)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, eNow, eWant, peakShapingChanged])

  const result = mode === 'shaping' ? fromShaping : fromPeak

  const findPeaksLive = async () => {
    setFindingPeaks(true)
    setPeakMsg(null)
    try {
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
      const { binCenters, findPeaks } = await import('@/lib/peak-fit')
      const x = binCenters(n, Number(ax.fXmin) || 0, Number(ax.fXmax) || n)
      const found = findPeaks(x, y, 6).map(p => Math.round(p.x)).sort((a, b) => a - b)
      setPeaks(found)
      if (found.length === 0) setPeakMsg('No clear peak in the spectrum yet.')
    } catch {
      setPeaks([])
      setPeakMsg('Could not read the live spectrum.')
    } finally {
      setFindingPeaks(false)
    }
  }

  const apply = async (targets: number[]) => {
    if (!result) return
    setApplying(true)
    try {
      if (await onApply(result, targets)) onOpenChange(false)
    } finally {
      setApplying(false)
    }
  }

  const today = todayScale && pageShaping && ampLsb > 0 ? describe(predictEnergy(ampLsb, pageShaping, todayScale)) : null
  const predicted = result && ampLsb > 0 ? predictEnergy(ampLsb, shaping, result) : null
  const shapingDiffers = !!(pageShaping && current && (Math.round(riseNs / nsPerUnit) !== current.riseUnits || Math.round(decayNs / nsPerUnit) !== current.decayUnits))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Trapezoid energy scale</DialogTitle>
          <DialogDescription>
            Trapezoid rescaling and fine gain that put the pulses on the 15-bit energy scale
            (0–{ENERGY_FULL_SCALE}).
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="ts-channel" className="text-sm">Channel</Label>
          <Select value={String(channel)} onValueChange={v => onChannelChange(Number(v))}>
            <SelectTrigger id="ts-channel" className="h-9 w-32" aria-label="Channel">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {channels.map(ch => <SelectItem key={ch} value={String(ch)}>Channel {ch}</SelectItem>)}
            </SelectContent>
          </Select>
          {todayScale && (
            <span className="text-xs text-muted-foreground">
              now: rescaling {todayScale.shf}, fine gain {hex(todayScale.fg)}
            </span>
          )}
        </div>

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
                  <NumericInput id="ts-rise" min={0} step={nsPerUnit} value={riseNs} onValueChange={setRiseNs} className="h-9" />
                  <p className="text-xs text-muted-foreground">
                    {Math.round(riseNs / nsPerUnit)} × {nsPerUnit} ns = {Math.round(riseNs / nsPerSample)} samples
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ts-decay">Decay time (ns)</Label>
                  <NumericInput id="ts-decay" min={0} step={nsPerUnit} value={decayNs} onValueChange={setDecayNs} className="h-9" />
                  <p className="text-xs text-muted-foreground">
                    {Math.round(decayNs / nsPerUnit)} × {nsPerUnit} ns = {Math.round(decayNs / nsPerSample)} samples
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
                    The whole ADC range is {2 ** adcBits} LSB = {rangeMv} mV. A pulse only rises from
                    the baseline, so a smaller value (your highest line) spreads the spectrum.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ts-target">Put it at (% of the scale)</Label>
                  <NumericInput id="ts-target" min={1} max={100} value={targetPct} onValueChange={setTargetPct} className="h-9" />
                  <p className="text-xs text-muted-foreground">
                    = channel {fmtEnergy(target)}. Below 100 % to leave room for the ~10 % the
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
                  <NumericInput id="ts-enow" min={1} value={eNow || ''} onValueChange={setENow} className="h-9" placeholder="e.g. 1124" />
                  <Button type="button" variant="outline" size="sm" className="h-9" onClick={findPeaksLive} disabled={findingPeaks}>
                    {findingPeaks ? 'Looking…' : 'Find peaks in the live spectrum'}
                  </Button>
                  {peaks && peaks.length > 0 && (
                    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Peaks found">
                      {peaks.map(p => (
                        <Button key={p} type="button" size="sm" variant={eNow === p ? 'default' : 'outline'} className="h-9 px-2.5 text-xs" onClick={() => setENow(p)}>
                          {p}
                        </Button>
                      ))}
                    </div>
                  )}
                  {peakMsg && <p className="text-xs text-muted-foreground">{peakMsg}</p>}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ts-ewant">Move it to channel</Label>
                  <NumericInput id="ts-ewant" min={1} max={ENERGY_FULL_SCALE} value={eWant} onValueChange={setEWant} className="h-9" />
                  <p className="text-xs text-muted-foreground">
                    {eWant > 0 ? `${pct(eWant)} of the scale. ` : ''}For the highest line of interest,
                    about 75 % leaves room above it.
                  </p>
                </div>
              </div>
              {ref && (
                <div className="space-y-2 rounded-md border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p>
                      Measured with rescaling {ref.shf}, fine gain {hex(ref.fg)}, rise {ref.riseNs} ns,
                      decay {ref.decayNs} ns
                      <span className="text-muted-foreground"> (the saved settings, which the last run used)</span>
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
                        <Label htmlFor="ts-ref-fg" className="text-xs">Fine gain (decimal)</Label>
                        <NumericInput id="ts-ref-fg" min={1} max={65535} value={ref.fg} onValueChange={v => setRef({ ...ref, fg: Math.max(1, Math.min(65535, Math.round(v))) })} className="h-9" />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="ts-ref-rise" className="text-xs">Rise time (ns)</Label>
                        <NumericInput id="ts-ref-rise" min={0} value={ref.riseNs} onValueChange={v => setRef({ ...ref, riseNs: v })} className="h-9" />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="ts-ref-decay" className="text-xs">Decay time (ns)</Label>
                        <NumericInput id="ts-ref-decay" min={0} value={ref.decayNs} onValueChange={v => setRef({ ...ref, decayNs: v })} className="h-9" />
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
                  <span className="font-semibold">fine gain {hex(result.fg)}</span>
                  <span className="text-muted-foreground"> ({result.fg})</span>
                </p>
                {mode === 'shaping' ? (
                  <>
                    {predicted !== null && (
                      <p>The largest pulse then lands {describe(predicted).text}, give or take 10 %.</p>
                    )}
                    {today && (
                      <p className={today.bad ? 'text-destructive' : 'text-muted-foreground'}>
                        Today: {today.text}.
                      </p>
                    )}
                  </>
                ) : peakShapingChanged ? (
                  <p className="text-warning">
                    Approximate: the rise or decay time on the page differs from the one the peak was
                    measured with, so the line moves by the estimated rise × decay ratio as well.
                  </p>
                ) : (
                  <p className="text-muted-foreground">
                    Exact: the energy is proportional to the fine gain and halves with each step of
                    rescaling.
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
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => apply(channels)}
            disabled={!result || applying || channels.length < 2}
            className={channels.length < 2 ? 'hidden' : ''}
          >
            Apply to all {channels.length} channels
          </Button>
          <Button onClick={() => apply([channel])} disabled={!result || applying}>
            {applying ? 'Saving…' : `Apply to channel ${channel}`}
          </Button>
        </DialogFooter>
        <p className="-mt-2 text-xs text-muted-foreground">
          Saved to the board&apos;s configuration; applies at the next run. The peaks move: re-check the
          energy calibration afterwards.
        </p>
      </DialogContent>
    </Dialog>
  )
}
