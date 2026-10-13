'use client'

/** A small dependency-free plot of scan results (points joined by a line). */
export function ScanPlot({
  points, xLabel, yLabel, logY = false, marker, reverseX = false, height = 180, ariaLabel,
}: {
  points: { x: number; y: number; err?: number }[]
  xLabel: string
  yLabel: string
  logY?: boolean
  /** Highlighted x (the recommendation). */
  marker?: number | null
  reverseX?: boolean
  height?: number
  ariaLabel: string
}) {
  const W = 520, H = height, L = 56, R = 12, T = 10, B = 34
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && (!logY || p.y > 0))
  if (!pts.length) {
    return <div className="flex h-24 items-center justify-center rounded-md border text-xs text-muted-foreground">No points yet</div>
  }
  const xs = pts.map((p) => p.x)
  let x0 = Math.min(...xs), x1 = Math.max(...xs)
  if (x0 === x1) { x0 -= 1; x1 += 1 }
  const fy = (v: number) => (logY ? Math.log10(v) : v)
  const ys = pts.flatMap((p) => [fy(Math.max(p.y - (p.err ?? 0), logY ? p.y / 2 : -Infinity)), fy(p.y + (p.err ?? 0))])
  let y0 = Math.min(...ys), y1 = Math.max(...ys)
  if (!logY) y0 = Math.min(y0, 0)
  if (y0 === y1) { y0 -= 1; y1 += 1 }
  const pad = (y1 - y0) * 0.08
  y0 -= logY ? pad : 0; y1 += pad
  const sx = (x: number) => {
    const t = (x - x0) / (x1 - x0)
    return L + (reverseX ? 1 - t : t) * (W - L - R)
  }
  const sy = (v: number) => T + (1 - (fy(v) - y0) / (y1 - y0)) * (H - T - B)
  const sorted = pts.slice().sort((a, b) => a.x - b.x)
  const path = sorted.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ')
  const yTicks = logY
    ? Array.from({ length: Math.floor(y1) - Math.ceil(y0) + 1 }, (_, i) => Math.pow(10, Math.ceil(y0) + i))
    : [0, 0.25, 0.5, 0.75, 1].map((t) => y0 + t * (y1 - y0))
  const fmt = (v: number) => (Math.abs(v) >= 1e4 ? v.toExponential(0) : Math.abs(v) >= 10 ? v.toFixed(0) : v.toPrecision(2))
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full text-foreground" role="img" aria-label={ariaLabel}>
      <rect x={L} y={T} width={W - L - R} height={H - T - B} fill="none" stroke="currentColor" strokeOpacity={0.3} />
      {yTicks.map((v) => (
        <g key={v}>
          <line x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} stroke="currentColor" strokeOpacity={0.08} />
          <text x={L - 4} y={sy(v) + 3} textAnchor="end" fontSize={10} fill="currentColor" fillOpacity={0.7}>{fmt(v)}</text>
        </g>
      ))}
      {sorted.map((p) => (
        <text key={`t${p.x}`} x={sx(p.x)} y={H - B + 13} textAnchor="middle" fontSize={10} fill="currentColor" fillOpacity={0.7}>{fmt(p.x)}</text>
      ))}
      <text x={(L + W - R) / 2} y={H - 4} textAnchor="middle" fontSize={11} fill="currentColor">{xLabel}</text>
      <text x={12} y={(T + H - B) / 2} textAnchor="middle" fontSize={11} fill="currentColor" transform={`rotate(-90 12 ${(T + H - B) / 2})`}>{yLabel}</text>
      {marker != null && Number.isFinite(marker) && marker >= x0 && marker <= x1 && (
        <line x1={sx(marker)} x2={sx(marker)} y1={T} y2={H - B} stroke="hsl(var(--success))" strokeWidth={2} strokeDasharray="4 3" />
      )}
      <path d={path} fill="none" stroke="hsl(var(--primary))" strokeWidth={1.5} />
      {sorted.map((p) => (
        <g key={`p${p.x}`}>
          {p.err != null && Number.isFinite(p.err) && p.err > 0 && (
            <line x1={sx(p.x)} x2={sx(p.x)} y1={sy(p.y + p.err)} y2={sy(Math.max(p.y - p.err, logY ? p.y / 2 : p.y - p.err))} stroke="hsl(var(--primary))" />
          )}
          <circle cx={sx(p.x)} cy={sy(p.y)} r={3.5} fill="hsl(var(--primary))" />
        </g>
      ))}
    </svg>
  )
}
