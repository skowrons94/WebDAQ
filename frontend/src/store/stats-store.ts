import { create } from 'zustand'

export interface StatPath {
  path: string
  alias: string
  enabled: boolean
}

export interface StatsState {
  paths: StatPath[]
  currentValues: { [key: string]: { value: number | null; timestamp: string | null } }
  isLoading: boolean
  error: string | null

  // Actions
  setPaths: (paths: StatPath[]) => void
  addPath: (path: string, alias: string) => void
  removePath: (path: string) => void
  updatePath: (path: string, updates: Partial<StatPath>) => void
  setCurrentValue: (path: string, value: number | null, timestamp: string | null) => void
  setLoading: (isLoading: boolean) => void
  setError: (error: string | null) => void
  clearError: () => void
}

export const useStatsStore = create<StatsState>((set) => ({
  paths: [],
  currentValues: {},
  isLoading: false,
  error: null,

  setPaths: (paths) => set({ paths }),

  addPath: (path, alias) =>
    set((state) => ({
      paths: [...state.paths, { path, alias, enabled: true }],
    })),

  removePath: (path) =>
    set((state) => ({
      paths: state.paths.filter((p) => p.path !== path),
    })),

  updatePath: (path, updates) =>
    set((state) => ({
      paths: state.paths.map((p) =>
        p.path === path ? { ...p, ...updates } : p
      ),
    })),

  setCurrentValue: (path, value, timestamp) =>
    set((state) => ({
      currentValues: {
        ...state.currentValues,
        [path]: { value, timestamp },
      },
    })),

  setLoading: (isLoading) => set({ isLoading }),

  setError: (error) => set({ error }),

  clearError: () => set({ error: null }),
}))
