'use client'

import Link from 'next/link'
import { BellRing, ChevronRight } from 'lucide-react'

import { AuthGate } from '@/components/auth-gate'
import { Layout } from '@/components/dashboard-layout'
import GrafanaAlertManager from '@/components/grafana-alert-manager'
import { PageHeader } from '@/components/page-header'
import { StatusBadge } from '@/components/ui/status-badge'
import { useAlertingHealth } from '@/hooks/use-alerting-health'

/**
 * The built-in alerts (board failure, beam current, Telegram/Zulip) are set up
 * in Settings → Notifications, not here: this page is Grafana's. Say so at the
 * top, with whether they are watching, so nobody concludes from an empty or
 * unreachable Grafana that nothing is watching the run.
 */
function BuiltInNotificationsCard() {
  const { known, watching, destinations, enabledRules, problems } = useAlertingHealth()
  const state = !known ? 'unknown' : problems.length ? 'warning' : 'running'
  const label = !known ? 'Checking…' : !watching ? 'Not watching' : problems.length ? problems[0].title : 'Watching'
  return (
    <Link
      href="/settings?view=notifications"
      className="mb-4 flex min-h-11 items-start gap-3 rounded-lg border bg-card p-4 hover:bg-muted/50"
    >
      <BellRing className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">Built-in notifications</span>
          <StatusBadge state={state} label={label} />
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Board failure, stalled buffers and beam-current rules, sent by LUNADAQ itself to
          Telegram or Zulip.
          {known && (
            <> {enabledRules} rule{enabledRules === 1 ? '' : 's'} on, {destinations.length
              ? `sent to ${destinations.join(' and ')}` : 'no destination set up'}.</>
          )}
        </p>
        <p className="mt-1 text-sm font-medium">Settings → Notifications</p>
      </div>
      <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </Link>
  )
}

function AlertsPageContent() {

  return (
    <Layout>
      <div className="max-w-4xl mx-auto">
        <PageHeader
          title="Alerts"
          description="Grafana's alert rules on the accelerator and DAQ metrics. LUNADAQ's own notifications are set up separately."
        />
        <BuiltInNotificationsCard />
        <GrafanaAlertManager />
      </div>
    </Layout>
  )
}

// AuthGate: rendered only after hydration and only with a token (see
// components/auth-gate.tsx); it also provides the app's one QueryClient.
export default function AlertsPage() {
    return (
        <AuthGate>
            <AlertsPageContent />
        </AuthGate>
    )
}
