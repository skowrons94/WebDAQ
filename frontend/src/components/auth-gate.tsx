'use client'

import { useEffect, useSyncExternalStore } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import useAuthStore from '@/store/auth-store'

// One QueryClient for the whole app (each page used to create its own).
const queryClient = new QueryClient()

const subscribeNoop = () => () => {}

/**
 * Renders a page only for a signed-in user, and only after hydration.
 *
 * The server (static HTML) and the browser's first render both see "not yet
 * known" and render nothing; the saved token is read after that, so React
 * never finds the HTML and the first client render disagreeing (#418/#423).
 * Without a token it sends the browser to the login page.
 *
 * Used per page, not in app/layout.tsx (which the website demo replaces).
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()  // without the basePath, as router.replace wants it
  // false during SSR and the hydration render, true afterwards.
  const isClient = useSyncExternalStore(subscribeNoop, () => true, () => false)
  const token = useAuthStore((s) => s.token)
  const hydrated = useAuthStore((s) => s.hydrated)
  const hydrate = useAuthStore((s) => s.hydrate)

  useEffect(() => {
    if (!hydrated) hydrate()
  }, [hydrated, hydrate])

  useEffect(() => {
    if (hydrated && !token) {
      // replace: Back must not return to a page that only redirects again.
      // ?next= brings the user back to the page they asked for.
      const here = (pathname || '/') + window.location.search
      router.replace(`/auth/login?next=${encodeURIComponent(here)}`)
    }
  }, [hydrated, token, router, pathname])

  if (!isClient || !hydrated || !token) return null

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}
