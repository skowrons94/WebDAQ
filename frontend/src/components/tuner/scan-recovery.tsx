'use client'

import { useEffect, useState } from 'react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { getBoardSettings } from '@/lib/api'
import {
  discardScanRecord, readScanRecord, restoreScan, scanRecordState,
  type RestoreResult, type ScanRecord, type ScanRecordState,
} from '@/components/tuner/scan-engine'

type Row = { key: string; name: string; original: number; now: number | null; action: 'restore' | 'same' | 'changed' }

const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const dayTime = (t: number) => {
  const d = new Date(t)
  return d.toDateString() === new Date().toDateString() ? hhmm(t) : `${d.toLocaleDateString()} ${hhmm(t)}`
}

/**
 * Asks before restoring an interrupted Tuner scan: "A scan was interrupted at
 * HH:MM; restore X to Y?". Registers changed since the scan (no longer
 * holding a value the scan wrote) are left alone and listed. Used by the
 * Tuner and by Start on the Dashboard, which waits until the record is gone.
 */
export function ScanRecoveryDialog({
  open, onOpenChange, isLive, onDone, context,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  /** True when the run on now is the Tuner's own (then the board is written too). */
  isLive: () => boolean
  onDone?: (r: RestoreResult | null) => void
  /** Where it is asked from: says what waits on it. */
  context: 'tuner' | 'start'
}) {
  const [rec, setRec] = useState<ScanRecord | null>(null)
  const [state, setState] = useState<ScanRecordState>('none')
  const [rows, setRows] = useState<Row[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<RestoreResult | null>(null)
  const [confirmKeep, setConfirmKeep] = useState(false)

  useEffect(() => {
    if (!open) return
    setResult(null); setConfirmKeep(false); setRows(null)
    const r = readScanRecord()
    setRec(r); setState(scanRecordState())
    if (!r) return
    let alive = true
    getBoardSettings(r.boardId).then((s: Record<string, { name?: string; value_dec: number }>) => {
      if (!alive) return
      setRows(r.original.map((o) => {
        const now = s?.[o.key]?.value_dec ?? null
        const byScan = now !== null && (r.scanned[o.key] ?? []).includes(now)
        return {
          key: o.key, name: s?.[o.key]?.name ?? o.key, original: o.raw, now,
          action: now === o.raw ? 'same' : (byScan || !r.scanned[o.key]) ? 'restore' : 'changed',
        }
      }))
    }).catch(() => { if (alive) setRows([]) })
    return () => { alive = false }
  }, [open])

  const restore = async () => {
    setBusy(true)
    try {
      const res = await restoreScan(isLive(), { onlyScanned: true })
      setResult(res)
      onDone?.(res)
    } finally { setBusy(false) }
  }

  const elsewhere = state === 'active-elsewhere'
  const toRestore = rows?.filter((r) => r.action === 'restore') ?? []

  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o) }}>
      <AlertDialogContent data-testid="scan-recovery">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {!rec ? 'No interrupted scan' : elsewhere ? `A ${rec.name.toLowerCase()} is running in another tab` : `A ${rec.name.toLowerCase()} was interrupted at ${dayTime(rec.heartbeat || rec.startedAt)}`}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm">
              {!rec && <p>Its values were restored already.</p>}
              {rec && elsewhere && (
                <p>Another Tuner tab or window is scanning board {rec.boardId}. Finish or cancel it there; its values are restored when it ends.
                  {context === 'start' && ' The run can start after that.'}</p>
              )}
              {rec && !elsewhere && (
                <>
                  <p>
                    It changed board {rec.boardId} and did not confirm putting the values back. The board configuration may still
                    hold scan values, which the next run would use.{context === 'start' && ' Start waits until they are restored.'}
                  </p>
                  {toRestore.length === 1 && (
                    <p className="font-medium">Restore {toRestore[0].name} to {toRestore[0].original} (now {toRestore[0].now})?</p>
                  )}
                  {rows === null ? <p>Reading the board settings…</p> : rows.length === 0 ? <p>The board settings could not be read.</p> : (
                    <table className="w-full text-sm">
                      <thead><tr className="text-left text-xs text-muted-foreground"><th className="font-normal">Register</th><th className="font-normal">Now</th><th className="font-normal">Before the scan</th><th /></tr></thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr key={r.key} className="border-t border-border/40">
                            <td className="py-1 pr-2">{r.name}</td>
                            <td className="py-1 pr-2 font-mono">{r.now ?? '–'}</td>
                            <td className="py-1 pr-2 font-mono">{r.original}</td>
                            <td className="py-1 text-xs">
                              {r.action === 'restore' ? 'restore' : r.action === 'same' ? 'already back' : 'changed since: left as is'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              )}
              {result && <p role="status" className={result.ok ? 'text-success' : 'font-semibold text-destructive'}>{result.message}</p>}
              {confirmKeep && (
                <p className="text-warning">The present values stay in the configuration and the next run uses them. Press again to confirm.</p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2">
          {rec && !elsewhere && !result?.ok && (
            <Button variant="ghost" disabled={busy} onClick={() => {
              if (!confirmKeep) { setConfirmKeep(true); return }
              discardScanRecord(); setResult({ ok: true, message: 'Kept the present values; the record is gone.', skipped: [] }); onDone?.(null)
            }}>
              {confirmKeep ? 'Yes, keep them' : 'Keep the present values'}
            </Button>
          )}
          <AlertDialogCancel disabled={busy}>{result?.ok || !rec ? 'Close' : 'Not now'}</AlertDialogCancel>
          {rec && !elsewhere && !result?.ok && (
            <AlertDialogAction disabled={busy || rows === null} onClick={(e) => { e.preventDefault(); void restore() }}>
              {busy ? 'Restoring…' : toRestore.length ? `Restore ${toRestore.length === 1 ? toRestore[0].name : `${toRestore.length} registers`}` : 'Check and clear'}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
