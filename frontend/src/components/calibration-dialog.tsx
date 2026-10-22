'use client'

/**
 * Energy calibration of one channel, from its histogram card.
 *
 * From peaks: the spectrum in channels; zoom on a peak, "Fit peak in view"
 * gives its centroid (a Gaussian on a straight background, fitted on the
 * server), the energy is typed or picked from the usual lines, and the line
 * E = offset + slope × channel through the peaks is shown with its residuals.
 * Or just the two numbers. Saving applies it at once: the card switches to
 * keV, its ROIs and zoom move to stay on the same peaks, and a change made
 * during a run is logged in that run's directory.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  fitCalibPeak, getChannelCalib, getRawHistogram, getReferenceLines, saveChannelCalib, solveCalib,
  type CalibChannel, type CalibPoint, type CalibSolution, type PeakFit, type ReferenceLine,
} from '@/lib/api'
import { RootPlot } from '@/components/root-plot'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { NumericInput } from '@/components/ui/numeric-input'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useToast } from '@/components/ui/use-toast'
import { Crosshair, Plus, RotateCcw, Save, Trash2 } from 'lucide-react'

function fmt(v: number, digits = 4): string {
  if (!Number.isFinite(v)) return '—'
  return Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(digits - 1) : v.toPrecision(digits + 2).replace(/\.?0+$/, '')
}

export function CalibrationDialog({ open, onOpenChange, boardId, channel, label, psd = false, running, onSaved, zoom = null, zoomInKeV = false }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  boardId: string
  channel: number
  label: string
  psd?: boolean
  running: boolean
  onSaved: () => void
  /** The card's zoom when the dialog is opened, in the card's units. */
  zoom?: { xmin: number; xmax: number } | null
  /** Whether that zoom is in keV (the card is calibrated) rather than channels. */
  zoomInKeV?: boolean
}) {
  const { toast } = useToast()
  const [current, setCurrent] = useState<CalibChannel | null>(null)
  const [tab, setTab] = useState<'peaks' | 'numbers'>('peaks')
  const [points, setPoints] = useState<CalibPoint[]>([])
  const [solution, setSolution] = useState<CalibSolution | null>(null)
  const [solveError, setSolveError] = useState<string | null>(null)
  const [fit, setFit] = useState<PeakFit | null>(null)
  const [fitError, setFitError] = useState<string | null>(null)
  const [fitting, setFitting] = useState(false)
  // Empty until typed or picked: a "0" had to be deleted before typing.
  const [energy, setEnergy] = useState<number | null>(null)
  const [lineName, setLineName] = useState<string>('')
  const [lines, setLines] = useState<ReferenceLine[]>([])
  const [offset, setOffset] = useState(0)
  const [slope, setSlope] = useState(1)
  const [logy, setLogy] = useState(true)
  const [saving, setSaving] = useState(false)
  const painter = useRef<any>(null)
  useEffect(() => {
    if (!open) return
    setFit(null); setFitError(null); setSolution(null); setSolveError(null)
    setEnergy(null); setLineName('')
    getChannelCalib(boardId, channel).then((c) => {
      setCurrent(c)
      setPoints(c.points ?? [])
      setOffset(c.offset)
      setSlope(c.slope)
      setTab('peaks')
    }).catch(() => setCurrent(null))
    getReferenceLines().then(setLines).catch(() => setLines([]))
  }, [open, boardId, channel])

  // The line through the peaks, recomputed whenever they change.
  useEffect(() => {
    if (!points.length) { setSolution(null); setSolveError(null); return }
    let alive = true
    solveCalib(points)
      .then((s) => { if (alive) { setSolution(s); setSolveError(null) } })
      .catch((e) => { if (alive) { setSolution(null); setSolveError(e?.response?.data?.error ?? String(e)) } })
    return () => { alive = false }
  }, [points])

  const fitInView = async () => {
    const fp = painter.current?.getFramePainter?.()
    const xmin = Number(fp?.zoom_xmin), xmax = Number(fp?.zoom_xmax)
    setFit(null)
    if (!fp || !(xmax > xmin)) {
      setFitError('Zoom on a peak first: drag across it on the plot.')
      return
    }
    setFitting(true)
    try {
      setFit(await fitCalibPeak(boardId, channel, xmin, xmax))
      setFitError(null)
    } catch (e: any) {
      setFitError(e?.response?.data?.error ?? String(e))
    } finally {
      setFitting(false)
    }
  }

  const addPoint = () => {
    if (!fit || energy === null || !(energy > 0)) return
    setPoints((p) => [...p, {
      channel: fit.centroid, channel_error: fit.centroid_error, energy,
      line: lineName || undefined, fwhm: fit.fwhm,
    }].sort((a, b) => a.channel - b.channel))
    setFit(null)
    setEnergy(null)
    setLineName('')
  }

  const pickLine = (value: string) => {
    const l = lines[Number(value)]
    if (!l) return
    setEnergy(l.energy)
    setLineName(`${l.name} ${l.energy}`)
  }

  // The plot opens on the part of the spectrum the card was zoomed on, so the
  // peak being looked at is not lost in 0–16k channels. The dialog's plot is in
  // channels: a zoom in keV is turned back with the calibration the card uses
  // (so it waits for that calibration to arrive).
  const cardRange = useMemo<[number, number] | null>(() => {
    if (!zoom || !(zoom.xmax > zoom.xmin)) return null
    if (!zoomInKeV) return [zoom.xmin, zoom.xmax]
    if (!current?.slope) return null
    const a = (zoom.xmin - current.offset) / current.slope
    const b = (zoom.xmax - current.offset) / current.slope
    return Number.isFinite(a) && Number.isFinite(b) && a !== b ? [Math.min(a, b), Math.max(a, b)] : null
  }, [zoom?.xmin, zoom?.xmax, zoomInKeV, current?.offset, current?.slope])

  // With a calibration at hand, the fitted peak is shown in keV too.
  const preview = tab === 'peaks' ? solution : { offset, slope }
  const asEnergy = (ch: number) => preview ? preview.offset + preview.slope * ch : NaN
  const fromPeaks = tab === 'peaks'
  const target = fromPeaks ? solution : { offset, slope }
  const changed = useMemo(() => target && current
    && (target.offset !== current.offset || target.slope !== current.slope), [target, current])

  const save = async (o: number, s: number, pts?: CalibPoint[]) => {
    setSaving(true)
    try {
      await saveChannelCalib(boardId, channel, o, s, pts)
      toast({
        title: 'Calibration saved',
        description: `${label}: E = ${fmt(o)} + ${fmt(s)} × channel.${running ? ' Logged in this run.' : ''}`,
      })
      onSaved()
      onOpenChange(false)
    } catch (e: any) {
      toast({ title: 'Not saved', description: e?.response?.data?.error ?? String(e), variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto overflow-x-hidden">
        <DialogHeader>
          {/* Room on the right for the close button, which sat on a long title. */}
          <DialogTitle className="pr-8">Calibrate {label}</DialogTitle>
          <DialogDescription>
            E = offset + slope × channel. Now:{' '}
            {current
              ? (current.calibrated
                ? <span className="font-medium text-foreground">E = {fmt(current.offset)} + {fmt(current.slope)} × channel</span>
                : 'not calibrated (the axis is in channels)')
              : '…'}
            {current?.updated && <> · from peaks on {current.updated.replace('T', ' ')}</>}
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as 'peaks' | 'numbers')}>
          <TabsList>
            <TabsTrigger value="peaks">From peaks</TabsTrigger>
            <TabsTrigger value="numbers">Numbers</TabsTrigger>
          </TabsList>

          <TabsContent value="peaks" className="space-y-3">
            <div>
              <div className="mb-1 flex items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground">
                  The spectrum in channels. Drag across a peak to zoom on it, then fit it.
                </p>
                <label className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Checkbox checked={logy} onCheckedChange={(v) => setLogy(v === true)} />Log
                </label>
              </div>
              {open && (
                <RootPlot fetch={() => getRawHistogram(boardId, channel, psd ? 'qlong' : 'energy')}
                          deps={[boardId, channel, psd]} logy={logy} height={280}
                          xRange={cardRange} xTitle="ADC channel" yTitle="Counts / bin"
                          onPainter={(p) => { painter.current = p }} />
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={fitInView} disabled={fitting || !running}>
                <Crosshair className="mr-1 h-4 w-4" />{fitting ? 'Fitting…' : 'Fit peak in view'}
              </Button>
              {!running && <span className="text-xs text-muted-foreground">Peaks are fitted on the live spectrum: start a run.</span>}
              {fitError && <span className="text-sm text-destructive">{fitError}</span>}
            </div>

            {fit && (
              <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-3 text-sm">
                <span>
                  Peak at <span className="font-semibold tabular-nums">{fit.centroid.toFixed(2)} ± {fit.centroid_error.toFixed(2)}</span> ch,
                  FWHM {fit.fwhm.toFixed(2)} ch, {Math.round(fit.area).toLocaleString()} counts
                  {preview && Number.isFinite(asEnergy(fit.centroid)) && <> (≈ {asEnergy(fit.centroid).toFixed(1)} keV)</>}
                </span>
                {/* Wraps on a phone: the energy on one line, the list of lines
                    across the full width below it, then Add — it used to run
                    off the screen to the right. */}
                <span className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
                  <Label className="text-sm">is</Label>
                  <NumericInput value={energy ?? ''} min={0} step={0.01} className="h-9 w-28 sm:h-8" aria-label="Energy in keV"
                                placeholder="energy"
                                onValueChange={(v) => { setEnergy(v); setLineName('') }} />
                  <span>keV</span>
                  <Select onValueChange={pickLine}>
                    <SelectTrigger className="h-9 w-full sm:h-8 sm:w-44"><SelectValue placeholder="or pick a line" /></SelectTrigger>
                    <SelectContent>
                      {lines.map((l, i) => (
                        <SelectItem key={`${l.name}-${l.energy}`} value={String(i)}>{l.name} — {l.energy} keV</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button size="sm" className="max-sm:ml-auto max-sm:h-9" onClick={addPoint} disabled={energy === null || !(energy > 0)}><Plus className="mr-1 h-4 w-4" />Add</Button>
                </span>
              </div>
            )}

            {points.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Channel</TableHead>
                    <TableHead>Energy [keV]</TableHead>
                    <TableHead>Line</TableHead>
                    <TableHead className="text-right">Residual [keV]</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {points.map((p, i) => (
                    <TableRow key={`${p.channel}-${p.energy}-${i}`}>
                      <TableCell className="tabular-nums">{p.channel.toFixed(2)}{p.channel_error ? ` ± ${p.channel_error.toFixed(2)}` : ''}</TableCell>
                      <TableCell className="tabular-nums">{p.energy}</TableCell>
                      <TableCell className="text-muted-foreground">{p.line ?? ''}</TableCell>
                      <TableCell className="text-right tabular-nums">{solution ? solution.residuals[i]?.toFixed(3) : '—'}</TableCell>
                      <TableCell className="w-10">
                        <Button variant="ghost" size="icon" aria-label="Remove this peak"
                                onClick={() => setPoints((ps) => ps.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            <p className="text-sm">
              {solution ? (
                <>
                  <span className="font-medium">E = {fmt(solution.offset)} + {fmt(solution.slope)} × channel</span>
                  <span className="text-muted-foreground">
                    {solution.method === 'line' ? ` — a line through ${points.length} peaks` : ' — through zero and one peak; add a second peak for the offset'}
                  </span>
                </>
              ) : solveError ? <span className="text-destructive">{solveError}</span>
                : <span className="text-muted-foreground">Fit at least one peak and give its energy.</span>}
            </p>
          </TabsContent>

          <TabsContent value="numbers" className="space-y-3">
            {/* Labels above full-width fields: a fitted slope has up to 17
                digits, which an inline 9 rem field cut off. */}
            <div className="grid gap-3 text-sm sm:grid-cols-2">
              <label className="space-y-1">
                <span className="text-muted-foreground">Offset (keV)</span>
                <NumericInput value={offset} step={0.1} className="h-8 w-full" aria-label="Offset in keV"
                              onValueChange={setOffset} />
              </label>
              <label className="space-y-1">
                <span className="text-muted-foreground">Slope (keV per channel)</span>
                <NumericInput value={slope} step={0.001} className="h-8 w-full" aria-label="Slope in keV per channel"
                              onValueChange={setSlope} />
              </label>
            </div>
            <p className="text-xs text-muted-foreground">
              E = offset + slope × channel. Offset 0 and slope 1 leave the axis in channels.
            </p>
          </TabsContent>
        </Tabs>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" onClick={() => save(0, 1)} disabled={saving || !current?.calibrated}>
            <RotateCcw className="mr-1 h-4 w-4" />Back to channels
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={() => target && save(target.offset, target.slope, fromPeaks ? points : undefined)}
                    disabled={saving || !target || !(target.slope !== 0) || (!changed && !fromPeaks)}>
              <Save className="mr-1 h-4 w-4" />{saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
