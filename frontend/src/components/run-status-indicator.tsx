"use client"

// Acquisition state in the page header, on every page.
//
// The point is that an operator glancing at any screen knows whether beam time
// is being recorded. Anything that has to be looked up on the DAQ page is a
// question that gets asked too late, so this stays visible everywhere and never
// depends on which tab is open.
//
// Three states, deliberately colour AND word coded — colour alone would fail
// both colour-vision-deficient users and a glance at a badly lit control room:
//   CAEN Error  red     at least one board reported a FAIL aggregate this run
//   Running     green   acquiring, no board failures
//   Stopped     neutral no run in progress
// A board failure outranks "running": the run is still going, but the data has
// holes in it, and that is the thing worth interrupting someone for.

import { useEffect, useRef, useState } from "react"
import { AlertTriangle, CircleDot, Square } from "lucide-react"
import { getRunStatus, getStartTime, getExperimentStats } from "@/lib/api"

const POLL_MS = 2000

// Only the fields this component needs; the endpoint returns much more.
interface BoardRateLike {
  failed?: boolean
  board_failures?: number
}

/** Elapsed run time as mm:ss, rolling over to h:mm:ss past an hour so a long
 *  run does not display as "197:43" and leave the reader doing division. */
function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(s / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  const seconds = s % 60
  const mm = String(minutes).padStart(2, "0")
  const ss = String(seconds).padStart(2, "0")
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}

export function RunStatusIndicator() {
  const [isRunning, setIsRunning] = useState(false)
  const [hasBoardError, setHasBoardError] = useState(false)
  const [startTime, setStartTime] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  // Until the first poll answers, show nothing rather than "Stopped" — claiming
  // the DAQ is idle before we know is worse than showing nothing at all.
  const [known, setKnown] = useState(false)

  // Poll acquisition state. Errors are swallowed: a momentary server hiccup
  // should leave the last known state on screen, and a real session expiry is
  // handled centrally by the api interceptor (it redirects to login).
  useEffect(() => {
    let active = true
    // Tracked in a ref rather than read from state, so the poll always sees the
    // latest value without re-creating the interval every time a run starts.
    let runningNow = false

    const poll = async () => {
      const [running, start] = await Promise.all([
        getRunStatus().catch(() => null),
        getStartTime().catch(() => null),
      ])
      if (!active) return

      if (running !== null) {
        runningNow = Boolean(running)
        setIsRunning(runningNow)
        setKnown(true)
      }
      setStartTime(typeof start === "string" ? start : null)

      // Only ask for rates while a run is on. This component lives in the header
      // of every page, and /experiment/stats carries every channel of every
      // board — a payload not worth fetching twice a second just to read one
      // boolean, and one the server answers with [] when nothing is running.
      if (!runningNow) { setHasBoardError(false); return }

      const stats = await getExperimentStats().catch(() => [])
      if (!active) return
      const boards: BoardRateLike[] = Array.isArray(stats) ? stats : []
      setHasBoardError(
        boards.some((b) => Boolean(b.failed) || (b.board_failures ?? 0) > 0),
      )
    }
    poll()
    const id = setInterval(poll, POLL_MS)
    return () => { active = false; clearInterval(id) }
  }, [])

  // Tick the clock locally so it counts every second rather than jumping in
  // POLL_MS steps. Anchored to the server's start_time, which is a
  // timezone-aware ISO string, so it stays right across time zones; the poll
  // above keeps re-anchoring it, so client clock drift cannot accumulate.
  const startRef = useRef<string | null>(null)
  startRef.current = startTime
  useEffect(() => {
    if (!isRunning || !startTime) { setElapsed(0); return }
    const tick = () => {
      const begin = new Date(startRef.current ?? startTime).getTime()
      if (Number.isNaN(begin)) { setElapsed(0); return }
      // Clamped at 0: small server/client clock skew must not show a negative.
      setElapsed(Math.max(0, Math.floor((Date.now() - begin) / 1000)))
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [isRunning, startTime])

  if (!known) return null

  const state = hasBoardError && isRunning
    ? "error"
    : isRunning
      ? "running"
      : "stopped"

  // 'Stopped' is asked to be black, but a literal black would vanish on the dark
  // theme — text-foreground is the theme's black, and white in dark mode.
  const styles = {
    error:   { text: "text-red-600 dark:text-red-500", dot: "bg-red-600 dark:bg-red-500" },
    running: { text: "text-green-600 dark:text-green-500", dot: "bg-green-600 dark:bg-green-500" },
    stopped: { text: "text-foreground", dot: "bg-muted-foreground" },
  }[state]

  const label = state === "error" ? "CAEN Error" : state === "running" ? "Running" : "Stopped"
  const Icon = state === "error" ? AlertTriangle : state === "running" ? CircleDot : Square

  return (
    <div
      className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 ${styles.text}`}
      // Announced to screen readers when it changes: an operator using one must
      // learn about a board failure too, not just see a colour change.
      role="status"
      aria-live="polite"
      title={
        state === "error"
          ? "A board reported a FAIL aggregate during this run — data may be incomplete"
          : state === "running"
            ? "Acquisition is running"
            : "No run in progress"
      }
    >
      {/* Pulsing dot only while healthy and running: on an error the triangle
          carries the alarm, and a pulsing red badge in a control room is noise. */}
      {state === "running" ? (
        <span className="relative flex h-2 w-2 shrink-0">
          <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${styles.dot}`} />
          <span className={`relative inline-flex h-2 w-2 rounded-full ${styles.dot}`} />
        </span>
      ) : (
        <Icon className="h-3.5 w-3.5 shrink-0" />
      )}

      <span className="text-sm font-medium whitespace-nowrap">{label}</span>

      {/* Tabular numerals so the digits do not jitter as the clock ticks. */}
      {isRunning && (
        <span className="text-sm font-mono tabular-nums whitespace-nowrap">
          {formatElapsed(elapsed)}
        </span>
      )}
    </div>
  )
}
