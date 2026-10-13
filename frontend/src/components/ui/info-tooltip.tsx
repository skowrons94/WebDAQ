"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

/**
 * A small "i" affordance that reveals an explanation on hover or keyboard focus.
 *
 * Used instead of inline description text so every control in a grid starts at
 * the same vertical offset — with descriptions inline, a two-line explanation
 * pushes its neighbour's input down and the rows stop lining up.
 *
 * Deliberately dependency-free (no popover library): the panel is a positioned
 * sibling shown via CSS, and `title` carries the same text for anything that
 * cannot render the panel. It is not laid out while hidden, and when shown it
 * is centred on the icon but kept 16 px inside the viewport (phones).
 */
export function InfoTooltip({
  text,
  className,
  side = "top",
}: {
  text: string
  className?: string
  /** Which side of the icon the panel opens on. */
  side?: "top" | "bottom"
}) {
  const ref = React.useRef<HTMLSpanElement>(null)
  const [pos, setPos] = React.useState<{ left: number; width: number } | null>(null)
  const place = () => {
    const el = ref.current
    if (!el || typeof window === "undefined") return
    const r = el.getBoundingClientRect()
    const vw = document.documentElement.clientWidth || window.innerWidth
    const width = Math.min(256, vw - 32)
    const centred = r.left + r.width / 2 - width / 2
    const left = Math.max(16, Math.min(centred, vw - 16 - width))
    setPos({ left: left - r.left, width })
  }
  return (
    <span ref={ref} onMouseEnter={place} onFocus={place}
      className={cn("relative inline-flex group/tip align-middle", className)}>
      <button
        type="button"
        // Not a submit button inside any enclosing form, and reachable by keyboard
        // so the explanation is not mouse-only.
        aria-label={text}
        title={text}
        className={cn(
          "flex h-4 w-4 items-center justify-center rounded-full border",
          "border-muted-foreground/40 text-xs leading-none text-muted-foreground",
          "hover:border-foreground hover:text-foreground",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
        onClick={e => e.preventDefault()}
      >
        i
      </button>
      <span
        role="tooltip"
        style={pos ? { left: pos.left, width: pos.width } : undefined}
        className={cn(
          "pointer-events-none absolute z-50 rounded-md border",
          !pos && "left-1/2 w-[min(16rem,calc(100vw-32px))] -translate-x-1/2",
          "bg-popover p-2.5 text-xs leading-snug text-popover-foreground shadow-md",
          "hidden group-hover/tip:block group-focus-within/tip:block",
          side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
        )}
      >
        {text}
      </span>
    </span>
  )
}
