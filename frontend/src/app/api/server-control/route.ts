import { NextResponse } from 'next/server'
import { spawn, spawnSync, ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs/promises'
import fsSync from 'fs'

// Module-level state. Tracks the child we spawned and the directory it's running
// in so the UI can show the active working dir even after a Next.js HMR reload.
let serverProcess: ChildProcess | null = null
let serverPid: number | null = null

// Take the backend down when this launcher exits gracefully. (SIGKILL of npm is
// covered by the backend's own launcher-watchdog, which polls LUNA_LAUNCHER_PID.)
if (!(globalThis as any).__lunaExitHandlerInstalled) {
    ;(globalThis as any).__lunaExitHandlerInstalled = true
    const killChild = () => {
        if (serverPid) {
            try { process.kill(serverPid, 'SIGTERM') } catch { /* already gone */ }
        }
    }
    process.once('exit', killChild)
    process.once('SIGINT', () => { killChild(); process.exit(0) })
    process.once('SIGTERM', () => { killChild(); process.exit(0) })
}

const CONDA_ENV = process.env.LUNA_CONDA_ENV || 'luna'
const CONDA_BIN = process.env.CONDA_BIN || 'conda'
const DEFAULT_USER = process.env.LUNA_DEFAULT_USER || 'luna'
const DEFAULT_PASSWORD = process.env.LUNA_DEFAULT_PASSWORD || 'assergi'

// server/ is a sibling of frontend/. process.cwd() is frontend/ when Next runs.
const SERVER_DIR = path.resolve(process.cwd(), '..', 'server')
const MAIN_PY = path.join(SERVER_DIR, 'main.py')
const MIGRATIONS_DIR = path.join(SERVER_DIR, 'migrations')
const CHECK_DB_SCRIPT = path.join(SERVER_DIR, 'scripts', 'check_db.sh')

// ── Which interpreter runs the backend ──────────────────────────────────────
// 'conda run -n luna python' cannot be trusted to pick the environment's own
// python: on some conda versions it resolves 'python' from the PATH it
// inherited, so the backend ends up running in whatever environment the person
// who started the web app happened to be in. That environment has no caendaq
// and no elog, and the failures show up much later as "incompatible function
// arguments" or "py_elog is not installed" — nothing that points at the cause.
//
// So find the environment's prefix and use <prefix>/bin/python directly, and
// put <prefix>/bin first on PATH for the shell steps (check_db.sh calls flask).
let cachedEnvPrefix: string | null | undefined

function condaEnvPrefix(): string | null {
    if (cachedEnvPrefix !== undefined) return cachedEnvPrefix

    // An explicit override wins, for setups that are not conda at all.
    const override = process.env.LUNA_ENV_PREFIX
    if (override && fsSync.existsSync(path.join(override, 'bin', 'python'))) {
        cachedEnvPrefix = override
        return cachedEnvPrefix
    }

    // Ask conda where the environment is: 'conda env list' prints one line per
    // environment, "name [*] prefix".
    try {
        const res = spawnSync(CONDA_BIN, ['env', 'list'], {
            encoding: 'utf-8',
            timeout: PROBE_TIMEOUT_MS,
        })
        for (const line of (res.stdout || '').split('\n')) {
            const parts = line.trim().split(/\s+/)
            if (parts[0] === CONDA_ENV) {
                const prefix = parts[parts.length - 1]
                if (prefix.startsWith('/') && fsSync.existsSync(path.join(prefix, 'bin', 'python'))) {
                    cachedEnvPrefix = prefix
                    return cachedEnvPrefix
                }
            }
        }
    } catch {
        /* fall through */
    }

    cachedEnvPrefix = null
    return cachedEnvPrefix
}

/** Command + leading arguments for running python in the backend environment. */
function pythonCommand(): { command: string; prefixArgs: string[] } {
    const prefix = condaEnvPrefix()
    if (prefix) return { command: path.join(prefix, 'bin', 'python'), prefixArgs: [] }
    // No prefix found: fall back to the old behaviour rather than refusing to
    // start. envForEnvironment() still repairs PATH where it can.
    return {
        command: CONDA_BIN,
        prefixArgs: ['run', '--no-capture-output', '-n', CONDA_ENV, 'python'],
    }
}

/** The same, for a shell script that needs flask/python on its PATH. */
function bashCommand(script: string): { command: string; args: string[] } {
    const prefix = condaEnvPrefix()
    if (prefix) return { command: 'bash', args: [script] }
    return {
        command: CONDA_BIN,
        args: ['run', '--no-capture-output', '-n', CONDA_ENV, 'bash', script],
    }
}

/** Put the environment's bin directory first, so child lookups resolve there. */
function envForEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const prefix = condaEnvPrefix()
    if (!prefix) return base
    const binDir = path.join(prefix, 'bin')
    return {
        ...base,
        PATH: `${binDir}:${base.PATH ?? process.env.PATH ?? ''}`,
        CONDA_PREFIX: prefix,
    }
}

