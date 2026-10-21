'use client'

import Link from 'next/link'
import { BellOff, ChevronRight, Wrench } from 'lucide-react'

import { useAlertingHealth } from '@/hooks/use-alerting-health'

/**
 * The overview's one-line warnings: alerting that would tell nobody, and what
 * Troubleshoot says needs attention. Nothing at all when both are fine, so an
 * empty strip really means "all quiet".
 */
export function AlertingStatusStrip() {
  const { problems, attention } = useAlertingHealth()
  if (problems.length === 0 && attention.length === 0) return null

  return (
    <div className="grid gap-2" role="status" aria-label="Things to know">
      {problems.map((p) => (
        <Link
          key={p.title}
          href={p.href}
          className="flex min-h-11 items-center gap-2 rounded-md border border-warning/50 bg-warning/5 px-3 py-2 text-sm hover:bg-warning/10"
        >
          <BellOff className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="font-medium">{p.title}.</span>{' '}
            <span className="text-muted-foreground">{p.detail}</span>
          </span>
          <span className="hidden shrink-0 text-xs font-medium sm:inline">{p.linkLabel}</span>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </Link>
      ))}
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
    </div>
  )
}
