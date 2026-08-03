/**
 * The histogram dashboard's configuration — types and server client.
 *
 * This is the single definition of what an ROI and a histogram are. The three
 * previous copies (histo-dashboard.tsx, card-holder.tsx and the Next.js cache
 * route) drifted from each other: one carried `rate` and `integral` fields as
 * though they were stored, another did not, and none of them agreed on whether
 * zoom was part of a histogram.
 *
 * Configuration is owned by the DAQ server (conf/histograms.json), not by the
 * browser and not by the Next.js process. That is what lets it survive a
 * restart, be the same for every operator, and be recorded into the run
 * directory as roi.json when a run ends.
 *
 * Note what is NOT stored: integrals and rates. They are measurements, refreshed
 * from `getRoiIntegrals`, not settings — keeping them out of the stored record
 * is why a dashboard tick no longer has to write the config file.
 */

import api from './api'

/** A background model for an ROI. Nothing computes one yet; see roi_analysis.py. */
export interface ROIBackground {
  method: string
  [key: string]: unknown
}

export interface ROI {
  id: string
  name: string
  low: number
  high: number
  color: string
  enabled: boolean
  background: ROIBackground | null
}

export interface HistogramZoom {
  xmin: number
  xmax: number
  ymin?: number
  ymax?: number
}

export interface HistogramConfig {
  id: string
  boardId: string
  channel: number
  visible: boolean
  size: 'small' | 'medium' | 'large'
  label: string
  customLabel: string
  order: number
  position: { row: number; col: number }
  /** Restored when the dashboard mounts; not pushed to other open browsers. */
  zoom: HistogramZoom | null
  rois: ROI[]
}

export interface DashboardSettings {
  layout: 'grid' | 'rows' | 'custom'
  gridCols: number
  isLogScale: boolean
  syncZoom: boolean
  showLabels: boolean
  showROIs: boolean
  showIntegrals: boolean
  autoUpdate: boolean
  updateInterval: number
  theme: 'auto' | 'light' | 'dark'
  rebinFactor: number
}

export interface HistogramDashboardConfig {
  version: number
  settings: DashboardSettings
  histograms: HistogramConfig[]
}

/**
 * One ROI's counts. `background` is null and `net === gross` until an estimator
 * exists; consumers should read `net` so they need no change when one does.
 */
export interface ROIIntegral {
  histogramId: string
  roiId: string
  gross: number
  background: number | null
  net: number
}

export const DEFAULT_DASHBOARD_SETTINGS: DashboardSettings = {
  layout: 'grid',
  gridCols: 3,
  isLogScale: false,
  syncZoom: false,
  showLabels: true,
  showROIs: true,
  showIntegrals: true,
  autoUpdate: true,
  updateInterval: 5000,
  theme: 'auto',
  rebinFactor: 1,
}

// ─────────────────────────────────────────────────────────────────── client

export const getHistogramDashboardConfig = () =>
  api.get('/histograms/config').then(res => res.data as HistogramDashboardConfig)

export const replaceHistogramDashboardConfig = (config: Partial<HistogramDashboardConfig>) =>
  api.put('/histograms/config', config).then(res => res.data as HistogramDashboardConfig)

export const updateDashboardSettings = (settings: Partial<DashboardSettings>) =>
  api.put('/histograms/config/settings', settings).then(res => res.data as DashboardSettings)

export const addHistogram = (histogram: Partial<HistogramConfig>) =>
  api.post('/histograms/config/histograms', histogram).then(res => res.data as HistogramConfig)

export const updateHistogram = (id: string, histogram: Partial<HistogramConfig>) =>
  api.put(`/histograms/config/histograms/${id}`, histogram).then(res => res.data as HistogramConfig)

export const deleteHistogram = (id: string) =>
  api.delete(`/histograms/config/histograms/${id}`).then(res => res.data)

export const reorderHistograms = (order: string[]) =>
  api.put('/histograms/config/order', { order }).then(res => res.data as HistogramConfig[])

/** Pass null to clear the zoom. */
export const setHistogramZoom = (id: string, zoom: HistogramZoom | null) =>
  api.put(`/histograms/config/histograms/${id}/zoom`, zoom).then(res => res.data as HistogramConfig)

export const clearAllHistogramZoom = () =>
  api.delete('/histograms/config/zoom').then(res => res.data as HistogramConfig[])

export const addROI = (histogramId: string, roi: Partial<ROI>) =>
  api.post(`/histograms/config/histograms/${histogramId}/rois`, roi).then(res => res.data as ROI)

export const updateROI = (histogramId: string, roiId: string, roi: Partial<ROI>) =>
  api.put(`/histograms/config/histograms/${histogramId}/rois/${roiId}`, roi)
    .then(res => res.data as ROI)

export const deleteROI = (histogramId: string, roiId: string) =>
  api.delete(`/histograms/config/histograms/${histogramId}/rois/${roiId}`).then(res => res.data)

/**
 * Every configured ROI's counts in one request.
 *
 * Replaces one request per ROI per tick. The server reads each spectrum once and
 * integrates every region on it, so the cost is now per channel rather than per
 * region.
 */
export const getROIIntegrals = (includeAll = false) =>
  api.get('/histograms/roi_integrals', { params: includeAll ? { all: 1 } : {} })
    .then(res => (res.data?.results ?? []) as ROIIntegral[])

export const writeROISnapshot = (runNumber: number) =>
  api.post(`/histograms/run/${runNumber}/roi_snapshot`).then(res => res.data)

/** Stable key for an ROI measurement, matching what the server returns. */
export const roiKey = (histogramId: string, roiId: string) => `${histogramId}_${roiId}`
