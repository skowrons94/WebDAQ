'use client'

/**
 * The app's navigation: every page, grouped by what it is for, in one list
 * used by the sidebar on wide screens and by the menu sheet on phones.
 *
 * The Dashboard's views (Overview, Histograms, ...) are entries of their own
 * here, each with its address (/dashboard?tab=...), instead of a second row of
 * tabs inside the page: the fundamental pages are all one click away, and
 * every one can be bookmarked.
 */

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import {
  Activity, AudioWaveform, BarChart3, BellRing, BookOpen, ChevronsLeft, ChevronsRight, Cog, Cpu,
  GitMerge, HeartPulse, LayoutDashboard, LifeBuoy, LineChart, ScatterChart, SlidersHorizontal, Wrench,
} from 'lucide-react'
import { useDashboardTabStore } from '@/store/dashboard-tab-store'
import { useVisualizationStore } from '@/store/visualization-settings-store'

export type NavItem = {
  label: string
  href: string
  icon: React.ElementType
  /** A view of the Dashboard page: selected by its tab, not by the path. */
  tab?: string
}

export const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Run',
    items: [
      { label: 'Overview', href: '/dashboard?tab=overview', tab: 'overview', icon: LayoutDashboard },
      { label: 'Data rates', href: '/dashboard?tab=runstats', tab: 'runstats', icon: Activity },
      { label: 'Stats', href: '/stats', icon: LineChart },
      { label: 'Board health', href: '/dashboard?tab=health', tab: 'health', icon: HeartPulse },
    ],
  },
  {
    title: 'Spectra',
    items: [
      { label: 'Histograms', href: '/dashboard?tab=histograms', tab: 'histograms', icon: BarChart3 },
      { label: 'Waveforms', href: '/dashboard?tab=waveforms', tab: 'waveforms', icon: AudioWaveform },
      { label: 'PSD', href: '/dashboard?tab=psd', tab: 'psd', icon: ScatterChart },
      { label: 'Coincidences', href: '/dashboard?tab=coincidences', tab: 'coincidences', icon: GitMerge },
    ],
  },
  {
    title: 'Setup',
    items: [
      { label: 'Boards', href: '/board', icon: Cpu },
      { label: 'DAQ settings', href: '/DAQ', icon: SlidersHorizontal },
      { label: 'Tuner', href: '/tuner', icon: Wrench },
    ],
  },
  {
    title: 'Records',
    items: [
      { label: 'Logbook', href: '/logbook', icon: BookOpen },
    ],
  },
  {
    title: 'System',
    items: [
      { label: 'Alerts', href: '/alerts', icon: BellRing },
      { label: 'Troubleshoot', href: '/troubleshoot', icon: LifeBuoy },
      { label: 'Settings', href: '/settings', icon: Cog },
    ],
  },
]

/** Views switched off under Settings → Appearance are not offered. */
function useVisibleGroups() {
  const { settings } = useVisualizationStore()
  const hidden = new Set<string>([
    ...(settings.showHistograms ? [] : ['histograms']),
    ...(settings.showWaveforms ? [] : ['waveforms']),
    ...((settings.showPSD ?? true) ? [] : ['psd']),
  ])
  return NAV_GROUPS
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.tab || !hidden.has(i.tab)) }))
    .filter((g) => g.items.length)
}

/** Which entry is the current page. */
export function useActiveItem(): NavItem | undefined {
  const pathname = usePathname()
  const tab = useDashboardTabStore((s) => s.tab)
  const path = (pathname || '/').replace(/\/+$/, '') || '/'
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (item.tab) { if (path === '/dashboard' && tab === item.tab) return item; continue }
      if (path === item.href || path.startsWith(item.href + '/')) return item
    }
  }
  return undefined
}

/** The grouped list of links, for the sidebar and the phone menu alike. */
export function NavList({ collapsed = false, onNavigate, wrap }: {
  collapsed?: boolean
  onNavigate?: () => void
  /** Wraps each link (the phone sheet closes itself through SheetClose). */
  wrap?: (link: React.ReactElement, key: string) => React.ReactNode
}) {
  const groups = useVisibleGroups()
  const active = useActiveItem()
  const setTab = useDashboardTabStore((s) => s.setTab)
  const router = useRouter()

  return (
    <nav aria-label="Main" className="grid gap-4">
      {groups.map((group) => (
        <div key={group.title} className="grid gap-0.5">
          {collapsed
            ? <div className="mx-2 my-1 border-t first:hidden" aria-hidden="true" />
            : <p className="px-2 pb-1 text-xs font-semibold text-muted-foreground">{group.title}</p>}
          {group.items.map((item) => {
            const on = active === item
            const Icon = item.icon
            const link = (
              <Link
                href={item.href}
                aria-current={on ? 'page' : undefined}
                title={collapsed ? item.label : undefined}
                onClick={(e) => {
                  if (item.tab) {
                    // The Dashboard does not remount for a new query string:
                    // set its view directly, then put the address in step.
                    e.preventDefault()
                    setTab(item.tab)
                    router.push(item.href)
                  }
                  onNavigate?.()
                }}
                className={`flex min-h-9 items-center gap-2.5 rounded-md px-2 text-sm transition-colors pointer-coarse:min-h-11 ${
                  collapsed ? 'justify-center' : ''
                } ${on
                  ? 'bg-primary/10 font-medium text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                {collapsed ? <span className="sr-only">{item.label}</span> : <span className="truncate">{item.label}</span>}
              </Link>
            )
            return wrap ? wrap(link, item.href) : <div key={item.href}>{link}</div>
          })}
        </div>
      ))}
    </nav>
  )
}

const COLLAPSED_KEY = 'webdaq.nav.collapsed'

/** The sidebar on wide screens; collapsible to icons, remembered per browser. */
export function SideNav() {
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => {
    try { setCollapsed(localStorage.getItem(COLLAPSED_KEY) === '1') } catch { /* private window */ }
  }, [])
  const toggle = () => setCollapsed((c) => {
    try { localStorage.setItem(COLLAPSED_KEY, c ? '0' : '1') } catch { /* not kept */ }
    return !c
  })
  return (
    <aside
      className={`sticky top-16 hidden h-[calc(100vh-4rem)] shrink-0 flex-col border-r bg-background lg:flex ${
        collapsed ? 'w-14' : 'w-52'}`}
    >
      <div className="flex-1 overflow-y-auto px-2 py-4">
        <NavList collapsed={collapsed} />
      </div>
      <button
        type="button"
        onClick={toggle}
        className="flex h-10 items-center justify-center gap-2 border-t text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
      >
        {collapsed ? <ChevronsRight className="h-4 w-4" /> : <><ChevronsLeft className="h-4 w-4" />Collapse</>}
      </button>
    </aside>
  )
}
