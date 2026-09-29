'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import useAuthStore from '@/store/auth-store'
import { Layout } from '@/components/dashboard-layout'
import ActivityLog from '@/components/activity-log'

export default function ActivityPage() {
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
      <div className="mx-auto max-w-5xl py-4">
        <ActivityLog />
      </div>
    </Layout>
  )
}
