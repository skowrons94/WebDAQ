import { create } from 'zustand'

/**
 * Which Dashboard tab is showing.
 *
 * It lives outside the page because the command palette has to be able to jump
 * to a tab from anywhere — including from the Dashboard itself, where pushing
 * /dashboard?tab=… changes the URL without remounting the page, so a query-param
 * effect never runs and the entry looked broken.
 */
interface DashboardTabState {
  tab: string
  setTab: (tab: string) => void
}

export const useDashboardTabStore = create<DashboardTabState>()((set) => ({
  tab: 'overview',
  setTab: (tab) => set({ tab }),
}))
