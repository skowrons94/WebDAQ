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
import { baseAddress, boardTiming, controlsFor, formatControl, getBits, setBits, toDisplay } from '@/components/tuner/units'
import { cancelActiveScan, onScanRecordChange, scanActive, scanRecordState, type ScanRecordState } from '@/components/tuner/scan-engine'
import { ScanRecoveryDialog } from '@/components/tuner/scan-recovery'
import { useRunBadge } from '@/hooks/use-run-badge'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { addHistory, clearHistory, loadHistory, registersFor, type HistoryEntry } from '@/lib/tuner-history'
import type { TraceReadout } from '@/components/tuner/waveform-panel'
import type { FitSummary } from '@/components/tuner/spectrum-panel'
import type { GuideStatus } from '@/components/tuner/guided-flow'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import dynamic from 'next/dynamic'

// Scans (and the fit code they use) load only when a scan can run.
const loadingScan = () => <p className="text-sm text-muted-foreground">Loading…</p>
const ThresholdScan = dynamic(() => import('@/components/tuner/threshold-scan'), { ssr: false, loading: loadingScan })
const ShapingScan = dynamic(() => import('@/components/tuner/shaping-scan'), { ssr: false, loading: loadingScan })
const PsdFomScan = dynamic(() => import('@/components/tuner/psd-fom'), { ssr: false, loading: loadingScan })
const HistoryPanel = dynamic(() => import('@/components/tuner/history-panel'), { ssr: false, loading: loadingScan })
const GuidedFlow = dynamic(() => import('@/components/tuner/guided-flow'), { ssr: false, loading: loadingScan })

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
  const runBadge = useRunBadge()

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
  const [scanBusy, setScanBusyState] = useState(false)
  const [scanTab, setScanTab] = useState<'threshold' | 'shaping' | 'psd'>('threshold')
  const [scanned, setScanned] = useState<Record<string, boolean>>({})
  useEffect(() => { setScanTab('threshold') }, [isPSD])
  const setScanBusy = (b: boolean) => {
    setScanBusyState(b)
    if (!b) setScanned((m) => ({ ...m, [scanTab]: true }))
  }

  // Change log (P7) and what the guided flow (P8) reads.
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [fit, setFit] = useState<FitSummary | null>(null)
  const fitRef = useRef<FitSummary | null>(null)
  fitRef.current = fit
  const [trace, setTrace] = useState<TraceReadout | null>(null)
  const [presetSaved, setPresetSaved] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  useEffect(() => {
    if (selectedBoardId) setHistory(loadHistory(selectedBoardId, selectedChannel))
    setFit(null); setTrace(null)
  }, [selectedBoardId, selectedChannel])
  const logChange = (regKey: string, from: number, to: number, label: string, written: boolean, source: HistoryEntry['source']) => {
    const f = fitRef.current
    addHistory({
      boardId: selectedBoardId, channel: selectedChannel, regKey, name: settings[regKey]?.name ?? regKey,
      label, from, to, written, source, fwhmBefore: f?.reliable ? f.fwhm : null, unit: f?.reliable ? f.unit : null,
    })
    setHistory(loadHistory(selectedBoardId, selectedChannel))
  }

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

  // Scans and other automatic writes: only in the run the Tuner started
  // itself, and only while the server answers ("No answer" stops a scan; its
  // values are restored, or offered for restore once the server is back).
  const unreachable = useRunStatus((s) => s.unreachable)
  const tunerLive = runKnown && !unreachable && isRunning && isAcquiring && tunerOwnsRun(runStartTime)
  const tunerLiveRef = useRef(tunerLive)
  tunerLiveRef.current = tunerLive
  const isTunerLive = () => tunerLiveRef.current

  // The scan record (this browser): another tab scanning, or a scan that
  // ended without a confirmed restore. Followed across tabs.
  const [scanState, setScanState] = useState<ScanRecordState>('none')
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  useEffect(() => {
    const check = () => setScanState(scanRecordState())
    check()
    const off = onScanRecordChange(check)
    const id = setInterval(check, 3000)
    return () => { off(); clearInterval(id) }
  }, [])
  // An interrupted scan: ask (once the server answers) before restoring.
  const asked = useRef(false)
  useEffect(() => {
    if (!runKnown || unreachable) return
    if ((scanState === 'interrupted' || scanState === 'expired') && !asked.current && !scanActive()) {
      asked.current = true
      setRecoveryOpen(true)
    }
    if (scanState === 'none') asked.current = false
  }, [runKnown, unreachable, scanState])

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
      // A scan first: cancel it and put its values back on the board while
      // the run is still on, then stop.
      if (scanActive()) {
        toast({ title: 'Stopping the scan…', description: 'Its starting values are restored before the run stops.' })
        await cancelActiveScan('Stopped from the Tuner.')
      }
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
  const applyRegister = async (regKey: string, rawValue: number, label: string) => {
    try {
      const result = await applySetting(selectedBoardId, regKey, rawValue, online)
      if (online && !result.written && result.reason) {
        toast({ title: `${label}: saved, not sent to the board`, description: result.reason })
      }
      return result
    } catch (error) {
      const serverMessage =
        (error as { response?: { data?: { message?: string } } })?.response?.data?.message
      toast({
        title: `Failed to update ${label}`,
        description: serverMessage ?? 'The server did not accept the change.',
        variant: 'destructive',
      })
      return null
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
      const res = await applyRegister(regKey, rawVal, r?.name ?? regKey)
      if (!res) continue
      if (res.written) writtenCount++
      if (r) logChange(regKey, r.value_dec, rawVal, describeChange(regKey, r.value_dec, rawVal), res.written, 'manual')
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

  // Switching board or channel drops staged edits: ask first.
  const [switchAsk, setSwitchAsk] = useState<{ kind: 'board' | 'channel'; value: string } | null>(null)
  const doSwitch = (sw: { kind: 'board' | 'channel'; value: string }) => {
    if (sw.kind === 'board') setSelectedBoardId(sw.value)
    else { setSelectedChannel(parseInt(sw.value)); setPending({}); setMeasuredBaseline(null) }
  }
  const askSwitch = (sw: { kind: 'board' | 'channel'; value: string }) => {
    if ((sw.kind === 'board' ? sw.value === selectedBoardId : sw.value === String(selectedChannel))) return
    if (Object.keys(pending).length > 0) setSwitchAsk(sw)
    else doSwitch(sw)
  }

  /** "Trapezoid rise time 400 → 4000 ns" for the change log. */
  const describeChange = (regKey: string, from: number, to: number): string => {
    const r = settings[regKey]
    if (!r) return regKey
    const specs = controlsFor(dpp).filter((s) => s.address === baseAddress(r.address))
    const parts = specs
      .map((s) => ({ s, a: s.bits ? getBits(from, s.bits) : from, b: s.bits ? getBits(to, s.bits) : to }))
      .filter((x) => x.a !== x.b)
      .map((x) => `${x.s.label} ${formatControl(x.s, x.a, timing)} → ${formatControl(x.s, x.b, timing)}`)
    return parts.length ? parts.join(', ') : `${r.name} ${from} → ${to}`
  }

  /** Undo stages the old value (like a preset); "Save all" applies it under the usual rules. */
  const handleUndo = (e: HistoryEntry) => {
    const saved = settings[e.regKey]?.value_dec
    if (saved === undefined) { toast({ title: 'Cannot undo', description: `${e.name} is not in this board's settings.`, variant: 'destructive' }); return }
    setPending(prev => {
      const n = { ...prev }
      if (saved === e.from) delete n[e.regKey]; else n[e.regKey] = e.from
      return n
    })
    if (saved !== e.to) {
      toast({
        title: 'Undo staged: changed since',
        description: `${e.name} was changed after this step: it is now ${describeChange(e.regKey, e.to, saved).replace(/^.*?→ /, '')}, not the value this step set. The old value is staged anyway: check it, then "Save all".`,
        variant: 'destructive',
      })
    } else {
      toast({ title: 'Undo staged', description: `${describeChange(e.regKey, saved, e.from)}: press "Save all" to apply.` })
    }
  }

  const handleLoadValues = (values: Record<string, number>, source: string) => {
    const regs = registersFor(dpp, settings, pending, selectedChannel, values)
    const n = Object.keys(regs).length
    if (!n) { toast({ title: 'Nothing to change', description: `The channel already has ${source}'s values.` }); return }
    setPending(prev => {
      const next = { ...prev }
      for (const [k, v] of Object.entries(regs)) {
        if (settings[k]?.value_dec === v) delete next[k]; else next[k] = v
      }
      return next
    })
    toast({ title: `Loaded ${source}`, description: `${n} register(s) changed, not saved yet: check and press "Save all".` })
  }

  const showsInput = boardConfigValue !== null && getBits(boardConfigValue, [12, 13]) === 0
  const showsTrapezoid = !isPSD && boardConfigValue !== null && getBits(boardConfigValue, [12, 13]) === 3
  const peakingNs = !isPSD && reg(0x1064) !== null ? toDisplay(reg(0x1064)!, 'step', timing) : null
  const shortNs = isPSD && reg(0x1054) !== null ? toDisplay(reg(0x1054)!, 'sample', timing) : null
  const recordNs = recordRaw !== null ? recordRaw * 8 * timing.sampleNs : null
  const preNs = preRaw !== null ? preRaw * 4 * timing.sampleNs : 0
  const guide: GuideStatus = {
    tunerRun: tunerLive,
    showsInput, showsTrapezoid,
    headroomPct: trace?.input ? (100 * trace.input.headroom) / timing.adcMax : null,
    clippedTraces: trace ? trace.clipped : null,
    pzResidualPct: trace?.trap?.pzResidualPct ?? null,
    trapezoidFits: !isPSD && riseNs !== null && flatNs !== null && recordNs !== null ? preNs + 2 * riseNs + flatNs <= recordNs : null,
    samplingInFlatTop: peakingNs !== null && flatNs !== null ? peakingNs < flatNs : null,
    shortBelowLong: shortNs !== null && longGateNs ? shortNs < longGateNs : null,
    saturatedPct: rates.now && rates.now.event > 0 ? (100 * rates.now.satu) / rates.now.event : null,
    thresholdScanned: !!scanned.threshold,
    riseScanned: !!scanned.shaping,
    gatesScanned: !!scanned.psd,
    fitReliable: !!fit?.reliable,
    presetSaved,
  }

  /** A scan's suggestion, applied as one change: to the board in the Tuner's run. */
  const applyFromScan = async (regKey: string, raw: number, label: string) => {
    try {
      const before = settings[regKey]?.value_dec
      const r = await applySettingRaw(selectedBoardId, regKey, raw, tunerLiveRef.current)
      if (before !== undefined) logChange(regKey, before, raw, label, r.written, 'scan')
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
      <ScanRecoveryDialog
        open={recoveryOpen}
        onOpenChange={setRecoveryOpen}
        isLive={isTunerLive}
        context="tuner"
        onDone={async () => {
          setScanState(scanRecordState())
          if (selectedBoardId) {
            try { setSettings(await getBoardSettings(selectedBoardId)) } catch { /* keep what is shown */ }
          }
        }}
      />
      <AlertDialog open={!!switchAsk} onOpenChange={(o) => { if (!o) setSwitchAsk(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pendingCount} unsaved change{pendingCount === 1 ? '' : 's'} on channel {selectedChannel}</AlertDialogTitle>
            <AlertDialogDescription>
              Switching to {switchAsk?.kind === 'board' ? 'another board' : `channel ${switchAsk?.value}`} drops them. Keep them to stay here and save
              (or discard) first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep them</AlertDialogCancel>
            <AlertDialogAction onClick={() => { const sw = switchAsk; setSwitchAsk(null); setPending({}); if (sw) doSwitch(sw) }}>
              Discard and switch
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <Label className="text-sm font-medium">Board</Label>
          <Select value={selectedBoardId} onValueChange={(v) => askSwitch({ kind: 'board', value: v })} disabled={scanBusy}>
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
            onValueChange={v => askSwitch({ kind: 'channel', value: v })}
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

        <StatusBadge state={runBadge.state} label={runBadge.label} title={runBadge.title} />
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

      {selectedBoard && (
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 py-4">
            <CardTitle className="text-base">Tune this channel <span className="text-sm font-normal text-muted-foreground">step by step, {isPSD ? 'DPP-PSD' : 'DPP-PHA'}</span></CardTitle>
            <Button variant="outline" size="sm" onClick={() => setGuideOpen((o) => !o)} aria-expanded={guideOpen}>
              {guideOpen ? 'Hide the steps' : 'Start guided tuning'}
            </Button>
          </CardHeader>
          {guideOpen && (
            <CardContent>
              <GuidedFlow
                psd={isPSD}
                status={guide}
                storageKey={`lunadaq:tuner-guide:${selectedBoardId}:${selectedChannel}`}
                onScanTab={setScanTab}
                onSelectTrace={(code, name) => {
                  if (boardConfigValue === null) return
                  void handleBoardConfigChange(setBits(boardConfigValue, [12, 13], code), `Trace 1: ${name}`)
                }}
              />
            </CardContent>
          )}
        </Card>
      )}

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
            onMetrics={setTrace}
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
          onFit={setFit}
        />
      )}

      {selectedBoard && (
        <Card id="tuner-scans" tabIndex={-1}>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
            <CardTitle>Scans <span className="text-sm font-normal text-muted-foreground">Ch {selectedChannel}</span></CardTitle>
            <Tabs value={scanTab} onValueChange={(v) => !scanBusy && setScanTab(v as typeof scanTab)}>
              <TabsList>
                <TabsTrigger value="threshold" disabled={scanBusy}>Threshold</TabsTrigger>
                {isPSD
                  ? <TabsTrigger value="psd" disabled={scanBusy}>PSD gates</TabsTrigger>
                  : <TabsTrigger value="shaping" disabled={scanBusy}>Rise time</TabsTrigger>}
              </TabsList>
            </Tabs>
          </CardHeader>
          <CardContent>
            {(scanState === 'active-elsewhere' || ((scanState === 'interrupted' || scanState === 'expired') && !scanBusy)) ? (
              <div className="space-y-2 text-sm" data-testid="scans-blocked">
                {scanState === 'active-elsewhere' ? (
                  <p>A scan is running in another Tuner tab or window. Scans run one at a time: finish or cancel it there.</p>
                ) : (
                  <>
                    <p className="text-warning">An earlier scan ended without confirming that its values were put back. Scans (and a production Start) wait until it is resolved.</p>
                    <Button size="sm" variant="outline" onClick={() => setRecoveryOpen(true)}>Review and restore…</Button>
                  </>
                )}
              </div>
            ) : tunerLive ? (
              scanTab === 'shaping' && !isPSD ? (
                <ShapingScan boardId={selectedBoardId} channel={selectedChannel} settings={settings} timing={timing}
                  isLive={isTunerLive} onBusy={setScanBusy} onApply={applyFromScan} />
              ) : scanTab === 'psd' && isPSD ? (
                <PsdFomScan boardId={selectedBoardId} channel={selectedChannel} settings={settings} timing={timing}
                  isLive={isTunerLive} onBusy={setScanBusy} onApply={applyFromScan} />
              ) : (
                <ThresholdScan
                  boardId={selectedBoardId}
                  channel={selectedChannel}
                  psd={isPSD}
                  settings={settings}
                  isLive={isTunerLive}
                  onBusy={setScanBusy}
                  onApply={applyFromScan}
                />
              )
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

      {selectedBoard && (
        <Card id="tuner-history" tabIndex={-1}>
          <CardHeader>
            <CardTitle>History, presets and past runs <span className="text-sm font-normal text-muted-foreground">Ch {selectedChannel}</span></CardTitle>
          </CardHeader>
          <CardContent>
            <HistoryPanel
              boardId={selectedBoardId}
              boardName={selectedBoard.name}
              channel={selectedChannel}
              dpp={dpp}
              timing={timing}
              settings={settings}
              pending={pending}
              entries={history}
              currentFwhm={fit?.reliable ? { fwhm: fit.fwhm, unit: fit.unit } : null}
              busy={scanBusy}
              onUndo={handleUndo}
              onLoadValues={handleLoadValues}
              onClearHistory={() => { clearHistory(selectedBoardId, selectedChannel); setHistory([]) }}
              onPresetSaved={() => setPresetSaved(true)}
            />
          </CardContent>
        </Card>
      )}
    </div>
  )
}
