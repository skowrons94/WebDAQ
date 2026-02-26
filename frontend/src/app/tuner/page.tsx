'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect } from 'react'
import useAuthStore from '@/store/auth-store'
import { useRouter } from 'next/navigation'
import { Layout } from '@/components/dashboard-layout'
import ParamTuner from '@/components/param-tuner'

const queryClient = new QueryClient()

export default function TunerPage() {
    const router = useRouter()
    const token = useAuthStore((state) => state.token)

    useEffect(() => {
        if (!token) {
            router.push('/auth/login')
        }
    }, [token, router])

    if (!token) {
        return null
    }

    return (
        <QueryClientProvider client={queryClient}>
            <Layout>
                <main className="flex min-h-[calc(100vh_-_theme(spacing.16))] flex-1 flex-col gap-4 bg-muted/40 p-4 md:gap-8 md:p-10 rounded-lg border">
                    <div className="mx-auto w-full max-w-7xl">
                        <div className="mb-6">
                            <h1 className="text-3xl font-semibold">Parameter Tuner</h1>
                            <p className="text-muted-foreground mt-2">
                                Interactive waveform and spectrum tuning — data saving disabled during acquisition
                            </p>
                        </div>
                        <ParamTuner />
                    </div>
                </main>
            </Layout>
        </QueryClientProvider>
    )
}
