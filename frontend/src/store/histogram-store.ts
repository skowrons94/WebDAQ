/**
 * Histogram dashboard state, backed by the server.
 *
 * Deliberately NOT wrapped in zustand's `persist`: the server owns this state
 * now, and a localStorage copy would only give each browser its own quietly
 * diverging version of the dashboard — which is the problem this replaces.
 *
 * What lives here is the configuration (from the server) plus the live
 * measurements derived from it (integrals and rates), which are not persisted
 * anywhere because they are re-read every tick.
 */

import { create } from 'zustand'
import {
  type DashboardSettings,
  type HistogramConfig,
  type HistogramZoom,
  type ROI,
  type ROIIntegral,
  DEFAULT_DASHBOARD_SETTINGS,
  addHistogram as apiAddHistogram,
  addROI as apiAddROI,
  clearAllHistogramZoom as apiClearZoom,
  deleteHistogram as apiDeleteHistogram,
  deleteROI as apiDeleteROI,
  getHistogramDashboardConfig,
  getROIIntegrals,
  reorderHistograms as apiReorder,
  roiKey,
  setHistogramZoom as apiSetZoom,
  updateDashboardSettings as apiUpdateSettings,
  updateHistogram as apiUpdateHistogram,
  updateROI as apiUpdateROI,
} from '@/lib/histogram-config'

/** Counts per minute, derived between two integral reads. */
interface RateSample {
  integral: number
  at: number
  rate: number
}

// Outside the store: a measurement scratchpad, not state anything renders from
// directly, and re-rendering on every sample would defeat the point.
const rateSamples: Record<string, RateSample> = {}

/**
 * Zoom is written on every wheel event a user makes, so it is coalesced here
 * rather than in each caller. The last write for a given histogram wins.
 */
const zoomTimers: Record<string, ReturnType<typeof setTimeout>> = {}
const ZOOM_SAVE_DELAY_MS = 400

let settingsTimer: ReturnType<typeof setTimeout> | null = null
const SETTINGS_SAVE_DELAY_MS = 300

interface HistogramStore {
  settings: DashboardSettings
  histograms: HistogramConfig[]
  integrals: Record<string, ROIIntegral>
  rates: Record<string, number>
  loaded: boolean
  loadError: string | null

  load: () => Promise<void>
  refreshIntegrals: () => Promise<void>

  setSettings: (partial: Partial<DashboardSettings>) => void
  addHistogram: (histogram: Partial<HistogramConfig>) => Promise<HistogramConfig | null>
  updateHistogram: (id: string, partial: Partial<HistogramConfig>) => Promise<void>
  removeHistogram: (id: string) => Promise<void>
  reorder: (ids: string[]) => Promise<void>
  setZoom: (id: string, zoom: HistogramZoom | null) => void
  clearZoom: () => Promise<void>
  addRoi: (histogramId: string, roi: Partial<ROI>) => Promise<void>
  updateRoi: (histogramId: string, roiId: string, roi: Partial<ROI>) => Promise<void>
  removeRoi: (histogramId: string, roiId: string) => Promise<void>
}

const byOrder = (a: HistogramConfig, b: HistogramConfig) => a.order - b.order

