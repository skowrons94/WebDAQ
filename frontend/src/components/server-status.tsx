'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Trash2, Plus, Play, Square, FolderOpen, FileText, FlaskConical, Loader2, AlertCircle } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Progress } from '@/components/ui/progress'

type WorkingDirectory = {
    id: string
    label: string
    path: string
}

export function ServerStatus() {
    const [connected, setConnected] = useState<boolean | null>(null)
    const [currentDirectory, setCurrentDirectory] = useState<string | null>(null)
    const [serverTestMode, setServerTestMode] = useState(false)
    const [open, setOpen] = useState(false)
    const [directories, setDirectories] = useState<WorkingDirectory[]>([])
    const [showAdd, setShowAdd] = useState(false)
    const [newLabel, setNewLabel] = useState('')
    const [newPath, setNewPath] = useState('')
    const [loading, setLoading] = useState(false)
    const [message, setMessage] = useState('')
    const [showLogs, setShowLogs] = useState(false)
    const [logs, setLogs] = useState('')
    const [logsTruncated, setLogsTruncated] = useState(false)
    // Whether the log view is pinned to the newest lines. False once the reader
    // scrolls up, which stops the poll from dragging them back to the bottom.
    const [followingTail, setFollowingTail] = useState(true)
    const [testModeOnLaunch, setTestModeOnLaunch] = useState(false)
    // Launch feedback: from the moment "Start" is clicked until the server
    // answers on its HTTP port (detected by the status poll) or errors out.
    const [launching, setLaunching] = useState(false)
    const [launchLabel, setLaunchLabel] = useState('')
    const [launchProgress, setLaunchProgress] = useState(0)
    const [launchError, setLaunchError] = useState('')
    const popoverRef = useRef<HTMLDivElement>(null)
    const logsRef = useRef<HTMLPreElement>(null)

    // Poll status every 3s
    useEffect(() => {
        const check = async () => {
            try {
                const res = await fetch('/api/server-control')
                const data = await res.json()
                setConnected(data.running)
                setCurrentDirectory(data.currentDirectory ?? null)
                setServerTestMode(Boolean(data.testMode))
            } catch {
                setConnected(false)
                setCurrentDirectory(null)
                setServerTestMode(false)
            }
        }
        check()
        const interval = setInterval(check, 3000)
        return () => clearInterval(interval)
    }, [])

    // Load saved directories on mount
    const loadDirectories = useCallback(async () => {
        try {
            const res = await fetch('/api/cache?type=working-directories')
            const data = await res.json()
            if (data.success && Array.isArray(data.data?.directories)) {
                setDirectories(data.data.directories)
            }
        } catch (e) {
            console.error('Failed to load working directories:', e)
        }
    }, [])

    useEffect(() => {
        loadDirectories()
    }, [loadDirectories])

    const persistDirectories = async (dirs: WorkingDirectory[]) => {
        setDirectories(dirs)
        try {
            await fetch('/api/cache', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'working-directories',
                    data: { directories: dirs },
                }),
            })
        } catch (e) {
            console.error('Failed to save working directories:', e)
        }
    }

    // Close popover on outside click
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
                setOpen(false)
            }
        }
        if (open) document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [open])

    // Detect when a launch finishes: the status poll flips `connected` true.
    useEffect(() => {
        if (launching && connected) {
            setLaunching(false)
            setLaunchProgress(100)
            setLaunchError('')
            setMessage('')
        }
    }, [launching, connected])

    // Ease an indeterminate-style progress bar toward ~90% while launching;
    // it only reaches 100% once the server actually answers (effect above).
    useEffect(() => {
        if (!launching) {
            setLaunchProgress(0)
            return
        }
        setLaunchProgress(8)
        // Tick every second (was 500ms) so the bar fills about half as fast.
        const id = setInterval(() => {
            setLaunchProgress((p) => (p < 90 ? p + Math.max(1, (90 - p) * 0.06) : p))
        }, 1000)
        return () => clearInterval(id)
    }, [launching])

    // Give up after a grace period and surface it as a likely error so the user
    // isn't left staring at a bar forever. Logs are already visible to diagnose.
    useEffect(() => {
        if (!launching) return
        const timeout = setTimeout(() => {
            setLaunching(false)
            setLaunchError(
                'Server did not come online within 90s. Check the logs below for errors.',
            )
            setShowLogs(true)
        }, 90000)
        return () => clearTimeout(timeout)
    }, [launching])

    // Poll logs while shown and the server is running or still launching.
    useEffect(() => {
        if (!showLogs || (!connected && !launching)) return
        let cancelled = false
        const tick = async () => {
            try {
                const res = await fetch('/api/server-control?logs=1')
                const data = await res.json()
                if (cancelled) return

                // Follow the tail only while the reader is already at the
                // bottom. Scrolling up means they are reading something, and
                // yanking them back down on the next poll (every 1.5 s) makes
                // the log impossible to read.
                const el = logsRef.current
                const STICK_TOLERANCE_PX = 40
                const wasAtBottom = !el ||
                    el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_TOLERANCE_PX

                setLogs(data.log || '')
                setLogsTruncated(Boolean(data.truncated))
                setFollowingTail(wasAtBottom)

                if (wasAtBottom) {
                    requestAnimationFrame(() => {
                        if (logsRef.current) {
                            logsRef.current.scrollTop = logsRef.current.scrollHeight
                        }
                    })
                }
            } catch {
                /* ignore */
            }
        }
        tick()
        const interval = setInterval(tick, 1500)
        return () => {
            cancelled = true
            clearInterval(interval)
        }
    }, [showLogs, connected, launching])

    // Track whether the reader is at the tail, so the poll knows whether to
    // follow it. Updated on scroll so the "jump to latest" hint appears at once
    // rather than on the next refresh.
    const STICK_TOLERANCE_PX = 40
    const handleLogScroll = () => {
        const el = logsRef.current
        if (!el) return
        setFollowingTail(el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_TOLERANCE_PX)
    }
    const jumpToLatest = () => {
        const el = logsRef.current
        if (!el) return
        el.scrollTop = el.scrollHeight
        setFollowingTail(true)
    }

    /** Label row above a log pane, with the follow state and a way back. */
    const logHeader = (label: string) => (
        <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] text-muted-foreground">{label}</p>
            {!followingTail && (
                <button
                    type="button"
                    onClick={jumpToLatest}
                    className="text-[10px] text-muted-foreground hover:text-foreground underline"
                >
                    paused — jump to latest
                </button>
            )}
        </div>
    )

    const startInDirectory = async (dir: WorkingDirectory) => {
        // Flip into the launching view immediately — the start request itself
        // (db upgrade + user creation, run synchronously server-side) can take a
        // few seconds before it even returns, so the user needs feedback now.
        setLaunchLabel(dir.label)
        setLaunchError('')
        setLaunching(true)
        setShowLogs(true)
        setMessage('')
        try {
            const res = await fetch('/api/server-control', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'start',
                    directory: dir.path,
                    testMode: testModeOnLaunch,
                }),
            })
            const data = await res.json()
            if (!data.success) {
                setLaunching(false)
                setLaunchError(data.error || 'Failed to start the server.')
            }
            // On success we stay in the launching state; the status poll detects
            // when the server is actually online and clears it.
        } catch (e: any) {
            setLaunching(false)
            setLaunchError(e?.message || 'Error communicating with launcher')
        }
    }

    const handleStop = async () => {
        setLoading(true)
        setMessage('')
        try {
            const res = await fetch('/api/server-control', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'stop' }),
            })
            const data = await res.json()
            if (!data.success) setMessage(data.error || 'Failed to stop')
        } catch (e: any) {
            setMessage(e?.message || 'Error')
        }
        setLoading(false)
    }

    const addDirectory = async () => {
        const label = newLabel.trim()
        const dirPath = newPath.trim()
        if (!label || !dirPath) return
        const next: WorkingDirectory[] = [
            ...directories,
            { id: `wd_${Date.now()}`, label, path: dirPath },
        ]
        await persistDirectories(next)
        setNewLabel('')
        setNewPath('')
        setShowAdd(false)
    }

    const deleteDirectory = async (id: string) => {
        await persistDirectories(directories.filter((d) => d.id !== id))
    }

    const dotColor = launching
        ? 'bg-amber-500 shadow-[0_0_6px_2px_rgba(245,158,11,0.4)] animate-pulse'
        : connected === null
            ? 'bg-gray-400'
            : connected
                ? 'bg-green-500 shadow-[0_0_6px_2px_rgba(34,197,94,0.4)]'
                : 'bg-red-500 shadow-[0_0_6px_2px_rgba(239,68,68,0.4)]'

    const label = launching
        ? 'Launching…'
        : connected === null
            ? 'Checking…'
            : connected
                ? 'DAQ Server Online'
                : 'DAQ Server Offline'

    const activeDir = currentDirectory
        ? directories.find((d) => d.path === currentDirectory)
        : null

    return (
        <div className="relative" ref={popoverRef}>
            <button
                onClick={() => {
                    setOpen(!open)
                    setMessage('')
                }}
                title={currentDirectory ? `${label} — ${currentDirectory}` : label}
                className="flex items-center gap-2 px-2 py-1 rounded hover:bg-muted transition-colors"
            >
                <span className={`inline-block w-2.5 h-2.5 rounded-full ${dotColor}`} />
                <span className="text-xs text-muted-foreground hidden sm:inline">
                    {label}
                    {connected && activeDir ? ` · ${activeDir.label}` : ''}
                </span>
            </button>

            {open && (
                <div className="absolute right-0 top-full mt-2 w-[26rem] max-w-[calc(100vw-1rem)] rounded-lg border bg-background shadow-lg p-4 z-50">
                    {launching ? (
                        <div className="space-y-3">
                            <div className="flex items-center gap-2">
                                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                                <p className="text-sm font-medium">Launching DAQ server…</p>
                            </div>
                            <p className="text-xs text-muted-foreground">
                                Starting in <span className="font-medium">{launchLabel}</span>
                                {testModeOnLaunch ? ' (test mode)' : ''}. Initializing the
                                database and creating the user — this can take up to
                                a minute.
                            </p>
                            <Progress value={launchProgress} className="h-2" />
                            <div className="space-y-1">
                                {logHeader('Live server log:')}
                                <pre
                                    ref={logsRef}
                                    onScroll={handleLogScroll}
                                    className="text-[10px] leading-tight font-mono whitespace-pre-wrap break-words bg-muted/40 border rounded p-2 max-h-72 overflow-auto"
                                >
                                    {logs || 'Waiting for output…'}
                                </pre>
                            </div>
                        </div>
                    ) : connected ? (
                        <div className="space-y-3">
                            <div>
                                <div className="flex items-center gap-2">
                                    <p className="text-sm font-medium">Server is running</p>
                                    {serverTestMode && (
                                        <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                                            <FlaskConical className="h-3 w-3" />
                                            TEST MODE
                                        </span>
                                    )}
                                </div>
                                {currentDirectory && (
                                    <p className="text-xs text-muted-foreground font-mono break-all">
                                        {activeDir ? `${activeDir.label} · ` : ''}
                                        {currentDirectory}
                                    </p>
                                )}
                            </div>
                            <div className="flex gap-2">
                                <Button
                                    variant="destructive"
                                    size="sm"
                                    className="flex-1"
                                    onClick={handleStop}
                                    disabled={loading}
                                >
                                    <Square className="h-3.5 w-3.5 mr-1.5" />
                                    {loading ? 'Stopping…' : 'Stop server'}
                                </Button>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setShowLogs((v) => !v)}
                                >
                                    <FileText className="h-3.5 w-3.5 mr-1.5" />
                                    {showLogs ? 'Hide logs' : 'Show logs'}
                                </Button>
                            </div>
                            {showLogs && (
                                <div className="space-y-1">
                                    {logHeader(logsTruncated
                                        ? 'Showing the latest 200 KB of server.log'
                                        : 'Server log:')}
                                    <pre
                                        ref={logsRef}
                                        onScroll={handleLogScroll}
                                        className="text-[10px] leading-tight font-mono whitespace-pre-wrap break-words bg-muted/40 border rounded p-2 max-h-72 overflow-auto"
                                    >
                                        {logs || 'No output yet…'}
                                    </pre>
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className="space-y-3">
                            <p className="text-sm font-medium">Start an Experiment</p>
                            {launchError && (
                                <div className="space-y-1.5">
                                    <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
                                        <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                                        <span className="break-words">{launchError}</span>
                                    </div>
                                    {logs && (
                                        <pre className="text-[10px] leading-tight font-mono whitespace-pre-wrap break-words bg-muted/40 border rounded p-2 max-h-48 overflow-auto">
                                            {logs}
                                        </pre>
                                    )}
                                </div>
                            )}
                            <p className="text-xs text-muted-foreground">
                                Pick a saved working directory or add a new one. The DAQ server runs
                                in the chosen directory; conf/, calib/, data/ and the database are
                                created there on first launch.
                            </p>

                            <label className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 cursor-pointer">
                                <Checkbox
                                    checked={testModeOnLaunch}
                                    onCheckedChange={(c) => setTestModeOnLaunch(Boolean(c))}
                                />
                                <FlaskConical className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                                <div className="flex flex-col">
                                    <span className="text-xs font-medium">Test Mode</span>
                                    <span className="text-[10px] text-muted-foreground">
                                        Use mock boards — for debugging without hardware.
                                    </span>
                                </div>
                            </label>

                            <div className="space-y-1.5 max-h-56 overflow-y-auto">
                                {directories.length === 0 && (
                                    <p className="text-xs text-muted-foreground italic">
                                        No saved directories yet.
                                    </p>
                                )}
                                {directories.map((dir) => (
                                    <div
                                        key={dir.id}
                                        className="flex items-center gap-2 rounded-md border bg-card/50 p-2 hover:bg-muted/40 transition-colors"
                                    >
                                        <FolderOpen className="h-4 w-4 text-muted-foreground shrink-0" />
                                        <div className="flex flex-col min-w-0 flex-1">
                                            <span className="text-sm font-medium truncate">
                                                {dir.label}
                                            </span>
                                            <span
                                                className="text-[10px] text-muted-foreground font-mono truncate"
                                                title={dir.path}
                                            >
                                                {dir.path}
                                            </span>
                                        </div>
                                        <Button
                                            size="sm"
                                            variant="default"
                                            onClick={() => startInDirectory(dir)}
                                            disabled={loading || launching}
                                            className="h-7 px-2"
                                        >
                                            <Play className="h-3 w-3 mr-1" />
                                            Start
                                        </Button>
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            onClick={() => deleteDirectory(dir.id)}
                                            className="h-7 w-7 text-destructive hover:text-destructive"
                                            title="Remove from list"
                                        >
                                            <Trash2 className="h-3.5 w-3.5" />
                                        </Button>
                                    </div>
                                ))}
                            </div>

                            {showAdd ? (
                                <div className="space-y-2 rounded-md border p-2">
                                    <Input
                                        placeholder="Label (e.g. 12C12C/14N_pg/19F_pg)"
                                        value={newLabel}
                                        onChange={(e) => setNewLabel(e.target.value)}
                                        className="text-xs h-8"
                                    />
                                    <Input
                                        placeholder="/absolute/path/to/working/dir"
                                        value={newPath}
                                        onChange={(e) => setNewPath(e.target.value)}
                                        onKeyDown={(e) => e.key === 'Enter' && addDirectory()}
                                        className="text-xs h-8 font-mono"
                                    />
                                    <div className="flex gap-2">
                                        <Button
                                            size="sm"
                                            onClick={addDirectory}
                                            disabled={!newLabel.trim() || !newPath.trim()}
                                            className="flex-1 h-7"
                                        >
                                            Save
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => {
                                                setShowAdd(false)
                                                setNewLabel('')
                                                setNewPath('')
                                            }}
                                            className="h-7"
                                        >
                                            Cancel
                                        </Button>
                                    </div>
                                </div>
                            ) : (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setShowAdd(true)}
                                    className="w-full h-8"
                                >
                                    <Plus className="h-3.5 w-3.5 mr-1.5" />
                                    Add working directory
                                </Button>
                            )}
                        </div>
                    )}

                    {message && (
                        <p className="text-xs text-muted-foreground mt-2 break-words">{message}</p>
                    )}
                </div>
            )}
        </div>
    )
}
