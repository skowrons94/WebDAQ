'use client'

import type { StatusState } from '@/components/ui/status-badge'
import { useRunStatus } from '@/hooks/use-run-status'
import { tunerOwnsRun } from '@/lib/tuner-save'
import type { RunControlState } from '@/store/run-control-store'

/**
 * The one rule for what the run state is called, so the header, the phone run
 * bar, the dashboard's Run status card, Recent runs and every tab say the same
 * thing at the same moment. In order of precedence:
 *
 *   No answer            the last poll failed: nothing else is claimed
 *   Unknown              no answer yet
 *   Board failure        running, and a board reported FAIL this run (red):
 *                        an error always wins over "Running"
 *   Tuning · not saved   running, but it is the Tuner's acquisition from this
 *                        browser (saving is off; it is not a production run)
 *   Running              acquiring
 *   Stopped              no run
 */
export interface RunBadge {
  state: StatusState
  label: string
  /** A sentence for a title attribute / tooltip. */
  title: string
  running: boolean
  failed: boolean
  tuning: boolean
}

type RunFields = Pick<RunControlState, 'known' | 'unreachable' | 'isRunning' | 'boardError' | 'startTime'>

export const BOARD_FAILURE_LABEL = 'Board failure'

export function deriveRunBadge(s: RunFields, opts: { boardFailed?: boolean } = {}): RunBadge {
  const running = s.isRunning
  const failed = running && (s.boardError || Boolean(opts.boardFailed))
  const tuning = running && tunerOwnsRun(s.startTime)
  const base = { running, failed, tuning }
  if (s.unreachable) {
    return { ...base, state: 'warning', label: 'No answer',
      title: 'The DAQ server did not answer the last run-status request; the run state is unknown until it does' }
  }
  if (!s.known) return { ...base, state: 'unknown', label: 'Unknown', title: 'Waiting for the DAQ server' }
  if (failed) {
    return { ...base, state: 'error', label: BOARD_FAILURE_LABEL,
      title: 'A board reported a FAIL flag during this run: data may be incomplete. See Troubleshoot.' }
  }
  if (tuning) {
    return { ...base, state: 'tuning', label: 'Tuning · not saved',
      title: 'The Tuner is acquiring with data saving off: this is not a production run and nothing is written' }
  }
  if (running) return { ...base, state: 'running', label: 'Running', title: 'Acquisition is running' }
  return { ...base, state: 'stopped', label: 'Stopped', title: 'No run in progress' }
}

/** deriveRunBadge on the shared run-status poller. */
export function useRunBadge(opts: { boardFailed?: boolean } = {}): RunBadge {
  const s = useRunStatus()
  return deriveRunBadge(s, opts)
}
