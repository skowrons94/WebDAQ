'use client'

/**
 * One live ROOT histogram from a fetcher returning ROOT JSON. Redrawn in place
 * on every refresh, so a zoom the operator made survives the updates; rebuilt
 * only when the shape changes (always for 2D, whose colour scale would stick).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTheme } from 'next-themes'
import { loadJSROOT } from '@/lib/load-jsroot'

const REFRESH_MS = 2500

/** The theme's series colour, as JSROOT wants it (rrggbb). */
function seriesHex(): string | null {
  if (typeof window === 'undefined') return null
  const v = getComputedStyle(document.documentElement).getPropertyValue('--chart-1').trim()
  const m = v.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/)
  if (!m) return null
  const h = Number(m[1]) / 360, sat = Number(m[2]) / 100, l = Number(m[3]) / 100
  const f = (n: number) => {
    const k = (n + h * 12) % 12
    const a = sat * Math.min(l, 1 - l)
    return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255).toString(16).padStart(2, '0')
  }
  return `${f(0)}${f(8)}${f(4)}`
}


/**
 * One live ROOT histogram. Redrawn in place on every refresh, so a zoom the
 * operator made survives the updates; rebuilt only when the shape changes.
 */
export function RootPlot({ fetch, deps, logx = false, logy = false, twoD = false, height = 260, live = true, onPainter }: {
  fetch: () => Promise<any>
  deps: unknown[]
  logx?: boolean
  logy?: boolean
  twoD?: boolean
  height?: number
  live?: boolean
  /** The JSROOT painter after each full drawing, e.g. to read the zoom. */
  onPainter?: (painter: any) => void
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
      const fp = sameShape ? painterRef.current?.getFramePainter?.() : null
      const zoom = fp && fp.zoom_xmin !== fp.zoom_xmax
        ? [fp.zoom_xmin, fp.zoom_xmax, fp.zoom_ymin, fp.zoom_ymax] : null
      try { JSROOT.cleanup(el) } catch { /* nothing drawn yet */ }
      const canvas = JSROOT.create('TCanvas')
      canvas.fLogx = logx ? 1 : 0
      canvas.fLogy = logy ? 1 : 0
      const series = seriesHex()
      const opt = twoD ? 'colz' : (series ? `hist nostat fill_${series}55 line_${series}` : 'hist nostat')
      canvas.fPrimitives.Add(obj, opt)
      canvasRef.current = canvas
      painterRef.current = await JSROOT.redraw(el, canvas)
      if (zoom) painterRef.current?.getFramePainter?.()?.zoom?.(...zoom)
      onPainterRef.current?.(painterRef.current)
      // An empty placeholder from the server says why in its title.
      if (!obj.fEntries) setError(obj.fName === 'no_data' && title ? title : 'No counts yet')
    } catch (e: any) {
      if (mine === seq.current) setError(e?.message ?? 'Could not draw')
    }
  }, [logx, logy, twoD, resolvedTheme])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { draw(true) }, [draw, ...deps])
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
