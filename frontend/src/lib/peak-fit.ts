/**
 * Peak finding and fitting for the Tuner (P3, P6): Gaussian + linear
 * background, with an optional low-energy (Hypermet skew) tail, fitted by
 * Levenberg–Marquardt in the browser. Works in axis units (keV when the
 * spectrum is calibrated, channels otherwise). Loaded on demand.
 */

export interface PeakCandidate {
  /** Peak position (axis units). */
  x: number
  /** Rough FWHM (axis units). */
  fwhm: number
  /** Counts above the local background (rough). */
  net: number
}

export interface PeakFit {
  centroid: number
  centroidErr: number
  sigma: number
  fwhm: number
  fwhmErr: number
  fwtm: number
  /** FWTM / FWHM: 1.82 for a pure Gaussian; larger with a tail. */
  fwtmRatio: number
  /** Share of the peak area in the low-energy tail (0 when fitted without one). */
  tailFraction: number
  /** Counts in the peak above the background. */
  net: number
  chi2ndf: number
  /** Why the numbers should not be trusted yet (few counts, peak narrower than 2 bins…), if so. */
  warning: string | null
  /** The fitted curve (with background) at x. */
  model: (x: number) => number
  /** The fitted background at x. */
  background: (x: number) => number
}

export const GAUSS_FWTM_RATIO = Math.sqrt(Math.log(10) / Math.log(2)) // 1.8226
const FWHM_PER_SIGMA = 2 * Math.sqrt(2 * Math.log(2)) // 2.3548

/** Complementary error function (Numerical Recipes erfcc, |ε| < 1.2e-7). */
export function erfc(x: number): number {
  const z = Math.abs(x)
  const t = 1 / (1 + 0.5 * z)
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 +
    t * (-0.82215223 + t * 0.17087277)))))))))
  return x >= 0 ? r : 2 - r
}

/** Bin centres of a TH1 axis. */
export function binCenters(nbins: number, xmin: number, xmax: number): Float64Array {
  const w = (xmax - xmin) / nbins
  const x = new Float64Array(nbins)
  for (let i = 0; i < nbins; i++) x[i] = xmin + (i + 0.5) * w
  return x
}

function smooth(y: ArrayLike<number>, half: number): Float64Array {
  const n = y.length
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0
    for (let k = i - half; k <= i + half; k++) if (k >= 0 && k < n) { s += y[k]; c++ }
    out[i] = s / c
  }
  return out
}

/**
 * The most prominent peaks, largest first: local maxima of the smoothed
 * spectrum standing clear of their surroundings by more than the counting
 * noise.
 */
export function findPeaks(xIn: ArrayLike<number>, yIn: ArrayLike<number>, max = 8): PeakCandidate[] {
  // Fine spectra (32 k bins) have a few counts per bin: look for peaks on a
  // copy of at most 1024 bins.
  const k = Math.max(1, Math.ceil(yIn.length / 1024))
  const { x, y } = group(xIn, yIn, k)
  const n = y.length
  if (n < 16) return []
  const w = (x[n - 1] - x[0]) / (n - 1)
  const sm = smooth(y, 1)
  const found: PeakCandidate[] = []
  const win = Math.max(4, Math.round(n / 100))
  for (let i = 2; i < n - 2; i++) {
    if (!(sm[i] > 0) || sm[i] < sm[i - 1] || sm[i] < sm[i + 1]) continue
    if (sm[i] === sm[i - 1]) continue
    // Background: the lower of the minima on either side.
    let lMin = Infinity, rMin = Infinity
    for (let k = Math.max(0, i - 3 * win); k < i; k++) lMin = Math.min(lMin, sm[k])
    for (let k = i + 1; k <= Math.min(n - 1, i + 3 * win); k++) rMin = Math.min(rMin, sm[k])
    const bg = Math.max(0, Math.max(lMin, rMin))
    const h = sm[i] - bg
    if (h < 3 * Math.sqrt(Math.max(bg, 1)) + 3) continue
    let a = i, b = i
    while (a > 0 && sm[a] - bg > h / 2) a--
    while (b < n - 1 && sm[b] - bg > h / 2) b++
    const fw = Math.max(1, b - a)
    let net = 0
    for (let k = Math.max(0, i - fw); k <= Math.min(n - 1, i + fw); k++) net += Math.max(0, y[k] - bg)
    found.push({ x: x[i], fwhm: fw * w, net })
  }
  // Merge maxima closer than a FWHM (keep the bigger).
  found.sort((p, q) => q.net - p.net)
  const out: PeakCandidate[] = []
  for (const p of found) {
    if (out.some((q) => Math.abs(q.x - p.x) < Math.max(q.fwhm, p.fwhm))) continue
    out.push(p)
    if (out.length >= max) break
  }
  return out
}