/** Modules the backend cannot work without, checked before it is started. */
function missingModules(): string[] {
    const { command, prefixArgs } = pythonCommand()
    const missing: string[] = []
    for (const module of ['caendaq', 'flask']) {
        const res = spawnSync(command, [...prefixArgs, '-c', `import ${module}`], {
            encoding: 'utf-8',
            timeout: PROBE_TIMEOUT_MS,
            env: envForEnvironment({ ...process.env }),
        })
        if (res.error || res.status !== 0) missing.push(module)
    }
    return missing
}

const STATE_FILE = path.join(process.cwd(), 'cache', 'server-control-state.json')
const LOG_FILENAME = 'server.log'
const LOG_TAIL_BYTES = 200_000 // cap on what we ship to the UI per poll

// The backend listens on this TCP port (waitress in main.py binds 0.0.0.0:5001).
// Derived from NEXT_PUBLIC_API_URL when it carries an explicit port so the
// preflight checks the same port the UI talks to.
const BACKEND_PORT = (() => {
    const raw = process.env.NEXT_PUBLIC_API_URL
    const m = raw?.match(/:(\d+)(?:\/|$)/)
    return m ? parseInt(m[1], 10) : 5001
})()

// Hard ceilings so a hung conda/flask/sqlite step never wedges this request
// (and with it the whole "Start" button) forever. On timeout spawnSync returns
// with status === null and error set, which the callers surface as a failure.
const DB_STEP_TIMEOUT_MS = 120_000
const USER_STEP_TIMEOUT_MS = 120_000
const PROBE_TIMEOUT_MS = 5_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// currentDirectory is the dir of a *running* server (cleared on exit/stop).
// lastDirectory is the dir of the most recent launch and is kept even after the
// process exits, so the logs from a failed/short-lived launch stay readable
// instead of collapsing to "Waiting for output…".
type ServerState = {
    currentDirectory: string | null
    lastDirectory: string | null
    testMode: boolean
}

