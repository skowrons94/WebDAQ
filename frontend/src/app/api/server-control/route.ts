import { NextResponse } from 'next/server'
import { spawn, spawnSync, ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs/promises'
import fsSync from 'fs'

// Module-level state. Tracks the child we spawned and the directory it's running
// in so the UI can show the active working dir even after a Next.js HMR reload.
let serverProcess: ChildProcess | null = null
let serverPid: number | null = null

const CONDA_ENV = process.env.LUNA_CONDA_ENV || 'luna'
const CONDA_BIN = process.env.CONDA_BIN || 'conda'
const DEFAULT_USER = process.env.LUNA_DEFAULT_USER || 'luna'
const DEFAULT_PASSWORD = process.env.LUNA_DEFAULT_PASSWORD || 'assergi'

// server/ is a sibling of frontend/. process.cwd() is frontend/ when Next runs.
const SERVER_DIR = path.resolve(process.cwd(), '..', 'server')
const MAIN_PY = path.join(SERVER_DIR, 'main.py')
const MIGRATIONS_DIR = path.join(SERVER_DIR, 'migrations')

const STATE_FILE = path.join(process.cwd(), 'cache', 'server-control-state.json')
const LOG_FILENAME = 'server.log'
const LOG_TAIL_BYTES = 200_000 // cap on what we ship to the UI per poll

type ServerState = { currentDirectory: string | null; testMode: boolean }

async function readState(): Promise<ServerState> {
    try {
        const raw = await fs.readFile(STATE_FILE, 'utf-8')
        const parsed = JSON.parse(raw)
        return {
            currentDirectory: parsed.currentDirectory ?? null,
            testMode: Boolean(parsed.testMode),
        }
    } catch {
        return { currentDirectory: null, testMode: false }
    }
}

async function writeState(state: ServerState) {
    try {
        await fs.mkdir(path.dirname(STATE_FILE), { recursive: true })
        await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2))
    } catch (e) {
        console.error('Failed to write server-control state:', e)
    }
}

async function isServerRunning(): Promise<boolean> {
    const url = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:5001'
    try {
        await fetch(url, { signal: AbortSignal.timeout(2000) })
        return true
    } catch {
        return false
    }
}

// Read the last LOG_TAIL_BYTES of the server log. We avoid loading huge files
// fully so tailing stays cheap even after a long-running measurement.
async function tailLog(absDir: string): Promise<{ content: string; size: number }> {
    const logPath = path.join(absDir, LOG_FILENAME)
    try {
        const stat = await fs.stat(logPath)
        const size = stat.size
        const start = Math.max(0, size - LOG_TAIL_BYTES)
        const fd = await fs.open(logPath, 'r')
        try {
            const buf = Buffer.alloc(size - start)
            await fd.read(buf, 0, buf.length, start)
            return { content: buf.toString('utf-8'), size }
        } finally {
            await fd.close()
        }
    } catch {
        return { content: '', size: 0 }
    }
}

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url)
    const wantLogs = searchParams.get('logs') === '1'

    const running = await isServerRunning()
    const state = await readState()
    const dir = running ? state.currentDirectory : null
    const testMode = running ? state.testMode : false

    if (wantLogs) {
        const log = state.currentDirectory ? await tailLog(state.currentDirectory) : null
        return NextResponse.json({
            running,
            currentDirectory: dir,
            testMode,
            log: log?.content ?? '',
            logSize: log?.size ?? 0,
            truncated: log ? log.size > LOG_TAIL_BYTES : false,
        })
    }

    return NextResponse.json({ running, currentDirectory: dir, testMode })
}

