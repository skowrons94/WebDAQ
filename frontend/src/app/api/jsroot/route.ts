import fs from "fs/promises"
import path from "path"

/**
 * JSROOT, served by this web server rather than fetched from root.cern.
 *
 * Every plot in WebDAQ is drawn by JSROOT. It used to be loaded from
 * root.cern/js/latest, which tied the DAQ's displays to a site outside the
 * experiment: when root.cern started sending visitors to the CERN single
 * sign-on, every histogram, waveform and PSD plot stopped drawing at once. The
 * version WebDAQ uses is pinned in package.json (npm package "jsroot") and
 * served from node_modules, so the plots work offline and do not change under
 * our feet. There is no outside fallback: if this fails, the plots say so.
 */

const FILE = path.join(process.cwd(), "node_modules", "jsroot", "build", "jsroot.js")

let cached: { body: Buffer; mtime: number } | null = null

export async function GET() {
  try {
    const stat = await fs.stat(FILE)
    if (!cached || cached.mtime !== stat.mtimeMs) {
      cached = { body: await fs.readFile(FILE), mtime: stat.mtimeMs }
    }
    return new Response(new Uint8Array(cached.body), {
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        // The file only changes when package.json pins another version.
        "Cache-Control": "public, max-age=86400",
      },
    })
  } catch {
    return new Response("// JSROOT is not installed: run npm install in frontend/", {
      status: 404,
      headers: { "Content-Type": "text/javascript; charset=utf-8" },
    })
  }
}