async function readState(): Promise<ServerState> {
    try {
        const raw = await fs.readFile(STATE_FILE, 'utf-8')
        const parsed = JSON.parse(raw)
        return {
            currentDirectory: parsed.currentDirectory ?? null,
            lastDirectory: parsed.lastDirectory ?? parsed.currentDirectory ?? null,
            testMode: Boolean(parsed.testMode),
        }
    } catch {
        return { currentDirectory: null, lastDirectory: null, testMode: false }
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
    // Try the configured URL first, then fall back to loopback. This covers the
    // case where NEXT_PUBLIC_API_URL points at a host/IP that this Next.js process
    // can't reach (e.g. behind port forwarding) but the backend is in fact running
    // locally on 127.0.0.1:5001.
    const candidates = [
        process.env.NEXT_PUBLIC_API_URL,
        'http://127.0.0.1:5001',
    ].filter((u): u is string => Boolean(u))

    // De-duplicate so we don't probe the same URL twice when the env var is unset
    // or already points at loopback.
    const urls = candidates.filter((u, i) => candidates.indexOf(u) === i)

    for (const url of urls) {
        try {
            await fetch(url, { signal: AbortSignal.timeout(2000) })
            return true
        } catch {
            // Try the next candidate.
        }
    }
    return false
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
        // Fall back to the last launch directory so logs from a process that has
        // already exited (e.g. a failed startup) remain visible.
        const logDir = state.currentDirectory ?? state.lastDirectory
        const log = logDir ? await tailLog(logDir) : null
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

// ── Port preflight ───────────────────────────────────────────────────────────
// A crashed backend can leave a process holding port 5001. The next "Start"
// then dies with "address already in use" and the only known fix has been to
// reboot the PC. Instead we detect the holder, reap leftover WebDAQ servers
// ourselves, and give a precise message when the port is taken by something
// unrelated.

type PortHolder = { pid: number; command: string }

// List the PIDs (with their short command name) currently LISTENing on a port.
// Uses lsof's parseable (-F) output; returns [] if lsof is missing or the port
// is free. Never throws.
function inspectPort(port: number): PortHolder[] {
    let res
    try {
        res = spawnSync(
            'lsof',
            ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'],
            { encoding: 'utf-8', timeout: PROBE_TIMEOUT_MS },
        )
    } catch {
        return []
    }
    if (!res.stdout) return []

    const holders: PortHolder[] = []
    let pid: number | null = null
    let command = ''
    const flush = () => {
        if (pid !== null && Number.isFinite(pid)) holders.push({ pid, command })
    }
    for (const line of res.stdout.split('\n')) {
        if (line.startsWith('p')) {
            flush()
            pid = parseInt(line.slice(1), 10)
            command = ''
        } else if (line.startsWith('c')) {
            command = line.slice(1)
        }
    }
    flush()

    // De-duplicate by PID (a process can hold several matching sockets).
    const seen = new Set<number>()
    return holders.filter((h) => (seen.has(h.pid) ? false : (seen.add(h.pid), true)))
}

// Full command line for a PID, used to decide whether a port holder is a
// leftover WebDAQ backend (worth reaping) or an unrelated app (leave alone).
function commandLine(pid: number): string {
    try {
        const res = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
            encoding: 'utf-8',
            timeout: PROBE_TIMEOUT_MS,
        })
        return (res.stdout || '').trim()
    } catch {
        return ''
    }
}

// A port holder is "ours" if it's the Python/waitress process that runs main.py.
function isOwnedBackend(cmd: string): boolean {
    return /main\.py/.test(cmd) || /waitress/.test(cmd)
}

// SIGTERM a PID, wait for it to actually die, then SIGKILL as a last resort.
async function killProcess(pid: number): Promise<void> {
    try {
        process.kill(pid, 'SIGTERM')
    } catch {
        return // already gone or not ours to signal
    }
    for (let i = 0; i < 15; i++) {
        await sleep(200)
        try {
            process.kill(pid, 0) // probe: throws ESRCH once the process is gone
        } catch {
            return
        }
    }
    try {
        process.kill(pid, 'SIGKILL')
    } catch {
        /* ignore */
    }
    await sleep(200)
}

