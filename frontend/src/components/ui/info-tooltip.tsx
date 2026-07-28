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
 * cannot render the panel.
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
  return (
    <span className={cn("relative inline-flex group/tip align-middle", className)}>
      <button
        type="button"
        // Not a submit button inside any enclosing form, and reachable by keyboard
        // so the explanation is not mouse-only.
        aria-label={text}
        title={text}
        className={cn(
          "flex h-4 w-4 items-center justify-center rounded-full border",
          "border-muted-foreground/40 text-[10px] leading-none text-muted-foreground",
          "hover:border-foreground hover:text-foreground",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
        onClick={e => e.preventDefault()}
      >
        i
      </button>
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute left-1/2 z-50 w-64 -translate-x-1/2 rounded-md border",
          "bg-popover p-2.5 text-xs leading-snug text-popover-foreground shadow-md",
          "invisible opacity-0 transition-opacity duration-100",
          "group-hover/tip:visible group-hover/tip:opacity-100",
          "group-focus-within/tip:visible group-focus-within/tip:opacity-100",
          side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
        )}
      >
        {text}
      </span>
    </span>
  )
}
