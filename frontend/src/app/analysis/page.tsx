'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import useAuthStore from '@/store/auth-store'
import { Layout } from '@/components/dashboard-layout'

const AnalysisWorkspace = dynamic(() => import('@/components/analysis/workspace'), {
  ssr: false, loading: () => <p className="p-8 text-muted-foreground">Loading analysis workspace…</p>,
})

export default function AnalysisPage() {
  const [mounted, setMounted] = useState(false)
  const token = useAuthStore(s => s.token)
  const router = useRouter()
  useEffect(() => { setMounted(true); if (!token) router.push('/auth/login') }, [token, router])
  if (!mounted || !token) return null
  return <Layout><AnalysisWorkspace /></Layout>
}
