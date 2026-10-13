/**
 * Run actions shared by the dashboard's Run control card and the phone run bar,
 * so both stop a run in exactly the same way.
 */
import {
  getSaveData,
  stopAcquisitionCurrent,
  stopRun,
  stopStatsRun,
} from '@/lib/api'
import { pauseAlertNonBlocking } from '@/lib/grafana-api'
import { noteRunAction } from '@/hooks/use-run-status'
import { restoreTunerSaveFlag, tunerSaveRecordPending } from '@/lib/tuner-save'
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
  if ((await restoreTunerSaveFlag()) === null && tunerSaveRecordPending()) {
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
