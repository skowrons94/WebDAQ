"use client"

import { useState, useEffect, useCallback } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { NumericInput } from "@/components/ui/numeric-input"
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
import {
  getBoardConfiguration, getBoardSettings, setSetting, updateJSON,
  getChannelEnabled, setChannelEnabled, getSyncSettings,
  START_MODE_SW, START_MODE_FIRST_TRIGGER,
  type SyncSettings,
} from "@/lib/api"
import {
  getRegisterOptions, getFieldOptions, getRegisterDoc,
  categorizeRegister, CATEGORY_LABELS, CATEGORY_ORDER,
  getChannelSections, getBoardSections, getFieldDoc,
  type RegisterCategory, type SettingSection, type CuratedSetting,
} from "@/lib/caen-registers"
import { InfoTooltip } from "@/components/ui/info-tooltip"

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
  { name: "Digital Virtual Probe 2", startBit: 26, endBit: 28 },
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
  // Two independent enables, not one 2-bit code (UM4380 rev.6 p.28).
  { name: "PSD Cut Below Threshold",   startBit: 27, endBit: 27 },
  { name: "PSD Cut Above Threshold",   startBit: 28, endBit: 28 },
  { name: "Over Range Rejection",      startBit: 29, endBit: 29 },
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
  { name: "PSD Cut Below Threshold",   startBit: 27, endBit: 27 },
  { name: "PSD Cut Above Threshold",   startBit: 28, endBit: 28 },
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

// ── Acquisition Control (0x8100) ────────────────────────────
// The register that decides how a run starts — and therefore whether several
// boards take synchronised data. Identical for PHA and PSD.
// (UM5678 rev.3 p.43 / UM4380 rev.6 p.43)
const ACQUISITION_CONTROL: BitFieldDef[] = [
  { name: "Start/Stop Mode",       startBit: 0,  endBit: 1  },
  { name: "Acquisition Start/Arm", startBit: 2,  endBit: 2  },
  { name: "PLL Reference Clock",   startBit: 6,  endBit: 6  },
  { name: "LVDS Busy Enable",      startBit: 8,  endBit: 8  },
  { name: "LVDS Veto Enable",      startBit: 9,  endBit: 9  },
  { name: "LVDS RunIn Mode",       startBit: 11, endBit: 11 },
  { name: "VetoIn Inhibits TRG-OUT", startBit: 12, endBit: 12 },
]

// ── Front Panel I/O Control (0x811C) ────────────────────────
// Decides what TRG-OUT/GPO carries — the other half of daisy-chain
// synchronisation. (UM5678 rev.3 pp.51-53)
const FRONT_PANEL_IO_CONTROL: BitFieldDef[] = [
  { name: "LEMO I/O Level",     startBit: 0,  endBit: 0  },
  { name: "TRG-OUT Enable",     startBit: 1,  endBit: 1  },
  { name: "TRG-IN Control",     startBit: 10, endBit: 10 },
  { name: "TRG-IN to Mezzanines", startBit: 11, endBit: 11 },
  { name: "Force TRG-OUT Level", startBit: 14, endBit: 14 },
  { name: "TRG-OUT Test Mode",  startBit: 15, endBit: 15 },
  { name: "TRG-OUT Mode",       startBit: 16, endBit: 17 },
  { name: "Motherboard Probe",  startBit: 18, endBit: 19 },
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
  // Tolerate the "Acquistion Control" typo present in some firmware dumps.
  if (isAcquisitionControl(registerName)) return ACQUISITION_CONTROL
  if (registerName.includes("Front Panel I/O Control")) return FRONT_PANEL_IO_CONTROL
  return null
}

