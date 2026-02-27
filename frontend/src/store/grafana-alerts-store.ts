import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface GrafanaAlertsState {
  autoManageUids: string[]
  toggleAutoManage: (uid: string) => void
  clearAutoManage: () => void
}

export const useGrafanaAlertsStore = create<GrafanaAlertsState>()(
  persist(
    (set) => ({
      autoManageUids: [],
      toggleAutoManage: (uid) =>
        set((state) => ({
          autoManageUids: state.autoManageUids.includes(uid)
            ? state.autoManageUids.filter((u) => u !== uid)
            : [...state.autoManageUids, uid],
        })),
      clearAutoManage: () => set({ autoManageUids: [] }),
    }),
    { name: 'grafana-alerts' }
  )
)
