'use client'

/**
 * One live ROOT histogram from a fetcher returning ROOT JSON. Redrawn in place
 * on every refresh, so a zoom the operator made survives the updates; rebuilt
 * only when the shape changes (always for 2D, whose colour scale would stick).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTheme } from 'next-themes'
import { loadJSROOT } from '@/lib/load-jsroot'
import { seriesOption } from '@/lib/jsroot-style'

const REFRESH_MS = 2500

/**
 * One live ROOT histogram. Redrawn in place on every refresh, so a zoom the
 * operator made survives the updates; rebuilt only when the shape changes.
 */
type Title = string | ((obj: any) => string)

/** TAxis kNoExponent (bit 17 in JSROOT): write 20000, not 20×10³, on both axes alike. */
const NO_EXPONENT = 1 << 17

export function RootPlot({ fetch, deps, logx = false, logy = false, twoD = false, height = 260, live = true, onPainter, xTitle, yTitle, xRange }: {
  fetch: () => Promise<any>
  deps: unknown[]
  logx?: boolean
  logy?: boolean
  twoD?: boolean
  height?: number
  live?: boolean
  /** The JSROOT painter after each full drawing, e.g. to read the zoom. */
  onPainter?: (painter: any) => void
  /**
   * Axis titles in the site's wording ("Δt (ns)", "Counts / bin"); they take
   * the place of the server's, which differ from plot to plot. A function
   * gets the parsed object, e.g. to tell a calibrated axis from a raw one.
   */
  xTitle?: Title
  yTitle?: Title
  /**
   * The x range shown when the plot is first drawn or this range changes;
   * null shows everything. The operator's own zoom is kept otherwise.
   */
  xRange?: [number, number] | null
}) {
  const ref = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<any>(null)
  const painterRef = useRef<any>(null)
  const [error, setError] = useState<string | null>(null)
  const { resolvedTheme } = useTheme()
  const fetchRef = useRef(fetch)
  fetchRef.current = fetch
  const seq = useRef(0)            // only the latest request may draw
  const onPainterRef = useRef(onPainter)
  onPainterRef.current = onPainter
  const titlesRef = useRef({ xTitle, yTitle })
  titlesRef.current = { xTitle, yTitle }
  const rangeKey = xRange ? `${xRange[0]}:${xRange[1]}` : ''
  const xRangeRef = useRef(xRange)
  xRangeRef.current = xRange
  const appliedRange = useRef<string | null>(null)

  const draw = useCallback(async (rebuild: boolean) => {
    const el = ref.current
    if (!el) return
    const mine = ++seq.current
    try {
      await loadJSROOT()
      const JSROOT = (window as any).JSROOT
      JSROOT.settings.DarkMode = resolvedTheme === 'dark'
      const data = await fetchRef.current()
      if (mine !== seq.current) return
      const obj = JSROOT.parse(data)
      if (!obj || !el.isConnected) return
      setError(null)
      const title = obj.fTitle
      obj.fTitle = ''
      const { xTitle: xt, yTitle: yt } = titlesRef.current
      if (obj.fName !== 'no_data') {
        if (xt && obj.fXaxis) obj.fXaxis.fTitle = typeof xt === 'function' ? xt(obj) : xt
        if (yt && obj.fYaxis) obj.fYaxis.fTitle = typeof yt === 'function' ? yt(obj) : yt
      }
      if (twoD) for (const ax of [obj.fXaxis, obj.fYaxis]) if (ax) ax.fBits = (ax.fBits ?? 0) | NO_EXPONENT
      const existing = canvasRef.current?.fPrimitives?.arr?.[0]
      const sameShape = existing && existing._typename === obj._typename
        && existing.fArray?.length === obj.fArray?.length
        && existing.fXaxis?.fXmin === obj.fXaxis?.fXmin && existing.fXaxis?.fXmax === obj.fXaxis?.fXmax
      // A 2D plot keeps the colour scale of its first drawing when only its
      // contents change, so it is always drawn anew (the zoom carried over).
      if (!rebuild && !twoD && sameShape && painterRef.current) {
        for (const f of ['fArray', 'fEntries', 'fMaximum', 'fMinimum', 'fTsumw', 'fTsumw2', 'fTsumwx', 'fTsumwx2'])
          existing[f] = obj[f]
        if (painterRef.current.redrawPad) painterRef.current.redrawPad()
        setError(obj.fEntries ? null : 'No counts yet')
        return
      }
      // A new requested range replaces the operator's zoom; otherwise the
      // zoom is carried over the redraw.
      const key = xRangeRef.current ? `${xRangeRef.current[0]}:${xRangeRef.current[1]}` : ''
      const newRange = appliedRange.current !== key
      const fp = sameShape && !newRange ? painterRef.current?.getFramePainter?.() : null
      const zoom = fp && fp.zoom_xmin !== fp.zoom_xmax
        ? [fp.zoom_xmin, fp.zoom_xmax, fp.zoom_ymin, fp.zoom_ymax] : null
      try { JSROOT.cleanup(el) } catch { /* nothing drawn yet */ }
      const canvas = JSROOT.create('TCanvas')
      canvas.fLogx = logx ? 1 : 0
      canvas.fLogy = logy ? 1 : 0
      // The same series colour as the histogram cards, in both themes.
      const opt = twoD ? 'colz' : seriesOption()
      canvas.fPrimitives.Add(obj, opt)
      canvasRef.current = canvas
      painterRef.current = await JSROOT.redraw(el, canvas)
      if (zoom) painterRef.current?.getFramePainter?.()?.zoom?.(...zoom)
      else if (xRangeRef.current) painterRef.current?.getFramePainter?.()?.zoom?.(xRangeRef.current[0], xRangeRef.current[1])
      appliedRange.current = key
      onPainterRef.current?.(painterRef.current)
      // An empty placeholder from the server says why in its title.
      if (!obj.fEntries) setError(obj.fName === 'no_data' && title ? title : 'No counts yet')
    } catch (e: any) {
      if (mine === seq.current) setError(e?.message ?? 'Could not draw')
    }
  }, [logx, logy, twoD, resolvedTheme])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { draw(true) }, [draw, rangeKey, ...deps])
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => { if (document.visibilityState === 'visible') draw(false) }, REFRESH_MS)
    return () => clearInterval(t)
  }, [draw, live])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => { try { (window as any).JSROOT?.resize(el) } catch { /* */ } })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div className="relative">
      <div ref={ref} style={{ height }} className="w-full" />
      {error && (
        <p className="pointer-events-none absolute inset-x-0 top-2 text-center text-xs text-muted-foreground">{error}</p>
      )}
    </div>
  )
}