/** Matches the acquisition-control register across firmware spelling variants. */
function isAcquisitionControl(registerName: string): boolean {
  const n = registerName.toLowerCase()
  return n.includes("acquisition control") || n.includes("acquistion control")
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

/**
 * Split a board's registers into per-channel groups.
 *
 * Addresses at or below 0x7000 are per-channel (the channel index is encoded in
 * the address); everything above is board-wide. Used both for rendering and for
 * copying settings between channels.
 */
function groupChannelSettings(
  settings: BoardSettings,
): { [channel: number]: { [regName: string]: RegisterData } } {
  const byChannel: { [channel: number]: { [regName: string]: RegisterData } } = {}
  Object.entries(settings).forEach(([regName, reg]) => {
    if (parseInt(reg.address, 16) > 0x7000) return
    if (!byChannel[reg.channel]) byChannel[reg.channel] = {}
    byChannel[reg.channel][regName] = reg
  })
  return byChannel
}

// Names identifying trigger-related channel settings
const TRIGGER_SETTING_NAMES = [
  "Trigger Threshold",
  "Input Rise Time",
  "Trigger Hold-Off Width",
  "Trigger Hold-off Width",
  "DC Offset",
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
      // The server sends numeric ids; the Select hands back strings. Normalise
      // here so board 0 — which is falsy as a number — behaves like any other.
      const boardList = (response.data ?? []).map((board: BoardData) => ({
        ...board,
        id: String(board.id),
      }))
      setBoards(boardList)
      if (boardList.length > 0 && selectedBoardId === "") {
        setSelectedBoardId(boardList[0].id)
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

  const selectedBoard = boards.find(board => String(board.id) === String(selectedBoardId))

  return (
    <div className="container mx-auto p-4">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">CAEN Dashboard</h1>
        <Button onClick={fetchBoardConfiguration}>Refresh</Button>
      </div>

      {/* Board tuning and synchronisation are separate jobs: one is per-channel
          detail work, the other is a system-wide decision about whether the
          boards share a time origin. Keep them in their own sub-dashboards. */}
      <Tabs defaultValue="boards">
        <TabsList className="grid w-full max-w-md grid-cols-2 mb-6">
          <TabsTrigger value="boards">Board Settings</TabsTrigger>
          <TabsTrigger value="sync">Synchronization</TabsTrigger>
        </TabsList>

        <TabsContent value="boards" className="space-y-6">
          <div>
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
        </TabsContent>

        <TabsContent value="sync">
          {/* Remounted when the board list changes so the chain is re-read. */}
          <AcquisitionControlCard key={boards.map(b => b.id).join(",")} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

/**
 * A register's name, plus the one-line explanation from the CAEN manual.
 *
 * PROBLEMS.md asked for every displayed register to say what it actually is —
 * so the label carries the description and the "decomposed" marker, and the
 * input underneath carries the raw value, unit and address.
 */
function RegisterLabel({
  reg, modified, decomposed,
}: {
  reg: RegisterData
  modified: boolean
  decomposed: boolean
}) {
  const doc = getRegisterDoc(reg.name)
  return (
    <div className="mb-2">
      <div className="flex items-center gap-1.5">
        <Label className="text-sm font-semibold">
          {reg.name}
          {modified && <span className="text-orange-500 ml-1">*</span>}
        </Label>
        {doc && <InfoTooltip text={doc.description} />}
        {decomposed && <Badge variant="outline" className="text-xs">decomposed</Badge>}
      </div>
    </div>
  )
}

// ============================================================
// Acquisition Control — multi-board synchronisation
// ============================================================

/**
 * Board synchronisation, front and centre.
 *
 * Whether a board joins the chain is decided by its OWN Acquisition Control
 * register (0x8100 bits[1:0]) — there is no separate setting that could drift
 * out of step with the hardware. This card reads those registers back, shows the
 * resulting chain, and offers one plain-language dropdown per board to change
 * them.
 *
 * How a run then starts:
 *   • boards on "Independent (software)" start on their own command;
 *   • boards on "On first trigger" are armed, and once every board is armed the
 *     master fires a software trigger that walks the TRG-OUT → TRG-IN chain,
 *     starting them all at the same instant.
 */
function AcquisitionControlCard({ onChanged }: { onChanged?: () => void }) {
  const [sync, setSync] = useState<SyncSettings | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { toast } = useToast()

  const load = useCallback(async () => {
    try {
      setSync(await getSyncSettings())
      setError(null)
    } catch {
      setError("Could not load the synchronisation settings.")
    }
  }, [])

  useEffect(() => { load() }, [load])

  /**
   * Rewrite one bit field of one register, found by name.
   * Read-modify-write, so everything else in that register survives.
   */
  const setRegField = async (
    boardId: string | number, match: (name: string) => boolean, label: string,
    startBit: number, endBit: number, value: number, description: string,
  ) => {
    setSaving(String(boardId))
    try {
      const regs = await getBoardSettings(String(boardId))
      const entry = Object.entries(regs as BoardSettings).find(([, r]) => match(r.name))
      if (!entry) throw new Error(`no ${label} register`)
      const [regName, reg] = entry
      const next = setFieldInRegister(reg.value_dec, startBit, endBit, value)
      await setSetting(String(boardId), regName, next.toString())
      await load()
      onChanged?.()
      toast({ title: `${label} updated`, description })
    } catch {
      toast({
        title: "Error",
        description: `Could not update ${label} for this board. Re-read the board configuration if the register is missing.`,
        variant: "destructive",
      })
    } finally {
      setSaving(null)
    }
  }

  const matchAcq = isAcquisitionControl
  const matchFpio = (n: string) => n.includes("Front Panel I/O Control")
  const matchTrgOutMask = (n: string) => n.includes("Front Panel TRG-OUT")

  const setStartMode = (boardId: string | number, mode: number) =>
    setRegField(boardId, matchAcq, "Acquisition Control", 0, 1, mode,
      mode === START_MODE_SW
        ? "This board will start on its own software command."
        : "This board will be armed and started by the trigger chain.")

  const setClockSource = (boardId: string | number, source: number) =>
    setRegField(boardId, matchAcq, "Acquisition Control", 6, 6, source,
      source === 0
        ? "This board uses its internal 50 MHz oscillator."
        : "This board takes its clock from the front-panel CLK-IN.")

  const setTrgOutMode = (boardId: string | number, mode: number) =>
    setRegField(boardId, matchFpio, "Front Panel I/O Control", 16, 17, mode,
      mode === 0
        ? "TRG-OUT now carries the trigger, so it can drive the chain."
        : "TRG-OUT no longer carries the trigger — this board cannot pass the start on.")

  const setSwTriggerToTrgOut = (boardId: string | number, on: number) =>
    setRegField(boardId, matchTrgOutMask, "TRG-OUT Enable Mask", 31, 31, on,
      on ? "The software trigger now reaches TRG-OUT and can start the chain."
         : "The software trigger no longer reaches TRG-OUT.")

  const setExtTriggerToTrgOut = (boardId: string | number, on: number) =>
    setRegField(boardId, matchTrgOutMask, "TRG-OUT Enable Mask", 30, 30, on,
      on ? "TRG-IN is now forwarded to TRG-OUT, passing the start down the chain."
         : "TRG-IN is no longer forwarded — boards after this one will not start.")

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Acquisition Control</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }
  if (!sync) return null

  const chained = sync.mode === "daisy-chain"
  const master = sync.chain.find(e => e.role === "master")
  const chainMembers = sync.chain.filter(e => e.synchronised)

  return (
    <Card className={chained ? "border-green-600/50" : undefined}>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          Acquisition Control
          <Badge variant={chained ? "default" : "secondary"}>
            {chained ? "Synchronised" : "Independent"}
          </Badge>
        </CardTitle>
        <p className="text-sm text-muted-foreground mt-1.5 max-w-3xl">
          {chained
            ? "Boards set to start on the first trigger are chained together, so they share one time origin and their timestamps are directly comparable."
            : "Every board starts on its own software command, so each one counts time from a different origin — timestamps are NOT comparable across boards. Set the boards to start on the first trigger to correlate events between them."}
        </p>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* Per-board start mode + clock source */}
        <div className="space-y-2">
          <div className="hidden md:flex items-center gap-4 px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <span className="flex-1">Board</span>
            <span className="w-60">Start mode</span>
            <span className="w-56">Clock source</span>
          </div>
          {sync.chain.map(entry => (
            <div
              key={String(entry.board_id)}
              className="rounded-md border px-3 py-2 space-y-3"
            >
              <div className="flex flex-col md:flex-row md:items-center gap-3 md:gap-4">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium flex items-center gap-2">
                  {entry.name}
                  <span className="text-xs text-muted-foreground font-normal">
                    id {String(entry.board_id)}
                  </span>
                  {entry.role === "master" && (
                    <Badge variant="default" className="text-xs">master</Badge>
                  )}
                  {entry.role === "slave" && (
                    <Badge variant="outline" className="text-xs">slave</Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {entry.role === "master"
                    ? "Fires the software trigger that starts the chain."
                    : entry.role === "slave"
                    ? "Armed, then started by the trigger arriving on TRG-IN."
                    : "Starts by itself, outside the chain."}
                </div>
              </div>

              <Select
                value={entry.start_mode.toString()}
                disabled={saving === String(entry.board_id)}
                onValueChange={v => setStartMode(entry.board_id, parseInt(v))}
              >
                <SelectTrigger className="w-full md:w-60 h-9 shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={START_MODE_SW.toString()}>
                    Independent (software)
                  </SelectItem>
                  <SelectItem value={START_MODE_FIRST_TRIGGER.toString()}>
                    On first trigger (synchronised)
                  </SelectItem>
                </SelectContent>
              </Select>

              <Select
                value={entry.clock_source.toString()}
                disabled={saving === String(entry.board_id)}
                onValueChange={v => setClockSource(entry.board_id, parseInt(v))}
              >
                <SelectTrigger className="w-full md:w-56 h-9 shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">Internal (50 MHz)</SelectItem>
                  <SelectItem value="1">External CLK-IN</SelectItem>
                </SelectContent>
              </Select>
              </div>

              {/* What the board actually puts on the cable. Only relevant for
                  boards taking part in the chain. */}
              {entry.synchronised && (
                <div className="flex flex-col md:flex-row md:items-center gap-3 md:gap-6 pt-1 border-t">
                  <div className="flex items-center gap-2">
                    <Label className="text-xs text-muted-foreground w-28 md:w-auto">
                      TRG-OUT carries
                    </Label>
                    <Select
                      value={entry.trg_out_mode.toString()}
                      disabled={saving === String(entry.board_id)}
                      onValueChange={v => setTrgOutMode(entry.board_id, parseInt(v))}
                    >
                      <SelectTrigger className="h-8 w-52 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="0">Trigger (drives the chain)</SelectItem>
                        <SelectItem value="1">Motherboard probe</SelectItem>
                        <SelectItem value="2">Channel probe</SelectItem>
                        <SelectItem value="3">S-IN / GPI propagation</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex items-center gap-2">
                    <Switch
                      id={`sw-${entry.board_id}`}
                      checked={entry.sw_trigger_to_trg_out === 1}
                      disabled={saving === String(entry.board_id)}
                      onCheckedChange={v => setSwTriggerToTrgOut(entry.board_id, v ? 1 : 0)}
                    />
                    <Label htmlFor={`sw-${entry.board_id}`} className="text-xs">
                      SW trigger → TRG-OUT
                    </Label>
                    <InfoTooltip
                      side="bottom"
                      text="Puts the software trigger on the TRG-OUT connector (0x8110 bit 31). The master needs this: without it, the trigger that starts the chain never leaves the board."
                    />
                  </div>

                  <div className="flex items-center gap-2">
                    <Switch
                      id={`ext-${entry.board_id}`}
                      checked={entry.ext_trigger_to_trg_out === 1}
                      disabled={saving === String(entry.board_id)}
                      onCheckedChange={v => setExtTriggerToTrgOut(entry.board_id, v ? 1 : 0)}
                    />
                    <Label htmlFor={`ext-${entry.board_id}`} className="text-xs">
                      TRG-IN → TRG-OUT
                    </Label>
                    <InfoTooltip
                      side="bottom"
                      text="Forwards the trigger arriving on TRG-IN straight back out (0x8110 bit 30), so the start walks to the next board. Every board except the last one in the chain needs this."
                    />
                  </div>
                </div>
              )}

              {entry.problems?.length > 0 && (
                <div className="rounded-md border border-orange-500/50 bg-orange-500/5 px-3 py-2">
                  {entry.problems.map((p, i) => (
                    <p key={i} className="text-xs text-orange-600 dark:text-orange-400">
                      ⚠ {p}
                    </p>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Why the clock matters, next to where it is set. */}
        <div className="rounded-md bg-muted/50 p-3 text-sm">
          <div className="font-medium text-xs uppercase tracking-wide text-muted-foreground mb-1.5">
            Clock source
          </div>
          <p className="text-muted-foreground">
            Synchronising the <em>start</em> aligns the boards at t=0; sharing a{" "}
            <em>clock</em> keeps them aligned. On their own 50 MHz oscillators the boards
            drift apart over a long run. To avoid that, distribute one clock: leave the
            first board on <span className="font-medium text-foreground">Internal</span>,
            feed its CLK-OUT to the next board&apos;s CLK-IN, and set every downstream board
            to <span className="font-medium text-foreground">External CLK-IN</span>.
          </p>
          <p className="text-xs text-muted-foreground mt-2">
            Register <span className="font-mono">0x8100</span> bit [6]. Desktop and NIM
            digitizers only — on VME boards the clock comes from the crate and this bit is
            reserved.
          </p>
        </div>

        {!sync.applicable && (
          <Alert>
            <AlertTitle>Only one board configured</AlertTitle>
            <AlertDescription>
              Synchronisation chains several boards together — with a single board there is
              nothing to chain.
            </AlertDescription>
          </Alert>
        )}

        {chained && chainMembers.length > 1 && (
          <>
            {/* Required cabling */}
            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                Cable the chain in this order
              </h4>
              <div className="flex items-center gap-2 flex-wrap">
                {chainMembers.map((entry, i) => (
                  <div key={String(entry.board_id)} className="flex items-center gap-2">
                    <div
                      className={`rounded-md border px-3 py-2 ${
                        entry.role === "master" ? "border-green-600/60 bg-green-600/5" : ""
                      }`}
                    >
                      <div className="text-sm font-medium">{entry.name}</div>
                      <div className="text-xs text-muted-foreground">
                        id {String(entry.board_id)} · {entry.role}
                      </div>
                    </div>
                    {i < chainMembers.length - 1 && (
                      <div className="text-xs text-muted-foreground font-mono whitespace-nowrap">
                        TRG-OUT →<br />TRG-IN
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* What actually happens, in order */}
            <div className="rounded-md bg-muted/50 p-3 text-sm space-y-1.5">
              <div className="font-medium text-xs uppercase tracking-wide text-muted-foreground">
                Start sequence
              </div>
              <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
                <li>
                  Every synchronised board is{" "}
                  <span className="font-medium text-foreground">armed</span> — it waits, acquiring
                  nothing, for a pulse on TRG-IN.
                </li>
                <li>
                  Once they are <em>all</em> armed, the{" "}
                  <span className="font-medium text-foreground">master</span>
                  {master ? ` (${master.name})` : ""} fires a{" "}
                  <span className="font-medium text-foreground">software trigger</span>.
                </li>
                <li>
                  That pulse leaves on TRG-OUT, enters the next board&apos;s TRG-IN, and walks the
                  chain — starting every board at the same instant.
                </li>
              </ol>
            </div>
          </>
        )}

        <p className="text-xs text-muted-foreground">
          This is register <span className="font-mono">0x8100</span> bits [1:0]. The full
          register — clock source, LVDS and veto options — is in General Settings.
        </p>
      </CardContent>
    </Card>
  )
}

// ============================================================
// Per-board settings component
// ============================================================

function BoardComponent({ boardData }: { boardData: BoardData }) {
  const [settings, setSettings] = useState<BoardSettings>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Registers with unsaved edits — what actually gets written.
  const [modifiedSettings, setModifiedSettings] = useState<Set<string>>(new Set())
  // Which individual bit fields were edited, keyed `${regName}#${start}:${end}`.
  // Several curated controls share one register (six of them live in DPP
  // Algorithm Control), so register-level tracking alone would light up every
  // one of their Save buttons after a single change. This keeps the marks on
  // the control the user actually touched; saving any of them still writes the
  // whole register, which is why saving one clears its siblings too.
  const [modifiedFields, setModifiedFields] = useState<Set<string>>(new Set())
  const [channelEnabled, setChannelEnabledState] = useState<Record<number, boolean>>({})
  const [advancedMode, setAdvancedMode] = useState(false)
  const [binaryMode, setBinaryMode] = useState(false)
  const [selectedChannel, setSelectedChannel] = useState<string>("0")
  // Channel-to-channel copy (see handleCopyChannel).
  const [copySource, setCopySource] = useState<string>("0")
  const [copyTargets, setCopyTargets] = useState<Set<number>>(new Set())
  const [copying, setCopying] = useState(false)
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
      // Fresh values from the board: nothing is pending any more.
      setModifiedSettings(new Set())
      setModifiedFields(new Set())

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

  /** Key identifying one bit field of one register, for dirty tracking. */
  const fieldKey = (regName: string, startBit: number, endBit: number) =>
    `${regName}#${startBit}:${endBit}`

  /** Forget every pending mark for a register — used once it has been written. */
  const clearModified = (regNames: string[]) => {
    const names = new Set(regNames)
    setModifiedSettings(prev => {
      const next = new Set(prev)
      names.forEach(n => next.delete(n))
      return next
    })
    setModifiedFields(prev => {
      const next = new Set(prev)
      // A register write carries all of its fields, so they are all saved.
      prev.forEach(key => {
        if (names.has(key.split("#")[0])) next.delete(key)
      })
      return next
    })
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
    setModifiedFields(prev => new Set(prev).add(fieldKey(regName, startBit, endBit)))
  }

  const handleSave = async (regName: string) => {
    try {
      await setSetting(boardData.id, regName, settings[regName].value_dec.toString())
      clearModified([regName])
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
      setModifiedFields(new Set())
      toast({ title: "Success", description: "All modified settings saved" })
    } catch {
      toast({ title: "Error", description: "Failed to save some settings", variant: "destructive" })
    }
  }

  /**
   * Copy every per-channel setting from one channel onto others.
   *
   * Registers are matched by their human name (e.g. "Trigger Threshold"), not by
   * address, because the address encodes the channel. Anything the source has
   * that a target doesn't is skipped rather than failing the whole copy.
   *
   * Values are written straight to the board and the local state is updated to
   * match, so the copy is immediately visible and needs no separate save.
   */
  const handleCopyChannel = async (source: number, targets: number[]) => {
    const byChannel = groupChannelSettings(settings)
    const sourceRegs = byChannel[source]
    if (!sourceRegs || targets.length === 0) return

    setCopying(true)
    const writes: { regName: string; value: number }[] = []

    for (const target of targets) {
      const targetRegs = byChannel[target]
      if (!targetRegs) continue
      for (const srcReg of Object.values(sourceRegs)) {
        const entry = Object.entries(targetRegs).find(([, r]) => r.name === srcReg.name)
        if (!entry) continue
        const [targetRegName, targetReg] = entry
        if (targetReg.value_dec === srcReg.value_dec) continue // already identical
        writes.push({ regName: targetRegName, value: srcReg.value_dec })
      }
    }

    if (writes.length === 0) {
      setCopying(false)
      toast({
        title: "Nothing to copy",
        description: `The selected channel(s) already match channel ${source}.`,
      })
      return
    }

    try {
      await Promise.all(
        writes.map(w => setSetting(boardData.id, w.regName, w.value.toString()))
      )
      // Reflect the new values locally so the UI matches the board without a refetch.
      setSettings(prev => {
        const next = { ...prev }
        for (const w of writes) {
          if (!next[w.regName]) continue
          next[w.regName] = {
            ...next[w.regName],
            value_dec: w.value,
            value_hex: `0x${w.value.toString(16).toUpperCase()}`,
          }
        }
        return next
      })
      // These are saved, so drop them from the unsaved sets.
      clearModified(writes.map(w => w.regName))
      toast({
        title: "Settings copied",
        description: `${writes.length} setting(s) copied from channel ${source} to channel(s) ${targets.join(", ")}.`,
      })
    } catch {
      toast({
        title: "Copy failed",
        description: "Some settings could not be written. Refresh to see the board's actual state.",
        variant: "destructive",
      })
    } finally {
      setCopying(false)
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

  const channelSettingsMap = groupChannelSettings(settings)
  const commonSettings: { [regName: string]: RegisterData } = {}

  Object.entries(settings).forEach(([regName, reg]) => {
    if (parseInt(reg.address, 16) <= 0x7000) return
    if (reg.name !== "Channel Enable Mask") commonSettings[regName] = reg
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
        <div className="text-xs text-muted-foreground font-mono">
          Reg value: {reg.value_dec}
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
            // Fields the manual defines as a closed set become dropdowns, so a
            // raw code like "4" is never presented where "1024 samples" is meant.
            const options = getFieldOptions(field.name, boardData.dpp)
            const selected = options?.find(o => o.value === fieldValue)

            return (
              <div
                key={field.name}
                className="flex items-center justify-between gap-3 py-1"
              >
                <div className="flex-1 min-w-0">
                  <span className="text-sm">{field.name}</span>
                  <span className="text-xs text-muted-foreground ml-1.5 font-mono">{bitLabel}</span>
                  {selected?.hint && (
                    <div className="text-xs text-muted-foreground leading-tight mt-0.5">
                      {selected.hint}
                    </div>
                  )}
                </div>
                {options ? (
                  <Select
                    value={fieldValue.toString()}
                    onValueChange={v =>
                      handleBitFieldChange(regName, field.startBit, field.endBit, parseInt(v))
                    }
                  >
                    <SelectTrigger className="h-7 w-56 text-sm shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {options.map(opt => (
                        <SelectItem key={opt.value} value={opt.value.toString()}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : isSingleBit ? (
                  <Switch
                    checked={fieldValue === 1}
                    onCheckedChange={checked =>
                      handleBitFieldChange(regName, field.startBit, field.endBit, checked ? 1 : 0)
                    }
                  />
                ) : (
                  <NumericInput
                    min={0}
                    max={maxValue}
                    value={fieldValue}
                    onValueChange={v => {
                      const iv = Math.round(v)
                      if (iv >= 0 && iv <= maxValue) {
                        handleBitFieldChange(regName, field.startBit, field.endBit, iv)
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

  // ── Render: curated settings ─────────────────────────────
  //   Resolves a CuratedSetting against the registers actually present and
  //   renders it as one labelled row. Returns null when the board/firmware does
  //   not have that register or field, so the sections adapt themselves.

  const renderCuratedRow = (
    item: CuratedSetting,
    regs: { [regName: string]: RegisterData },
    key: string,
  ) => {
    const entry = Object.entries(regs).find(([, r]) => r.name === item.register)
    if (!entry) return null
    const [regName, reg] = entry

    // Whole-register control: reuse the normal input (handles unit conversion,
    // enumerated values and the save button).
    if (!item.field) {
      const doc = getRegisterDoc(reg.name)
      return (
        <div key={key} className="space-y-1.5">
          <div className="flex items-center gap-1.5 min-h-5">
            <Label className="text-sm font-medium">
              {item.label ?? reg.name}
              {modifiedSettings.has(regName) && <span className="text-orange-500 ml-1">*</span>}
            </Label>
            {doc && <InfoTooltip text={doc.description} />}
          </div>
          {renderSettingInput(regName, reg, true)}
        </div>
      )
    }

    // Bit-field control: pull the field out of its register so it reads as an
    // ordinary switch or dropdown.
    const fields = getDecomposition(reg.name, boardData.dpp, boardData.name)
    const field = fields?.find(f => f.name === item.field)
    if (!field) return null

    const isSingleBit = field.startBit === field.endBit
    const width = field.endBit - field.startBit + 1
    const maxValue = width >= 32 ? 4294967295 : (1 << width) - 1
    const value = getFieldValue(reg.value_dec, field.startBit, field.endBit)
    const options = getFieldOptions(field.name, boardData.dpp)
    const selected = options?.find(o => o.value === value)
    // Only this field, not every other field sharing the register.
    const isModified = modifiedFields.has(fieldKey(regName, field.startBit, field.endBit))

    // Explanation + where the bit lives + any caveat on the chosen option, all
    // behind the tooltip so every row in the grid starts at the same height.
    const bits = isSingleBit ? `${field.startBit}` : `${field.startBit}:${field.endBit}`
    const doc = getFieldDoc(field.name, boardData.dpp)
    const tip = [
      doc,
      selected?.hint ? `This option: ${selected.hint}` : null,
      `${reg.name}, bit${isSingleBit ? "" : "s"} [${bits}].`,
    ].filter(Boolean).join(" ")

    return (
      <div key={key} className="space-y-1.5">
        <div className="flex items-center gap-1.5 min-h-5">
          <Label className="text-sm font-medium">
            {item.label ?? field.name}
            {isModified && <span className="text-orange-500 ml-1">*</span>}
          </Label>
          <InfoTooltip text={tip} />
        </div>
        <div className="flex items-center gap-2">
          {options ? (
            <Select
              value={value.toString()}
              onValueChange={v =>
                handleBitFieldChange(regName, field.startBit, field.endBit, parseInt(v))
              }
            >
              <SelectTrigger className="h-8 flex-1 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map(opt => (
                  <SelectItem key={opt.value} value={opt.value.toString()}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : isSingleBit ? (
            <div className="flex-1">
              <Switch
                checked={value === 1}
                onCheckedChange={checked =>
                  handleBitFieldChange(regName, field.startBit, field.endBit, checked ? 1 : 0)
                }
              />
            </div>
          ) : (
            <NumericInput
              min={0}
              max={maxValue}
              value={value}
              onValueChange={v => {
                const iv = Math.round(v)
                if (iv >= 0 && iv <= maxValue) {
                  handleBitFieldChange(regName, field.startBit, field.endBit, iv)
                }
              }}
              className="h-8 flex-1 text-sm text-right"
              title={`0–${maxValue}`}
            />
          )}
          <Button
            size="sm"
            className="h-8 px-2 text-xs"
            onClick={() => handleSave(regName)}
            disabled={!isModified}
          >
            Save
          </Button>
        </div>
      </div>
    )
  }

  /** One curated section; renders nothing when none of its settings exist. */
  const renderCuratedSection = (
    section: SettingSection,
    regs: { [regName: string]: RegisterData },
  ) => {
    const rows = section.settings
      .map((item, i) => renderCuratedRow(item, regs, `${section.id}-${i}`))
      .filter(Boolean)
    if (rows.length === 0) return null

    return (
      <div key={section.id}>
        <h4 className="text-sm font-semibold">{section.title}</h4>
        <p className="text-xs text-muted-foreground mt-0.5 mb-4 max-w-3xl">
          {section.description}
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-6 gap-y-5">
          {rows}
        </div>
      </div>
    )
  }

  // ── Render: a single register control ────────────────────
  //   compact=true  → plain number input only (used in the trigger table)
  //   compact=false → full view: bit-field decomposition, binary editor, or plain input

  const renderSettingInput = (regName: string, reg: RegisterData, compact = false) => {
    const isModified = modifiedSettings.has(regName)

    // Registers whose value is a closed set (e.g. the RC-CR2 Smoothing Factor,
    // which accepts only 8 of its 64 bit patterns) must never be a free numeric
    // input — an out-of-range value is silently undefined behaviour on the board.
    const valueOptions = getRegisterOptions(reg.name)
    if (valueOptions) {
      const known = valueOptions.some(o => o.value === reg.value_dec)
      return (
        <div className="space-y-1">
          <div className="flex gap-2 items-center">
            <Select
              value={known ? reg.value_dec.toString() : ""}
              onValueChange={v => handleSettingChange(regName, v)}
            >
              <SelectTrigger className={`h-8 ${compact ? "text-sm" : ""} ${isModified ? "border-orange-500" : ""}`}>
                <SelectValue placeholder={`Non-standard (${reg.value_dec})`} />
              </SelectTrigger>
              <SelectContent>
                {valueOptions.map(opt => (
                  <SelectItem key={opt.value} value={opt.value.toString()}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              onClick={() => handleSave(regName)}
              disabled={!isModified}
              className={compact ? "h-8 px-2 text-xs" : ""}
            >
              Save
            </Button>
          </div>
          {!known && (
            <div className="text-xs text-orange-500">
              Current value {reg.value_dec} (0x{reg.value_dec.toString(16)}) is not one of the
              documented options — pick one to correct it.
            </div>
          )}
          <div className="text-xs text-muted-foreground font-mono">
            Reg value: {reg.value_dec} | Hex: {reg.value_hex} | Addr: {reg.address}
          </div>
        </div>
      )
    }

    if (compact) {
      const unit = unitForName(reg.name)
      const step = isDcOffsetReg(reg.name) ? 0.1 : (isTimeReg(reg.name) && nsPerSample > 1 ? nsPerSample : 1)
      return (
        <div className="space-y-1">
          <div className="flex gap-1 items-center">
            <NumericInput
              min="0"
              max={isDcOffsetReg(reg.name) ? "100" : "4294967295"}
              step={step}
              value={toDisplay(reg)}
              onValueChange={v => handleSettingChange(regName, fromDisplay(reg, v.toString()).toString())}
              className={`h-8 text-sm ${isModified ? "border-orange-500" : ""}`}
            />
            {unit && <span className="text-xs text-muted-foreground w-6 shrink-0">{unit}</span>}
            <Button size="sm" onClick={() => handleSave(regName)} disabled={!isModified} className="h-8 px-2 text-xs">
              Save
            </Button>
          </div>
          {isTimeReg(reg.name) && nsPerSample > 1 && (
            <div className="text-xs text-muted-foreground font-mono">{reg.value_dec} samples</div>
          )}
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
          <NumericInput
            min="0"
            max={isDcOffsetReg(reg.name) ? "100" : "4294967295"}
            step={step}
            value={toDisplay(reg)}
            onValueChange={v => handleSettingChange(regName, fromDisplay(reg, v.toString()).toString())}
            className={isModified ? "border-orange-500" : ""}
          />
          {unit && <span className="text-xs text-muted-foreground w-6 shrink-0">{unit}</span>}
          <Button size="sm" onClick={() => handleSave(regName)} disabled={!isModified}>Save</Button>
        </div>
        <div className="text-xs text-muted-foreground font-mono">
          Reg value: {reg.value_dec}
          {isTimeReg(reg.name) && nsPerSample > 1 ? ` samples (${nsPerSample} ns/sample)` : ""}
          {" "}| Hex: {reg.value_hex} | Addr: {reg.address}
        </div>
      </div>
    )
  }

  // ── Main render ───────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-6">
        <div>
          <h3 className="text-lg font-semibold">
            Settings for {boardData.name}
            <Badge variant="outline" className="ml-2 font-mono text-xs">
              {boardData.dpp || "?"}
            </Badge>
          </h3>
          <p className="text-sm text-muted-foreground mt-0.5">
            {advancedMode
              ? "Every register on the board, grouped by function."
              : "The settings tuned during an experiment, in the order the signal is processed."}
          </p>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          <div className="flex items-center gap-2">
            <Label htmlFor="advanced-mode" title="Show every register, not just the tuned ones">
              Advanced
            </Label>
            <Switch id="advanced-mode" checked={advancedMode} onCheckedChange={setAdvancedMode} />
          </div>
          {/* Raw bit editing only makes sense once all registers are visible. */}
          {advancedMode && (
            <div className="flex items-center gap-2">
              <Label htmlFor="binary-mode">Binary</Label>
              <Switch id="binary-mode" checked={binaryMode} onCheckedChange={setBinaryMode} />
            </div>
          )}
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

        {/* Board Settings */}
        <TabsContent value="general" className="space-y-4">
          {!advancedMode ? (
            // Curated: waveform recording and data format, the two board-wide
            // things that actually get changed between runs. Channel-level
            // registers are reachable per channel; the rest is in Advanced.
            (() => {
              const boardRegs = { ...commonSettings, ...(channelSettingsMap[0] ?? {}) }
              const curated = getBoardSections()
                .map(s => renderCuratedSection(s, boardRegs))
                .filter(Boolean)
              return (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      Board Settings
                      <Badge variant="outline" className="text-xs font-normal">
                        Essential settings
                      </Badge>
                    </CardTitle>
                    <p className="text-sm text-muted-foreground">
                      Applies to the whole board. Waveform and data-format options here are
                      written to every channel; switch on Advanced for the raw registers.
                    </p>
                  </CardHeader>
                  <CardContent className="space-y-8">
                    {curated.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No recognised board settings — switch on Advanced to see every register.
                      </p>
                    ) : (
                      curated.map((node, i) => (
                        <div key={i}>
                          {i > 0 && <Separator className="mb-8" />}
                          {node}
                        </div>
                      ))
                    )}
                  </CardContent>
                </Card>
              )
            })()
          ) : (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  Board Settings
                  <Badge variant="outline" className="text-xs font-normal">All registers</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {Object.keys(commonSettings).length === 0 ? (
                  <p className="text-sm text-muted-foreground">No general settings available.</p>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-6 items-start">
                    {Object.entries(commonSettings).map(([regName, reg]) => {
                      const hasDecomp = !binaryMode && getDecomposition(reg.name, boardData.dpp, boardData.name)
                      // Bit-field and binary editors need the full width; plain
                      // single-value settings pack two per row to save space.
                      const isWide = binaryMode || !!hasDecomp
                      return (
                        <div key={regName} className={isWide ? "md:col-span-2" : ""}>
                          <RegisterLabel
                            reg={reg}
                            modified={modifiedSettings.has(regName)}
                            decomposed={!!hasDecomp}
                          />
                          {renderSettingInput(regName, reg)}
                        </div>
                      )
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Channel Settings */}
        <TabsContent value="channels" className="space-y-4">
          {channels.length === 0 ? (
            <div className="text-center text-muted-foreground py-8">
              No channel settings available for this board.
            </div>
          ) : (
            <>
              {/* ── Copy settings between channels ── */}
              {channels.length > 1 && (
                <Card className="border-dashed">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Copy Channel Settings</CardTitle>
                    <p className="text-sm text-muted-foreground">
                      Copy every setting from one channel onto others. Values are written to
                      the board immediately.
                    </p>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex items-end gap-4 flex-wrap">
                      <div className="space-y-1.5">
                        <Label className="text-sm">From</Label>
                        <Select value={copySource} onValueChange={setCopySource}>
                          <SelectTrigger className="w-36">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {channels.map(ch => (
                              <SelectItem key={ch} value={ch.toString()}>
                                Channel {ch}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-1.5 flex-1 min-w-64">
                        <div className="flex items-center gap-3">
                          <Label className="text-sm">To</Label>
                          <button
                            type="button"
                            className="text-xs text-muted-foreground hover:text-foreground underline"
                            onClick={() =>
                              setCopyTargets(new Set(channels.filter(c => c !== parseInt(copySource))))
                            }
                          >
                            all others
                          </button>
                          <button
                            type="button"
                            className="text-xs text-muted-foreground hover:text-foreground underline"
                            onClick={() =>
                              setCopyTargets(new Set(
                                enabledChannels.filter(c => c !== parseInt(copySource))
                              ))
                            }
                          >
                            enabled only
                          </button>
                          <button
                            type="button"
                            className="text-xs text-muted-foreground hover:text-foreground underline"
                            onClick={() => setCopyTargets(new Set())}
                          >
                            none
                          </button>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {channels
                            .filter(ch => ch !== parseInt(copySource))
                            .map(ch => {
                              const picked = copyTargets.has(ch)
                              return (
                                <Button
                                  key={ch}
                                  type="button"
                                  size="sm"
                                  variant={picked ? "default" : "outline"}
                                  className="h-8 px-2.5 text-xs"
                                  onClick={() =>
                                    setCopyTargets(prev => {
                                      const next = new Set(prev)
                                      if (next.has(ch)) next.delete(ch)
                                      else next.add(ch)
                                      return next
                                    })
                                  }
                                >
                                  Ch {ch}
                                  {!channelEnabled[ch] && (
                                    <span className="ml-1 opacity-60">(off)</span>
                                  )}
                                </Button>
                              )
                            })}
                        </div>
                      </div>

                      <Button
                        onClick={() =>
                          handleCopyChannel(parseInt(copySource), Array.from(copyTargets).sort((a, b) => a - b))
                        }
                        disabled={copying || copyTargets.size === 0}
                      >
                        {copying && <ReloadIcon className="mr-2 h-4 w-4 animate-spin" />}
                        Copy to {copyTargets.size || "…"} channel{copyTargets.size === 1 ? "" : "s"}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )}

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
                // Group by what the setting actually does (trigger, energy
                // filter, gates, ...) rather than dumping one long list, so
                // related knobs sit together and are easier to find.
                const byCategory = new Map<RegisterCategory, [string, RegisterData][]>()
                Object.entries(chRegs).forEach(entry => {
                  const category = categorizeRegister(entry[1].name)
                  const list = byCategory.get(category) ?? []
                  list.push(entry)
                  byCategory.set(category, list)
                })
                const sections = CATEGORY_ORDER
                  .map(c => [c, byCategory.get(c) ?? []] as const)
                  .filter(([, entries]) => entries.length > 0)

                const renderSection = (
                  title: string,
                  entries: [string, RegisterData][],
                ) => (
                  <div>
                    <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-4">
                      {title}
                    </h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-6 items-start">
                      {entries.map(([regName, reg]) => {
                        const hasDecomp = !binaryMode && getDecomposition(reg.name, boardData.dpp, boardData.name)
                        // Wide editors (decomposed/binary) span the row; plain
                        // single-value settings sit two per row.
                        const isWide = binaryMode || !!hasDecomp
                        return (
                          <div key={regName} className={isWide ? "md:col-span-2" : ""}>
                            <RegisterLabel
                              reg={reg}
                              modified={modifiedSettings.has(regName)}
                              decomposed={!!hasDecomp}
                            />
                            {renderSettingInput(regName, reg)}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )

                // Curated view: the settings that are actually tuned, ordered
                // the way the signal flows through the firmware. Advanced mode
                // falls back to every register grouped by category.
                const curated = getChannelSections(boardData.dpp)
                  .map(s => renderCuratedSection(s, chRegs))
                  .filter(Boolean)

                return (
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base flex items-center gap-2">
                        Channel {selectedChannel}
                        <Badge variant={channelEnabled[parseInt(selectedChannel)] ? "default" : "secondary"}>
                          {channelEnabled[parseInt(selectedChannel)] ? "Enabled" : "Disabled"}
                        </Badge>
                        <Badge variant="outline" className="text-xs font-normal">
                          {advancedMode ? "All registers" : "Essential settings"}
                        </Badge>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-8">
                      {!advancedMode ? (
                        curated.length > 0 ? (
                          curated.map((node, i) => (
                            <div key={i}>
                              {i > 0 && <Separator className="mb-8" />}
                              {node}
                            </div>
                          ))
                        ) : (
                          <p className="text-sm text-muted-foreground">
                            No recognised settings for this firmware — switch on Advanced to
                            see every register.
                          </p>
                        )
                      ) : (
                        sections.map(([category, entries], i) => (
                          <div key={category}>
                            {i > 0 && <Separator className="mb-8" />}
                            {renderSection(CATEGORY_LABELS[category], entries)}
                          </div>
                        ))
                      )}
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
