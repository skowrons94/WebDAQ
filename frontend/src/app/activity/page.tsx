'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * The page moved to /troubleshoot.
 *
 * "Activity" named the log; the page is really the answer to "something looks
 * wrong — what do I press", so it is called Troubleshoot now. This redirect
 * stays because the old address is in browser histories and pinned tabs around
 * the control room, and a dead link to it would be found during a shift.
 */
export default function ActivityPage() {
  const router = useRouter()

  useEffect(() => {
    router.replace('/troubleshoot')
  }, [router])

  return null
}
