'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * A horizontal scroller that says there is more to the right: a fade on the
 * right edge (and on the left once scrolled), shown only while there is
 * something hidden on that side. Used where columns or tabs run off-screen
 * with no other cue (channels 6–15 of the trigger table, the phone tab strip).
 */
export function ScrollFade({
  children,
  className,
  innerClassName,
  hint,
  tone = 'background',
}: {
  children: React.ReactNode
  className?: string
  innerClassName?: string
  /** Optional text under the scroller while more is hidden to the right. */
  hint?: string
  /** The surface it sits on, so the fade matches it. */
  tone?: 'background' | 'card'
}) {
  const from = tone === 'card' ? 'from-card' : 'from-background'
  const ref = React.useRef<HTMLDivElement>(null)
  const [edges, setEdges] = React.useState({ left: false, right: false })

  const measure = React.useCallback(() => {
    const el = ref.current
    if (!el) return
    const left = el.scrollLeft > 2
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }))
  }, [])

  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    measure()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    if (el.firstElementChild) ro?.observe(el.firstElementChild)
    return () => ro?.disconnect()
  }, [measure])

  return (
    <div className={className}>
      <div className="relative">
        <div ref={ref} onScroll={measure} className={cn('overflow-x-auto', innerClassName)}>
          {children}
        </div>
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r to-transparent transition-opacity',
            from,
            edges.left ? 'opacity-100' : 'opacity-0',
          )}
        />
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l to-transparent transition-opacity',
            from,
            edges.right ? 'opacity-100' : 'opacity-0',
          )}
        />
      </div>
      {hint && edges.right && <p className="mt-1 text-right text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
