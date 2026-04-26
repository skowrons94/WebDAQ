'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Trash2, Plus, Play, Square, FolderOpen, FileText, FlaskConical } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'

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
    const [busyId, setBusyId] = useState<string | null>(null)
    const [message, setMessage] = useState('')
    const [showLogs, setShowLogs] = useState(false)
    const [logs, setLogs] = useState('')
    const [logsTruncated, setLogsTruncated] = useState(false)
    const [testModeOnLaunch, setTestModeOnLaunch] = useState(false)
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

    // Poll logs while shown and server is running
    useEffect(() => {
        if (!showLogs || !connected) return
        let cancelled = false
        const tick = async () => {
            try {
                const res = await fetch('/api/server-control?logs=1')
                const data = await res.json()
                if (cancelled) return
                setLogs(data.log || '')
                setLogsTruncated(Boolean(data.truncated))
                // Autoscroll to bottom
                requestAnimationFrame(() => {
                    if (logsRef.current) {
                        logsRef.current.scrollTop = logsRef.current.scrollHeight
                    }
                })
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
    }, [showLogs, connected])

    const startInDirectory = async (dir: WorkingDirectory) => {
        setBusyId(dir.id)
        setLoading(true)
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
            if (data.success) {
                setMessage(
                    `Starting in ${dir.label}${testModeOnLaunch ? ' (test mode)' : ''}…`,
                )
            } else {
                setMessage(data.error || 'Failed to start')
            }
        } catch (e: any) {
            setMessage(e?.message || 'Error communicating with launcher')
        }
        setLoading(false)
        setBusyId(null)
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

    const dotColor =
        connected === null
            ? 'bg-gray-400'
            : connected
                ? 'bg-green-500 shadow-[0_0_6px_2px_rgba(34,197,94,0.4)]'
                : 'bg-red-500 shadow-[0_0_6px_2px_rgba(239,68,68,0.4)]'

    const label =
        connected === null
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
                    {connected ? (
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
                                    {logsTruncated && (
                                        <p className="text-[10px] text-muted-foreground">
                                            Showing the latest 200 KB of server.log
                                        </p>
                                    )}
                                    <pre
                                        ref={logsRef}
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
                                        Skip XDAQ / CAEN components — for debugging without hardware.
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
                                            disabled={loading}
                                            className="h-7 px-2"
                                        >
                                            {busyId === dir.id ? (
                                                'Starting…'
                                            ) : (
                                                <>
                                                    <Play className="h-3 w-3 mr-1" />
                                                    Start
                                                </>
                                            )}
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
