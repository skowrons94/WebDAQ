"use client"

/**
 * A bare trend line for a metric card: enough to see rising, falling or flat
 * without leaving the page. No axes and no labels — the number above it is the
 * reading; this only gives it a direction.
 */
export function Sparkline({
  values,
  className = '',
  height = 32,
}: {
  values: (number | null)[]
  className?: string
  height?: number
}) {
  const points = values.filter((v): v is number => v !== null && Number.isFinite(v))

  if (points.length < 2) {
    return (
      <div
        className={`flex items-center justify-center text-[10px] text-muted-foreground ${className}`}
        style={{ height }}
      >
        no history
      </div>
    )
  }

  const min = Math.min(...points)
  const max = Math.max(...points)
  // A flat series would divide by zero; draw it down the middle instead.
  const span = max - min || 1
  const width = 100 // viewBox units; the SVG scales to its container

  const coords = points.map((value, i) => {
    const x = (i / (points.length - 1)) * width
    const y = height - ((value - min) / span) * (height - 4) - 2
    return `${x.toFixed(2)},${y.toFixed(2)}`
  })

  const rising = points[points.length - 1] >= points[0]

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={`w-full ${className}`}
      style={{ height }}
      role="img"
      aria-label={rising ? 'Trend rising' : 'Trend falling'}
    >
      <polyline
        points={coords.join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        className={rising ? 'text-green-500' : 'text-blue-500'}
      />
    </svg>
  )
}
