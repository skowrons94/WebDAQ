'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  CheckCheck, Loader2, MailWarning, RefreshCw, Trash2, Wrench,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'
import { useToast } from '@/components/ui/use-toast'
import { eventIcon, relativeTime } from '@/components/notification-bell'
import {
  clearAlertEvents, getAlertEvents, getRecoveryActions, markAlertEventsSeen,
  runRecoveryAction,
  type AlertEvent, type AlertEventSummary, type RecoveryAction,
} from '@/lib/api'

/**
 * Activity & recovery — what happened, and what to press about it.
 *
 * The history is the whole point of writing alerts down: a shift that starts at
 * 08:00 can read 03:00, including whether the message actually reached anybody.
 * The recovery panel sits beside it because the next question after "what
 * happened" is "what do I do", and the answer used to live in someone's head.
 */

const POLL_MS = 10000
const KINDS = [
  { value: '', label: 'Everything' },
  { value: 'alert', label: 'Problems' },
  { value: 'recovery', label: 'Recoveries' },
  { value: 'info', label: 'Actions' },
] as const

export default function ActivityLog() {
  const { toast } = useToast()
  const [events, setEvents] = useState<AlertEvent[]>([])
  const [summary, setSummary] = useState<AlertEventSummary | null>(null)
  const [actions, setActions] = useState<RecoveryAction[]>([])
  const [kind, setKind] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [running, setRunning] = useState<string | null>(null)
  // Clearing throws away the only record of the night: ask first.
  const [confirmClear, setConfirmClear] = useState(false)

  const refresh = useCallback(async (initial = false) => {
    try {
      if (initial) setLoading(true)
      const [history, recovery] = await Promise.all([
        getAlertEvents({ limit: 200, kind: kind || undefined }),
        getRecoveryActions(),
      ])
      setEvents(history.events)
      setSummary(history.summary)
      setActions(recovery.actions)
      setError(false)
    } catch (e) {
      console.error('Failed to load the activity log:', e)
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [kind])

  useEffect(() => {
    refresh(true)
    const timer = setInterval(() => refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const recover = async (action: RecoveryAction) => {
    try {
      setRunning(action.name)
      const result = await runRecoveryAction(action.name)
      toast({
        title: result.success ? action.label : `${action.label} did not work`,
        description: result.message,
        variant: result.success ? undefined : 'destructive',
      })
      await refresh()
    } catch (error) {
      toast({ title: 'Error', description: 'The server could not be reached.',
              variant: 'destructive' })
    } finally {
      setRunning(null)
    }
  }

  // Something that is only blocked right now (reopening boards during a run) or
  // not installed at all is not a problem to shout about.
  const problems = actions.filter((a) => !a.ok && a.enabled
    && !a.detail.toLowerCase().includes('no beam-current monitor'))

  return (
    <div className="space-y-4">
      {/* ── Recovery: what to press ───────────────────────────────────────── */}
      <Card className={problems.length ? 'border-amber-500' : ''}>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Wrench className="h-4 w-4" />
            Recovery
          </CardTitle>
          <CardDescription>
            {problems.length
              ? `${problems.length} thing${problems.length === 1 ? '' : 's'} need attention. `
                + 'Nothing here runs by itself — press what you want to happen.'
              : 'Everything answers. These are the fixes, if something stops.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 md:grid-cols-2">
          {actions.map((action) => (
            <div key={action.name}
                 className={`flex items-start justify-between gap-3 rounded-lg border p-3 ${
                   !action.ok && action.enabled ? 'border-amber-500/60 bg-amber-500/5' : ''}`}>
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-medium">
                  {action.label}
                  {!action.ok && action.enabled && (
                    <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
                      needs attention
                    </Badge>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">{action.detail}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">{action.description}</p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <Button size="sm" variant={action.ok ? 'outline' : 'default'}
                        disabled={!action.enabled || running !== null}
                        title={action.blocked_reason || action.description}
                        onClick={() => recover(action)}>
                  {running === action.name
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : 'Run'}
                </Button>
                {/* A disabled button shows no tooltip in most browsers, so the
                    reason has to be on the page. */}
                {action.blocked_reason && (
                  <span className="max-w-[9rem] text-right text-[10px] text-muted-foreground">
                    {action.blocked_reason}
                  </span>
                )}
              </div>
            </div>
          ))}
          {actions.length === 0 && !loading && (
            <p className="text-sm text-muted-foreground">
              No recovery actions are available.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── History: what happened ────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">History</CardTitle>
              <CardDescription>
                Every alert and recovery, newest first, kept on the DAQ server across
                restarts.
                {summary ? ` ${summary.total} recorded, ${summary.unseen} unread.` : ''}
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex overflow-hidden rounded-lg border">
                {KINDS.map((k) => (
                  <button key={k.value} onClick={() => setKind(k.value)}
                          className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                            kind === k.value ? 'bg-primary text-primary-foreground'
                                             : 'text-muted-foreground hover:text-foreground'}`}>
                    {k.label}
                  </button>
                ))}
              </div>
              <Button variant="outline" size="sm" onClick={() => refresh()}>
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                Refresh
              </Button>
              <Button variant="outline" size="sm"
                      disabled={!summary?.unseen}
                      onClick={async () => {
                        try {
                          const data = await markAlertEventsSeen()
                          setSummary(data.summary)
                          setEvents((c) => c.map((e) => ({ ...e, seen: true })))
                        } catch {
                          toast({ title: 'Could not mark them read',
                                  description: 'The DAQ server did not answer.',
                                  variant: 'destructive' })
                        }
                      }}>
                <CheckCheck className="mr-1.5 h-3.5 w-3.5" />
                Mark all read
              </Button>
              {confirmClear ? (
                <span className="flex items-center gap-1">
                  <Button variant="destructive" size="sm"
                          onClick={async () => {
                            try {
                              const { removed } = await clearAlertEvents()
                              await refresh()
                              toast({ title: `Deleted ${removed} event(s)` })
                            } catch {
                              toast({ title: 'Nothing was deleted',
                                      description: 'The DAQ server did not answer.',
                                      variant: 'destructive' })
                            } finally {
                              setConfirmClear(false)
                            }
                          }}>
                    Delete all {summary?.total ?? 0}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmClear(false)}>
                    Cancel
                  </Button>
                </span>
              ) : (
                <Button variant="ghost" size="sm" className="text-destructive"
                        title="Delete the whole history"
                        disabled={!summary?.total}
                        onClick={() => setConfirmClear(true)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Reading the history…
            </div>
          ) : error ? (
            <div className="py-16 text-center text-sm">
              <p className="text-destructive">The history could not be read.</p>
              <p className="mt-1 text-muted-foreground">
                The DAQ server did not answer — this is not the same as nothing
                having happened.
              </p>
            </div>
          ) : events.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted-foreground">
              Nothing recorded{kind ? ' of this kind' : ''} yet.
            </p>
          ) : (
            <div className="divide-y">
              {events.map((event) => {
                const delivered = Object.entries(event.deliveries)
                const reachedNobody = delivered.length > 0 && !delivered.some(([, ok]) => ok)
                return (
                  <div key={event.id}
                       className={`flex gap-3 px-4 py-3 ${event.seen ? '' : 'bg-muted/30'}`}>
                    <div className="mt-0.5 shrink-0">{eventIcon(event.kind)}</div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium">{event.title}</p>
                        {event.subject && (
                          <Badge variant="secondary" className="text-[10px]">
                            {event.rule_type === 'board_failure'
                             || event.rule_type === 'stalled_buffers'
                              ? `board ${event.subject}` : event.subject}
                          </Badge>
                        )}
                        {event.run_number !== null && (
                          <Badge variant="outline" className="text-[10px]">
                            run {event.run_number}
                          </Badge>
                        )}
                        {reachedNobody && (
                          <Badge className="gap-1 bg-amber-100 text-amber-800 text-[10px] dark:bg-amber-900/30 dark:text-amber-400">
                            <MailWarning className="h-3 w-3" />
                            reached nobody
                          </Badge>
                        )}
                        {delivered.filter(([, ok]) => ok).map(([name]) => (
                          <Badge key={name} variant="outline" className="text-[10px]">
                            sent to {name}
                          </Badge>
                        ))}
                      </div>
                      {event.lines.map((line, i) => (
                        <p key={i} className="text-xs text-muted-foreground">{line}</p>
                      ))}
                    </div>
                    <div className="shrink-0 text-right text-[11px] text-muted-foreground">
                      <p>{new Date(event.at * 1000).toLocaleTimeString()}</p>
                      <p>{new Date(event.at * 1000).toLocaleDateString()}</p>
                      <p className="mt-0.5">{relativeTime(event.at)}</p>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
