/**
 * Neutron/gamma figure of merit from the PSD 2-D histogram (Tuner P6).
 * x = Q-long (energy), y = PSD = 1 − Qshort/Qlong. FoM = |μn − μγ| / (FWHMn + FWHMγ)
 * on the PSD projection of an energy band. Loaded with the PSD scan.
 */
import { binCenters, findPeaks, fitPeak } from '@/lib/peak-fit'

export interface Th2Data {
  nx: number; ny: number
  xmin: number; xmax: number; ymin: number; ymax: number
  /** Counts without under/overflow, x fastest: c[iy * nx + ix]. */
  c: Float64Array
}

type Th2Json = {
  fArray?: ArrayLike<number>
  fXaxis?: { fNbins?: number; fXmin?: number; fXmax?: number }
  fYaxis?: { fNbins?: number; fXmin?: number; fXmax?: number }
}

/** The 2-D histogram as plain numbers, or null if it is not one. */
export function th2Of(h: Th2Json | null | undefined): Th2Data | null {
  const nx = h?.fXaxis?.fNbins, ny = h?.fYaxis?.fNbins, a = h?.fArray
  if (!nx || !ny || !a || a.length < (nx + 2) * (ny + 2)) return null
  const c = new Float64Array(nx * ny)
  for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) c[iy * nx + ix] = Number(a[(iy + 1) * (nx + 2) + ix + 1]) || 0
  return {
    nx, ny, c,
    xmin: Number(h!.fXaxis!.fXmin) || 0, xmax: Number(h!.fXaxis!.fXmax) || nx,
    ymin: Number(h!.fYaxis!.fXmin) || 0, ymax: Number(h!.fYaxis!.fXmax) || 1,
  }
}

/** cur − snap, or null when they do not match (rebinned, restarted). */
export function th2Since(cur: Th2Data, snap: Th2Data | null): Th2Data | null {
  if (!snap) return cur
  if (snap.nx !== cur.nx || snap.ny !== cur.ny || snap.xmin !== cur.xmin || snap.xmax !== cur.xmax) return null
  const c = new Float64Array(cur.c.length)
  for (let i = 0; i < c.length; i++) {
    const d = cur.c[i] - snap.c[i]
    if (d < 0) return null
    c[i] = d
  }
  return { ...cur, c }
}

export interface FomResult {
  fom: number | null
  gamma: { mu: number; fwhm: number } | null
  neutron: { mu: number; fwhm: number } | null
  /** Events in the energy band. */
  counts: number
  reason: string | null
}

/** PSD projection of the x band [lo, hi] (axis units). */
export function projectBand(h: Th2Data, lo: number, hi: number): { y: Float64Array; x: Float64Array; counts: number } {
  const wx = (h.xmax - h.xmin) / h.nx
  const ix0 = Math.max(0, Math.floor((lo - h.xmin) / wx))
  const ix1 = Math.min(h.nx, Math.ceil((hi - h.xmin) / wx))
  const y = new Float64Array(h.ny)
  let counts = 0
  for (let iy = 0; iy < h.ny; iy++) {
    let s = 0
    for (let ix = ix0; ix < ix1; ix++) s += h.c[iy * h.nx + ix]
    y[iy] = s; counts += s
  }
  return { y, x: binCenters(h.ny, h.ymin, h.ymax), counts }
}

export function figureOfMerit(h: Th2Data, lo: number, hi: number): FomResult {
  const { x, y, counts } = projectBand(h, lo, hi)
  if (counts < 50) return { fom: null, gamma: null, neutron: null, counts, reason: 'Too few events in the band yet.' }
  const peaks = findPeaks(x, y, 4).sort((a, b) => b.net - a.net).slice(0, 2).sort((a, b) => a.x - b.x)
  if (peaks.length < 2) return { fom: null, gamma: null, neutron: null, counts, reason: 'Only one population in the band (no neutrons, or not separated).' }
  // Split at the lowest point between the two populations.
  const [g, n] = peaks
  let valley = (g.x + n.x) / 2, vMin = Infinity
  for (let i = 0; i < x.length; i++) if (x[i] > g.x && x[i] < n.x && y[i] < vMin) { vMin = y[i]; valley = x[i] }
  const fg = fitPeak(x, y, Math.max(x[0], g.x - 2 * g.fwhm), valley, { tail: false })
  const fn = fitPeak(x, y, valley, Math.min(x[x.length - 1], n.x + 2 * n.fwhm), { tail: false })
  if (!fg || !fn) return { fom: null, gamma: null, neutron: null, counts, reason: 'The two populations could not be fitted yet.' }
  return {
    fom: Math.abs(fn.centroid - fg.centroid) / (fn.fwhm + fg.fwhm),
    gamma: { mu: fg.centroid, fwhm: fg.fwhm },
    neutron: { mu: fn.centroid, fwhm: fn.fwhm },
    counts,
    reason: null,
  }
}
