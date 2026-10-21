'use client'

import { AuthGate } from '@/components/auth-gate'
import { Layout } from '@/components/dashboard-layout'
import ParamTuner from '@/components/param-tuner'
import { PageHeader } from '@/components/page-header'


function TunerPageContent() {

    return (
        <>
            <Layout>
                <PageHeader
                    title="Parameter tuner"
                    description="Tune one channel at a time against its live trace, rates and spectrum. A run started here is not saved to disk; a production run keeps saving as usual."
                />
                <ParamTuner />
            </Layout>
        </>
    )
}

// AuthGate: rendered only after hydration and only with a token (see
// components/auth-gate.tsx); it also provides the app's one QueryClient.
export default function TunerPage() {
    return (
        <AuthGate>
            <TunerPageContent />
        </AuthGate>
    )
}
