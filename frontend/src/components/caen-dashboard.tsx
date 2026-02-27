"use client"

import { useState, useEffect, useCallback } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { ReloadIcon } from "@radix-ui/react-icons"
import { useToast } from "@/components/ui/use-toast"
import { getBoardConfiguration, getBoardSettings, setSetting, updateJSON, getChannelEnabled, setChannelEnabled } from "@/lib/api"

// ============================================================
// Bit-field definitions extracted from CAENRegisterBuilder*.cc
// ============================================================

interface BitFieldDef {
  name: string
  startBit: number
  endBit: number
}

// ── PHA: DPP Algorithm Control (0x1n80) ─────────────────────
// Applies to DT5730 / DT5725 / DT5724 / DT5781 / DT5782
const PHA_DPP_CTRL1: BitFieldDef[] = [
  { name: "Trapezoid Rescaling",       startBit: 0,  endBit: 5  },
  { name: "Decimation",                startBit: 8,  endBit: 9  }, // DT5730/5725 only
  { name: "Decimation Gain",           startBit: 10, endBit: 11 }, // DT5730/5725 only
  { name: "Peak Mean",                 startBit: 12, endBit: 13 },
  { name: "Invert Input",              startBit: 16, endBit: 16 },
  { name: "Trigger Mode",              startBit: 18, endBit: 19 },
  { name: "Baseline Averaging Window", startBit: 20, endBit: 22 },
  { name: "Disable Self Trigger",      startBit: 24, endBit: 24 },
  { name: "Enable Roll-Over",          startBit: 26, endBit: 26 },
  { name: "Enable Pile-Up",            startBit: 27, endBit: 27 },
]

// ── PHA: DPP Algorithm Control 2 ────────────────────────────
// DT5730 / DT5725 (also DT5724/5781/5782 on non-legacy firmware)
const PHA_DPP_CTRL2: BitFieldDef[] = [
  { name: "Local Shaped Trigger",           startBit: 0,  endBit: 1  },
  { name: "Enable Local Shaped Trigger",    startBit: 2,  endBit: 2  },
  { name: "Local Trigger Validation",       startBit: 4,  endBit: 5  },
  { name: "Enable Local Trigger Valid.",    startBit: 6,  endBit: 6  },
  { name: "Extras 2",                       startBit: 8,  endBit: 10 },
  { name: "Veto Source",                    startBit: 14, endBit: 15 },
  { name: "Count Trigger Step",             startBit: 16, endBit: 17 },
  { name: "Ready Baseline",                 startBit: 18, endBit: 18 },
  { name: "Baseline Restorer",              startBit: 29, endBit: 29 },
]

// ── PHA: Board Configuration (0x8000) ───────────────────────
// DT5730 / DT5725 / DT5724 / DT5781 / DT5782
const PHA_BOARD_CONFIG: BitFieldDef[] = [
  { name: "Automatic Data Flush",    startBit: 0,  endBit: 0  },
  { name: "Decimated Samples",       startBit: 1,  endBit: 1  },
  { name: "Trigger Propagation",     startBit: 2,  endBit: 2  },
  { name: "Dual Trace",              startBit: 11, endBit: 11 },
  { name: "Analog Probe 1",          startBit: 12, endBit: 13 },
  { name: "Analog Probe 2",          startBit: 14, endBit: 15 },
  { name: "Enable Waveform",         startBit: 16, endBit: 16 },
  { name: "Enable Extras",           startBit: 17, endBit: 17 },
  { name: "Digital Virtual Probe 1", startBit: 20, endBit: 23 },
]

// ── PSD: DPP Algorithm Control (0x1n80) – DT5730 / DT5725 ──
const PSD_730_DPP_CTRL1: BitFieldDef[] = [
  { name: "Charge Sensitivity",        startBit: 0,  endBit: 2  },
  { name: "Charge Pedestal",           startBit: 4,  endBit: 4  },
  { name: "Trigger Counting",          startBit: 5,  endBit: 5  },
  { name: "Discrimination Mode",       startBit: 6,  endBit: 6  },
  { name: "Pile-Up Counting",          startBit: 7,  endBit: 7  },
  { name: "Internal Pulse",            startBit: 8,  endBit: 8  },
  { name: "Internal Pulse Rate",       startBit: 9,  endBit: 10 },
  { name: "Baseline Recalculation",    startBit: 15, endBit: 15 },
  { name: "Invert Input",              startBit: 16, endBit: 16 },
  { name: "Trigger Mode",              startBit: 18, endBit: 19 },
  { name: "Baseline Averaging Window", startBit: 20, endBit: 22 },
  { name: "Disable Self Trigger",      startBit: 24, endBit: 24 },
  { name: "Long Threshold",            startBit: 25, endBit: 25 },
  { name: "Pile-Up Rejection",         startBit: 26, endBit: 26 },
  { name: "PSD Cut",                   startBit: 27, endBit: 28 },
  { name: "Trigger Hysteresis",        startBit: 30, endBit: 30 },
  { name: "Inhibit Zero Crossing",     startBit: 31, endBit: 31 },
]