const useHistogramStore = create<HistogramStore>()((set, get) => ({
  settings: DEFAULT_DASHBOARD_SETTINGS,
  histograms: [],
  integrals: {},
  rates: {},
  loaded: false,
  loadError: null,

  load: async () => {
    try {
      const config = await getHistogramDashboardConfig()
      set({
        settings: { ...DEFAULT_DASHBOARD_SETTINGS, ...config.settings },
        histograms: [...(config.histograms ?? [])].sort(byOrder),
        loaded: true,
        loadError: null,
      })
    } catch (error: any) {
      console.error('Failed to load the histogram dashboard configuration:', error)
      set({ loaded: true, loadError: error?.message ?? 'Could not load the dashboard' })
    }
  },

  refreshIntegrals: async () => {
    try {
      const results = await getROIIntegrals()
      if (results.length === 0) {
        // Don't clear what is on screen: an empty answer usually means the
        // spectra are not readable this instant, not that the ROIs are gone.
        return
      }
      const now = Date.now()
      const integrals: Record<string, ROIIntegral> = {}
      const rates = { ...get().rates }

      for (const result of results) {
        const key = roiKey(result.histogramId, result.roiId)
        integrals[key] = result
        const previous = rateSamples[key]
        let rate = previous?.rate ?? 0
        if (previous) {
          const minutes = (now - previous.at) / 60000
          if (minutes > 0.0016 && previous.integral !== result.net) {
            rate = Math.abs(result.net - previous.integral) / minutes
          }
        }
        rateSamples[key] = { integral: result.net, at: now, rate }
        rates[key] = Math.max(0, rate)
      }
      set({ integrals, rates })
    } catch (error) {
      console.error('Failed to refresh ROI integrals:', error)
    }
  },

  setSettings: (partial) => {
    // Applied locally at once so the controls feel immediate, then written
    // behind a short debounce — a slider would otherwise be one PUT per pixel.
    set((state) => ({ settings: { ...state.settings, ...partial } }))
    if (settingsTimer) clearTimeout(settingsTimer)
    settingsTimer = setTimeout(() => {
      apiUpdateSettings(get().settings)
        .then((settings) => set({ settings }))
        .catch((error) => console.error('Failed to save dashboard settings:', error))
    }, SETTINGS_SAVE_DELAY_MS)
  },

  addHistogram: async (histogram) => {
    try {
      const created = await apiAddHistogram(histogram)
      set((state) => ({ histograms: [...state.histograms, created].sort(byOrder) }))
      return created
    } catch (error) {
      console.error('Failed to add the histogram:', error)
      return null
    }
  },

  updateHistogram: async (id, partial) => {
    try {
      const updated = await apiUpdateHistogram(id, partial)
      set((state) => ({
        histograms: state.histograms.map((h) => (h.id === id ? updated : h)).sort(byOrder),
      }))
    } catch (error) {
      console.error(`Failed to update histogram ${id}:`, error)
    }
  },

  removeHistogram: async (id) => {
    try {
      await apiDeleteHistogram(id)
      set((state) => ({ histograms: state.histograms.filter((h) => h.id !== id) }))
    } catch (error) {
      console.error(`Failed to remove histogram ${id}:`, error)
    }
  },

  reorder: async (ids) => {
    // Optimistic: dragging a card that snaps back while the request lands is
    // worse than briefly showing an order the server has not confirmed.
    const rank = new Map(ids.map((id, index) => [id, index]))
    set((state) => ({
      histograms: [...state.histograms]
        .map((h) => ({ ...h, order: rank.get(h.id) ?? h.order }))
        .sort(byOrder),
    }))
    try {
      const histograms = await apiReorder(ids)
      set({ histograms: [...histograms].sort(byOrder) })
    } catch (error) {
      console.error('Failed to save the histogram order:', error)
      void get().load()
    }
  },

  setZoom: (id, zoom) => {
    set((state) => ({
      histograms: state.histograms.map((h) => (h.id === id ? { ...h, zoom } : h)),
    }))
    if (zoomTimers[id]) clearTimeout(zoomTimers[id])
    zoomTimers[id] = setTimeout(() => {
      apiSetZoom(id, zoom).catch((error) =>
        console.error(`Failed to save the zoom for ${id}:`, error))
    }, ZOOM_SAVE_DELAY_MS)
  },

  clearZoom: async () => {
    Object.values(zoomTimers).forEach(clearTimeout)
    set((state) => ({ histograms: state.histograms.map((h) => ({ ...h, zoom: null })) }))
    try {
      const histograms = await apiClearZoom()
      set({ histograms: [...histograms].sort(byOrder) })
    } catch (error) {
      console.error('Failed to clear the saved zooms:', error)
    }
  },

  addRoi: async (histogramId, roi) => {
    try {
      const created = await apiAddROI(histogramId, roi)
      set((state) => ({
        histograms: state.histograms.map((h) =>
          h.id === histogramId ? { ...h, rois: [...h.rois, created] } : h),
      }))
    } catch (error) {
      console.error(`Failed to add an ROI to ${histogramId}:`, error)
    }
  },

  updateRoi: async (histogramId, roiId, roi) => {
    try {
      const updated = await apiUpdateROI(histogramId, roiId, roi)
      set((state) => ({
        histograms: state.histograms.map((h) =>
          h.id === histogramId
            ? { ...h, rois: h.rois.map((r) => (r.id === roiId ? updated : r)) }
            : h),
      }))
    } catch (error) {
      console.error(`Failed to update ROI ${roiId}:`, error)
    }
  },

  removeRoi: async (histogramId, roiId) => {
    try {
      await apiDeleteROI(histogramId, roiId)
      delete rateSamples[roiKey(histogramId, roiId)]
      set((state) => ({
        histograms: state.histograms.map((h) =>
          h.id === histogramId
            ? { ...h, rois: h.rois.filter((r) => r.id !== roiId) }
            : h),
      }))
    } catch (error) {
      console.error(`Failed to remove ROI ${roiId}:`, error)
    }
  },
}))

export default useHistogramStore
