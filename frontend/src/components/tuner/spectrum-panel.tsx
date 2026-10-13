'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { AlertTriangle, Crosshair, RotateCcw } from 'lucide-react'
import { getCalib, getHistogram } from '@/lib/api'
import type { PeakCandidate, PeakFit } from '@/lib/peak-fit'

/** Calibration (offset a, slope b) for a channel; null when uncalibrated (0, 1) or unknown. */
export async function readCalibration(boardName: string, boardId: string, channel: number): Promise<{ a: number; b: number } | null> {
  try {
    const res = await getCalib(boardName, boardId, String(channel))
    if (res?.data?.status !== 'success') return null
    const a = Number(res.data.a), b = Number(res.data.b)
    if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null
    if (a === 0 && b === 1) return null
    return { a, b }
  } catch {
    return null
  }
}

/** X-axis title of the channel spectrum: calibrated energy, or channels (Q-long for PSD). */
export function spectrumAxisTitle(psd: boolean, calibrated: boolean): string {
  if (calibrated) return psd ? 'Q-long (keV)' : 'Energy (keV)'
  return psd ? 'Q-long (ch)' : 'Energy (ch)'
}

/** A spectrum as plain numbers: bin contents without under/overflow, and the axis. */
interface SpectrumData { y: Float64Array; nbins: number; xmin: number; xmax: number }

function spectrumOf(h: { fArray?: ArrayLike<number>; fXaxis?: { fNbins?: number; fXmin?: number; fXmax?: number } } | null): SpectrumData | null {
  const arr = h?.fArray, ax = h?.fXaxis
  if (!arr || !ax?.fNbins) return null
  const n = ax.fNbins
  const y = new Float64Array(n)
  for (let i = 0; i < n; i++) y[i] = Number(arr[i + 1]) || 0
  return { y, nbins: n, xmin: Number(ax.fXmin) || 0, xmax: Number(ax.fXmax) || n }
}

/**
 * Counts since a snapshot: current − snapshot, or null when the two do not
 * belong together (rebinned, or the spectrum restarted with a new run).
 */
export function spectrumSince(cur: SpectrumData, snap: SpectrumData | null): { y: Float64Array; variance: Float64Array } | null {
  if (!snap) return { y: cur.y, variance: cur.y }
  if (snap.nbins !== cur.nbins || snap.xmin !== cur.xmin || snap.xmax !== cur.xmax) return null
  const y = new Float64Array(cur.nbins), v = new Float64Array(cur.nbins)
  let dropped = 0
  for (let i = 0; i < cur.nbins; i++) {
    const d = cur.y[i] - snap.y[i]
    if (d < 0) dropped -= d
    y[i] = Math.max(0, d)
    // The new counts are Poisson on their own: variance = the difference.
    v[i] = Math.max(d, 1)
  }
  // Counts going down means the server started the spectrum again.
  return dropped > 0 ? null : { y, variance: v }
}

type Roi = { center: number; half: number }
/** Below this many counts in the peak, no fit value is shown or used. */
export const MIN_COUNTS = 50

/** Counts inside a region of the shown spectrum. */
function regionCounts(x: ArrayLike<number>, y: ArrayLike<number>, r: Roi): number {
  let n = 0
  for (let i = 0; i < x.length; i++) if (x[i] >= r.center - r.half && x[i] <= r.center + r.half) n += y[i]
  return n
}

/**
 * Whether, after a change, the region should look for its peak elsewhere:
 * only when it has at least MIN_COUNTS and still gives no usable fit.
 */
export function shouldRefind(f: { warning: string | null; net: number } | null, countsInRegion: number): boolean {
  if (countsInRegion < MIN_COUNTS) return false
  return !f || (!!f.warning && f.net >= MIN_COUNTS)
}

/** The line the peak most likely moved to: the nearest, within twice the region's half-width. */
export function nearestLine<T extends { x: number }>(lines: T[], r: Roi): T | null {
  const near = lines.slice().sort((a, b) => Math.abs(a.x - r.center) - Math.abs(b.x - r.center))[0]
  return near && Math.abs(near.x - r.center) <= 2 * r.half ? near : null
}

/** Peaks the panel may pick by itself: lines (narrow against their position) with enough counts, strongest first. */
export function autoPickable<T extends { x: number; fwhm: number; net: number }>(cands: T[]): T[] {
  return cands.filter((c) => c.x > 0 && c.fwhm < 0.25 * c.x && c.net >= MIN_COUNTS)
}

