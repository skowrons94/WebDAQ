'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import useAuthStore from '@/store/auth-store'
import { Layout } from '@/components/dashboard-layout'
import GrafanaAlertManager from '@/components/grafana-alert-manager'

export default function AlertsPage() {
  const token = useAuthStore((state) => state.token)
  const router = useRouter()

  useEffect(() => {
    if (!token) {
      router.push('/auth/login')
    }
  }, [token, router])

  if (!token) return null

  return (
    <Layout>
      <div className="max-w-4xl mx-auto py-4">
        <GrafanaAlertManager />
      </div>
    </Layout>
  )
}
