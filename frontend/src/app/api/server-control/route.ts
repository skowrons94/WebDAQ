import { NextResponse } from 'next/server'
import { spawn, ChildProcess } from 'child_process'
import path from 'path'

// Module-level state: tracks the child process we spawned
let serverProcess: ChildProcess | null = null
let serverPid: number | null = null

async function isServerRunning(): Promise<boolean> {
    const url = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:5001'
    try {
        await fetch(url, { signal: AbortSignal.timeout(2000) })
        return true
    } catch {
        return false
    }
}

export async function GET() {
    const running = await isServerRunning()
    return NextResponse.json({ running })
}

export async function POST(request: Request) {
    const { action, directory } = await request.json()

    if (action === 'start') {
        if (await isServerRunning()) {
            return NextResponse.json({ success: true })
        }
        if (!directory) {
            return NextResponse.json({ success: false, error: 'Directory required' }, { status: 400 })
        }
        try {
            // main.py is in server/ relative to this Next.js project root
            const mainPy = path.resolve(process.cwd(), '..', 'server', 'main.py')
            const proc = spawn('python3', [mainPy], {
                cwd: directory,
                detached: false,
                stdio: 'ignore',
            })
            serverProcess = proc
            serverPid = proc.pid ?? null
            proc.on('exit', () => {
                serverProcess = null
                serverPid = null
            })
            return NextResponse.json({ success: true, pid: serverPid })
        } catch (err: any) {
            return NextResponse.json({ success: false, error: err.message }, { status: 500 })
        }
    }

    if (action === 'stop') {
        try {
            if (serverPid) {
                process.kill(serverPid, 'SIGTERM')
            } else {
                // Fallback: try to kill any python3 main.py we don't have a handle for
                const { execSync } = require('child_process')
                try { execSync('pkill -f "python3.*main.py"', { stdio: 'ignore' }) } catch { /* ignore */ }
            }
            serverProcess = null
            serverPid = null
            return NextResponse.json({ success: true })
        } catch (err: any) {
            return NextResponse.json({ success: false, error: err.message }, { status: 500 })
        }
    }

    return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 })
}
