import { create } from 'zustand'
import { persist } from 'zustand/middleware'


export interface VisualizationSettings {
    theme: 'light' | 'dark' | 'system'
    showStats: boolean
    showHistograms: boolean
    showCoincidence: boolean
    showAnticoincidence: boolean
    showWaveforms: boolean
}

interface VisualizationStore {
    settings: VisualizationSettings
    updateSettings: (settings: Partial<VisualizationSettings>) => void
    resetSettings: () => void
}

const DEFAULT_SETTINGS: VisualizationSettings = {
    theme: 'system',
    showStats: true,
    showHistograms: true,
    showCoincidence: true,
    showAnticoincidence: true,
    showWaveforms: true,
}

export const useVisualizationStore = create<VisualizationStore>()(
    persist(
        (set) => ({
            settings: DEFAULT_SETTINGS,
            updateSettings: (newSettings) =>
                set((state) => ({
                    settings: { ...state.settings, ...newSettings }
                })),
            resetSettings: () => set({ settings: DEFAULT_SETTINGS })
        }),
        {
            name: 'visualization-settings'
        }
    )
)