import * as React from "react"
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  CircleDot,
  HelpCircle,
  MinusCircle,
  Square,
  XCircle,
} from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * The one way LUNADAQ shows a state: colour AND word AND icon, so it reads in
 * a dim control room, in greyscale and to a screen reader alike.
 *
 *   running  green, filled     acquiring
 *   ready    green, outlined   connected and able to start
 *   stopped  grey              no run (a normal state, never red)
 *   off      grey, outlined    a feature that is switched off (not an error)
 *   warning  amber             needs attention, data still flowing
 *   error    red, filled       a fault: FAIL flag, disconnected, failed
 *   unknown  grey, dashed      not answered yet; never claims "Stopped"
 */
export type StatusState =
  | "running"
  | "ready"
  | "stopped"
  | "off"
  | "warning"
  | "error"
  | "unknown"

const STYLES: Record<StatusState, { cls: string; Icon: React.ElementType; label: string }> = {
  running: { cls: "border-transparent bg-success text-success-foreground", Icon: CircleDot, label: "Running" },
  ready:   { cls: "border-success/60 bg-success/10 text-success", Icon: CheckCircle2, label: "Ready" },
  stopped: { cls: "border-transparent bg-muted text-foreground", Icon: Square, label: "Stopped" },
  off:     { cls: "border-border bg-transparent text-muted-foreground", Icon: MinusCircle, label: "Off" },
  warning: { cls: "border-transparent bg-warning text-warning-foreground", Icon: AlertTriangle, label: "Warning" },
  error:   { cls: "border-transparent bg-destructive text-destructive-foreground", Icon: XCircle, label: "Error" },
  unknown: { cls: "border-dashed border-border bg-transparent text-muted-foreground", Icon: HelpCircle, label: "Unknown" },
}

export interface StatusBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  state: StatusState
  /** The word shown; defaults to the state's own ("Running", "Stopped", …). */
  label?: React.ReactNode
  size?: "sm" | "md"
  /** Hide the icon (e.g. inside a dense table cell that already has one). */
  noIcon?: boolean
}

export function StatusBadge({
  state,
  label,
  size = "sm",
  noIcon = false,
  className,
  ...props
}: StatusBadgeProps) {
  const s = STYLES[state]
  const Icon = state === "unknown" && label === undefined ? CircleDashed : s.Icon
  return (
    <span
      data-state={state}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border font-semibold",
        size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-sm",
        s.cls,
        className,
      )}
      {...props}
    >
      {!noIcon && <Icon aria-hidden="true" className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} />}
      {label ?? s.label}
    </span>
  )
}

/** "Running" / "Stopped" / "Unknown" for a run-state boolean that may not be known yet. */
export function runState(isRunning: boolean | null | undefined): StatusState {
  return isRunning == null ? "unknown" : isRunning ? "running" : "stopped"
}