export type FitSummary = { fwhm: number; centroid: number; unit: string; reliable: boolean; fwtmRatio: number }
type Reference = { centroid: number; fwhm: number; unit: string }

const roiKey = (b: string, ch: number, dpp = '') => `lunadaq:tuner-roi:${b}:${ch}:${dpp}`
const refKey = (b: string, ch: number, dpp = '') => `lunadaq:tuner-ref:${b}:${ch}:${dpp}`
const readJson = <T,>(k: string): T | null => { try { const s = window.sessionStorage.getItem(k); return s ? JSON.parse(s) as T : null } catch { return null } }
const writeJson = (k: string, v: unknown) => { try { if (v === null) window.sessionStorage.removeItem(k); else window.sessionStorage.setItem(k, JSON.stringify(v)) } catch { /* tab only */ } }

const fmt = (v: number, unit: string) => {
  if (!Number.isFinite(v)) return '–'
  const a = Math.abs(v)
  const d = a >= 100 ? 0 : a >= 10 ? 1 : 2
  return `${v.toFixed(d)} ${unit}`
}

/**
 * The channel's spectrum (P3): "since last change" (current minus the copy
 * kept when a change reached the board) or the whole run, and a live fit of
 * one peak — FWHM, FWTM, tail and the change since the session started.
 */
