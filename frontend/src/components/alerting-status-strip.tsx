'use client'

import Link from 'next/link'
import { BellOff, ChevronRight, Wrench } from 'lucide-react'

import { useAlertingHealth } from '@/hooks/use-alerting-health'

/**
 * The overview's notes on alerting and on what Troubleshoot says needs
 * attention. Setting up notifications is a choice each setup makes, so their
 * state is one quiet line, not a warning; a real problem (a board, the current
 * monitor, a stats.csv not written) gets the coloured line.
 */
export function AlertingStatusStrip() {
  const { problems, attention } = useAlertingHealth()
  if (problems.length === 0 && attention.length === 0) return null

  return (
    <div className="grid gap-2" role="status" aria-label="Things to know">
      {attention.length > 0 && (
        <Link
          href="/troubleshoot"
          className="flex min-h-11 items-center gap-2 rounded-md border border-warning/50 bg-warning/5 px-3 py-2 text-sm hover:bg-warning/10"
        >
          <Wrench className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="font-medium">
              {attention.length === 1 ? '1 thing needs' : `${attention.length} things need`} attention.
            </span>{' '}
            <span className="text-muted-foreground">{attention[0].detail}{attention.length > 1 ? ` (and ${attention.length - 1} more)` : ''}</span>
          </span>
          <span className="hidden shrink-0 text-xs font-medium sm:inline">Troubleshoot</span>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </Link>
      )}
      {problems.slice(0, 1).map((p) => (
        <p key={p.title} className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
          <BellOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            {p.title}: {p.detail.charAt(0).toLowerCase() + p.detail.slice(1).replace(/\.$/, '')}.{' '}
            <Link href={p.href} className="underline underline-offset-2 hover:text-foreground">Set up notifications</Link>
          </span>
        </p>
      ))}
    </div>
  )
}
