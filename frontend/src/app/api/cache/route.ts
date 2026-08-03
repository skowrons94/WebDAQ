import { NextResponse } from "next/server"
import fs from "fs/promises"
import path from "path"

/**
 * Small file-backed cache for state that belongs to the *browser client*, not to
 * the DAQ.
 *
 * The histogram dashboard used to live here too — which histograms existed,
 * their ROIs, their zooms and the dashboard settings. That was the wrong home:
 * this runs in the Next.js process, so the DAQ server could not see the ROIs it
 * was supposed to record with a run, and every deployment of the web server got
 * its own copy. It now lives on the DAQ server in conf/histograms.json; see
 * lib/histogram-config.ts.
 *
 * The old files are left in place. The server imports them once, on first start,
 * to seed conf/histograms.json.
 */

const CACHE_DIR = path.join(process.cwd(), "cache")
const VIS_CHANNELS_FILE = path.join(CACHE_DIR, "visualization-channels.json")
const WAVE_CONFIG_FILE = path.join(CACHE_DIR, "wave-config.json")
const WORKING_DIRS_FILE = path.join(CACHE_DIR, "working-directories.json")

const DEFAULT_WORKING_DIRS = {
  directories: [] as Array<{ id: string; label: string; path: string }>,
}

const DEFAULT_VIS_CHANNELS = {
  selectedBoardsChannelsPSD: [] as Array<{ boardId: string; channels: number[] }>,
  selectedBoardsChannelsWaveform: [] as Array<{ boardId: string; channels: number[] }>,
}

const DEFAULT_WAVE_CONFIG = {
  selectedWaveform: {} as Record<string, number>,
}

const FILES: Record<string, { file: string; fallback: unknown }> = {
  "visualization-channels": { file: VIS_CHANNELS_FILE, fallback: DEFAULT_VIS_CHANNELS },
  "wave-config": { file: WAVE_CONFIG_FILE, fallback: DEFAULT_WAVE_CONFIG },
  "working-directories": { file: WORKING_DIRS_FILE, fallback: DEFAULT_WORKING_DIRS },
}

/** Types this route used to own, now served by the DAQ server. */
const MOVED = new Set(["rois", "settings", "histograms", "zoom-ranges", "zoom-range", "histogram", "all"])

async function ensureCacheDirectoryExists() {
  try {
    await fs.access(CACHE_DIR)
  } catch (error) {
    await fs.mkdir(CACHE_DIR, { recursive: true })
  }
}

function movedResponse(dataType: string) {
  return NextResponse.json(
    {
      success: false,
      error: `'${dataType}' now lives on the DAQ server under /histograms/config. ` +
        `Use the helpers in lib/histogram-config.ts.`,
    },
    { status: 410 },
  )
}

// GET - Retrieve cached data
export async function GET(request: Request) {
  try {
    await ensureCacheDirectoryExists()

    const { searchParams } = new URL(request.url)
    const dataType = searchParams.get("type") || ""

    if (MOVED.has(dataType)) return movedResponse(dataType)

    const entry = FILES[dataType]
    if (!entry) {
      return NextResponse.json({ success: false, error: "Invalid data type" }, { status: 400 })
    }

    let stored: unknown = {}
    try {
      stored = JSON.parse(await fs.readFile(entry.file, "utf-8"))
    } catch (error) {
      // Missing or unreadable: the defaults are the answer, and writing the file
      // is the caller's business, not a side effect of reading it.
      stored = {}
    }

    return NextResponse.json({
      success: true,
      data: { ...(entry.fallback as object), ...(stored as object) },
    })
  } catch (error) {
    console.error("Failed to read cache data:", error)
    return NextResponse.json({ success: false, error: "Failed to read cache data" }, { status: 500 })
  }
}

// POST - Save cached data
export async function POST(request: Request) {
  try {
    await ensureCacheDirectoryExists()

    const body = await request.json()
    const { type, data } = body

    if (!type || !data) {
      return NextResponse.json({ success: false, error: "Missing type or data" }, { status: 400 })
    }

    if (MOVED.has(type)) return movedResponse(type)

    const entry = FILES[type]
    if (!entry) {
      return NextResponse.json({ success: false, error: "Invalid data type" }, { status: 400 })
    }

    await fs.writeFile(entry.file, JSON.stringify(data, null, 2))
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("Failed to write cache data:", error)
    return NextResponse.json({ success: false, error: "Failed to write cache data" }, { status: 500 })
  }
}