export function SpectrumPanel({
  boardId, boardName, channel, psd, jsrootLoaded, refreshTick, changeMark = 0, changeLabel, onFit,
}: {
  boardId: string
  boardName: string
  channel: number
  psd: boolean
  jsrootLoaded: boolean
  refreshTick: number
  /** Goes up each time a change reaches the board: the spectrum restarts from there. */
  changeMark?: number
  changeLabel?: string | null
  /** The current fit (for the change log and the guided flow). */
  onFit?: (f: FitSummary | null) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const zoomRef = useRef<HTMLDivElement>(null)
  const [calibrated, setCalibrated] = useState(false)
  const [logY, setLogY] = useState(false)
  const [mode, setMode] = useState<'since' | 'whole'>('since')
  const [empty, setEmpty] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [roi, setRoiState] = useState<Roi | null>(null)
  const [candidates, setCandidates] = useState<PeakCandidate[]>([])
  const [fit, setFit] = useState<PeakFit | null>(null)
  const [reference, setReference] = useState<Reference | null>(null)
  const [since, setSince] = useState<{ at: number; label: string | null } | null>(null)
  const latest = useRef<SpectrumData | null>(null)
  const snapshot = useRef<SpectrumData | null>(null)
  const pendingSnapshot = useRef(false)
  const autoPicked = useRef(false)
  const refind = useRef(false)
  const unit = calibrated ? 'keV' : 'ch'
  useEffect(() => {
    onFit?.(fit ? { fwhm: fit.fwhm, centroid: fit.centroid, unit, reliable: !fit.warning && fit.net >= MIN_COUNTS, fwtmRatio: fit.fwtmRatio } : null)
  }, [fit, unit]) // eslint-disable-line react-hooks/exhaustive-deps

  // Region and reference belong to the board, channel and firmware: a channel
  // that changes detector (PHA → PSD) starts afresh.
  const fw = psd ? 'psd' : 'pha'
  const setRoi = (r: Roi | null) => { setRoiState(r); writeJson(roiKey(boardId, channel, fw), r) }

  // A new channel: its own region, reference and a fresh start.
  useEffect(() => {
    setRoiState(readJson<Roi>(roiKey(boardId, channel, fw)))
    setReference(readJson<Reference>(refKey(boardId, channel, fw)))
    snapshot.current = null
    latest.current = null
    autoPicked.current = false
    setSince(null)
    setFit(null)
    setCandidates([])
    setNote(null)
  }, [boardId, channel, fw])

  useEffect(() => {
    let alive = true
    readCalibration(boardName, boardId, channel).then((c) => { if (alive) setCalibrated(!!c) })
    return () => { alive = false }
  }, [boardName, boardId, channel])

  // A change reached the board: keep a copy of the spectrum as it is now
  // (taken from the next reading if none is at hand).
  const firstMark = useRef(changeMark)
  useEffect(() => {
    if (changeMark === firstMark.current) return
    if (latest.current) snapshot.current = latest.current
    else pendingSnapshot.current = true
    setSince({ at: Date.now(), label: changeLabel ?? null })
    setNote(null)
    // The peak may move (gain) or widen: let the next fits find it again.
    refind.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changeMark])

  const restartHere = () => {
    if (latest.current) snapshot.current = latest.current
    else pendingSnapshot.current = true
    setSince({ at: Date.now(), label: 'restarted by hand' })
    setNote(null)
    setFit(null)
  }

  useEffect(() => {
    if (!jsrootLoaded || !boardId) return
    const el = ref.current
    if (!el || !window.JSROOT) return
    let alive = true
    ;(async () => {
      try {
        const data = await getHistogram(boardId, String(channel))
        if (!alive) return
        const h = window.JSROOT.parse(data)
        const cur = spectrumOf(h)
        if (!cur) { setEmpty(true); return }
        if (pendingSnapshot.current) { snapshot.current = cur; pendingSnapshot.current = false }
        latest.current = cur
        let shown = cur.y
        let variance = cur.y
        if (mode === 'since' && snapshot.current) {
          const d = spectrumSince(cur, snapshot.current)
          if (d) { shown = d.y; variance = d.variance }
          else {
            snapshot.current = null
            setSince(null)
            setNote('The spectrum started again (new run or rebinning): showing the whole run.')
          }
        }
        let sum = 0
        for (let i = 0; i < shown.length; i++) sum += shown[i]
        setEmpty(sum === 0)
        const arr = new Float64Array(cur.nbins + 2)
        arr.set(shown, 1)
        h.fArray = arr
        h.fEntries = sum
        if (h.fXaxis) h.fXaxis.fTitle = spectrumAxisTitle(psd, calibrated)
        if (h.fYaxis) h.fYaxis.fTitle = 'Counts / bin'
        await window.JSROOT.redraw(el, h, logY ? 'hist;logy' : 'hist')

        // Peaks and the fit: loaded on first use.
        if (sum <= 0) { setFit(null); return }
        const pf = await import('@/lib/peak-fit')
        if (!alive) return
        const x = pf.binCenters(cur.nbins, cur.xmin, cur.xmax)
        const cands = pf.findPeaks(x, shown)
        setCandidates(cands)
        let r = roi
        // Pick the strongest real line by itself (narrow against its position):
        // a continuum (scintillator Compton edges) gives no automatic pick.
        const lines = autoPickable(cands)
        const line = lines[0]
        if (!r && !autoPicked.current && line) {
          autoPicked.current = true
          r = { center: line.x, half: Math.max(3 * line.fwhm, 4 * (cur.xmax - cur.xmin) / cur.nbins) }
          setRoi(r)
        }
        if (!r) { setFit(null); return }
        let f = pf.fitPeak(x, shown, r.center - r.half, r.center + r.half, { variance })
        // After a change the peak may have moved out of the region. Look for it
        // only once the region has collected counts and still fails (few
        // counts right after a change are not a moved peak), and only nearby.
        if (refind.current && shouldRefind(f, regionCounts(x, shown, r))) {
          const near = nearestLine(lines, r)
          if (near) {
            r = { center: near.x, half: Math.max(3 * near.fwhm, r.half) }
            setRoi(r)
            f = pf.fitPeak(x, shown, r.center - r.half, r.center + r.half, { variance })
          }
        }
        if (!alive) return
        setFit(f)
        // The first good fit of the session is the reference.
        if (f && !f.warning) {
          setReference((prev) => {
            if (prev && prev.unit === unit && Math.abs(prev.centroid - f.centroid) < Math.max(3 * f.fwhm, r!.half)) return prev
            const next = { centroid: f.centroid, fwhm: f.fwhm, unit }
            writeJson(refKey(boardId, channel, fw), next)
            return next
          })
          // Follow the peak: re-centre, and narrow or widen to ±4 FWHM when the
          // region is more than 50 % off that, or the peak is off-centre.
          refind.current = false
          const want = 4 * f.fwhm
          if (Math.abs(r.half - want) > 0.5 * want || Math.abs(f.centroid - r.center) > f.fwhm) setRoi({ center: f.centroid, half: want })
        }
        // Zoom on the region with the fitted curve.
        const z = zoomRef.current
        if (z) {
          const w = (cur.xmax - cur.xmin) / cur.nbins
          // Drawn with the fit's grouping, so data and curve share a scale.
          const k = f?.groupFactor ?? Math.max(1, Math.floor((2 * r.half) / w / 80))
          const i0 = Math.max(0, Math.floor((r.center - r.half - cur.xmin) / w))
          const nb = Math.floor((Math.min(cur.nbins, Math.ceil((r.center + r.half - cur.xmin) / w)) - i0) / k)
          const i1 = i0 + nb * k
          if (nb >= 4) {
            const hz = window.JSROOT.createHistogram('TH1D', nb)
            hz.fName = `tuner_roi_${boardId}_${channel}`
            hz.fTitle = ''
            hz.fXaxis.fXmin = cur.xmin + i0 * w
            hz.fXaxis.fXmax = cur.xmin + i1 * w
            hz.fXaxis.fTitle = spectrumAxisTitle(psd, calibrated)
            hz.fYaxis.fTitle = k > 1 ? `Counts / bin (${k} bins grouped)` : 'Counts / bin'
            for (let i = i0; i < i1; i++) hz.fArray[Math.floor((i - i0) / k) + 1] += shown[i]
            const canvas = window.JSROOT.create('TCanvas')
            canvas.fName = `tuner_roi_c_${boardId}_${channel}`
            canvas.fPrimitives.Add(hz, 'hist nostat')
            if (f) {
              const N = 200
              const hc = window.JSROOT.createHistogram('TH1D', N)
              hc.fName = `tuner_fit_${boardId}_${channel}`
              hc.fXaxis.fXmin = hz.fXaxis.fXmin
              hc.fXaxis.fXmax = hz.fXaxis.fXmax
              const cw = (hc.fXaxis.fXmax - hc.fXaxis.fXmin) / N
              for (let i = 0; i < N; i++) hc.fArray[i + 1] = f.model(hc.fXaxis.fXmin + (i + 0.5) * cw)
              hc.fLineColor = 2
              hc.fLineWidth = 2
              canvas.fPrimitives.Add(hc, 'L same')
            }
            await window.JSROOT.redraw(z, canvas)
          }
        }
      } catch {
        /* the next tick retries */
      }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jsrootLoaded, refreshTick, boardId, channel, psd, calibrated, logY, mode, roi])

  const fewCounts = !!fit && fit.net < MIN_COUNTS
  const resolutionPct = fit && fit.centroid > 0 ? (100 * fit.fwhm) / fit.centroid : null
  const sinceText = useMemo(() => {
    if (mode === 'whole') return 'Whole run'
    if (!since) return 'No change sent to the board yet: same as the whole run'
    const t = new Date(since.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    return `Since ${t}${since.label ? ` (${since.label})` : ''}`
  }, [mode, since])

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle>
          {psd ? 'Q-long spectrum' : 'Energy spectrum'}
          <span className="ml-2 text-base font-normal text-muted-foreground">{boardName} — Channel {channel}</span>
        </CardTitle>
        <div className="flex flex-wrap items-center gap-3">
          <ToggleGroup type="single" value={mode} onValueChange={(v) => v && setMode(v as 'since' | 'whole')} aria-label="Spectrum range" className="rounded-md border p-0.5">
            <ToggleGroupItem value="since" className="h-8 px-2 text-xs">Since last change</ToggleGroupItem>
            <ToggleGroupItem value="whole" className="h-8 px-2 text-xs">Whole run</ToggleGroupItem>
          </ToggleGroup>
          <Button variant="outline" size="sm" onClick={restartHere} title="Start counting again from now (the server's spectrum is not touched)">
            <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />Restart from now
          </Button>
          <div className="flex items-center gap-2">
            <Switch id="tuner-spectrum-logy" checked={logY} onCheckedChange={setLogY} />
            <Label htmlFor="tuner-spectrum-logy" className="text-sm">Log scale</Label>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground" aria-live="polite">{sinceText}</p>
        {note && <p className="text-xs text-warning">{note}</p>}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[3fr_2fr]">
          <div className="relative">
            <div ref={ref} className="h-80 w-full rounded-lg border shadow-sm max-md:aspect-[4/3] max-md:h-auto" data-testid="tuner-spectrum" />
            {empty && (
              <p className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-sm text-muted-foreground">
                {mode === 'since' && since ? 'No counts since the last change yet.' : 'No counts yet: the spectrum fills while a run is on.'}
              </p>
            )}
          </div>
          <div className="space-y-3" role="region" aria-label="Peak fit">
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="tuner-roi-center" className="text-xs">Peak at ({unit})</Label>
                <Input id="tuner-roi-center" type="number" className="h-8 w-28 text-sm" value={roi ? Number(roi.center.toFixed(2)) : ''}
                  onChange={(e) => { const v = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(v)) setRoi({ center: v, half: roi?.half ?? 10 }) }} />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="tuner-roi-half" className="text-xs">± ({unit})</Label>
                <Input id="tuner-roi-half" type="number" className="h-8 w-24 text-sm" min={0} value={roi ? Number(roi.half.toFixed(2)) : ''}
                  onChange={(e) => { const v = Number(e.target.value); if (roi && v > 0) setRoi({ ...roi, half: v }) }} />
              </div>
              {candidates.length > 0 && (
                <div className="flex flex-wrap items-center gap-1" aria-label="Peaks found">
                  <Crosshair className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  {candidates.slice(0, 5).map((c) => (
                    <Button key={c.x} variant="outline" size="sm" className="h-7 px-2 text-xs"
                      onClick={() => setRoi({ center: c.x, half: Math.max(3 * c.fwhm, roi?.half && Math.abs(roi.center - c.x) < c.fwhm ? roi.half : 0) })}>
                      {fmt(c.x, '')}
                    </Button>
                  ))}
                </div>
              )}
            </div>
            <div ref={zoomRef} className="h-48 w-full rounded-lg border" data-testid="tuner-roi" />
            {fit ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm" data-testid="tuner-fit">
                {fewCounts ? (
                  <>
                    <dt className="text-muted-foreground">FWHM</dt>
                    <dd className="font-mono tabular-nums text-muted-foreground" title={`Fewer than ${MIN_COUNTS} counts in the peak`}>—</dd>
                  </>
                ) : (
                  <>
                    <dt className="text-muted-foreground">FWHM</dt>
                    <dd className={`font-mono tabular-nums ${fit.warning ? 'text-muted-foreground' : 'font-semibold'}`}>
                      {fmt(fit.fwhm, unit)}{Number.isFinite(fit.fwhmErr) && fit.fwhmErr < fit.fwhm ? ` ± ${fmt(fit.fwhmErr, '').trim()}` : ''}
                      {resolutionPct != null && <span className="ml-2 font-sans text-xs font-normal text-muted-foreground">({resolutionPct.toFixed(resolutionPct < 1 ? 2 : 1)} %)</span>}
                    </dd>
                    <dt className="text-muted-foreground">FWTM</dt>
                    <dd className="font-mono tabular-nums">{fmt(fit.fwtm, unit)} <span className="font-sans text-xs text-muted-foreground">(FWTM/FWHM {fit.fwtmRatio.toFixed(2)}, Gauss 1.82)</span></dd>
                    <dt className="text-muted-foreground">Low tail</dt>
                    <dd className="font-mono tabular-nums">{(fit.tailFraction * 100).toFixed(0)} %</dd>
                    <dt className="text-muted-foreground">Centroid</dt>
                    <dd className="font-mono tabular-nums">{fmt(fit.centroid, unit)}</dd>
                  </>
                )}
                <dt className="text-muted-foreground">Counts</dt>
                <dd className="font-mono tabular-nums">{Math.round(fit.net).toLocaleString()}</dd>
                {!fewCounts && !fit.warning && reference && reference.unit === unit && Math.abs(reference.centroid - fit.centroid) < Math.max(3 * fit.fwhm, roi?.half ?? 0) && (
                  <>
                    <dt className="text-muted-foreground">Session</dt>
                    <dd className="text-sm">
                      start {fmt(reference.fwhm, unit)} → now <span className="font-semibold">{fmt(fit.fwhm, unit)}</span>
                      <button type="button" className="ml-2 text-xs text-muted-foreground underline"
                        onClick={() => { const r = { centroid: fit.centroid, fwhm: fit.fwhm, unit }; setReference(r); writeJson(refKey(boardId, channel, fw), r) }}>
                        use now as start
                      </button>
                    </dd>
                  </>
                )}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">
                {roi ? 'No peak to fit in this region yet.' : 'Pick a peak to fit: type its position or choose one found above.'}
              </p>
            )}
            {fit?.warning && (
              <p className="flex items-start gap-1.5 text-xs text-warning"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{fit.warning}</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