/** Sum groups of k bins (x = mean of the group). */
function group(x: ArrayLike<number>, y: ArrayLike<number>, k: number, v?: ArrayLike<number>) {
  const m = Math.floor(y.length / k)
  if (k <= 1) return { x: Float64Array.from(x), y: Float64Array.from(y), v: Float64Array.from(v ?? y) }
  const gx = new Float64Array(m), gy = new Float64Array(m), gv = new Float64Array(m)
  for (let i = 0; i < m; i++) {
    let sx = 0, sy = 0, sv = 0
    for (let j = 0; j < k; j++) { sx += x[i * k + j]; sy += y[i * k + j]; sv += v ? v[i * k + j] : y[i * k + j] }
    gx[i] = sx / k; gy[i] = sy; gv[i] = sv
  }
  return { x: gx, y: gy, v: gv }
}

type Model = (p: number[], x: number) => number

/** Levenberg–Marquardt on weighted least squares; returns params, covariance and χ². */
function levenberg(
  f: Model, p0: number[], x: ArrayLike<number>, y: ArrayLike<number>, w: ArrayLike<number>,
  clamp: (p: number[]) => number[], maxIter = 200,
): { p: number[]; cov: number[][] | null; chi2: number } {
  const n = x.length, m = p0.length
  let p = clamp(p0.slice())
  const chi2Of = (q: number[]) => {
    let s = 0
    for (let i = 0; i < n; i++) { const r = y[i] - f(q, x[i]); s += r * r * w[i] }
    return s
  }
  let chi2 = chi2Of(p)
  let lambda = 1e-3
  const jac = (q: number[]) => {
    const J: Float64Array[] = []
    for (let j = 0; j < m; j++) {
      const h = Math.max(1e-6, Math.abs(q[j]) * 1e-5)
      const qa = q.slice(); qa[j] += h
      const qb = q.slice(); qb[j] -= h
      const col = new Float64Array(n)
      for (let i = 0; i < n; i++) col[i] = (f(qa, x[i]) - f(qb, x[i])) / (2 * h)
      J.push(col)
    }
    return J
  }
  const normal = (q: number[], J: Float64Array[]) => {
    const A = Array.from({ length: m }, () => new Array(m).fill(0))
    const g = new Array(m).fill(0)
    for (let i = 0; i < n; i++) {
      const r = (y[i] - f(q, x[i])) * w[i]
      for (let a = 0; a < m; a++) {
        g[a] += J[a][i] * r
        for (let b = 0; b <= a; b++) A[a][b] += J[a][i] * J[b][i] * w[i]
      }
    }
    for (let a = 0; a < m; a++) for (let b = a + 1; b < m; b++) A[a][b] = A[b][a]
    return { A, g }
  }
  for (let it = 0; it < maxIter; it++) {
    const J = jac(p)
    const { A, g } = normal(p, J)
    let improved = false
    for (let tries = 0; tries < 10; tries++) {
      const M = A.map((row, a) => row.map((v, b) => (a === b ? v * (1 + lambda) + 1e-12 : v)))
      const d = solve(M, g)
      if (!d) { lambda *= 10; continue }
      const q = clamp(p.map((v, j) => v + d[j]))
      const c = chi2Of(q)
      if (c < chi2) {
        const rel = (chi2 - c) / Math.max(chi2, 1e-12)
        p = q; chi2 = c; lambda = Math.max(lambda / 10, 1e-9); improved = true
        if (rel < 1e-7) it = maxIter
        break
      }
      lambda *= 10
    }
    if (!improved) break
  }
  const { A } = normal(p, jac(p))
  return { p, cov: invert(A), chi2 }
}

function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length
  const M = A.map((r, i) => [...r, b[i]])
  for (let c = 0; c < n; c++) {
    let piv = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r
    if (Math.abs(M[piv][c]) < 1e-300) return null
    ;[M[c], M[piv]] = [M[piv], M[c]]
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const k = M[r][c] / M[c][c]
      for (let k2 = c; k2 <= n; k2++) M[r][k2] -= k * M[c][k2]
    }
  }
  return M.map((r, i) => r[n] / r[i])
}

