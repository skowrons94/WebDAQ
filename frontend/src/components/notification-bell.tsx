'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { BellOff, BellRing, CheckCheck, ChevronRight, MailWarning, ShieldCheck, TriangleAlert, Wrench } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  getAlertEventSummary, getAlertEvents, markAlertEventsSeen,
  type AlertEvent, type AlertEventSummary,
} from '@/lib/api'
import { useAlertingHealth } from '@/hooks/use-alerting-health'

/**
 * The bell in the header: what the DAQ did while you were not watching.
 *
 * A Telegram message is gone once read, and a shift arriving in the morning has
 * no way to ask what happened at 03:00. The count is polled on its own (cheap),
 * and the list is only fetched when the menu is opened.
 */

const SUMMARY_POLL_MS = 15000
const LIST_LIMIT = 12

export function relativeTime(epochSeconds: number): string {
  const seconds = Math.round(Date.now() / 1000 - epochSeconds)
  // The DAQ server's clock can be ahead of this browser's: say so rather than
  // calling a future timestamp "just now".
  if (seconds < -5) return 'clock ahead'
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}

export function eventIcon(kind: AlertEvent['kind']) {
  if (kind === 'recovery') return <ShieldCheck className="h-4 w-4 text-success" />
  if (kind === 'info') return <Wrench className="h-4 w-4 text-muted-foreground" />
  return <TriangleAlert className="h-4 w-4 text-destructive" />
}

export function NotificationBell() {
  const [summary, setSummary] = useState<AlertEventSummary | null>(null)
  const [events, setEvents] = useState<AlertEvent[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  const poll = useCallback(async () => {
    try {
      setSummary(await getAlertEventSummary())
    } catch {
      // The header must never be the thing that breaks: no count, no noise.
    }
  }, [])

  useEffect(() => {
    poll()
    const timer = setInterval(poll, SUMMARY_POLL_MS)
    return () => clearInterval(timer)
  }, [poll])

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(false)
    getAlertEvents({ limit: LIST_LIMIT })
      .then((data) => { setEvents(data.events); setSummary(data.summary) })
      // Keep whatever was already listed: an empty list would claim nothing ever
      // happened, which is exactly the wrong thing to say when the server is down.
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [open])

  const unseen = summary?.unseen ?? 0
  const undelivered = summary?.undelivered ?? 0
  // An empty bell must not read as "all quiet" when nothing is watching, or
  // nothing would be delivered: that is said here for as long as it is true.
  const { problems, attention } = useAlertingHealth()
  const warnings = problems.length + (attention.length > 0 ? 1 : 0)

  const markAllSeen = async () => {
    try {
      const data = await markAlertEventsSeen()
      setSummary(data.summary)
      setEvents((current) => current.map((e) => ({ ...e, seen: true })))
    } catch {
      // Say it rather than leaving a button that seems not to work.
      setError(true)
    }
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" title={problems[0]?.title ?? 'Recent alerts'}>
          <BellRing className="h-5 w-5" />
          {unseen > 0 ? (
            <span className={`absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center
              justify-center rounded-full px-1 text-xs font-semibold ${
              undelivered > 0 || warnings > 0 ? 'bg-warning text-warning-foreground' : 'bg-destructive text-destructive-foreground'}`}>
              {unseen > 9 ? '9+' : unseen}
            </span>
          ) : warnings > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 text-xs font-semibold text-warning-foreground"
                  aria-hidden="true">
              !
            </span>
          )}
          <span className="sr-only">
            {unseen > 0 ? `${unseen} unread alert${unseen === 1 ? '' : 's'}` : 'Alerts'}
            {problems.length > 0 ? ` (${problems[0].title})` : ''}
          </span>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-[min(24rem,calc(100vw-1rem))] p-0">
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <span className="text-sm font-medium">Recent alerts</span>
          <div className="flex items-center gap-1">
            {unseen > 0 && (
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs"
                      onClick={markAllSeen}>
                <CheckCheck className="mr-1 h-3.5 w-3.5" />
                Mark read
              </Button>
            )}
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" asChild>
              <Link href="/troubleshoot">History</Link>
            </Button>
          </div>
        </div>

        {/* Before the list: the list cannot show what was never raised. */}
        {problems.map((p) => (
          <Link key={p.title} href={p.href} onClick={() => setOpen(false)}
                className="flex items-start gap-2 border-b bg-warning/10 px-3 py-2 text-xs hover:bg-warning/15">
            <BellOff className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="font-semibold">{p.title}.</span> {p.detail}{' '}
              <span className="font-medium underline underline-offset-2">{p.linkLabel}</span>
            </span>
          </Link>
        ))}
        {attention.length > 0 && (
          <Link href="/troubleshoot" onClick={() => setOpen(false)}
                className="flex items-start gap-2 border-b bg-warning/10 px-3 py-2 text-xs hover:bg-warning/15">
            <Wrench className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="font-semibold">
                {attention.length === 1 ? '1 thing needs' : `${attention.length} things need`} attention.
              </span>{' '}
              {attention[0].detail}{attention.length > 1 ? ` (and ${attention.length - 1} more)` : ''}
            </span>
            <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          </Link>
        )}

        {undelivered > 0 && (
          <div className="flex items-start gap-2 border-b bg-warning/10 px-3 py-2 text-xs">
            <MailWarning className="mt-0.5 h-3.5 w-3.5 text-warning" />
            <span>
              {undelivered} of them reached nobody — check Settings → Notifications.
            </span>
          </div>
        )}

        {error && (
          <div className="border-b bg-destructive/10 px-3 py-2 text-xs text-destructive">
            The DAQ server could not be reached, so this list may be out of date.
          </div>
        )}

        <div className="max-h-96 overflow-y-auto">
          {loading && events.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              Reading the history…
            </p>
          ) : events.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              {error ? 'The history could not be read.'
                : problems.length > 0 ? 'Nothing has been raised, but see above: that does not mean all is well.'
                : 'Nothing has been raised yet.'}
            </p>
          ) : (
            events.map((event) => (
              <div key={event.id}
                   className={`flex gap-2 border-b px-3 py-2 last:border-0 ${
                     event.seen ? '' : 'bg-muted/40'}`}>
                <div className="mt-0.5 shrink-0">{eventIcon(event.kind)}</div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium leading-snug">{event.title}</p>
                  {event.lines[0] && (
                    <p className="truncate text-xs text-muted-foreground">{event.lines[0]}</p>
                  )}
                  <p className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{relativeTime(event.at)}</span>
                    {event.run_number !== null && <span>run {event.run_number}</span>}
                    {Object.keys(event.deliveries).length > 0 && (
                      <Badge variant="outline" className="h-4 px-1 text-xs">
                        {Object.entries(event.deliveries)
                          .filter(([, ok]) => ok)
                          .map(([name]) => name)
                          .join(', ') || 'not delivered'}
                      </Badge>
                    )}
                  </p>
                </div>
              </div>
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
