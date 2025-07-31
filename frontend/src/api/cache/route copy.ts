import { NextResponse } from "next/server"
import fs from "fs/promises"
import path from "path"

const CACHE_DIR = path.join(process.cwd(), "cache")
const ROI_CACHE_FILE = path.join(CACHE_DIR, "roi-cache-enhanced.json")
const DASHBOARD_SETTINGS_FILE = path.join(CACHE_DIR, "dashboard-settings.json")
const HISTOGRAM_CONFIGS_FILE = path.join(CACHE_DIR, "histogram-configs.json")
const ZOOM_RANGES_FILE = path.join(CACHE_DIR, "zoom-ranges.json")

// Enhanced ROI structure
type ROI = {
  id: string
  name: string
  low: number
  high: number
  integral: number
  color: string
  enabled: boolean
}

type ROICollection = {
  [histogramId: string]: ROI[]
}

type HistogramConfig = {
  id: string
  boardId: string
  channel: number
  visible: boolean
  size: "small" | "medium" | "large"
  label: string
  customLabel?: string
  position: { row: number; col: number }
  zoomRange?: { xmin: number; xmax: number; ymin: number; ymax: number }
  rois: ROI[]
}

type DashboardSettings = {
  layout: "grid" | "rows" | "custom"
  gridCols: number
  isLogScale: boolean
  syncZoom: boolean
  showLabels: boolean
  showROIs: boolean
  showIntegrals: boolean
  autoUpdate: boolean
  updateInterval: number
  theme: "auto" | "light" | "dark"
  rebinFactor?: number
}

// New type for zoom ranges
type ZoomRanges = {
  [histogramId: string]: {
    xmin: number
    xmax: number
    ymin: number
    ymax: number
    timestamp: number // Track when zoom was last updated
  }
}

async function ensureCacheDirectoryExists() {
  try {
    await fs.access(CACHE_DIR)
  } catch (error) {
    await fs.mkdir(CACHE_DIR, { recursive: true })
  }
}

async function ensureFileExists(filePath: string, defaultContent: string) {
  try {
    await fs.access(filePath)
  } catch (error) {
    await fs.writeFile(filePath, defaultContent)
  }
}

// GET - Retrieve cached data
export async function GET(request: Request) {
  try {
    await ensureCacheDirectoryExists()

    const { searchParams } = new URL(request.url)
    const dataType = searchParams.get("type") || "rois"

    switch (dataType) {
      case "rois":
        await ensureFileExists(ROI_CACHE_FILE, "{}")
        const roiData = await fs.readFile(ROI_CACHE_FILE, "utf-8")
        return NextResponse.json({
          success: true,
          data: JSON.parse(roiData) as ROICollection,
        })

      case "settings":
        await ensureFileExists(
          DASHBOARD_SETTINGS_FILE,
          JSON.stringify({
            layout: "grid",
            gridCols: 3,
            isLogScale: false,
            syncZoom: false,
            showLabels: true,
            showROIs: true,
            showIntegrals: true,
            autoUpdate: true,
            updateInterval: 2000,
            theme: "auto",
            rebinFactor: 1,
          }),
        )
        const settingsData = await fs.readFile(DASHBOARD_SETTINGS_FILE, "utf-8")
        return NextResponse.json({
          success: true,
          data: JSON.parse(settingsData) as DashboardSettings,
        })

      case "histograms":
        await ensureFileExists(HISTOGRAM_CONFIGS_FILE, "[]")
        const histogramData = await fs.readFile(HISTOGRAM_CONFIGS_FILE, "utf-8")
        return NextResponse.json({
          success: true,
          data: JSON.parse(histogramData) as HistogramConfig[],
        })

      case "zoom-ranges":
        await ensureFileExists(ZOOM_RANGES_FILE, "{}")
        const zoomData = await fs.readFile(ZOOM_RANGES_FILE, "utf-8")
        return NextResponse.json({
          success: true,
          data: JSON.parse(zoomData) as ZoomRanges,
        })

      case "all":
        // Return all cached data including zoom ranges
        await ensureFileExists(ROI_CACHE_FILE, "{}")
        await ensureFileExists(
          DASHBOARD_SETTINGS_FILE,
          JSON.stringify({
            layout: "grid",
            gridCols: 3,
            isLogScale: false,
            syncZoom: false,
            showLabels: true,
            showROIs: true,
            showIntegrals: true,
            autoUpdate: true,
            updateInterval: 2000,
            theme: "auto",
            rebinFactor: 1,
          }),
        )
        await ensureFileExists(HISTOGRAM_CONFIGS_FILE, "[]")
        await ensureFileExists(ZOOM_RANGES_FILE, "{}")

        const [allRoiData, allSettingsData, allHistogramData, allZoomData] = await Promise.all([
          fs.readFile(ROI_CACHE_FILE, "utf-8"),
          fs.readFile(DASHBOARD_SETTINGS_FILE, "utf-8"),
          fs.readFile(HISTOGRAM_CONFIGS_FILE, "utf-8"),
          fs.readFile(ZOOM_RANGES_FILE, "utf-8"),
        ])

        return NextResponse.json({
          success: true,
          data: {
            rois: JSON.parse(allRoiData) as ROICollection,
            settings: JSON.parse(allSettingsData) as DashboardSettings,
            histograms: JSON.parse(allHistogramData) as HistogramConfig[],
            zoomRanges: JSON.parse(allZoomData) as ZoomRanges,
          },
        })

      default:
        return NextResponse.json(
          {
            success: false,
            error: "Invalid data type",
          },
          { status: 400 },
        )
    }
  } catch (error) {
    console.error("Failed to read cache data:", error)
    return NextResponse.json(
      {
        success: false,
        error: "Failed to read cache data",
      },
      { status: 500 },
    )
  }
}

