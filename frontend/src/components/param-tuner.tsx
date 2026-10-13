'use client'

import { useRunStatus, noteRunAction } from '@/hooks/use-run-status'
import useRunControlStore from '@/store/run-control-store'
import { markTunerRunStarted, rememberTunerSaveFlag, restoreTunerSaveFlag, tunerOwnsRun, tunerRunRecordStarted } from '@/lib/tuner-save'
import { applySetting as applySettingRaw, getStartTime } from '@/lib/api'
import { StatusBadge } from '@/components/ui/status-badge'
import React, { useState, useEffect, useMemo, useRef } from 'react'
import {
  getBoardConfiguration,
  getBoardSettings,
  applySetting,
  getOnlineRegisters,
  startRun,
  stopRun,
  getSaveData,
  setSaveData,
} from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/use-toast'
import { Zap } from 'lucide-react'
import { loadJSROOT } from '@/lib/load-jsroot'
import { ControlsPanel, findRegKey, type BoardSettings } from '@/components/tuner/controls-panel'
import { HealthStrip } from '@/components/tuner/health-strip'
import { WaveformPanel } from '@/components/tuner/waveform-panel'
import { SpectrumPanel } from '@/components/tuner/spectrum-panel'
import { useChannelRates } from '@/components/tuner/use-channel-rates'
import { baseAddress, boardTiming, getBits, toDisplay } from '@/components/tuner/units'
import { recoverInterruptedScan } from '@/components/tuner/scan-engine'
import dynamic from 'next/dynamic'

// Scans (and the fit code they use) load only when a scan can run.
const ThresholdScan = dynamic(() => import('@/components/tuner/threshold-scan'), {
  ssr: false,
  loading: () => <p className="text-sm text-muted-foreground">Loading the scan…</p>,
})

type BoardData = {
  id: string
  name: string
  vme: string
  link_type: string
  link_num: string
  dpp: string
  chan: string
}

const ONLINE_KEY = 'lunadaq:tuner-online'

