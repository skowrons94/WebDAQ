'use client'

import React, { useState, useEffect, useRef } from 'react'
import {
  getBoardConfiguration,
  getBoardSettings,
  setSetting,
  getHistogram,
  getWaveform1,
  getWaveform2,
  getProbe1,
  getProbe2,
  startRun,
  stopRun,
  getRunStatus,
  getSaveData,
  setSaveData,
} from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { useToast } from '@/components/ui/use-toast'
import { loadJSROOT } from '@/lib/load-jsroot'

type BoardData = {
  id: string
  name: string
  vme: string
  link_type: string
  link_num: string
  dpp: string
  chan: string
}

interface RegisterData {
  name: string
  value_dec: number
  value_hex: string
  channel: number
  address: string
}

interface BoardSettings {
  [key: string]: RegisterData
}

const PHA_TRACE1_OPTIONS = [
  { value: 0, label: 'Input' },
  { value: 1, label: 'RC-CR' },
  { value: 2, label: 'RC-CR2' },
  { value: 3, label: 'Trapezoid' },
]

const PHA_TRACE2_OPTIONS = [
  { value: 0, label: 'Input' },
  { value: 1, label: 'Threshold' },
  { value: 2, label: 'Trapezoid - Baseline' },
  { value: 3, label: 'Baseline' },
]

const PSD_TRACE1_OPTIONS = [
  { value: 0, label: 'Input' },
  { value: 1, label: 'CFD' },
  { value: 2, label: 'Input' },
  { value: 3, label: 'Reserved' },
]

const PSD_TRACE2_OPTIONS = [
  { value: 0, label: 'Baseline' },
  { value: 1, label: 'Baseline' },
  { value: 2, label: 'CFD' },
  { value: 3, label: 'Reserved' },
]

const DIGITAL_PROBE_OPTIONS = [
  { value: 0,  label: 'Peaking' },
  { value: 1,  label: 'RC-CR2 Crossing' },
  { value: 3,  label: 'Pile-up' },
  { value: 6,  label: 'Baseline Freeze' },
  { value: 7,  label: 'Trigger Hold-Off' },
  { value: 10, label: 'RC-CR Crossing' },
]

const TRIGGER_REG_NAMES = [
  'Trigger Threshold',
  'Input Rise Time',
  'Trigger Hold-Off Width',
  'Trigger Hold-off Width',
  'DC Offset',
]

const TRAPEZOID_REG_NAMES = [
  'Trapezoid Rise Time',
  'Trapezoid Flat Top',
  'Trapezoid Decay Time',
  'Decay Time',
  'Trapezoid Peaking Time',
  'Peaking Time',
]

function isTriggerReg(name: string): boolean {
  return TRIGGER_REG_NAMES.some(n => name.toLowerCase().includes(n.toLowerCase()))
}

function isTrapezoidReg(name: string): boolean {
  return TRAPEZOID_REG_NAMES.some(n => name.toLowerCase().includes(n.toLowerCase()))
}

// ── Unit conversion helpers ──────────────────────────────────

const TIME_REG_KEYWORDS = [
  'Trapezoid Rise Time',
  'Trapezoid Flat Top',
  'Peaking Time',
  'Decay Time',
  'Input Rise Time',
  'Trigger Hold-Off',
]

function getNsPerSample(boardName: string): number {
  if (boardName.includes('1730')) return 8
  if (boardName.includes('1725')) return 16
  if (boardName.includes('1724')) return 10
  return 1
}

function isTimeReg(name: string): boolean {
  return TIME_REG_KEYWORDS.some(t => name.toLowerCase().includes(t.toLowerCase()))
}

function isDcOffsetReg(name: string): boolean {
  return name.toLowerCase().includes('dc offset')
}