// POST - Save cached data
export async function POST(request: Request) {
  try {
    await ensureCacheDirectoryExists()

    const body = await request.json()
    const { type, data, histogramId } = body

    if (!type || !data) {
      return NextResponse.json(
        {
          success: false,
          error: "Missing type or data",
        },
        { status: 400 },
      )
    }

    switch (type) {
      case "rois":
        await fs.writeFile(ROI_CACHE_FILE, JSON.stringify(data, null, 2))
        break

      case "settings":
        await fs.writeFile(DASHBOARD_SETTINGS_FILE, JSON.stringify(data, null, 2))
        break

      case "histograms":
        await fs.writeFile(HISTOGRAM_CONFIGS_FILE, JSON.stringify(data, null, 2))
        break

      case "zoom-range":
        // Save individual zoom range for a specific histogram
        if (!histogramId) {
          return NextResponse.json(
            {
              success: false,
              error: "Missing histogramId for zoom-range",
            },
            { status: 400 },
          )
        }

        await ensureFileExists(ZOOM_RANGES_FILE, "{}")
        const existingZoomData = JSON.parse(await fs.readFile(ZOOM_RANGES_FILE, "utf-8")) as ZoomRanges

        existingZoomData[histogramId] = {
          ...data,
          timestamp: Date.now(),
        }

        await fs.writeFile(ZOOM_RANGES_FILE, JSON.stringify(existingZoomData, null, 2))
        break

      case "zoom-ranges":
        // Save all zoom ranges at once
        await fs.writeFile(ZOOM_RANGES_FILE, JSON.stringify(data, null, 2))
        break

      case "all":
        if (data.rois) {
          await fs.writeFile(ROI_CACHE_FILE, JSON.stringify(data.rois, null, 2))
        }
        if (data.settings) {
          await fs.writeFile(DASHBOARD_SETTINGS_FILE, JSON.stringify(data.settings, null, 2))
        }
        if (data.histograms) {
          await fs.writeFile(HISTOGRAM_CONFIGS_FILE, JSON.stringify(data.histograms, null, 2))
        }
        if (data.zoomRanges) {
          await fs.writeFile(ZOOM_RANGES_FILE, JSON.stringify(data.zoomRanges, null, 2))
        }
        break

      default:
        return NextResponse.json(
          {
            success: false,
            error: "Invalid data type",
          },
          { status: 400 },
        )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("Failed to write cache data:", error)
    return NextResponse.json(
      {
        success: false,
        error: "Failed to write cache data",
      },
      { status: 500 },
    )
  }
}

// DELETE - Clear cached data
export async function DELETE(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const { searchParams } = new URL(request.url)
    const dataType = searchParams.get("type") || body.type || "all"
    const histogramId = searchParams.get("id") || body.id

    switch (dataType) {
      case "rois":
        await fs.writeFile(ROI_CACHE_FILE, "{}")
        break

      case "settings":
        await fs.writeFile(
          DASHBOARD_SETTINGS_FILE,
          JSON.stringify({
            layout: "grid",
            gridCols: 3,
            isLogScale: false,
            syncZoom: false,
            showLabels: true,
            showROIs: true,
            showIntegrals: true,
            autoUpdate: true,
            updateInterval: 2000,
            theme: "auto",
            rebinFactor: 1,
          }),
        )
        break

      case "histograms":
        await fs.writeFile(HISTOGRAM_CONFIGS_FILE, "[]")
        break

      case "histogram":
        // Remove specific histogram from cache (used when visibility is toggled off)
        if (histogramId) {
          // Remove from zoom ranges
          await ensureFileExists(ZOOM_RANGES_FILE, "{}")
          const zoomData = JSON.parse(await fs.readFile(ZOOM_RANGES_FILE, "utf-8")) as ZoomRanges
          delete zoomData[histogramId]
          await fs.writeFile(ZOOM_RANGES_FILE, JSON.stringify(zoomData, null, 2))

          // Remove from ROI data
          await ensureFileExists(ROI_CACHE_FILE, "{}")
          const roiData = JSON.parse(await fs.readFile(ROI_CACHE_FILE, "utf-8")) as ROICollection
          delete roiData[histogramId]
          await fs.writeFile(ROI_CACHE_FILE, JSON.stringify(roiData, null, 2))
        }
        break

      case "zoom-ranges":
        await fs.writeFile(ZOOM_RANGES_FILE, "{}")
        break

      case "all":
        await fs.writeFile(ROI_CACHE_FILE, "{}")
        await fs.writeFile(
          DASHBOARD_SETTINGS_FILE,
          JSON.stringify({
            layout: "grid",
            gridCols: 3,
            isLogScale: false,
            syncZoom: false,
            showLabels: true,
            showROIs: true,
            showIntegrals: true,
            autoUpdate: true,
            updateInterval: 2000,
            theme: "auto",
            rebinFactor: 1,
          }),
        )
        await fs.writeFile(HISTOGRAM_CONFIGS_FILE, "[]")
        await fs.writeFile(ZOOM_RANGES_FILE, "{}")
        break

      default:
        return NextResponse.json(
          {
            success: false,
            error: "Invalid data type",
          },
          { status: 400 },
        )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("Failed to clear cache data:", error)
    return NextResponse.json(
      {
        success: false,
        error: "Failed to clear cache data",
      },
      { status: 500 },
    )
  }
}

// PUT - Update specific ROI or histogram
export async function PUT(request: Request) {
  try {
    await ensureCacheDirectoryExists()

    const body = await request.json()
    const { type, histogramId, roiId, data } = body

    if (type === "roi" && histogramId && roiId) {
      // Update specific ROI
      await ensureFileExists(ROI_CACHE_FILE, "{}")
      const roiData = JSON.parse(await fs.readFile(ROI_CACHE_FILE, "utf-8")) as ROICollection

      if (!roiData[histogramId]) {
        roiData[histogramId] = []
      }

      const roiIndex = roiData[histogramId].findIndex((roi) => roi.id === roiId)
      if (roiIndex >= 0) {
        roiData[histogramId][roiIndex] = { ...roiData[histogramId][roiIndex], ...data }
      } else {
        roiData[histogramId].push({ id: roiId, ...data } as ROI)
      }

      await fs.writeFile(ROI_CACHE_FILE, JSON.stringify(roiData, null, 2))
      return NextResponse.json({ success: true })
    }

    if (type === "histogram" && histogramId) {
      // Update specific histogram
      await ensureFileExists(HISTOGRAM_CONFIGS_FILE, "[]")
      const histogramData = JSON.parse(await fs.readFile(HISTOGRAM_CONFIGS_FILE, "utf-8")) as HistogramConfig[]

      const histogramIndex = histogramData.findIndex((hist) => hist.id === histogramId)
      if (histogramIndex >= 0) {
        histogramData[histogramIndex] = { ...histogramData[histogramIndex], ...data }
      } else {
        histogramData.push({ id: histogramId, ...data } as HistogramConfig)
      }

      await fs.writeFile(HISTOGRAM_CONFIGS_FILE, JSON.stringify(histogramData, null, 2))
      return NextResponse.json({ success: true })
    }

    if (type === "zoom-range" && histogramId) {
      // Update specific histogram zoom range
      await ensureFileExists(ZOOM_RANGES_FILE, "{}")
      const zoomData = JSON.parse(await fs.readFile(ZOOM_RANGES_FILE, "utf-8")) as ZoomRanges

      zoomData[histogramId] = {
        ...data,
        timestamp: Date.now(),
      }

      await fs.writeFile(ZOOM_RANGES_FILE, JSON.stringify(zoomData, null, 2))
      return NextResponse.json({ success: true })
    }

    return NextResponse.json(
      {
        success: false,
        error: "Invalid update parameters",
      },
      { status: 400 },
    )
  } catch (error) {
    console.error("Failed to update cache data:", error)
    return NextResponse.json(
      {
        success: false,
        error: "Failed to update cache data",
      },
      { status: 500 },
    )
  }
}
