'use client'

import { AuthGate } from '@/components/auth-gate'
import { Layout } from '@/components/dashboard-layout'
import ActivityLog from '@/components/activity-log'

function TroubleshootPageContent() {

  return (
    <Layout>
      <ActivityLog />
    </Layout>
  )
}

// AuthGate: rendered only after hydration and only with a token (see
// components/auth-gate.tsx); it also provides the app's one QueryClient.
export default function TroubleshootPage() {
    return (
        <AuthGate>
            <TroubleshootPageContent />
        </AuthGate>
    )
}