// Safe 32-bit bit-field setter using BigInt to avoid signed overflow
function setFieldInRegister(regVal: number, start: number, end: number, fieldVal: number): number {
  const width = end - start + 1
  const maskBig = (BigInt(1) << BigInt(width)) - BigInt(1)
  const shiftedMask = maskBig << BigInt(start)
  const result =
    (BigInt(regVal >>> 0) & ~shiftedMask) |
    ((BigInt(fieldVal) & maskBig) << BigInt(start))
  return Number(result & BigInt(0xFFFFFFFF))
}

export default function ParamTuner() {
  const [boards, setBoards] = useState<BoardData[]>([])
  const [selectedBoardId, setSelectedBoardId] = useState<string>('')
  const [selectedChannel, setSelectedChannel] = useState<number>(0)
  const [settings, setSettings] = useState<BoardSettings>({})
  const [pendingValues, setPendingValues] = useState<{ [key: string]: string }>({})
  const [isAcquiring, setIsAcquiring] = useState(false)
  const [savedSaveFlag, setSavedSaveFlagState] = useState<boolean | null>(null)
  const [waveformNum, setWaveformNum] = useState<1 | 2>(1)
  const [jsrootLoaded, setJsrootLoaded] = useState(false)
  const [refreshTick, setRefreshTick] = useState(0)
  const [isRunning, setIsRunning] = useState(false)

  const waveformRef = useRef<HTMLDivElement>(null)
  const histogramRef = useRef<HTMLDivElement>(null)
  const probe1PainterRef = useRef<any>(null)
  const probe2PainterRef = useRef<any>(null)
  const waveformKeyRef = useRef<string>('')
  const { toast } = useToast()

  // --- Derived values ---
  const selectedBoard = boards.find(b => b.id === selectedBoardId)
  const channelCount = selectedBoard ? parseInt(selectedBoard.chan) : 0
  const isPSD = selectedBoard ? selectedBoard.dpp.toUpperCase().includes('PSD') : false
  const nsPerSample = selectedBoard ? getNsPerSample(selectedBoard.name) : 1

  // Per-channel registers (address < 0x8000)
  const channelRegs = Object.entries(settings).filter(
    ([, reg]) => reg.channel === selectedChannel && parseInt(reg.address, 16) < 0x8000
  )

  // Board Configuration register (global)
  const boardConfigEntry = Object.entries(settings).find(
    ([, reg]) => reg.name?.includes('Board Configuration')
  )
  const boardConfigReg = boardConfigEntry?.[1] ?? null
  const boardConfigKey = boardConfigEntry?.[0] ?? null

  const dualTrace = boardConfigReg ? ((boardConfigReg.value_dec >> 11) & 1) === 1 : false
  const trace1Val = boardConfigReg ? (boardConfigReg.value_dec >> 12) & 0x3 : 0
  const trace2Val = boardConfigReg ? (boardConfigReg.value_dec >> 14) & 0x3 : 0
  const digitalProbeVal = boardConfigReg ? (boardConfigReg.value_dec >> 20) & 0xF : 0

  // DPP Algorithm Control (not "2") for Invert Input (bit 16)
  const dppCtrlEntry = Object.entries(settings).find(
    ([, reg]) =>
      reg.channel === selectedChannel &&
      reg.name?.includes('DPP Algorithm Control') &&
      !reg.name.includes('2')
  )
  const dppCtrlReg = dppCtrlEntry?.[1] ?? null
  const dppCtrlKey = dppCtrlEntry?.[0] ?? null

  const invertInput = dppCtrlReg ? ((dppCtrlReg.value_dec >> 16) & 1) === 1 : false

  const triggerRegs = channelRegs.filter(([, r]) => isTriggerReg(r.name))
  const trapezoidRegs = channelRegs.filter(([, r]) => isTrapezoidReg(r.name))

  const traceOptions1 = isPSD ? PSD_TRACE1_OPTIONS : PHA_TRACE1_OPTIONS
  const traceOptions2 = isPSD ? PSD_TRACE2_OPTIONS : PHA_TRACE2_OPTIONS

  // --- Effects ---

  // Load boards on mount
  useEffect(() => {
    const init = async () => {
      try {
        const res = await getBoardConfiguration()
        const boardList: BoardData[] = res.data
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
    setPendingValues({})
    const load = async () => {
      try {
        const data = await getBoardSettings(selectedBoardId)
        setSettings(data)
      } catch {
        toast({ title: 'Error', description: 'Failed to load board settings', variant: 'destructive' })
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

  // Poll run status
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const running = await getRunStatus()
        setIsRunning(running)
      } catch {}
    }
    fetchStatus()
    const interval = setInterval(fetchStatus, 3000)
    return () => clearInterval(interval)
  }, [])

  // Auto-refresh tick
  useEffect(() => {
    if (!jsrootLoaded || !selectedBoardId) return
    const interval = setInterval(() => setRefreshTick(t => t + 1), 2000)
    return () => clearInterval(interval)
  }, [jsrootLoaded, selectedBoardId])

  // Fetch and render waveform
  useEffect(() => {
    if (!jsrootLoaded || !selectedBoardId) return
    const el = waveformRef.current
    if (!el || !window.JSROOT) return
    const fetch = async () => {
      try {
        const data =
          waveformNum === 1
            ? await getWaveform1(selectedBoardId, selectedChannel.toString())
            : await getWaveform2(selectedBoardId, selectedChannel.toString())
        const parsed = window.JSROOT.parse(data)

        // When board/channel/waveformNum changes, forget the old probe painters so
        // they get re-created fresh on the new (blank) pad.
        const currentKey = `${selectedBoardId}-${selectedChannel}-${waveformNum}`
        if (waveformKeyRef.current !== currentKey) {
          waveformKeyRef.current = currentKey
          probe1PainterRef.current = null
          probe2PainterRef.current = null
        }

        // Fetch probe data
        let p1: any = null
        let p2: any = null
        try {
          const p1Data = await getProbe1(selectedBoardId, selectedChannel.toString())
          if (p1Data) { p1 = window.JSROOT.parse(p1Data); p1.fLineColor = 3 }
        } catch {}
        try {
          const p2Data = await getProbe2(selectedBoardId, selectedChannel.toString())
          if (p2Data) { p2 = window.JSROOT.parse(p2Data); p2.fLineColor = 2 }
        } catch {}

        // If probe painters already exist, push new data into them before redraw.
        // JSROOT.redraw calls redrawPad internally, which repaints all painters on
        // the pad — so the updated probe objects are picked up without any cleanup.
        if (p1 && probe1PainterRef.current) probe1PainterRef.current.updateObject(p1)
        if (p2 && probe2PainterRef.current) probe2PainterRef.current.updateObject(p2)

        // Redraw main waveform in-place (preserves zoom, triggers full pad repaint)
        await window.JSROOT.redraw(el, parsed, 'hist')

        // First render (or after context change): add probe overlays now that the
        // main histogram painter owns the pad.
        if (p1 && !probe1PainterRef.current)
          probe1PainterRef.current = await window.JSROOT.draw(el, p1, 'hist same')
        if (p2 && !probe2PainterRef.current)
          probe2PainterRef.current = await window.JSROOT.draw(el, p2, 'hist same')
      } catch {}
    }
    fetch()
  }, [jsrootLoaded, refreshTick, selectedBoardId, selectedChannel, waveformNum])

  // Fetch and render histogram
  useEffect(() => {
    if (!jsrootLoaded || !selectedBoardId) return
    const el = histogramRef.current
    if (!el || !window.JSROOT) return
    const fetch = async () => {
      try {
        const data = await getHistogram(selectedBoardId, selectedChannel.toString())
        const parsed = window.JSROOT.parse(data)
        window.JSROOT.redraw(el, parsed, 'hist')
      } catch {}
    }
    fetch()
  }, [jsrootLoaded, refreshTick, selectedBoardId, selectedChannel])

  // --- Handlers ---

  const handleStart = async () => {
    try {
      const original = await getSaveData()
      setSavedSaveFlagState(original)
      await setSaveData(false)
      await startRun()
      setIsAcquiring(true)
      toast({ title: 'Started', description: 'Acquisition started (data saving disabled)' })
    } catch {
      toast({ title: 'Error', description: 'Failed to start acquisition', variant: 'destructive' })
    }
  }

  const handleStop = async () => {
    try {
      await stopRun()
      if (savedSaveFlag !== null) await setSaveData(savedSaveFlag)
      setIsAcquiring(false)
      toast({ title: 'Stopped', description: 'Acquisition stopped' })
    } catch {
      toast({ title: 'Error', description: 'Failed to stop acquisition', variant: 'destructive' })
    }
  }

  const handleDualTraceToggle = async (enabled: boolean) => {
    const cfg = boardConfigReg
    const cfgKey = boardConfigKey
    if (!cfg || !cfgKey) return
    try {
      const newValue = enabled
        ? cfg.value_dec | (1 << 11)
        : cfg.value_dec & ~(1 << 11)
      await setSetting(selectedBoardId, cfgKey, newValue.toString())
      setSettings(prev => ({
        ...prev,
        [cfgKey]: { ...cfg, value_dec: newValue, value_hex: `0x${newValue.toString(16).toUpperCase()}` },
      }))
      if (!enabled) setWaveformNum(1)
    } catch {
      toast({ title: 'Error', description: 'Failed to update Dual Trace', variant: 'destructive' })
    }
  }

  const handleTraceTypeChange = async (traceNumber: 1 | 2, newTraceVal: number) => {
    const cfg = boardConfigReg
    const cfgKey = boardConfigKey
    if (!cfg || !cfgKey) return
    try {
      let newValue = cfg.value_dec
      if (traceNumber === 1) {
        newValue = (newValue & ~(0x3 << 12)) | (newTraceVal << 12)
      } else {
        newValue = (newValue & ~(0x3 << 14)) | (newTraceVal << 14)
      }
      await setSetting(selectedBoardId, cfgKey, newValue.toString())
      setSettings(prev => ({
        ...prev,
        [cfgKey]: { ...cfg, value_dec: newValue, value_hex: `0x${newValue.toString(16).toUpperCase()}` },
      }))
    } catch {
      toast({ title: 'Error', description: `Failed to update Trace ${traceNumber}`, variant: 'destructive' })
    }
  }

  const handleDigitalProbeChange = async (newVal: number) => {
    const cfg = boardConfigReg
    const cfgKey = boardConfigKey
    if (!cfg || !cfgKey) return
    try {
      const newValue = (cfg.value_dec & ~(0xF << 20)) | (newVal << 20)
      await setSetting(selectedBoardId, cfgKey, newValue.toString())
      setSettings(prev => ({
        ...prev,
        [cfgKey]: { ...cfg, value_dec: newValue, value_hex: `0x${newValue.toString(16).toUpperCase()}` },
      }))
    } catch {
      toast({ title: 'Error', description: 'Failed to update Digital Probe', variant: 'destructive' })
    }
  }

  const handleSettingChange = (regKey: string, value: string) => {
    setPendingValues(prev => ({ ...prev, [regKey]: value }))
  }

  const handleSaveAll = async () => {
    const entries = Object.entries(pendingValues)
    if (entries.length === 0) return
    let savedCount = 0
    for (const [regKey, value] of entries) {
      try {
        const reg = settings[regKey]
        // Convert display value back to raw register value
        let rawVal: number
        if (reg && isDcOffsetReg(reg.name)) {
          rawVal = Math.round((parseFloat(value) / 100) * 65535)
        } else if (reg && isTimeReg(reg.name) && nsPerSample > 1) {
          rawVal = Math.round(parseFloat(value) / nsPerSample)
        } else {
          rawVal = parseInt(value, 10)
        }
        if (isNaN(rawVal)) continue
        await setSetting(selectedBoardId, regKey, rawVal.toString())
        setSettings(prev => {
          const r = prev[regKey]
          if (!r) return prev
          return {
            ...prev,
            [regKey]: {
              ...r,
              value_dec: rawVal,
              value_hex: `0x${rawVal.toString(16).toUpperCase()}`,
            },
          }
        })
        savedCount++
      } catch {
        toast({ title: 'Error', description: `Failed to save setting ${regKey}`, variant: 'destructive' })
      }
    }
    setPendingValues({})
    if (savedCount > 0) {
      toast({ title: 'Saved', description: `${savedCount} setting(s) saved` })
    }
  }

  const handleInvertInputToggle = async (enabled: boolean) => {
    const ctrl = dppCtrlReg
    const ctrlKey = dppCtrlKey
    if (!ctrl || !ctrlKey) return
    try {
      const newValue = setFieldInRegister(ctrl.value_dec, 16, 16, enabled ? 1 : 0)
      await setSetting(selectedBoardId, ctrlKey, newValue.toString())
      setSettings(prev => ({
        ...prev,
        [ctrlKey]: { ...ctrl, value_dec: newValue, value_hex: `0x${newValue.toString(16).toUpperCase()}` },
      }))
    } catch {
      toast({ title: 'Error', description: 'Failed to update Invert Input', variant: 'destructive' })
    }
  }

  const getRegValue = (regKey: string): string => {
    // Pending values are already in display units (user typed them)
    if (pendingValues[regKey] !== undefined) return pendingValues[regKey]
    const reg = settings[regKey]
    if (!reg) return ''
    const raw = reg.value_dec
    if (isDcOffsetReg(reg.name)) return ((raw / 65535) * 100).toFixed(1)
    if (isTimeReg(reg.name) && nsPerSample > 1) return (raw * nsPerSample).toString()
    return raw.toString()
  }

  const renderSettingRow = (regKey: string, reg: RegisterData) => {
    const unit = isDcOffsetReg(reg.name) ? '%' : (isTimeReg(reg.name) && nsPerSample > 1 ? 'ns' : '')
    const step = isDcOffsetReg(reg.name) ? 0.1 : (isTimeReg(reg.name) && nsPerSample > 1 ? nsPerSample : 1)
    return (
      <div key={regKey} className="flex items-center gap-3">
        <Label className="text-sm w-44 shrink-0">{reg.name}</Label>
        <Input
          className="w-32 h-8 text-sm"
          type="number"
          step={step}
          value={getRegValue(regKey)}
          onChange={e => handleSettingChange(regKey, e.target.value)}
        />
        {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
        {pendingValues[regKey] !== undefined && (
          <Badge variant="outline" className="text-xs text-orange-500 border-orange-500">
            unsaved
          </Badge>
        )}
      </div>
    )
  }

  const pendingCount = Object.keys(pendingValues).length

  return (
    <div className="flex flex-col gap-6">
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <Label className="text-sm font-medium">Board</Label>
          <Select value={selectedBoardId} onValueChange={setSelectedBoardId}>
            <SelectTrigger className="w-52">
              <SelectValue placeholder="Select board..." />
            </SelectTrigger>
            <SelectContent>
              {boards.map(b => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name} (ID: {b.id})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <Label className="text-sm font-medium">Channel</Label>
          <Select
            value={selectedChannel.toString()}
            onValueChange={v => {
              setSelectedChannel(parseInt(v))
              setPendingValues({})
            }}
          >
            <SelectTrigger className="w-36">
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
          disabled={isAcquiring || isRunning}
          className="bg-green-600 hover:bg-green-700 text-white"
        >
          Start
        </Button>
        <Button
          onClick={handleStop}
          disabled={!isAcquiring && !isRunning}
          variant="destructive"
        >
          Stop
        </Button>

        <Badge variant={isRunning ? 'default' : 'secondary'}>
          {isRunning ? 'Running' : 'Stopped'}
        </Badge>
        {isAcquiring && (
          <Badge variant="outline" className="text-yellow-600 border-yellow-600">
            Tuner active · saving disabled
          </Badge>
        )}
      </div>

      {/* Main content: waveform (left) + settings (right) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Waveform panel */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>Waveform</span>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant={waveformNum === 1 ? 'default' : 'outline'}
                  onClick={() => setWaveformNum(1)}
                >
                  Waveform 1
                </Button>
                {dualTrace && (
                  <Button
                    size="sm"
                    variant={waveformNum === 2 ? 'default' : 'outline'}
                    onClick={() => setWaveformNum(2)}
                  >
                    Waveform 2
                  </Button>
                )}
              </div>
            </CardTitle>
            <div className="flex flex-col gap-3 mt-1">
              <div className="flex items-center gap-2">
                <Switch
                  id="dual-trace-switch"
                  checked={dualTrace}
                  onCheckedChange={handleDualTraceToggle}
                />
                <Label htmlFor="dual-trace-switch" className="text-sm cursor-pointer">
                  Dual Trace
                </Label>
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <Label className="text-sm w-14">Trace 1:</Label>
                  <Select
                    value={trace1Val.toString()}
                    onValueChange={v => handleTraceTypeChange(1, parseInt(v))}
                  >
                    <SelectTrigger className="w-44 h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {traceOptions1.map(o => (
                        <SelectItem key={o.value} value={o.value.toString()}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {dualTrace && (
                  <div className="flex items-center gap-2">
                    <Label className="text-sm w-14">Trace 2:</Label>
                    <Select
                      value={trace2Val.toString()}
                      onValueChange={v => handleTraceTypeChange(2, parseInt(v))}
                    >
                      <SelectTrigger className="w-44 h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {traceOptions2.map(o => (
                          <SelectItem key={o.value} value={o.value.toString()}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <Label className="text-sm w-28">Digital Probe:</Label>
                  <Select
                    value={digitalProbeVal.toString()}
                    onValueChange={v => handleDigitalProbeChange(parseInt(v))}
                  >
                    <SelectTrigger className="w-44 h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DIGITAL_PROBE_OPTIONS.map(o => (
                        <SelectItem key={o.value} value={o.value.toString()}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div ref={waveformRef} className="w-full h-80 border rounded-lg shadow-sm" />
          </CardContent>
        </Card>

        {/* Settings panel */}
        <Card>
          <CardHeader>
            <CardTitle>Settings — Ch {selectedChannel}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Trigger Settings */}
            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                Trigger Settings
              </h4>
              <div className="space-y-3">
                {triggerRegs.length > 0 ? (
                  triggerRegs.map(([k, r]) => renderSettingRow(k, r))
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No trigger settings found for channel {selectedChannel}.
                  </p>
                )}
              </div>
            </div>

            <Separator />

            {/* Trapezoid Settings */}
            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                Trapezoid Settings
              </h4>
              <div className="space-y-3">
                {trapezoidRegs.length > 0 ? (
                  trapezoidRegs.map(([k, r]) => renderSettingRow(k, r))
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No trapezoid settings found for channel {selectedChannel}.
                  </p>
                )}
                {dppCtrlReg && (
                  <div className="flex items-center gap-3 pt-1">
                    <Label className="text-sm w-44 shrink-0">Invert Input</Label>
                    <Switch checked={invertInput} onCheckedChange={handleInvertInputToggle} />
                  </div>
                )}
              </div>
            </div>

            <Separator />

            <div className="flex justify-end">
              <Button onClick={handleSaveAll} disabled={pendingCount === 0}>
                Save All
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

      {/* Energy Spectrum */}
      <Card>
        <CardHeader>
          <CardTitle>
            Energy Spectrum
            {selectedBoard && (
              <span className="text-muted-foreground font-normal ml-2 text-base">
                {selectedBoard.name} — Channel {selectedChannel}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div ref={histogramRef} className="w-full h-80 border rounded-lg shadow-sm" />
        </CardContent>
      </Card>
    </div>
  )
}
