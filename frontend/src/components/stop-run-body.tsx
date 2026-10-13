import { formatElapsed } from '@/components/run-status-indicator'

/**
 * What a Stop does, said the same way on the dashboard and in the phone run
 * bar: how long the run went, whether it is being written to disk, and that
 * starting again makes a new run.
 */
export function StopRunBody({ elapsed, saving }: { elapsed: number; saving: boolean | null }) {
  return (
    <>
      <p>
        Acquisition ends for every board{elapsed > 0 ? ` after ${formatElapsed(elapsed)}` : ''}.
      </p>
      {saving === null ? (
        <p>Checking whether this run is being saved…</p>
      ) : saving ? (
        <p>Data saving is <span className="font-semibold text-foreground">on</span>: the run is closed and its files are kept.</p>
      ) : (
        <p className="font-semibold text-destructive">
          Data saving is off for this run: nothing from it is on disk.
        </p>
      )}
      <p>Starting again makes a new run.</p>
    </>
  )
}
