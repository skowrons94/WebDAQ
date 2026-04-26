'use client'

import { useState, useEffect, useRef } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

export function ServerStatus() {
    const [connected, setConnected] = useState<boolean | null>(null)
    const [open, setOpen] = useState(false)
    const [directory, setDirectory] = useState('')
    const [loading, setLoading] = useState(false)
    const [message, setMessage] = useState('')
    const popoverRef = useRef<HTMLDivElement>(null)

    // Poll server status every 3 seconds
    useEffect(() => {
        const check = async () => {
            try {
                const res = await fetch('/api/server-control')
                const data = await res.json()
                setConnected(data.running)
            } catch {
                setConnected(false)
            }
        }
        check()
        const interval = setInterval(check, 3000)
        return () => clearInterval(interval)
    }, [])

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

    const handleStart = async () => {
        setLoading(true)
        setMessage('')
        try {
            const res = await fetch('/api/server-control', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'start', directory }),
            })
            const data = await res.json()
            if (data.success) {
                setMessage('Starting…')
                setOpen(false)
            } else {
                setMessage(data.error || 'Failed to start')
            }
        } catch {
            setMessage('Error communicating with Next.js API')
        }
        setLoading(false)
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
            if (data.success) {
                setOpen(false)
            } else {
                setMessage(data.error || 'Failed to stop')
            }
        } catch {
            setMessage('Error')
        }
        setLoading(false)
    }

    const dotColor =
        connected === null
            ? 'bg-gray-400'
            : connected
            ? 'bg-green-500 shadow-[0_0_6px_2px_rgba(34,197,94,0.4)]'
            : 'bg-red-500 shadow-[0_0_6px_2px_rgba(239,68,68,0.4)]'

    const label =
        connected === null ? 'Checking…' : connected ? 'DAQ Server Online' : 'DAQ Server Offline'

    return (
        <div className="relative" ref={popoverRef}>
            <button
                onClick={() => { setOpen(!open); setMessage('') }}
                title={label}
                className="flex items-center gap-2 px-2 py-1 rounded hover:bg-muted transition-colors"
            >
                <span className={`inline-block w-2.5 h-2.5 rounded-full ${dotColor}`} />
                <span className="text-xs text-muted-foreground hidden sm:inline">{label}</span>
            </button>

            {open && (
                <div className="absolute right-0 top-full mt-2 w-72 rounded-lg border bg-background shadow-lg p-4 z-50">
                    {connected ? (
                        <div className="space-y-3">
                            <p className="text-sm font-medium">Server is running</p>
                            <Button
                                variant="destructive"
                                size="sm"
                                className="w-full"
                                onClick={handleStop}
                                disabled={loading}
                            >
                                {loading ? 'Stopping…' : 'Stop server'}
                            </Button>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            <p className="text-sm font-medium">Start server</p>
                            <p className="text-xs text-muted-foreground">
                                Working directory — conf/, data/, calib/ will be created here.
                            </p>
                            <Input
                                placeholder="/path/to/working/directory"
                                value={directory}
                                onChange={e => setDirectory(e.target.value)}
                                onKeyDown={e => e.key === 'Enter' && directory && handleStart()}
                                className="text-xs"
                            />
                            <Button
                                size="sm"
                                className="w-full"
                                onClick={handleStart}
                                disabled={loading || !directory}
                            >
                                {loading ? 'Starting…' : 'Start server'}
                            </Button>
                        </div>
                    )}
                    {message && (
                        <p className="text-xs text-muted-foreground mt-2">{message}</p>
                    )}
                </div>
            )}
        </div>
    )
}