// Make sure the backend port is free before launching. Reaps leftover WebDAQ
// servers automatically; refuses (with a clear message) when a foreign process
// owns the port so we never kill something the user actually wants.
async function ensureBackendPortFree(): Promise<{ ok: true } | { ok: false; error: string }> {
    const holders = inspectPort(BACKEND_PORT)
    if (holders.length === 0) return { ok: true }

    const ourPids: number[] = []
    const foreign: PortHolder[] = []
    for (const h of holders) {
        const cmd = commandLine(h.pid) || h.command
        if (isOwnedBackend(cmd)) ourPids.push(h.pid)
        else foreign.push({ pid: h.pid, command: cmd })
    }

    for (const pid of ourPids) await killProcess(pid)

    const remaining = inspectPort(BACKEND_PORT)
    if (remaining.length === 0) return { ok: true }

    const stuckOurs = remaining.filter((h) => ourPids.includes(h.pid)).map((h) => h.pid)
    if (stuckOurs.length > 0) {
        return {
            ok: false,
            error:
                `Port ${BACKEND_PORT} is still held by a previous WebDAQ server ` +
                `(PID ${stuckOurs.join(', ')}) that would not exit. ` +
                `Kill it manually and retry:  kill -9 ${stuckOurs.join(' ')}`,
        }
    }
    const desc = remaining
        .map((h) => `PID ${h.pid} (${commandLine(h.pid) || h.command || 'unknown'})`)
        .join(', ')
    return {
        ok: false,
        error:
            `Port ${BACKEND_PORT} is in use by another process not managed by WebDAQ: ${desc}. ` +
            `Stop that process (or point NEXT_PUBLIC_API_URL at a free port) and start again.`,
    }
}

// ── Lightweight DB / user preflight ──────────────────────────────────────────
// On a warm boot the migrations are already applied and the default user
// already exists. Re-running the conda-wrapped 'flask db upgrade' and the
// app-importing create-user script every time added seconds to startup for no
// benefit. These sqlite3-only probes let us skip both when nothing needs doing.

// Copy migration revisions the repo has but a measurement directory does not.
// Only adds files: anything already there wins, so a project whose history
// diverged keeps it. Returns the filenames copied, for logging.
function copyNewMigrations(repoMigrationsDir: string, projectMigrationsDir: string): string[] {
    const from = path.join(repoMigrationsDir, 'versions')
    const to = path.join(projectMigrationsDir, 'versions')
    const copied: string[] = []
    try {
        if (!fsSync.existsSync(from)) return copied
        fsSync.mkdirSync(to, { recursive: true })
        const have = new Set(fsSync.readdirSync(to))
        for (const file of fsSync.readdirSync(from)) {
            if (!file.endsWith('.py') || have.has(file)) continue
            fsSync.copyFileSync(path.join(from, file), path.join(to, file))
            copied.push(file)
        }
    } catch {
        // Non-fatal: check_db.sh still runs, and reports clearly if the
        // database ends up behind the models.
    }
    return copied
}

// Determine the Alembic head from the migration files: the revision that no
// other migration lists as its down_revision. Mirrors scripts/check_db.sh.
function findMigrationHead(versionsDir: string): string | null {
    let files: string[]
    try {
        files = fsSync.readdirSync(versionsDir)
    } catch {
        return null
    }
    const revisions = new Set<string>()
    const downs = new Set<string>()
    for (const f of files) {
        if (!f.endsWith('.py')) continue
        let content: string
        try {
            content = fsSync.readFileSync(path.join(versionsDir, f), 'utf-8')
        } catch {
            continue
        }
        const rev = content.match(/^revision\s*=\s*['"]([^'"]+)['"]/m)
        const down = content.match(/^down_revision\s*=\s*['"]([^'"]+)['"]/m)
        if (rev) revisions.add(rev[1])
        if (down && down[1]) downs.add(down[1])
    }
    for (const r of Array.from(revisions)) {
        if (!downs.has(r)) return r
    }
    return null
}

// Run a scalar sqlite3 query; null if sqlite3 is missing or the query errors
// (e.g. the table doesn't exist). Read-only, so it can't corrupt the DB.
function sqliteScalar(dbPath: string, sql: string): string | null {
    let res
    try {
        res = spawnSync('sqlite3', ['-batch', dbPath, sql], {
            encoding: 'utf-8',
            timeout: PROBE_TIMEOUT_MS,
        })
    } catch {
        return null
    }
    if (res.error || res.status !== 0) return null
    return (res.stdout || '').trim()
}