export default function ParamTuner() {
  const [boards, setBoards] = useState<BoardData[]>([])
  const [selectedBoardId, setSelectedBoardId] = useState<string>('')
  const [selectedChannel, setSelectedChannel] = useState<number>(0)
  const [settings, setSettings] = useState<BoardSettings>({})
  // Unsaved register values (raw), keyed by register key; written by "Save all".
  const [pending, setPending] = useState<Record<string, number>>({})
  const [isAcquiring, setIsAcquiring] = useState(false)
  const [jsrootLoaded, setJsrootLoaded] = useState(false)
  const [refreshTick, setRefreshTick] = useState(0)
  const [measuredBaseline, setMeasuredBaseline] = useState<number | null>(null)
  // From the app's shared run-status poller (hooks/use-run-status.ts).
  const isRunning = useRunStatus((s) => s.isRunning)
  // Online mode: write each change to the board as well as to its configuration,
  // so the effect shows up in the trace and the spectrum straight away. Off by
  // default — a session that only edits the configuration must stay possible.
  // Kept for the browser tab, so leaving the page and coming back keeps it.
  const [online, setOnlineState] = useState(false)
  useEffect(() => {
    try { setOnlineState(window.sessionStorage.getItem(ONLINE_KEY) === '1') } catch { /* default off */ }
  }, [])
  const setOnline = (v: boolean) => {
    setOnlineState(v)
    try { window.sessionStorage.setItem(ONLINE_KEY, v ? '1' : '0') } catch { /* tab-only setting */ }
  }
  // Registers this board accepts while acquiring, keyed by address ("0x106C").
  const [onlineRegisters, setOnlineRegisters] = useState<Record<string, string>>({})
  const { toast } = useToast()

  // --- Derived values ---
  // Compare as strings: the id is a number in the server's JSON and a string
  // everywhere in the UI.
  const selectedBoard = boards.find(b => String(b.id) === String(selectedBoardId))
  const channelCount = selectedBoard ? Number(selectedBoard.chan) || 0 : 0
  const dpp = selectedBoard?.dpp ?? 'DPP-PHA'
  const isPSD = dpp.toUpperCase().includes('PSD')
  const timing = useMemo(() => boardTiming(selectedBoard?.name ?? ''), [selectedBoard?.name])

  const boardConfigKey = Object.entries(settings).find(([, r]) => parseInt(r.address, 16) === 0x8000)?.[0] ?? null
  const boardConfigValue = boardConfigKey ? (pending[boardConfigKey] ?? settings[boardConfigKey].value_dec) : null

  /** A channel register's current (pending or saved) raw value, by channel-0 address. */
  const reg = (address: number): number | null => {
    const k = findRegKey(settings, selectedChannel, address)
    return k ? (pending[k] ?? settings[k].value_dec) : null
  }
  const algo = reg(0x1080)
  const negative = algo !== null && getBits(algo, [16, 16]) === 1
  const recordRaw = reg(0x1020)
  const preRaw = reg(0x1038)
  const riseNs = !isPSD && reg(0x105c) !== null ? toDisplay(reg(0x105c)!, 'step', timing) : null
  const flatNs = !isPSD && reg(0x1060) !== null ? toDisplay(reg(0x1060)!, 'step', timing) : null
  const peakHoldNs = !isPSD && reg(0x1078) !== null ? toDisplay(reg(0x1078)!, 'step', timing) : 0
  const longGateNs = isPSD && reg(0x1058) !== null ? toDisplay(reg(0x1058)!, 'sample', timing) : 0
  // The window in which a second pulse piles up (design §P2).
  const pileupWindowNs = isPSD ? longGateNs : Math.max(2 * (riseNs ?? 0) + (flatNs ?? 0), peakHoldNs)

  const rates = useChannelRates(selectedBoardId, selectedChannel, isRunning)

  // Spectrum restarts ("since last change") each time a change reaches the board.
  const [changeMark, setChangeMark] = useState(0)
  const [changeLabel, setChangeLabel] = useState<string | null>(null)
  const noteBoardChange = (label: string) => { setChangeLabel(label); setChangeMark((m) => m + 1) }
  // A scan is writing to the board: the rest of the page waits.
  const [scanBusy, setScanBusy] = useState(false)

  // --- Effects ---

  // Load boards on mount
  useEffect(() => {
    const init = async () => {
      try {
        const res = await getBoardConfiguration()
        // The server sends the id as a number, and board 0 is the usual case.
        // Left as a number it is falsy, so every "no board selected yet" guard
        // below treats a perfectly good board as no board and the page stays
        // empty; it also never matches the string the Select hands back. Make
        // every id a string at the boundary and the rest can stop caring.
        const boardList: BoardData[] = (res.data ?? []).map((board: BoardData) => ({
          ...board,
          id: String(board.id),
        }))
        setBoards(boardList)
        if (boardList.length > 0) setSelectedBoardId(boardList[0].id)
      } catch {
        toast({ title: 'Error', description: 'Failed to load boards', variant: 'destructive' })
      }
    }
    init()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Load settings when board changes
  useEffect(() => {
    if (!selectedBoardId) return
    setSelectedChannel(0)
    setPending({})
    const load = async () => {
      try {
        const data = await getBoardSettings(selectedBoardId)
        setSettings(data)
      } catch (error) {
        // A board with no register file (config deleted, never read from the
        // hardware) is the usual cause, and "failed to load" hides that.
        const serverMessage =
          (error as { response?: { data?: { message?: string } } })?.response?.data?.message
        setSettings({})
        toast({
          title: 'No settings for this board',
          description: serverMessage
            ? `${serverMessage} Restart the server to re-read the board, or remove and re-add it.`
            : 'Failed to load board settings',
          variant: 'destructive',
        })
      }
      try {
        setOnlineRegisters((await getOnlineRegisters(selectedBoardId)).registers)
      } catch {
        setOnlineRegisters({})
      }
    }
    load()
  }, [selectedBoardId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load JSROOT
  useEffect(() => {
    loadJSROOT()
      .then(() => setJsrootLoaded(true))
      .catch(() =>
        toast({ title: 'Error', description: 'Failed to load JSROOT', variant: 'destructive' })
      )
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // The Tuner's own acquisition ended elsewhere (stopped from the Dashboard,
  // or by a reset): it is no longer the Tuner's to stop.
  const sawOwnRun = useRef(false)
  useEffect(() => {
    if (!isAcquiring) { sawOwnRun.current = false; return }
    if (isRunning) sawOwnRun.current = true
    else if (sawOwnRun.current) {
      // Ended elsewhere: data saving is put back by whoever saw the stop
      // (lib/tuner-save.ts); make sure of it here too.
      setIsAcquiring(false)
      void restoreTunerSaveFlag()
    }
  }, [isRunning, isAcquiring])

  // After a reload, a Tuner acquisition still going is still the Tuner's --
  // but only the very run it started (same server start time). A record left
  // by an older Tuner run never makes a production run stoppable from here.
  const runKnown = useRunStatus((s) => s.known)
  const runStartTime = useRunStatus((s) => s.startTime)
  useEffect(() => {
    if (runKnown && isRunning && tunerOwnsRun(runStartTime)) setIsAcquiring(true)
  }, [runKnown, isRunning, runStartTime])

  // Scans and other automatic writes: only in the run the Tuner started itself.
  const tunerLive = runKnown && isRunning && isAcquiring && tunerOwnsRun(runStartTime)
  const tunerLiveRef = useRef(tunerLive)
  tunerLiveRef.current = tunerLive
  const isTunerLive = () => tunerLiveRef.current

  // A scan cut short by a reload or a closed tab: put its starting values back.
  const recovered = useRef(false)
  useEffect(() => {
    if (!runKnown || recovered.current) return
    recovered.current = true
    void recoverInterruptedScan(() => tunerLiveRef.current).then(async (name) => {
      if (!name) return
      toast({ title: `${name} was interrupted`, description: 'The values it started from are back in the configuration.' })
      if (selectedBoardId) {
        try { setSettings(await getBoardSettings(selectedBoardId)) } catch { /* keep what is shown */ }
      }
    })
  }, [runKnown]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh tick
  useEffect(() => {
    if (!jsrootLoaded || !selectedBoardId) return
    const interval = setInterval(() => setRefreshTick(t => t + 1), 2000)
    return () => clearInterval(interval)
  }, [jsrootLoaded, selectedBoardId])

  // --- Handlers ---

  const [busy, setBusy] = useState(false)
  const handleStart = async () => {
    if (busy) return
    setBusy(true)
    try {
      // Kept outside this component (lib/tuner-save.ts): however this
      // acquisition ends, saving is put back.
      const original = Boolean(await getSaveData())
      rememberTunerSaveFlag(original)
      await setSaveData(false)
      try {
        await startRun()
      } catch (error) {
        await restoreTunerSaveFlag({ evenIfNotStarted: true })
        throw error
      }
      // Set the state here; the shared poll catches up (never awaited: a
      // hung poll must not keep the Tuner from knowing its own run).
      useRunControlStore.getState().setIsRunning(true)
      noteRunAction()
      // The server's start time identifies this run (for a reload, and so an
      // old record can never claim another run). Read with a deadline.
      const startTime = await Promise.race([
        getStartTime().then((t: unknown) => (typeof t === 'string' ? t : null)).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
      ])
      markTunerRunStarted(startTime)
      setIsAcquiring(true)
      toast({ title: 'Started', description: 'Acquisition started (data saving disabled)' })
    } catch {
      toast({ title: 'Error', description: 'Failed to start acquisition', variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  // Stops only the acquisition the Tuner started itself (isAcquiring): a
  // production run started from the Dashboard is never the Tuner's to stop.
  const handleStop = async () => {
    if (!isAcquiring || busy) return
    setBusy(true)
    try {
      await stopRun()
      useRunControlStore.getState().setIsRunning(false)
      noteRunAction()
      const restored = await restoreTunerSaveFlag()
      setIsAcquiring(false)
      if (restored === null && tunerRunRecordStarted()) {
        toast({ title: 'Data saving not restored', description: 'Check "Save to disk" on the Dashboard before the next run.', variant: 'destructive' })
      }
      toast({ title: 'Stopped', description: 'Acquisition stopped' })
    } catch {
      toast({ title: 'Error', description: 'Failed to stop acquisition', variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  // Whether a register can be written to a live board — the allowlist is keyed
  // by the channel-0 form of the address (0x1A6C -> 0x106C).
  const isOnlineTunable = (regKey: string): boolean => {
    const r = settings[regKey]
    if (!r) return false
    return `0x${baseAddress(r.address).toString(16).toUpperCase().padStart(4, '0')}` in onlineRegisters
  }

  /**
   * Write one register: always to the configuration, and in Online mode to the
   * board too. Returns true when the value was stored, so callers can update
   * their local copy; a refused *board* write still counts as stored, and says
   * why in a toast.
   */
  const applyRegister = async (regKey: string, rawValue: number, label: string): Promise<boolean> => {
    try {
      const result = await applySetting(selectedBoardId, regKey, rawValue, online)
      if (online && !result.written && result.reason) {
        toast({ title: `${label}: saved, not sent to the board`, description: result.reason })
      }
      return true
    } catch (error) {
      const serverMessage =
        (error as { response?: { data?: { message?: string } } })?.response?.data?.message
      toast({
        title: `Failed to update ${label}`,
        description: serverMessage ?? 'The server did not accept the change.',
        variant: 'destructive',
      })
      return false
    }
  }

  const storeLocal = (regKey: string, rawValue: number) => {
    setSettings(prev => {
      const r = prev[regKey]
      if (!r) return prev
      return { ...prev, [regKey]: { ...r, value_dec: rawValue, value_hex: `0x${(rawValue >>> 0).toString(16).toUpperCase()}` } }
    })
  }

  // Trace and probe selection (Board Configuration): written at once, as before.
  const handleBoardConfigChange = async (newValue: number, label: string) => {
    if (!boardConfigKey) return
    if (!(await applyRegister(boardConfigKey, newValue, label))) return
    storeLocal(boardConfigKey, newValue)
    setPending(prev => { const n = { ...prev }; delete n[boardConfigKey]; return n })
  }

  const handleChange = (regKey: string, newRaw: number) => {
    setPending(prev => {
      const n = { ...prev }
      if (settings[regKey] && settings[regKey].value_dec === newRaw) delete n[regKey]
      else n[regKey] = newRaw
      return n
    })
  }

  const handleSaveAll = async () => {
    const entries = Object.entries(pending)
    if (entries.length === 0) return
    let savedCount = 0
    let writtenCount = 0
    for (const [regKey, rawVal] of entries) {
      const r = settings[regKey]
      if (!(await applyRegister(regKey, rawVal, r?.name ?? regKey))) continue
      if (online && isOnlineTunable(regKey)) writtenCount++
      storeLocal(regKey, rawVal)
      setPending(prev => { const n = { ...prev }; delete n[regKey]; return n })
      savedCount++
    }
    if (writtenCount > 0 && isRunning) {
      noteBoardChange(entries.map(([k]) => settings[k]?.name ?? k).slice(0, 3).join(', ') + (entries.length > 3 ? '…' : ''))
    }
    if (savedCount > 0) {
      toast({
        title: 'Saved',
        description: online
          ? `${savedCount} setting(s) saved, ${writtenCount} written to the board`
          : `${savedCount} setting(s) saved`,
      })
    }
  }

  const pendingCount = Object.keys(pending).length

  /** A scan's suggestion, applied as one change: to the board in the Tuner's run. */
  const applyFromScan = async (regKey: string, raw: number, label: string) => {
    try {
      const r = await applySettingRaw(selectedBoardId, regKey, raw, tunerLiveRef.current)
      storeLocal(regKey, raw)
      setPending(prev => { const n = { ...prev }; delete n[regKey]; return n })
      if (r.written) noteBoardChange(label)
      toast({ title: 'Applied', description: r.written ? `${label} (on the board now)` : `${label} (from the next run)` })
    } catch {
      toast({ title: 'Not applied', description: `${label}: the server did not accept the change.`, variant: 'destructive' })
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <Label className="text-sm font-medium">Board</Label>
          <Select value={selectedBoardId} onValueChange={setSelectedBoardId} disabled={scanBusy}>
            <SelectTrigger className="w-52 max-w-full" aria-label="Board">
              <SelectValue placeholder="Select board..." />
            </SelectTrigger>
            <SelectContent>
              {boards.map(b => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name} (ID: {b.id}) · {b.dpp}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <Label className="text-sm font-medium">Channel</Label>
          <Select
            disabled={scanBusy}
            value={selectedChannel.toString()}
            onValueChange={v => {
              setSelectedChannel(parseInt(v))
              setPending({})
              setMeasuredBaseline(null)
            }}
          >
            <SelectTrigger className="w-36" aria-label="Channel">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: channelCount }, (_, i) => (
                <SelectItem key={i} value={i.toString()}>
                  Channel {i}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button
          onClick={handleStart}
          disabled={isAcquiring || isRunning || !runKnown || busy || scanBusy}
          variant="success"
        >
          Start
        </Button>
        <Button
          onClick={handleStop}
          disabled={!isAcquiring}
          variant="destructive"
          title={isRunning && !isAcquiring ? 'A run started from the Dashboard is in progress: stop it there' : undefined}
        >
          Stop
        </Button>

        <StatusBadge state={isRunning ? 'running' : 'stopped'} label={isAcquiring ? 'Tuning' : undefined} />
        {isRunning && !isAcquiring && (
          <span className="text-xs text-muted-foreground">
            Production run: stop it from the Dashboard. Changes follow the usual rules.
          </span>
        )}
        {isAcquiring && (
          <Badge variant="outline" className="text-warning border-warning">
            Tuner run · not saved to disk
          </Badge>
        )}

        {/* Online mode: changes go to the board as well as to its configuration.
            Only the parameters that are safe to move during acquisition are sent;
            the rest are saved and applied at the next run. */}
        <div className="ml-auto flex items-center gap-2 rounded-md border px-3 py-1.5">
          <Zap className={`h-4 w-4 ${online ? 'text-success' : 'text-muted-foreground'}`} />
          <Label htmlFor="tuner-online" className="text-sm font-medium">Online</Label>
          <Switch id="tuner-online" checked={online} onCheckedChange={setOnline} />
          <span className="text-xs text-muted-foreground max-w-[16rem]">
            {online
              ? isRunning
                ? 'Safe parameters go straight to the board'
                : 'Written to the board; the run applies the whole configuration anyway'
              : 'Changes are saved to the configuration only'}
          </span>
        </div>
      </div>

      <HealthStrip rates={rates.now} windowNs={pileupWindowNs} psd={isPSD} running={isRunning} />

      {/* Main content: waveform (left) + settings (right) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {selectedBoardId ? (
          <WaveformPanel
            boardId={selectedBoardId}
            dpp={dpp}
            channel={selectedChannel}
            timing={timing}
            jsrootLoaded={jsrootLoaded}
            refreshTick={refreshTick}
            running={isRunning}
            online={online}
            boardConfig={boardConfigValue}
            onBoardConfigChange={handleBoardConfigChange}
            preSamples={preRaw !== null ? preRaw * 4 : null}
            recordSamples={recordRaw !== null ? recordRaw * 8 : null}
            riseNs={riseNs}
            flatNs={flatNs}
            negative={negative}
            onBaseline={setMeasuredBaseline}
          />
        ) : <Card><CardContent className="py-10 text-sm text-muted-foreground">No board configured: add one on the Boards page.</CardContent></Card>}

        {/* Settings panel */}
        <Card>
          <CardHeader>
            <CardTitle>Settings — Ch {selectedChannel} <span className="text-sm font-normal text-muted-foreground">{dpp}</span></CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <ControlsPanel
              dpp={dpp}
              channel={selectedChannel}
              timing={timing}
              settings={settings}
              pending={pending}
              onChange={handleChange}
              online={online}
              isOnlineTunable={isOnlineTunable}
              measuredBaseline={measuredBaseline}
            />
            <div className="flex items-center justify-end gap-2 border-t pt-4">
              {pendingCount > 0 && (
                <Button variant="ghost" onClick={() => setPending({})}>Discard</Button>
              )}
              <Button onClick={handleSaveAll} disabled={pendingCount === 0 || scanBusy}>
                Save all
                {pendingCount > 0 && (
                  <Badge variant="secondary" className="ml-2 text-xs">
                    {pendingCount}
                  </Badge>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {selectedBoard && (
        <SpectrumPanel
          boardId={selectedBoardId}
          boardName={selectedBoard.name}
          channel={selectedChannel}
          psd={isPSD}
          jsrootLoaded={jsrootLoaded}
          refreshTick={refreshTick}
          changeMark={changeMark}
          changeLabel={changeLabel}
        />
      )}

      {selectedBoard && (
        <Card>
          <CardHeader>
            <CardTitle>Scans <span className="text-sm font-normal text-muted-foreground">Ch {selectedChannel}</span></CardTitle>
          </CardHeader>
          <CardContent>
            {tunerLive ? (
              <ThresholdScan
                boardId={selectedBoardId}
                channel={selectedChannel}
                psd={isPSD}
                settings={settings}
                isLive={isTunerLive}
                onBusy={setScanBusy}
                onApply={applyFromScan}
              />
            ) : (
              <p className="text-sm text-muted-foreground" data-testid="scans-locked">
                {isRunning
                  ? 'Scans write to the board, so they run only in a run started here. A production run is never scanned.'
                  : 'Scans write to the board while it acquires: press Start above (Tuner run, not saved), then scan.'}
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
