/**
 * Run actions shared by the dashboard's Run control card and the phone run bar,
 * so both stop a run in exactly the same way.
 */
import {
  getCurrentRunNumber,
  getSaveData,
  reset,
  setRunNumber,
  stopAcquisitionCurrent,
  stopRun,
  stopStatsRun,
} from '@/lib/api'
import { pauseAlertNonBlocking } from '@/lib/grafana-api'
import { noteRunAction } from '@/hooks/use-run-status'
import { restoreTunerSaveFlag, tunerRunRecordStarted } from '@/lib/tuner-save'
import useRunControlStore from '@/store/run-control-store'
import { useGrafanaAlertsStore } from '@/store/grafana-alerts-store'
import { useVisualizationStore } from '@/store/visualization-settings-store'

export interface StopRunResult {
  /** Side effects that did not complete; the DAQ itself is stopped. */
  warnings: string[]
}

/**
 * Stop the DAQ, then the current log and stats.csv if this run was saving
 * them, then pause the auto-managed Grafana alerts. The order is the one the
 * dashboard always used. Throws only if the DAQ stop itself fails, in which
 * case nothing else is touched and the run is still going.
 *
 * `saveData`: whether this run is being saved. When the caller does not know
 * it (the run bar), it is read from the server, where it cannot change during
 * a run.
 */
export async function stopRunSequence(saveData?: boolean): Promise<StopRunResult> {
  const warnings: string[] = []
  // Read with a deadline: a hung request must not hold up a Stop. Unknown
  // counts as "saving", so the current log and stats.csv are closed.
  const saving = saveData ?? Boolean(await Promise.race([
    getSaveData().catch(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 4000)),
  ]))
  const currentEnabled = useVisualizationStore.getState().settings.currentEnabled !== false

  await stopRun()
  // The DAQ is stopped: say so now, and ignore any poll sent before the stop
  // (its answer would put "Running" back for a moment).
  useRunControlStore.getState().update({ isRunning: false, startTime: null, known: true })
  noteRunAction()
  // A run the Tuner started had saving switched off: switch it back.
  if ((await restoreTunerSaveFlag()) === null && tunerRunRecordStarted()) {
    warnings.push('data saving was not switched back on after the Tuner run')
  }

  if (saving) {
    if (currentEnabled) {
      try {
        await stopAcquisitionCurrent()
      } catch (error) {
        console.error('Current recording did not stop:', error)
        warnings.push('the beam current log did not stop')
      }
    }
    try {
      await stopStatsRun()
    } catch (error) {
      console.error('stats.csv did not stop:', error)
      warnings.push('stats.csv did not stop')
    }
  }

  useGrafanaAlertsStore.getState().autoManageUids.forEach((uid) => pauseAlertNonBlocking(uid))
  return { warnings }
}

export interface ForceResetResult {
  warnings: string[]
  /** The run number the next Start will use, when it was advanced. */
  nextRun: number | null
}

/**
 * Last resort after a failed Stop (dashboard and run bar): the server's reset
 * tears the CAEN acquisition down and clears the running flag whatever state
 * it is in. Then, as a Stop does: close the current log and stats.csv, pause
 * the auto-managed Grafana alerts, put back data saving after a Tuner run.
 * The reset does not advance the run number the way a Stop with saving does,
 * so it is advanced here: the next Start must not land on the partial run.
 */
export async function forceResetSequence(runNumber: number | null, saveData?: boolean): Promise<ForceResetResult> {
  const warnings: string[] = []
  const saving = saveData ?? Boolean(await Promise.race([
    getSaveData().catch(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 4000)),
  ]))
  const result = await reset()
  if (result === -1) throw new Error('reset refused')
  useRunControlStore.getState().update({ isRunning: false, startTime: null, known: true, stopFailed: false })
  noteRunAction()
  try { await stopAcquisitionCurrent() } catch { warnings.push('the beam current log did not stop') }
  try { await stopStatsRun() } catch { warnings.push('stats.csv did not stop') }
  useGrafanaAlertsStore.getState().autoManageUids.forEach((uid) => pauseAlertNonBlocking(uid))
  await restoreTunerSaveFlag()
  let nextRun: number | null = null
  if (saving && runNumber !== null) {
    try {
      const current = await getCurrentRunNumber()
      // Advance only if the server has not already moved past the run.
      if (current === runNumber) {
        await setRunNumber(runNumber + 1)
        nextRun = runNumber + 1
        useRunControlStore.getState().setRunNumber(nextRun)
      } else if (typeof current === 'number') {
        nextRun = current
      }
    } catch {
      warnings.push(`the run number was not advanced: set it before the next Start, or run ${runNumber} is offered for overwriting`)
    }
  }
  return { warnings, nextRun }
}

