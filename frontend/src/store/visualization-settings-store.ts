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
    updateSettings: (settings: Partial<VisualizationSettings>) => void
    resetSettings: () => void
    updateBoardChannelSelection: (type: 'PSD' | 'Waveform', boardId: string, channels: number[]) => void
    removeBoardSelection: (type: 'PSD' | 'Waveform', boardId: string) => void
    clearAllSelections: (type: 'PSD' | 'Waveform') => void
}

const DEFAULT_SETTINGS: VisualizationSettings = {
    theme: 'system',
    showStats: true,
    showHistograms: true,
    showWaveforms: true,
    showStatus: true,
    showCurrent: true,
    showXDAQ: true,
    showROIs: true,
    showMetrics: true,
    selectedBoardsChannelsPSD: [],
    selectedBoardsChannelsWaveform: []
}

export const useVisualizationStore = create<VisualizationStore>()(
    persist(
        (set) => ({
            settings: DEFAULT_SETTINGS,
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

                    return {
                        settings: { ...state.settings, [key]: newSelections }
                    }
                }),
            removeBoardSelection: (type: 'PSD' | 'Waveform', boardId: string) =>
                set((state: { settings: VisualizationSettings }) => {
                    const key = type === 'PSD' ? 'selectedBoardsChannelsPSD' : 'selectedBoardsChannelsWaveform'
                    const newSelections = (state.settings[key] || []).filter((sel: BoardChannelSelection) => sel.boardId !== boardId)

                    return {
                        settings: { ...state.settings, [key]: newSelections }
                    }
                }),
            clearAllSelections: (type: 'PSD' | 'Waveform') =>
                set((state: { settings: VisualizationSettings }) => {
                    const key = type === 'PSD' ? 'selectedBoardsChannelsPSD' : 'selectedBoardsChannelsWaveform'
                    return {
                        settings: { ...state.settings, [key]: [] }
                    }
                })
        }),
        {
            name: 'visualization-settings'
        }
    )
)