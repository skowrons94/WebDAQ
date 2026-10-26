'use client'

import dynamic from 'next/dynamic'
import { AuthGate } from '@/components/auth-gate'
import { Layout } from '@/components/dashboard-layout'

// React Flow and the charts are only downloaded by this page.
const AnalysisWorkspace = dynamic(() => import('@/components/analysis/workspace'), {
  ssr: false, loading: () => <p className="p-8 text-muted-foreground">Loading analysis workspace…</p>,
})

export default function AnalysisPage() {
  return (
    <AuthGate>
      <Layout fullHeight>
        <AnalysisWorkspace />
      </Layout>
    </AuthGate>
  )
}
