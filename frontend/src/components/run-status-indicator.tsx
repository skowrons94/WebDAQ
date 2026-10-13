"use client"

// Acquisition state in the page header, on every page.
//
// The point is that an operator glancing at any screen knows whether beam time
// is being recorded. Anything that has to be looked up on the DAQ page is a
// question that gets asked too late, so this stays visible everywhere and never
// depends on which tab is open.
//
// Colour AND word AND icon coded (StatusBadge) — colour alone would fail both
// colour-vision-deficient users and a glance at a badly lit control room. The
// states and their precedence are in hooks/use-run-badge.ts:
//   Board failure       red     at least one board reported a FAIL aggregate this run
//   Tuning              amber   the Tuner's own acquisition, saving off
//   Running             green   acquiring, no board failures
//   Stopped             neutral no run in progress
// A board failure outranks "running": the run is still going, but the data has
// holes in it, and that is the thing worth interrupting someone for.

import { useEffect, useState } from "react"
import { StatusBadge } from "@/components/ui/status-badge"
import { useRunStatus } from "@/hooks/use-run-status"
import { useRunBadge } from "@/hooks/use-run-badge"
import { cn } from "@/lib/utils"

/** Elapsed run time as mm:ss, rolling over to h:mm:ss past an hour so a long
 *  run does not display as "197:43" and leave the reader doing division. */
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(s / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  const seconds = s % 60
  const mm = String(minutes).padStart(2, "0")
  const ss = String(seconds).padStart(2, "0")
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}

/**
 * Seconds since the server's start_time, ticking every second. Anchored to the
 * server's timezone-aware ISO string, so it is right across time zones; the
 * shared poller keeps re-anchoring it, so client clock drift cannot accumulate.
 */
export function useElapsed(isRunning: boolean, startTime: string | null): number {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!isRunning || !startTime) { setElapsed(0); return }
    const begin = new Date(startTime).getTime()
    if (Number.isNaN(begin)) { setElapsed(0); return }
    // Clamped at 0: small server/client clock skew must not show a negative.
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - begin) / 1000)))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [isRunning, startTime])
  return elapsed
}

export function RunStatusIndicator({ className }: { className?: string }) {
  // The state comes from the one shared poller (hooks/use-run-status.ts), and
  // its name from the one rule (hooks/use-run-badge.ts), so the header can
  // never disagree with the dashboard, the run bar or /alerts.
  const { known, isRunning, startTime, unreachable } = useRunStatus()
  const badge = useRunBadge()
  const elapsed = useElapsed(isRunning, startTime)

  // Until the first poll answers, show nothing rather than "Stopped" — claiming
  // the DAQ is idle before we know is worse than showing nothing at all.
  if (!known && !unreachable) return null

  return (
    <div
      className={cn("flex shrink-0 items-center gap-1.5", className)}
      // Announced to screen readers when it changes: an operator using one must
      // learn about a board failure too, not just see a colour change.
      role="status"
      aria-live="polite"
      title={badge.title}
    >
      <StatusBadge state={badge.state} label={badge.label} size="md" />
      {/* Tabular numerals so the digits do not jitter as the clock ticks. */}
      {isRunning && !unreachable && (
        <span className="font-mono text-sm tabular-nums whitespace-nowrap">
          {formatElapsed(elapsed)}
        </span>
      )}
    </div>
  )
}