// ── PSD: DPP Algorithm Control (0x1n80) – DT5720 ────────────
const PSD_720_DPP_CTRL1: BitFieldDef[] = [
  { name: "Charge Sensitivity",        startBit: 0,  endBit: 1  },
  { name: "Charge Pedestal",           startBit: 4,  endBit: 4  },
  { name: "Trigger Counting",          startBit: 5,  endBit: 5  },
  { name: "Extended Time Stamp",       startBit: 7,  endBit: 7  },
  { name: "Internal Pulse",            startBit: 8,  endBit: 8  },
  { name: "Internal Pulse Rate",       startBit: 9,  endBit: 10 },
  { name: "Invert Input",              startBit: 16, endBit: 16 },
  { name: "Trigger Mode",              startBit: 18, endBit: 19 },
  { name: "Baseline Averaging Window", startBit: 20, endBit: 22 },
  { name: "Disable Self Trigger",      startBit: 24, endBit: 24 },
  { name: "Pile-Up Rejection",         startBit: 26, endBit: 26 },
  { name: "PSD Cut",                   startBit: 27, endBit: 28 },
  { name: "Over Range Rejection",      startBit: 29, endBit: 29 },
  { name: "Trigger Hysteresis",        startBit: 30, endBit: 30 },
]

// ── PSD: DPP Algorithm Control 2 – DT5730 / DT5725 ──────────
// (DT5720 does not have this register)
const PSD_DPP_CTRL2: BitFieldDef[] = [
  { name: "Local Shaped Trigger",           startBit: 0,  endBit: 1  },
  { name: "Enable Local Shaped Trigger",    startBit: 2,  endBit: 2  },
  { name: "Local Trigger Validation",       startBit: 4,  endBit: 5  },
  { name: "Enable Local Trigger Valid.",    startBit: 6,  endBit: 6  },
  { name: "Extras 2",                       startBit: 8,  endBit: 10 },
  { name: "Smoothed Signal",                startBit: 11, endBit: 11 },
  { name: "Smoothed Signal Samples",        startBit: 12, endBit: 15 },
  { name: "Count Trigger Step",             startBit: 16, endBit: 17 },
  { name: "Veto Source",                    startBit: 18, endBit: 19 },
  { name: "Mark Saturated Pulses",          startBit: 24, endBit: 24 },
  { name: "Additional Local Trigger Val.",  startBit: 25, endBit: 26 },
  { name: "Veto Signal Mode",               startBit: 27, endBit: 27 },
  { name: "Reset Time Stamp",               startBit: 28, endBit: 28 },
]

// ── PSD: Board Configuration (0x8000) – DT5730 / DT5725 ─────
const PSD_730_BOARD_CONFIG: BitFieldDef[] = [
  { name: "Automatic Data Flush",    startBit: 0,  endBit: 0  },
  { name: "Trigger Propagation",     startBit: 2,  endBit: 2  },
  { name: "Dual Trace",              startBit: 11, endBit: 11 },
  { name: "Analog Probe",            startBit: 12, endBit: 13 },
  { name: "Enable Waveform",         startBit: 16, endBit: 16 },
  { name: "Enable Extras",           startBit: 17, endBit: 17 },
  { name: "Digital Virtual Probe 1", startBit: 23, endBit: 25 },
  { name: "Digital Virtual Probe 2", startBit: 26, endBit: 28 },
  { name: "Enable Digital Probe",    startBit: 31, endBit: 31 },
]

