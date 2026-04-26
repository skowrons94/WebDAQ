import { create } from 'zustand'
import { persist } from 'zustand/middleware'


export interface BoardChannelSelection {
    boardId: string
    channels: number[]
}

export interface VisualizationSettings {
    theme: 'light' | 'dark' | 'system'
    showStats: boolean
    showHistograms: boolean
    showWaveforms: boolean
    showPSD: boolean
    showStatus: boolean
    showCurrent: boolean
    showXDAQ: boolean
    showROIs: boolean
    showMetrics: boolean
    selectedBoardsChannelsPSD: BoardChannelSelection[]
    selectedBoardsChannelsWaveform: BoardChannelSelection[]
}

interface VisualizationStore {
    settings: VisualizationSettings
    hydrated: boolean
    updateSettings: (settings: Partial<VisualizationSettings>) => void
    resetSettings: () => void
    updateBoardChannelSelection: (type: 'PSD' | 'Waveform', boardId: string, channels: number[]) => void
    removeBoardSelection: (type: 'PSD' | 'Waveform', boardId: string) => void
    clearAllSelections: (type: 'PSD' | 'Waveform') => void
    hydrateFromServer: () => Promise<void>
}

const DEFAULT_SETTINGS: VisualizationSettings = {
    theme: 'system',
    showStats: true,
    showHistograms: true,
    showWaveforms: true,
    showPSD: true,
    showStatus: true,
    showCurrent: true,
    showXDAQ: true,
    showROIs: true,
    showMetrics: true,
    selectedBoardsChannelsPSD: [],
    selectedBoardsChannelsWaveform: []
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null
const persistChannelsToServer = (settings: VisualizationSettings) => {
    if (typeof window === 'undefined') return
    if (saveTimeout) clearTimeout(saveTimeout)
    saveTimeout = setTimeout(() => {
        fetch('/api/cache', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'visualization-channels',
                data: {
                    selectedBoardsChannelsPSD: settings.selectedBoardsChannelsPSD,
                    selectedBoardsChannelsWaveform: settings.selectedBoardsChannelsWaveform,
                }
            })
        }).catch(err => console.error('Failed to persist channel selections:', err))
    }, 400)
}

export const useVisualizationStore = create<VisualizationStore>()(
    persist(
        (set, get) => ({
            settings: DEFAULT_SETTINGS,
            hydrated: false,
            updateSettings: (newSettings) =>
                set((state) => ({
                    settings: { ...state.settings, ...newSettings }
                })),
            resetSettings: () => set({ settings: DEFAULT_SETTINGS }),
            updateBoardChannelSelection: (type: 'PSD' | 'Waveform', boardId: string, channels: number[]) =>
                set((state: { settings: VisualizationSettings }) => {
                    const key = type === 'PSD' ? 'selectedBoardsChannelsPSD' : 'selectedBoardsChannelsWaveform'
                    const existingSelections = state.settings[key] || []
                    const existingIndex = existingSelections.findIndex((sel: BoardChannelSelection) => sel.boardId === boardId)

                    let newSelections: BoardChannelSelection[]
                    if (existingIndex >= 0) {
                        newSelections = [...existingSelections]
                        if (channels.length === 0) {
                            newSelections.splice(existingIndex, 1)
                        } else {
                            newSelections[existingIndex] = { boardId, channels }
                        }
                    } else if (channels.length > 0) {
                        newSelections = [...existingSelections, { boardId, channels }]
                    } else {
                        newSelections = existingSelections
                    }

                    const nextSettings = { ...state.settings, [key]: newSelections }
                    persistChannelsToServer(nextSettings)
                    return { settings: nextSettings }
                }),
            removeBoardSelection: (type: 'PSD' | 'Waveform', boardId: string) =>
                set((state: { settings: VisualizationSettings }) => {
                    const key = type === 'PSD' ? 'selectedBoardsChannelsPSD' : 'selectedBoardsChannelsWaveform'
                    const newSelections = (state.settings[key] || []).filter((sel: BoardChannelSelection) => sel.boardId !== boardId)
                    const nextSettings = { ...state.settings, [key]: newSelections }
                    persistChannelsToServer(nextSettings)
                    return { settings: nextSettings }
                }),
            clearAllSelections: (type: 'PSD' | 'Waveform') =>
                set((state: { settings: VisualizationSettings }) => {
                    const key = type === 'PSD' ? 'selectedBoardsChannelsPSD' : 'selectedBoardsChannelsWaveform'
                    const nextSettings = { ...state.settings, [key]: [] }
                    persistChannelsToServer(nextSettings)
                    return { settings: nextSettings }
                }),
            hydrateFromServer: async () => {
                if (get().hydrated) return
                try {
                    const response = await fetch('/api/cache?type=visualization-channels')
                    const data = await response.json()
                    if (data.success && data.data) {
                        set((state) => ({
                            settings: {
                                ...state.settings,
                                selectedBoardsChannelsPSD: Array.isArray(data.data.selectedBoardsChannelsPSD)
                                    ? data.data.selectedBoardsChannelsPSD : [],
                                selectedBoardsChannelsWaveform: Array.isArray(data.data.selectedBoardsChannelsWaveform)
                                    ? data.data.selectedBoardsChannelsWaveform : [],
                            },
                            hydrated: true,
                        }))
                    } else {
                        set({ hydrated: true })
                    }
                } catch (err) {
                    console.error('Failed to hydrate visualization channels from server:', err)
                    set({ hydrated: true })
                }
            }
        }),
        {
            name: 'visualization-settings'
        }
    )
)
