'use client'

import { useEffect } from 'react'
import { useTheme } from 'next-themes'

/**
 * JSROOT canvases follow the app's light/dark theme wherever they are drawn
 * (the Histograms tab sets the same for its own plots). Applied as soon as
 * JSROOT is loaded and on every theme change; canvases pick it up on their
 * next redraw.
 */
export function useJsrootTheme(jsrootLoaded: boolean): boolean {
  const { resolvedTheme } = useTheme()
  const dark = resolvedTheme === 'dark'
  useEffect(() => {
    const J = typeof window !== 'undefined' ? window.JSROOT : null
    if (!jsrootLoaded || !J?.settings) return
    J.settings.DarkMode = dark
    J.settings.OptStat = 0
  }, [jsrootLoaded, dark])
  return dark
}