// Initialize a fresh measurement directory: ensure folders exist, run db upgrade,
// create the default luna user. Idempotent — safe to call repeatedly.
// testMode propagates TEST_FLAG=True so any code paths that touch hardware during
// init (e.g. importing modules that try to load CAEN libs at import time) take the
// stub path instead.
function initMeasurementDirectory(
    absDir: string,
    testMode: boolean,
): { success: boolean; error?: string } {
    try {
        fsSync.mkdirSync(absDir, { recursive: true })
        for (const sub of ['conf', 'calib', 'data']) {
            fsSync.mkdirSync(path.join(absDir, sub), { recursive: true })
        }

        const dbPath = path.join(absDir, 'app.db')
        const dbUrl = `sqlite:///${dbPath}`
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            DATABASE_URL: dbUrl,
            FLASK_APP: MAIN_PY,
            PYTHONPATH:
                SERVER_DIR + (process.env.PYTHONPATH ? `:${process.env.PYTHONPATH}` : ''),
        }
        if (testMode) env.TEST_FLAG = 'True'

        // Run flask db upgrade from server/ so Flask finds the migrations folder
        // and the app package; DATABASE_URL points the schema at the measurement
        // directory's app.db.
        const upgrade = spawnSync(
            CONDA_BIN,
            [
                'run',
                '--no-capture-output',
                '-n',
                CONDA_ENV,
                'flask',
                '--app',
                MAIN_PY,
                'db',
                'upgrade',
                '-d',
                MIGRATIONS_DIR,
            ],
            { cwd: SERVER_DIR, env, encoding: 'utf-8' },
        )
        if (upgrade.status !== 0) {
            return {
                success: false,
                error: `db upgrade failed: ${upgrade.stderr || upgrade.stdout || 'unknown error'}`,
            }
        }

        // Create the default user if one with that username doesn't already exist.
        const createUserScript = `
import sys
sys.path.insert(0, ${JSON.stringify(SERVER_DIR)})
from app import create_app, db
from app.models.user import User
app = create_app()
with app.app_context():
    if not User.query.filter_by(username=${JSON.stringify(DEFAULT_USER)}).first():
        u = User(username=${JSON.stringify(DEFAULT_USER)}, email=${JSON.stringify(DEFAULT_USER + '@local')})
        u.set_password(${JSON.stringify(DEFAULT_PASSWORD)})
        db.session.add(u)
        db.session.commit()
        print('user-created')
    else:
        print('user-exists')
`
        const createUser = spawnSync(
            CONDA_BIN,
            [
                'run',
                '--no-capture-output',
                '-n',
                CONDA_ENV,
                'python',
                '-c',
                createUserScript,
            ],
            { cwd: SERVER_DIR, env, encoding: 'utf-8' },
        )
        if (createUser.status !== 0) {
            return {
                success: false,
                error: `user creation failed: ${createUser.stderr || createUser.stdout || 'unknown error'}`,
            }
        }

        return { success: true }
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}

export async function POST(request: Request) {
    const body = await request.json().catch(() => ({}))
    const { action, directory } = body
    const testMode = Boolean(body?.testMode)

    if (action === 'start') {
        if (await isServerRunning()) {
            return NextResponse.json({ success: true })
        }
        if (!directory) {
            return NextResponse.json(
                { success: false, error: 'Directory required' },
                { status: 400 },
            )
        }

        const absDir = path.resolve(directory)
        const init = initMeasurementDirectory(absDir, testMode)
        if (!init.success) {
            return NextResponse.json({ success: false, error: init.error }, { status: 500 })
        }

        try {
            const dbPath = path.join(absDir, 'app.db')
            const env: NodeJS.ProcessEnv = {
                ...process.env,
                DATABASE_URL: `sqlite:///${dbPath}`,
                PYTHONPATH:
                    SERVER_DIR + (process.env.PYTHONPATH ? `:${process.env.PYTHONPATH}` : ''),
                // Force Python's stdout/stderr to be unbuffered so the log file is
                // updated in real time instead of after big chunks.
                PYTHONUNBUFFERED: '1',
            }
            // Skip hardware/Docker init when running for debugging.
            if (testMode) env.TEST_FLAG = 'True'

            // Truncate log on each new launch and inherit the FD into the child
            // so it keeps writing even after a Next.js HMR reload.
            const logPath = path.join(absDir, LOG_FILENAME)
            const logFd = fsSync.openSync(logPath, 'w')
            try {
                const proc = spawn(
                    CONDA_BIN,
                    ['run', '--no-capture-output', '-n', CONDA_ENV, 'python', MAIN_PY],
                    {
                        cwd: absDir,
                        env,
                        detached: false,
                        stdio: ['ignore', logFd, logFd],
                    },
                )
                serverProcess = proc
                serverPid = proc.pid ?? null
                await writeState({ currentDirectory: absDir, testMode })

                proc.on('exit', () => {
                    serverProcess = null
                    serverPid = null
                    writeState({ currentDirectory: null, testMode: false })
                })
                return NextResponse.json({
                    success: true,
                    pid: serverPid,
                    directory: absDir,
                    testMode,
                    logPath,
                })
            } finally {
                // Close the parent's copy of the FD; the child has its own.
                fsSync.closeSync(logFd)
            }
        } catch (err: any) {
            return NextResponse.json({ success: false, error: err.message }, { status: 500 })
        }
    }

    if (action === 'stop') {
        try {
            if (serverPid) {
                try {
                    process.kill(serverPid, 'SIGTERM')
                } catch {
                    /* ignore */
                }
            }
            // Best-effort fallback for orphaned processes from before a Next.js reload.
            const { execSync } = require('child_process')
            try {
                execSync('pkill -f "python.*main.py"', { stdio: 'ignore' })
            } catch {
                /* ignore */
            }
            serverProcess = null
            serverPid = null
            await writeState({ currentDirectory: null, testMode: false })
            return NextResponse.json({ success: true })
        } catch (err: any) {
            return NextResponse.json({ success: false, error: err.message }, { status: 500 })
        }
    }

    return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 })
}