// ── PSD: Board Configuration (0x8000) – DT5720 ──────────────
const PSD_720_BOARD_CONFIG: BitFieldDef[] = [
  { name: "Trigger Propagation",     startBit: 2,  endBit: 2  },
  { name: "Dual Trace",              startBit: 11, endBit: 11 },
  { name: "Enable Waveform",         startBit: 16, endBit: 16 },
  { name: "Enable Extras",           startBit: 17, endBit: 17 },
  { name: "Enable Time Stamp",       startBit: 18, endBit: 18 },
  { name: "Enable Charge",           startBit: 19, endBit: 19 },
  { name: "Digital Virtual Probe 1", startBit: 23, endBit: 25 },
  { name: "Digital Virtual Probe 2", startBit: 26, endBit: 28 },
]

/**
 * Returns the bit-field decomposition for a register, or null if unknown.
 * dppType: "PHA" | "PSD" (case-insensitive substring match)
 * boardName: e.g. "DT5720B", "DT5730", "DT5725", "DT5781"
 */
function getDecomposition(
  registerName: string,
  dppType: string,
  boardName: string,
): BitFieldDef[] | null {
  const isPSD = dppType.toUpperCase().includes("PSD")
  const is720 = boardName.includes("720")

  if (registerName.includes("DPP Algorithm Control 2")) {
    if (isPSD) return is720 ? null : PSD_DPP_CTRL2
    return PHA_DPP_CTRL2
  }
  if (registerName.includes("DPP Algorithm Control")) {
    if (isPSD) return is720 ? PSD_720_DPP_CTRL1 : PSD_730_DPP_CTRL1
    return PHA_DPP_CTRL1
  }
  if (registerName === "Board Configuration") {
    if (isPSD) return is720 ? PSD_720_BOARD_CONFIG : PSD_730_BOARD_CONFIG
    return PHA_BOARD_CONFIG
  }
  return null
}

// ── Bit manipulation helpers ─────────────────────────────────

/** Extract a bit field value from a 32-bit register value. */
function getFieldValue(regVal: number, start: number, end: number): number {
  const width = end - start + 1
  const mask = width >= 32 ? 0xFFFFFFFF : (1 << width) - 1
  return (regVal >>> start) & mask
}

/** Return a new 32-bit register value with one bit field replaced. */
function setFieldInRegister(regVal: number, start: number, end: number, fieldVal: number): number {
  const width = end - start + 1
  const maskBig = (BigInt(1) << BigInt(width)) - BigInt(1)
  const shiftedMask = maskBig << BigInt(start)
  const result =
    (BigInt(regVal >>> 0) & ~shiftedMask) |
    ((BigInt(fieldVal) & maskBig) << BigInt(start))
  return Number(result & BigInt(0xFFFFFFFF))
}

// ============================================================
// Component types
// ============================================================

interface BoardData {
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
  [reg_name: string]: RegisterData
}

// Names identifying trigger-related channel settings
const TRIGGER_SETTING_NAMES = [
  "Trigger Threshold",
  "Input Rise Time",
  "Trigger Hold-Off Width",
  "Trigger Hold-off Width",
  "DC Offset",
]

// General settings shown in basic (non-advanced) mode
const BASIC_GENERAL_SETTINGS = [
  "Record Length",
  "Acquisition Control",
  "Acquistion Control",
  "Front Panel TRG-OUT",
  "Board ID",
  "Aggregate Number per BLT",
  "Board Configuration",
  "Global Trigger Mask",
]

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

// ============================================================
// Top-level page component
// ============================================================

