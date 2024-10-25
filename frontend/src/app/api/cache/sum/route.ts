import { NextResponse } from 'next/server'
import fs from 'fs/promises'
import path from 'path'

const CACHE_DIR = path.join(process.cwd(), 'cache')
const ROI_CACHE_FILE = path.join(CACHE_DIR, 'roi-cache-sum.json')

async function ensureCacheDirectoryExists() {
  try {
    await fs.access(CACHE_DIR)
  } catch (error) {
    await fs.mkdir(CACHE_DIR, { recursive: true })
  }
}

export async function GET() {
  try {
    await ensureCacheDirectoryExists()

    try {
      await fs.access(ROI_CACHE_FILE)
    } catch (error) {
      // If the file doesn't exist, create it with an empty object
      await fs.writeFile(ROI_CACHE_FILE, '{}')
    }

    const roiData = await fs.readFile(ROI_CACHE_FILE, 'utf-8')
    return NextResponse.json({ roiValues: JSON.parse(roiData) })
  } catch (error) {
    console.error('Failed to read ROI cache:', error)
    return NextResponse.json({ error: 'Failed to read ROI cache' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    await ensureCacheDirectoryExists()

    const roiValues = await request.json()
    await fs.writeFile(ROI_CACHE_FILE, JSON.stringify(roiValues))

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Failed to write ROI cache:', error)
    return NextResponse.json({ error: 'Failed to write ROI cache' }, { status: 500 })
  }
}