function invert(A: number[][]): number[][] | null {
  const n = A.length
  const cols: number[][] = []
  for (let j = 0; j < n; j++) {
    const e = new Array(n).fill(0); e[j] = 1
    const c = solve(A, e)
    if (!c) return null
    cols.push(c)
  }
  return A.map((_, i) => cols.map((c) => c[i]))
}

/** Width of a single-peaked function at `frac` of its maximum, by dense sampling. */
function widthAt(g: (x: number) => number, lo: number, hi: number, frac: number): number {
  const N = 4000
  const step = (hi - lo) / N
  let im = 0, ym = -Infinity
  const v = new Float64Array(N + 1)
  for (let i = 0; i <= N; i++) { v[i] = g(lo + i * step); if (v[i] > ym) { ym = v[i]; im = i } }
  const t = ym * frac
  let a = im, b = im
  while (a > 0 && v[a] > t) a--
  while (b < N && v[b] > t) b++
  const xa = lo + (a + (t - v[a]) / ((v[a + 1] - v[a]) || 1)) * step
  const xb = lo + (b - (t - v[b]) / ((v[b - 1] - v[b]) || 1)) * step
  return xb - xa
}

/**
 * Fit the peak inside [lo, hi] (axis units). `variance` per bin defaults to
 * the counts (Poisson); pass current + snapshot for a difference spectrum.
 * Tries Gaussian + line first, then adds a low-energy tail when the peak has
 * the counts for it and the tail clearly improves the fit.
 */
