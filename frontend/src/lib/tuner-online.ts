/**
 * The Tuner's Online switch and production runs (round-2 review M1).
 *
 * With Online on, Save all writes the live-safe registers straight to the
 * board. During a production run that changes the data being saved, while
 * the run's stored register file (taken at start) does not show it. So:
 *  - Online is remembered for the tab, but restored only when no production
 *    run is on (stopped, or the run is the Tuner's own);
 *  - a production run starting while Online is on switches it off;
 *  - Online during a production run needs an explicit confirmation, for that
 *    run only.
 */
export type RunKind = 'unknown' | 'stopped' | 'tuner' | 'production'

export function runKind(known: boolean, isRunning: boolean, tunerOwns: boolean): RunKind {
  if (!known) return 'unknown'
  if (!isRunning) return 'stopped'
  return tunerOwns ? 'tuner' : 'production'
}

/** Online as restored from the tab: never into a production run (nor before the run state is known). */
export function restoredOnline(stored: boolean, kind: RunKind): boolean {
  return stored && (kind === 'stopped' || kind === 'tuner')
}

/** Whether Online, on now, must be switched off (a production run without the operator's confirmation for it). */
export function onlineMustDrop(online: boolean, kind: RunKind, confirmedFor: string | null, startTime: string | null): boolean {
  return online && kind === 'production' && (confirmedFor === null || confirmedFor !== startTime)
}
