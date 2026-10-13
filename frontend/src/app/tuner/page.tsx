'use client'

import { AuthGate } from '@/components/auth-gate'
import { Layout } from '@/components/dashboard-layout'
import ParamTuner from '@/components/param-tuner'


function TunerPageContent() {

    return (
        <>
            <Layout>
                <div className="flex min-h-[calc(100vh_-_theme(spacing.16))] flex-1 flex-col gap-4 rounded-lg border bg-muted/40 p-3 sm:p-4 md:gap-8 md:p-10">
                    <div className="mx-auto w-full max-w-7xl">
                        <div className="mb-6">
                            <h1 className="text-2xl font-semibold">Parameter tuner</h1>
                            <p className="text-muted-foreground mt-2">
                                Interactive waveform and spectrum tuning — data saving disabled during acquisition
                            </p>
                        </div>
                        <ParamTuner />
                    </div>
                </div>
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