export function fitPeak(
  x: ArrayLike<number>, y: ArrayLike<number>, lo: number, hi: number,
  opts: { variance?: ArrayLike<number>; tail?: boolean } = {},
): PeakFit | null {
  const idx: number[] = []
  for (let i = 0; i < x.length; i++) if (x[i] >= lo && x[i] <= hi) idx.push(i)
  if (idx.length < 8) return null
  // At most ~80 bins in the region (more counts per bin, steadier weights).
  const k = Math.max(1, Math.floor(idx.length / 80))
  const g = group(Float64Array.from(idx, (i) => x[i]), Float64Array.from(idx, (i) => y[i]), k,
    opts.variance ? Float64Array.from(idx, (i) => opts.variance![i]) : undefined)
  const xs = g.x, ys = g.y
  // Weights from the locally averaged variance: 1/count weights pull low-count fits down.
  const vs = smooth(g.v, 2)
  const ws = Float64Array.from(vs, (v) => 1 / Math.max(1, v))
  const n = xs.length
  const binW = (xs[n - 1] - xs[0]) / (n - 1)

  // Start values: line through the window edges, the highest bin above it.
  const e = Math.max(2, Math.floor(n * 0.1))
  let yl = 0, yr = 0
  for (let i = 0; i < e; i++) { yl += ys[i]; yr += ys[n - 1 - i] }
  yl /= e; yr /= e
  const xl = xs[Math.floor(e / 2)], xr = xs[n - 1 - Math.floor(e / 2)]
  const slope0 = (yr - yl) / ((xr - xl) || 1)
  const bgAt = (xx: number) => yl + slope0 * (xx - xl)
  let im = 0, hm = -Infinity
  for (let i = 0; i < n; i++) { const h = ys[i] - bgAt(xs[i]); if (h > hm) { hm = h; im = i } }
  if (!(hm > 0)) return null
  let a = im, b = im
  while (a > 0 && ys[a] - bgAt(xs[a]) > hm / 2) a--
  while (b < n - 1 && ys[b] - bgAt(xs[b]) > hm / 2) b++
  const sigma0 = Math.max(binW * 0.5, ((xs[b] - xs[a]) || binW) / FWHM_PER_SIGMA)
  const mu0 = xs[im]
  const span = xs[n - 1] - xs[0]

  // p = [A, mu, sigma, b0, b1, (T, beta)]
  const gauss: Model = (p, xx) => p[0] * Math.exp(-((xx - p[1]) ** 2) / (2 * p[2] * p[2])) + p[3] + p[4] * (xx - mu0)
  const tailTerm = (p: number[], xx: number) => {
    const [A, mu, s, , , T, beta] = p
    const arg = (xx - mu) / beta + (s * s) / (2 * beta * beta)
    if (arg > 50) return 0
    return 0.5 * A * T * Math.exp(arg) * erfc((xx - mu) / (Math.SQRT2 * s) + s / (Math.SQRT2 * beta))
  }
  const withTailPoint: Model = (p, xx) => gauss(p, xx) + tailTerm(p, xx)
  // Bins as wide as the peak: average the shape over the bin (Simpson) rather
  // than sample its centre, or narrow peaks come out too wide.
  const hw = binW / 2
  const binned = (f: Model): Model => (p, xx) => (f(p, xx - hw) + 4 * f(p, xx) + f(p, xx + hw)) / 6
  const gaussB = binned(gauss)
  const withTail = binned(withTailPoint)
  const clampG = (p: number[]) => {
    p[0] = Math.max(1e-9, p[0])
    p[1] = Math.min(xs[n - 1], Math.max(xs[0], p[1]))
    p[2] = Math.min(span, Math.max(binW * 0.2, p[2]))
    return p
  }
  const clampT = (p: number[]) => {
    clampG(p)
    p[5] = Math.min(1, Math.max(0, p[5]))
    p[6] = Math.min(10 * p[2], Math.max(0.3 * p[2], p[6]))
    return p
  }

  const gf = levenberg(gaussB, [hm, mu0, sigma0, yl + slope0 * (mu0 - xl), slope0], xs, ys, ws, clampG)
  let best = { p: gf.p, cov: gf.cov, chi2: gf.chi2, model: gaussB, tail: false }
  let netCounts = 0
  for (let i = 0; i < n; i++) netCounts += ys[i] - (gf.p[3] + gf.p[4] * (xs[i] - mu0))
  if (opts.tail !== false && netCounts > 400 && n >= 12) {
    const t = levenberg(withTail, [...gf.p, 0.05, 2 * gf.p[2]], xs, ys, ws, clampT)
    if (t.chi2 < gf.chi2 - 10 && t.p[5] > 0.005) best = { p: t.p, cov: t.cov, chi2: t.chi2, model: withTail, tail: true }
  }
  const p = best.p
  const ndf = Math.max(1, n - p.length)
  const chi2ndf = best.chi2 / ndf
  const scale = Math.max(1, chi2ndf)
  const err = (j: number) => (best.cov && best.cov[j][j] > 0 ? Math.sqrt(best.cov[j][j] * scale) : NaN)

  const peakOnly = (xx: number) => (best.tail ? withTailPoint : gauss)(p, xx) - (p[3] + p[4] * (xx - mu0))
  const range0 = p[1] - 10 * p[2] - (best.tail ? 10 * p[6] : 0)
  const range1 = p[1] + 6 * p[2]
  let fwhm: number, fwtm: number
  if (best.tail) {
    fwhm = widthAt(peakOnly, range0, range1, 0.5)
    fwtm = widthAt(peakOnly, range0, range1, 0.1)
  } else {
    fwhm = FWHM_PER_SIGMA * p[2]
    fwtm = GAUSS_FWTM_RATIO * fwhm
  }
  let tailFraction = 0
  if (best.tail) {
    let sg = 0, st = 0
    const N = 2000, step = (range1 - range0) / N
    for (let i = 0; i <= N; i++) {
      const xx = range0 + i * step
      sg += p[0] * Math.exp(-((xx - p[1]) ** 2) / (2 * p[2] * p[2]))
      st += tailTerm(p, xx)
    }
    tailFraction = st / Math.max(1e-12, sg + st)
  }
  let net = 0
  for (let i = 0; i < n; i++) net += ys[i] - (p[3] + p[4] * (xs[i] - mu0))
  if (!Number.isFinite(fwhm) || fwhm <= 0) return null
  const fwhmErr = err(2) * (fwhm / p[2])
  const warning = net < 200 ? 'Few counts in the peak: wait for more.'
    : fwhm < 2 * binW ? 'The peak is narrower than two bins: rebin finer for a reliable width.'
    : !(fwhmErr < 0.3 * fwhm) ? 'The width is poorly determined: wait for more counts or adjust the region.'
    : chi2ndf > 5 ? 'Poor fit: a neighbouring peak in the region, or the region too narrow.'
    : null
  return {
    centroid: p[1],
    centroidErr: err(1),
    sigma: p[2],
    fwhm,
    fwhmErr,
    fwtm,
    fwtmRatio: fwtm / fwhm,
    tailFraction,
    net: Math.max(0, net),
    chi2ndf,
    warning,
    model: (xx) => (best.tail ? withTailPoint : gauss)(p, xx),
    background: (xx) => p[3] + p[4] * (xx - mu0),
  }
}
