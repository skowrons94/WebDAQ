import { getAlertEvents, type AlertEvent } from '@/lib/api'

/**
 * Alerts carry the number of the run they happened in. Grouped by run, they
 * let the Logbook flag a run that had a board failure (or any other alert)
 * instead of logging it as a clean "completed run".
 *
 * One request for the newest alerts (the server keeps them across restarts;
 * 500 is its cap in the demo and covers many shifts).
 */
export const RUN_ALERT_LIMIT = 500

export async function getAlertsByRun(): Promise<Map<number, AlertEvent[]>> {
  const { events } = await getAlertEvents({ limit: RUN_ALERT_LIMIT, kind: 'alert' })
  const byRun = new Map<number, AlertEvent[]>()
  for (const e of events) {
    if (e.run_number === null || e.run_number === undefined) continue
    const list = byRun.get(e.run_number)
    if (list) list.push(e)
    else byRun.set(e.run_number, [e])
  }
  return byRun
}

/** "1 alert", "3 alerts". */
export const alertCount = (n: number) => `${n} alert${n === 1 ? '' : 's'}`
