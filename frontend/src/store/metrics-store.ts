import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface Metric {
    id: string
    entityName: string
    metricName: string
    unit: string
    isVisible?: boolean
    refreshInterval?: number // in seconds
    multiplier?: number // Added multiplier
}

interface MetricsStore {
    metrics: Metric[]
    addMetric: (metric: Omit<Metric, 'id'>) => void
    removeMetric: (id: string) => void
    updateMetric: (id: string, updates: Partial<Metric>) => void
    toggleMetricVisibility: (id: string) => void
    clearAllMetrics: () => void
}

export const useMetricsStore = create<MetricsStore>()(
    persist(
        (set) => ({
            metrics: [],
            addMetric: (metric) =>
                set((state) => ({
                    metrics: [...state.metrics, { ...metric, id: Date.now().toString(), isVisible: true }]
                })),
            removeMetric: (id) =>
                set((state) => ({
                    metrics: state.metrics.filter((metric) => metric.id !== id)
                })),
            updateMetric: (id, updates) =>
                set((state) => ({
                    metrics: state.metrics.map((metric) =>
                        metric.id === id ? { ...metric, ...updates } : metric
                    )
                })),
            toggleMetricVisibility: (id) =>
                set((state) => ({
                    metrics: state.metrics.map((metric) =>
                        metric.id === id ? { ...metric, isVisible: !metric.isVisible } : metric
                    )
                })),
            clearAllMetrics: () => set({ metrics: [] })
        }),
        {
            name: 'metrics-settings'
        }
    )
)