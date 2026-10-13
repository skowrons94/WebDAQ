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
import { refreshRunStatus } from '@/hooks/use-run-status'
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
  const saving = saveData ?? Boolean(await getSaveData().catch(() => true))
  const currentEnabled = useVisualizationStore.getState().settings.currentEnabled !== false

  await stopRun()

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
  await refreshRunStatus().catch(() => undefined)
  return { warnings }
}
