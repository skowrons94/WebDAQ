'use client'

import { AuthGate } from '@/components/auth-gate'
import { Layout } from '@/components/dashboard-layout'
import GrafanaAlertManager from '@/components/grafana-alert-manager'

function AlertsPageContent() {

  return (
    <Layout>
      <div className="max-w-4xl mx-auto py-4">
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