export default function Dashboard() {
  const [boards, setBoards] = useState<BoardData[]>([])
  const [selectedBoardId, setSelectedBoardId] = useState<string>("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { toast } = useToast()

  const fetchBoardConfiguration = async () => {
    updateJSON()
    setLoading(true)
    setError(null)
    try {
      const response = await getBoardConfiguration()
      setBoards(response.data)
      if (response.data.length > 0 && !selectedBoardId) {
        setSelectedBoardId(response.data[0].id)
      }
    } catch {
      setError("Failed to load boards data")
      toast({
        title: "Error",
        description: "Failed to fetch board configuration. Please try again.",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchBoardConfiguration() }, [])

  if (loading) {
    return (
      <div className="flex justify-center items-center h-screen">
        <ReloadIcon className="mr-2 h-4 w-4 animate-spin" />
        Loading boards data...
      </div>
    )
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }

  const selectedBoard = boards.find(board => board.id === selectedBoardId)

  return (
    <div className="container mx-auto p-4">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">CAEN Dashboard</h1>
        <Button onClick={fetchBoardConfiguration}>Refresh</Button>
      </div>

      <div className="mb-6">
        <Label className="text-lg font-semibold">Select Board</Label>
        <Select value={selectedBoardId} onValueChange={setSelectedBoardId}>
          <SelectTrigger className="w-full max-w-md">
            <SelectValue placeholder="Select a board..." />
          </SelectTrigger>
          <SelectContent>
            {boards.map(board => (
              <SelectItem key={board.id} value={board.id}>
                {board.name} (ID: {board.id})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {selectedBoard && <BoardComponent boardData={selectedBoard} />}
    </div>
  )
}

// ============================================================
// Per-board settings component
// ============================================================

function BoardComponent({ boardData }: { boardData: BoardData }) {
  const [settings, setSettings] = useState<BoardSettings>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [modifiedSettings, setModifiedSettings] = useState<Set<string>>(new Set())
  const [channelEnabled, setChannelEnabledState] = useState<Record<number, boolean>>({})
  const [advancedMode, setAdvancedMode] = useState(false)
  const [binaryMode, setBinaryMode] = useState(false)
  const [selectedChannel, setSelectedChannel] = useState<string>("0")
  const { toast } = useToast()

  // ── Unit conversion (board-specific) ─────────────────────
  const nsPerSample = getNsPerSample(boardData.name)

  const toDisplay = (reg: RegisterData): string => {
    if (isDcOffsetReg(reg.name)) return ((reg.value_dec / 65535) * 100).toFixed(1)
    if (isTimeReg(reg.name) && nsPerSample > 1) return (reg.value_dec * nsPerSample).toString()
    return reg.value_dec.toString()
  }

  const fromDisplay = (reg: RegisterData, displayVal: string): number => {
    const v = parseFloat(displayVal)
    if (isNaN(v)) return reg.value_dec
    if (isDcOffsetReg(reg.name)) return Math.round((v / 100) * 65535)
    if (isTimeReg(reg.name) && nsPerSample > 1) return Math.round(v / nsPerSample)
    return Math.round(v)
  }

  const unitForName = (name: string): string => {
    if (isDcOffsetReg(name)) return '%'
    if (isTimeReg(name) && nsPerSample > 1) return 'ns'
    return ''
  }

  // ── Data fetching ──────────────────────────────────────────

  const fetchSettings = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await getBoardSettings(boardData.id)
      setSettings(response)

      const channelSet = new Set<number>()
      Object.values(response as BoardSettings).forEach((reg: RegisterData) => {
        if (parseInt(reg.address, 16) <= 0x7000) channelSet.add(reg.channel)
      })
      const channelList = Array.from(channelSet).sort((a, b) => a - b)

      const enableStates: Record<number, boolean> = {}
      await Promise.all(
        channelList.map(async ch => {
          try {
            const enabled = await getChannelEnabled(boardData.id, ch.toString())
            enableStates[ch] = enabled === 1
          } catch {
            enableStates[ch] = false
          }
        })
      )
      setChannelEnabledState(enableStates)
    } catch {
      setError("Failed to load settings data")
      toast({
        title: "Error",
        description: "Failed to fetch settings. Please try again.",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }, [boardData.id])

  useEffect(() => { fetchSettings() }, [fetchSettings])

  // ── Handlers ──────────────────────────────────────────────

  const handleChannelToggle = async (channel: number, enabled: boolean) => {
    try {
      await setChannelEnabled(boardData.id, channel.toString(), enabled ? "1" : "0")
      setChannelEnabledState(prev => ({ ...prev, [channel]: enabled }))
      toast({ title: "Success", description: `Channel ${channel} ${enabled ? "enabled" : "disabled"}` })
    } catch {
      toast({
        title: "Error",
        description: `Failed to ${enabled ? "enable" : "disable"} channel ${channel}`,
        variant: "destructive",
      })
    }
  }

  const handleSettingChange = (regName: string, value: string) => {
    const numValue = Number.parseInt(value)
    if (isNaN(numValue) || numValue < 0 || numValue > 4294967295) return
    setSettings(prev => ({
      ...prev,
      [regName]: {
        ...prev[regName],
        value_dec: numValue,
        value_hex: `0x${numValue.toString(16).toUpperCase()}`,
      },
    }))
    setModifiedSettings(prev => new Set(prev).add(regName))
  }

  /** Update a single bit-field inside a register, recomputing the full value. */
  const handleBitFieldChange = (regName: string, startBit: number, endBit: number, fieldValue: number) => {
    const currentRegValue = settings[regName].value_dec
    const newRegValue = setFieldInRegister(currentRegValue, startBit, endBit, fieldValue)
    setSettings(prev => ({
      ...prev,
      [regName]: {
        ...prev[regName],
        value_dec: newRegValue,
        value_hex: `0x${newRegValue.toString(16).toUpperCase()}`,
      },
    }))
    setModifiedSettings(prev => new Set(prev).add(regName))
  }

  const handleSave = async (regName: string) => {
    try {
      await setSetting(boardData.id, regName, settings[regName].value_dec.toString())
      setModifiedSettings(prev => {
        const next = new Set(prev)
        next.delete(regName)
        return next
      })
      toast({ title: "Success", description: `"${settings[regName].name}" updated` })
    } catch {
      toast({
        title: "Error",
        description: `Failed to update "${settings[regName].name}"`,
        variant: "destructive",
      })
    }
  }

  const handleSaveAll = async () => {
    try {
      await Promise.all(
        Array.from(modifiedSettings).map(regName =>
          setSetting(boardData.id, regName, settings[regName].value_dec.toString())
        )
      )
      setModifiedSettings(new Set())
      toast({ title: "Success", description: "All modified settings saved" })
    } catch {
      toast({ title: "Error", description: "Failed to save some settings", variant: "destructive" })
    }
  }

  const handleBitToggle = (regName: string, bitIndex: number) => {
    const currentValue = settings[regName].value_dec
    const bitMask = bitIndex === 31 ? 0x80000000 : (1 << bitIndex)
    const newValue = (currentValue ^ bitMask) >>> 0
    setSettings(prev => ({
      ...prev,
      [regName]: {
        ...prev[regName],
        value_dec: newValue,
        value_hex: `0x${newValue.toString(16).toUpperCase()}`,
      },
    }))
    setModifiedSettings(prev => new Set(prev).add(regName))
  }

  // ── Helpers ───────────────────────────────────────────────

  const formatBinary = (value: number) => value.toString(2).padStart(32, '0')

  const isTriggerSetting = (reg: RegisterData) =>
    TRIGGER_SETTING_NAMES.some(t =>
      reg.name === t || reg.name.toLowerCase().includes(t.toLowerCase())
    )

  // ── Loading / error states ────────────────────────────────

  if (loading) {
    return (
      <div className="flex justify-center items-center py-8">
        <ReloadIcon className="mr-2 h-4 w-4 animate-spin" />
        Loading settings...
      </div>
    )
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }

  // ── Group registers ───────────────────────────────────────

  const channelSettingsMap: { [channel: number]: { [regName: string]: RegisterData } } = {}
  const commonSettings: { [regName: string]: RegisterData } = {}

  Object.entries(settings).forEach(([regName, reg]) => {
    const address = parseInt(reg.address, 16)
    if (address > 0x7000) {
      if (reg.name !== "Channel Enable Mask") {
        commonSettings[regName] = reg
      }
    } else {
      if (!channelSettingsMap[reg.channel]) channelSettingsMap[reg.channel] = {}
      channelSettingsMap[reg.channel][regName] = reg
    }
  })

  const channels = Object.keys(channelSettingsMap).map(Number).sort((a, b) => a - b)
  const enabledChannels = channels.filter(ch => channelEnabled[ch])

  // Trigger setting names, ordered by preferred sequence
  const triggerOrder = [
    "Trigger Threshold",
    "Input Rise Time",
    "Trigger Hold-Off Width",
    "Trigger Hold-off Width",
    "DC Offset",
  ]
  const allTriggerNames = new Set<string>()
  channels.forEach(ch => {
    Object.values(channelSettingsMap[ch] || {}).forEach(reg => {
      if (isTriggerSetting(reg)) allTriggerNames.add(reg.name)
    })
  })
  const uniqueTriggerNames = Array.from(allTriggerNames).sort((a, b) => {
    const ai = triggerOrder.findIndex(t => a.toLowerCase().includes(t.toLowerCase()))
    const bi = triggerOrder.findIndex(t => b.toLowerCase().includes(t.toLowerCase()))
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
  })

  const findRegForChannelAndName = (channel: number, settingName: string): [string, RegisterData] | null => {
    const chSettings = channelSettingsMap[channel]
    if (!chSettings) return null
    const entry = Object.entries(chSettings).find(([, reg]) => reg.name === settingName)
    return entry ?? null
  }

  // ── Render: binary editor (32-bit button grid) ────────────

  const renderBinaryEditor = (regName: string, reg: RegisterData) => {
    const binaryString = formatBinary(reg.value_dec)
    return (
      <div className="space-y-2">
        <div className="grid grid-cols-8 gap-1 text-xs font-mono">
          {Array.from({ length: 32 }, (_, i) => 31 - i).map(bitPos => (
            <div key={bitPos} className="text-center text-muted-foreground">{bitPos}</div>
          ))}
        </div>
        <div className="grid grid-cols-8 gap-1">
          {Array.from({ length: 32 }, (_, i) => {
            const bitIndex = 31 - i
            const bitValue = binaryString[i]
            return (
              <Button
                key={bitIndex}
                variant={bitValue === '1' ? 'default' : 'outline'}
                size="sm"
                className="h-8 w-full text-xs font-mono p-0"
                onClick={() => handleBitToggle(regName, bitIndex)}
              >
                {bitValue}
              </Button>
            )
          })}
        </div>
        <div className="grid grid-cols-4 gap-1 text-xs font-mono text-muted-foreground">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="text-center">{binaryString.slice(i * 4, i * 4 + 4)}</div>
          ))}
        </div>
      </div>
    )
  }

  // ── Render: bit-field decomposition ──────────────────────

  const renderBitFields = (regName: string, reg: RegisterData, fields: BitFieldDef[]) => {
    const isModified = modifiedSettings.has(regName)
    return (
      <div className="space-y-3">
        {/* Raw value row */}
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="font-mono">
            Hex: {reg.value_hex} | Addr: {reg.address}
            {isModified && <span className="text-orange-500 ml-2">● unsaved</span>}
          </span>
          <Button size="sm" onClick={() => handleSave(regName)} disabled={!isModified}>
            Save
          </Button>
        </div>

        <Separator />

        {/* Bit fields grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2">
          {fields.map(field => {
            const isSingleBit = field.startBit === field.endBit
            const width = field.endBit - field.startBit + 1
            const maxValue = width >= 32 ? 4294967295 : (1 << width) - 1
            const fieldValue = getFieldValue(reg.value_dec, field.startBit, field.endBit)
            const bitLabel = isSingleBit
              ? `[${field.startBit}]`
              : `[${field.startBit}:${field.endBit}]`

            return (
              <div
                key={field.name}
                className="flex items-center justify-between gap-3 py-1"
              >
                <div className="flex-1 min-w-0">
                  <span className="text-sm">{field.name}</span>
                  <span className="text-xs text-muted-foreground ml-1.5 font-mono">{bitLabel}</span>
                </div>
                {isSingleBit ? (
                  <Switch
                    checked={fieldValue === 1}
                    onCheckedChange={checked =>
                      handleBitFieldChange(regName, field.startBit, field.endBit, checked ? 1 : 0)
                    }
                  />
                ) : (
                  <Input
                    type="number"
                    min={0}
                    max={maxValue}
                    value={fieldValue}
                    onChange={e => {
                      const v = parseInt(e.target.value)
                      if (!isNaN(v) && v >= 0 && v <= maxValue) {
                        handleBitFieldChange(regName, field.startBit, field.endBit, v)
                      }
                    }}
                    className="h-7 w-24 text-sm text-right"
                    title={`0–${maxValue}`}
                  />
                )}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  // ── Render: a single register control ────────────────────
  //   compact=true  → plain number input only (used in the trigger table)
  //   compact=false → full view: bit-field decomposition, binary editor, or plain input

  const renderSettingInput = (regName: string, reg: RegisterData, compact = false) => {
    const isModified = modifiedSettings.has(regName)

    if (compact) {
      const unit = unitForName(reg.name)
      const step = isDcOffsetReg(reg.name) ? 0.1 : (isTimeReg(reg.name) && nsPerSample > 1 ? nsPerSample : 1)
      return (
        <div className="space-y-1">
          <div className="flex gap-1 items-center">
            <Input
              type="number"
              min="0"
              max={isDcOffsetReg(reg.name) ? "100" : "4294967295"}
              step={step}
              value={toDisplay(reg)}
              onChange={e => handleSettingChange(regName, fromDisplay(reg, e.target.value).toString())}
              className={`h-8 text-sm ${isModified ? "border-orange-500" : ""}`}
            />
            {unit && <span className="text-xs text-muted-foreground w-6 shrink-0">{unit}</span>}
            <Button size="sm" onClick={() => handleSave(regName)} disabled={!isModified} className="h-8 px-2 text-xs">
              Save
            </Button>
          </div>
          {isModified && <div className="text-xs text-muted-foreground font-mono">{reg.value_hex}</div>}
        </div>
      )
    }

    // Full mode: check for bit-field decomposition
    const decomposition = getDecomposition(reg.name, boardData.dpp, boardData.name)

    if (binaryMode) {
      // Binary editor overrides decomposition when explicitly requested
      return (
        <div className="space-y-2">
          {renderBinaryEditor(regName, reg)}
          <div className="flex justify-end">
            <Button size="sm" onClick={() => handleSave(regName)} disabled={!isModified}>Save</Button>
          </div>
          <div className="text-xs text-muted-foreground font-mono">
            Dec: {reg.value_dec} | Hex: {reg.value_hex} | Addr: {reg.address}
          </div>
        </div>
      )
    }

    if (decomposition) {
      return renderBitFields(regName, reg, decomposition)
    }

    // Plain numeric input
    const unit = unitForName(reg.name)
    const step = isDcOffsetReg(reg.name) ? 0.1 : (isTimeReg(reg.name) && nsPerSample > 1 ? nsPerSample : 1)
    return (
      <div className="space-y-1">
        <div className="flex gap-2 items-center">
          <Input
            type="number"
            min="0"
            max={isDcOffsetReg(reg.name) ? "100" : "4294967295"}
            step={step}
            value={toDisplay(reg)}
            onChange={e => handleSettingChange(regName, fromDisplay(reg, e.target.value).toString())}
            className={isModified ? "border-orange-500" : ""}
          />
          {unit && <span className="text-xs text-muted-foreground w-6 shrink-0">{unit}</span>}
          <Button size="sm" onClick={() => handleSave(regName)} disabled={!isModified}>Save</Button>
        </div>
        <div className="text-xs text-muted-foreground font-mono">
          Hex: {reg.value_hex} | Addr: {reg.address}
        </div>
      </div>
    )
  }

  // ── Main render ───────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">
          Settings for {boardData.name}
          <Badge variant="outline" className="ml-2 font-mono text-xs">
            {boardData.dpp || "?"}
          </Badge>
        </h3>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Label htmlFor="advanced-mode">Advanced</Label>
            <Switch id="advanced-mode" checked={advancedMode} onCheckedChange={setAdvancedMode} />
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="binary-mode">Binary</Label>
            <Switch id="binary-mode" checked={binaryMode} onCheckedChange={setBinaryMode} />
          </div>
        </div>
      </div>

      {/* ── Channel Enable ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Channel Enable</CardTitle>
        </CardHeader>
        <CardContent>
          {channels.length === 0 ? (
            <p className="text-sm text-muted-foreground">No channels found.</p>
          ) : (
            <div className="flex flex-wrap gap-6">
              {channels.map(ch => (
                <div key={ch} className="flex flex-col items-center gap-2 min-w-12">
                  <span className="text-sm font-medium">Ch {ch}</span>
                  <Switch
                    checked={channelEnabled[ch] ?? false}
                    onCheckedChange={enabled => handleChannelToggle(ch, enabled)}
                  />
                  <Badge variant={channelEnabled[ch] ? "default" : "secondary"} className="text-xs px-2">
                    {channelEnabled[ch] ? "ON" : "OFF"}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Trigger Settings – multi-channel table ── */}
      {uniqueTriggerNames.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Trigger Settings</CardTitle>
          </CardHeader>
          <CardContent>
            {enabledChannels.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No channels enabled. Enable at least one channel above to configure trigger settings.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-2 pr-6 font-medium text-muted-foreground">Setting</th>
                      {enabledChannels.map(ch => (
                        <th key={ch} className="text-center py-2 px-3 font-medium min-w-44">
                          Channel {ch}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {uniqueTriggerNames.map(settingName => (
                      <tr key={settingName} className="border-b last:border-0">
                        <td className="py-3 pr-6 font-medium whitespace-nowrap">
                          {settingName}
                          {unitForName(settingName) && (
                            <span className="text-xs font-normal text-muted-foreground ml-1">
                              ({unitForName(settingName)})
                            </span>
                          )}
                        </td>
                        {enabledChannels.map(ch => {
                          const entry = findRegForChannelAndName(ch, settingName)
                          if (!entry) {
                            return <td key={ch} className="py-3 px-3 text-center text-muted-foreground">—</td>
                          }
                          const [regName, reg] = entry
                          return (
                            <td key={ch} className="py-3 px-3">
                              {renderSettingInput(regName, reg, true)}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── General / Channel tabs ── */}
      <Tabs defaultValue="general">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="general">General Settings</TabsTrigger>
          <TabsTrigger value="channels">Channel Settings</TabsTrigger>
        </TabsList>

        {/* General Settings */}
        <TabsContent value="general" className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                General Settings
                {!advancedMode && (
                  <span className="text-sm font-normal text-muted-foreground ml-2">(Basic mode)</span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {Object.keys(commonSettings).length === 0 ? (
                <p className="text-sm text-muted-foreground">No general settings available.</p>
              ) : (
                <div className="space-y-6">
                  {Object.entries(commonSettings)
                    .filter(([, reg]) =>
                      advancedMode || BASIC_GENERAL_SETTINGS.some(b => reg.name.includes(b))
                    )
                    .map(([regName, reg]) => {
                      const hasDecomp = !binaryMode && getDecomposition(reg.name, boardData.dpp, boardData.name)
                      return (
                        <div key={regName}>
                          <div className="flex items-center gap-2 mb-2">
                            <Label className="text-sm font-semibold">
                              {reg.name}
                              {modifiedSettings.has(regName) && <span className="text-orange-500 ml-1">*</span>}
                            </Label>
                            {hasDecomp && (
                              <Badge variant="outline" className="text-xs">decomposed</Badge>
                            )}
                          </div>
                          {renderSettingInput(regName, reg)}
                        </div>
                      )
                    })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Channel Settings */}
        <TabsContent value="channels" className="space-y-4">
          {channels.length === 0 ? (
            <div className="text-center text-muted-foreground py-8">
              No channel settings available for this board.
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-sm font-medium">Channel:</span>
                {channels.map(ch => (
                  <Button
                    key={ch}
                    variant={selectedChannel === ch.toString() ? "default" : "outline"}
                    size="sm"
                    onClick={() => setSelectedChannel(ch.toString())}
                    className="flex items-center gap-1.5"
                  >
                    Ch {ch}
                    <Badge
                      variant={channelEnabled[ch] ? "default" : "secondary"}
                      className="text-xs px-1.5 py-0 ml-0.5"
                    >
                      {channelEnabled[ch] ? "ON" : "OFF"}
                    </Badge>
                  </Button>
                ))}
              </div>

              {selectedChannel && channelSettingsMap[parseInt(selectedChannel)] && (() => {
                const chRegs = channelSettingsMap[parseInt(selectedChannel)]
                const triggerEntries = Object.entries(chRegs).filter(([, reg]) => isTriggerSetting(reg))
                const otherEntries = Object.entries(chRegs).filter(([, reg]) => !isTriggerSetting(reg))

                const renderSection = (
                  title: string,
                  entries: [string, RegisterData][],
                ) => (
                  <div>
                    <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-4">
                      {title}
                    </h4>
                    <div className="space-y-6">
                      {entries.map(([regName, reg]) => {
                        const hasDecomp = !binaryMode && getDecomposition(reg.name, boardData.dpp, boardData.name)
                        return (
                          <div key={regName}>
                            <div className="flex items-center gap-2 mb-2">
                              <Label className="text-sm font-semibold">
                                {reg.name}
                                {modifiedSettings.has(regName) && <span className="text-orange-500 ml-1">*</span>}
                              </Label>
                              {hasDecomp && (
                                <Badge variant="outline" className="text-xs">decomposed</Badge>
                              )}
                            </div>
                            {renderSettingInput(regName, reg)}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )

                return (
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base flex items-center gap-2">
                        Channel {selectedChannel}
                        <Badge variant={channelEnabled[parseInt(selectedChannel)] ? "default" : "secondary"}>
                          {channelEnabled[parseInt(selectedChannel)] ? "Enabled" : "Disabled"}
                        </Badge>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-8">
                      {triggerEntries.length > 0 && renderSection("Trigger Settings", triggerEntries)}
                      {triggerEntries.length > 0 && otherEntries.length > 0 && <Separator />}
                      {otherEntries.length > 0 && renderSection("Other Settings", otherEntries)}
                    </CardContent>
                  </Card>
                )
              })()}
            </>
          )}
        </TabsContent>
      </Tabs>

      {/* Save All */}
      {modifiedSettings.size > 0 && (
        <div className="flex justify-center">
          <Button onClick={handleSaveAll} className="bg-green-600 hover:bg-green-700">
            Save All Modified Settings ({modifiedSettings.size})
          </Button>
        </div>
      )}
    </div>
  )
}