function dbAtHead(dbPath: string, head: string): boolean {
    const hasTable = sqliteScalar(
        dbPath,
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='alembic_version';",
    )
    if (hasTable !== '1') return false
    return sqliteScalar(dbPath, 'SELECT version_num FROM alembic_version LIMIT 1;') === head
}

function userExists(dbPath: string, username: string): boolean {
    const hasTable = sqliteScalar(
        dbPath,
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='user';",
    )
    if (hasTable !== '1') return false
    const escaped = username.replace(/'/g, "''")
    return sqliteScalar(dbPath, `SELECT 1 FROM "user" WHERE username='${escaped}' LIMIT 1;`) === '1'
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

        // Each measurement directory carries its own self-contained migration
        // history next to its app.db so its alembic revisions stay valid even
        // when the repo's migrations evolve independently. Seed it from the
        // repo's copy on first init.
        const projectMigrationsDir = path.join(absDir, 'migrations')
        if (!fsSync.existsSync(projectMigrationsDir)) {
            fsSync.cpSync(MIGRATIONS_DIR, projectMigrationsDir, {
                recursive: true,
                filter: (src) => !src.includes('__pycache__'),
            })
        } else {
            // ...but a directory seeded earlier must still learn about
            // migrations added upstream since, or its app.db can never gain the
            // columns the current models expect — the server then starts and
            // fails on every query touching them. Copy in only the revision
            // files it does not already have: existing ones are left untouched,
            // so a history that diverged locally is preserved.
            copyNewMigrations(MIGRATIONS_DIR, projectMigrationsDir)
        }

        // Fast path: if the DB is already present and stamped at the current
        // migration head, there's nothing for check_db.sh to do. Detect that
        // with a couple of cheap sqlite3 reads and skip the (much slower)
        // conda-wrapped 'flask db upgrade' entirely. Only when this probe is
        // inconclusive do we pay for the full check.
        const head = findMigrationHead(path.join(projectMigrationsDir, 'versions'))
        const dbReady = Boolean(head) && fsSync.existsSync(dbPath) && dbAtHead(dbPath, head!)

        if (!dbReady) {
            // Run check_db.sh against this measurement directory's app.db AND its
            // own migrations folder. The script handles fresh DBs, in-flight
            // migrations, legacy db.create_all DBs, and DBs stamped at revisions
            // that no longer exist in the migration history — all of which a bare
            // 'flask db upgrade' would crash on.
            const checkEnv: NodeJS.ProcessEnv = {
                ...env,
                DB_FILE: dbPath,
                MIGRATIONS_DIR: projectMigrationsDir,
            }
            const db = bashCommand(CHECK_DB_SCRIPT)
            const upgrade = spawnSync(
                db.command,
                db.args,
                {
                    cwd: SERVER_DIR,
                    env: envForEnvironment(checkEnv),
                    encoding: 'utf-8',
                    timeout: DB_STEP_TIMEOUT_MS,
                },
            )
            if (upgrade.error || upgrade.status !== 0) {
                return {
                    success: false,
                    error: `db upgrade failed: ${upgrade.error?.message || upgrade.stderr || upgrade.stdout || 'unknown error'}`,
                }
            }
        }

        // Fast path: if the default user row already exists, skip the
        // app-importing create-user script (its 'from app import create_app'
        // is the single most expensive step of startup). We only run it to
        // create the user the first time. A direct sqlite3 read avoids
        // importing Flask just to discover there's nothing to do.
        if (userExists(dbPath, DEFAULT_USER)) {
            return { success: true }
        }

        // Create the default user. set_password hashes DEFAULT_PASSWORD so the
        // configured credentials are authoritative for the initial login.
        const createUserScript = `
import sys
sys.path.insert(0, ${JSON.stringify(SERVER_DIR)})
from app import create_app, db
from app.models.user import User
app = create_app()
with app.app_context():
    user = User.query.filter_by(username=${JSON.stringify(DEFAULT_USER)}).first()
    if user is None:
        user = User(username=${JSON.stringify(DEFAULT_USER)}, email=${JSON.stringify(DEFAULT_USER + '@local')})
        db.session.add(user)
        action = 'user-created'
    else:
        action = 'user-password-reset'
    user.set_password(${JSON.stringify(DEFAULT_PASSWORD)})
    db.session.commit()
    print(action)
`
        const py = pythonCommand()
        const createUser = spawnSync(
            py.command,
            [...py.prefixArgs, '-c', createUserScript],
            {
                cwd: SERVER_DIR,
                env: envForEnvironment(env),
                encoding: 'utf-8',
                timeout: USER_STEP_TIMEOUT_MS,
            },
        )
        if (createUser.error || createUser.status !== 0) {
            return {
                success: false,
                error: `user creation failed: ${createUser.error?.message || createUser.stderr || createUser.stdout || 'unknown error'}`,
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

        // The server didn't answer the health probe above, but a crashed
        // previous instance may still be holding the port. Reap our own
        // leftovers (or report a foreign holder) before binding, so a stale
        // process can't force a full PC reboot to recover.
        const portCheck = await ensureBackendPortFree()
        if (!portCheck.ok) {
            return NextResponse.json({ success: false, error: portCheck.error }, { status: 409 })
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
                // The backend watches this PID and exits if we (the launcher) die,
                // so killing npm/Next always takes the backend down with it.
                LUNA_LAUNCHER_PID: String(process.pid),
            }
            // Use mock boards (no hardware) when running for debugging.
            if (testMode) env.TEST_FLAG = 'True'

            // Truncate log on each new launch and inherit the FD into the child
            // so it keeps writing even after a Next.js HMR reload.
            const logPath = path.join(absDir, LOG_FILENAME)
            const logFd = fsSync.openSync(logPath, 'w')
            try {
                const launcher = pythonCommand()
                const proc = spawn(
                    launcher.command,
                    [...launcher.prefixArgs, MAIN_PY],
                    {
                        cwd: absDir,
                        env: envForEnvironment(env),
                        detached: false,
                        stdio: ['ignore', logFd, logFd],
                    },
                )
                serverProcess = proc
                serverPid = proc.pid ?? null
                await writeState({ currentDirectory: absDir, lastDirectory: absDir, testMode })

                proc.on('exit', () => {
                    serverProcess = null
                    serverPid = null
                    // Keep lastDirectory so the logs from this (possibly failed)
                    // launch remain readable after the process is gone.
                    writeState({ currentDirectory: null, lastDirectory: absDir, testMode: false })
                })
                // Say which interpreter is running the backend, and warn now if
                // it cannot import what the backend needs. Started in the wrong
                // environment, the server comes up looking healthy and then
                // fails at the first run with a message about acquisition.
                const missing = missingModules()
                return NextResponse.json({
                    success: true,
                    pid: serverPid,
                    directory: absDir,
                    testMode,
                    logPath,
                    python: launcher.command,
                    ...(missing.length
                        ? {
                            warning:
                                `The interpreter running the server cannot import ${missing.join(', ')}. ` +
                                `It is ${launcher.command}. Runs will fail until the '${CONDA_ENV}' ` +
                                `environment is used — check that it exists and has the packages ` +
                                `(conda env update -f environment.yml).`,
                        }
                        : {}),
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
            // Preserve lastDirectory so the stopped server's logs stay readable.
            const prev = await readState()
            await writeState({ currentDirectory: null, lastDirectory: prev.lastDirectory, testMode: false })
            return NextResponse.json({ success: true })
        } catch (err: any) {
            return NextResponse.json({ success: false, error: err.message }, { status: 500 })
        }
    }

    return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 })
}
