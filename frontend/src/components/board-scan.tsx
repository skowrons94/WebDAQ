"use client"

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Progress } from "@/components/ui/progress"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useToast } from "@/components/ui/use-toast"
import { Radar, Search, Settings2, X, Plus, CheckCircle2 } from 'lucide-react'
import {
  startBoardScan, getBoardScanStatus, cancelBoardScan,
  type ScanOptions, type ScanStatus, type DiscoveredBoard,
} from '@/lib/api'

// A board's VME base address comes from two rotary switches setting bits 31..16,
// so only multiples of 0x10000 can hold a board and a range never needs a finer
// step. The server refuses ranges longer than this many probes.
const VME_STEP = 0x10000
const MAX_VME_PROBES = 1024

const defaultOptions = (vmeStart: string, vmeEnd: string): ScanOptions => ({
  usb: { enabled: true, links: 8 },
  optical: { enabled: true, links: 4, nodes: 8 },
  a4818: { enabled: true, pids: [], nodes: 8 },
  vme: { enabled: false, link_type: 'Optical', link_num: '0', start: vmeStart, end: vmeEnd, step: '10000' },
})

// Crate boards sit in a narrow band of addresses, so start from the ones already
// configured (0x32100000 -> 0x32000000..0x32FF0000) rather than from nothing.
function vmeRangeFrom(boards: { vme?: string }[]): [string, string] {
  const configured = boards
    .map(b => parseInt(String(b.vme ?? '0'), 16))
    .filter(v => Number.isFinite(v) && v > 0)
  const base = configured.length ? configured[0] : 0x32100000
  const start = base & 0xff000000
  return [start.toString(16).toUpperCase().padStart(8, '0'),
          ((start | 0x00ff0000) >>> 0).toString(16).toUpperCase().padStart(8, '0')]
}

function probeCount(start: string, end: string, step: string): number | null {
  const s = parseInt(start, 16), e = parseInt(end, 16), st = parseInt(step, 16)
  if (!Number.isFinite(s) || !Number.isFinite(e) || !Number.isFinite(st) || st <= 0 || e < s) return null
  return Math.floor((e - s) / st) + 1
}

function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
}

type ConfiguredBoard = { id: string; vme?: string; link_type?: string; link_num?: string }

type Props = {
  /** Boards already added — used to seed the VME range and to grey out known hits. */
  boards: ConfiguredBoard[]
  /** Fill the add-board form with a discovered board, for the operator to confirm. */
  onUse: (board: DiscoveredBoard, suggestedId: string) => void
}

export function BoardScan({ boards, onUse }: Props) {
  const { toast } = useToast()
  const [status, setStatus] = useState<ScanStatus | null>(null)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [options, setOptions] = useState<ScanOptions>(() => defaultOptions(...vmeRangeFrom([])))
  const [starting, setStarting] = useState(false)
  const seededVme = useRef(false)

  // Seed the VME range from the configured boards once they have loaded.
  useEffect(() => {
    if (seededVme.current || boards.length === 0) return
    seededVme.current = true
    const [start, end] = vmeRangeFrom(boards)
    setOptions(prev => ({ ...prev, vme: { ...prev.vme, start, end } }))
  }, [boards])

  const refresh = useCallback(async () => {
    try {
      setStatus(await getBoardScanStatus())
    } catch (error) {
      console.error('Failed to fetch scan status:', error)
    }
  }, [])

  // Pick up a scan that is still running (another tab, or a page reload).
  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    if (status?.status !== 'running') return
    const interval = setInterval(refresh, 500)
    return () => clearInterval(interval)
  }, [status?.status, refresh])

  async function handleScan() {
    setStarting(true)
    try {
      setStatus(await startBoardScan(options))
    } catch (error) {
      const serverMessage =
        (error as { response?: { data?: { message?: string } } })?.response?.data?.message
      toast({
        title: "Cannot start the scan",
        description: serverMessage ?? "Failed to start the board scan. Please try again.",
        variant: "destructive",
      })
    } finally {
      setStarting(false)
    }
  }

  async function handleCancel() {
    try {
      setStatus(await cancelBoardScan())
    } catch (error) {
      console.error('Failed to cancel scan:', error)
    }
  }

  // The server marks hits it skipped because they were already added; a board
  // added *after* the scan has to be recognised here, so the card does not keep
  // offering settings that would now be rejected as a duplicate.
  function isConfigured(board: DiscoveredBoard): boolean {
    if (board.already_configured) return true
    return boards.some(b =>
      String(b.id) === String(board.id) &&
      b.link_type === board.link_type &&
      String(b.link_num) === String(board.link_num) &&
      parseInt(String(b.vme ?? '0'), 16) === parseInt(board.vme || '0', 16))
  }

  // A discovered board keeps its CONET node as its id where possible; if that id
  // is taken, offer the next free one so the form does not open with a conflict.
  function suggestedIdFor(board: DiscoveredBoard): string {
    const used = new Set(boards.map(b => String(b.id)))
    if (!used.has(String(board.id))) return String(board.id)
    let candidate = 0
    while (used.has(String(candidate))) candidate++
    return String(candidate)
  }

  const running = status?.status === 'running'
  const { done = 0, total = 0 } = status?.progress ?? {}
  const percent = total ? Math.round((done / total) * 100) : 0
  const vmeProbes = probeCount(options.vme.start, options.vme.end, options.vme.step)

  return (
    <>
      <Card className="w-full mx-auto">
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle>Find CAEN Boards</CardTitle>
            <CardDescription>
              Probe the links and list the digitizers that answer, so you do not have to
              type their settings from memory.
            </CardDescription>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" onClick={() => setOptionsOpen(true)} disabled={running}>
              <Settings2 className="mr-1.5 h-4 w-4" />
              Options
            </Button>
            {running ? (
              <Button variant="destructive" size="sm" onClick={handleCancel}>
                <X className="mr-1.5 h-4 w-4" />
                Cancel
              </Button>
            ) : (
              <Button size="sm" onClick={handleScan} disabled={starting}>
                <Search className="mr-1.5 h-4 w-4" />
                Scan for boards
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {running && (
            <div className="space-y-2">
              <Progress value={percent} className="h-2" />
              <p className="text-xs text-muted-foreground">
                Probing {done} of {total}
                {status?.eta != null && ` — about ${formatSeconds(status.eta)} left`}
              </p>
            </div>
          )}

          {!running && status && status.status !== 'idle' && (
            <p className="text-sm text-muted-foreground">{status.message}</p>
          )}

          {status?.errors?.map((error, i) => (
            <p key={i} className="text-sm text-amber-600 dark:text-amber-400">{error}</p>
          ))}

          {status && status.found.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {status.found.map((board, i) => {
                const configured = isConfigured(board)
                return (
                <div
                  key={`${board.link_type}-${board.link_num}-${board.id}-${board.vme}-${i}`}
                  className={`rounded-lg border bg-card p-4 shadow-sm ${configured ? 'opacity-60' : ''}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold leading-tight">{board.model}</p>
                      <p className="text-xs text-muted-foreground">
                        {board.serial ? `S/N ${board.serial}` : 'Already added'}
                        {board.channels ? ` — ${board.channels} ch` : ''}
                        {board.adc_bits ? ` — ${board.adc_bits} bit` : ''}
                      </p>
                    </div>
                    {configured ? (
                      <Badge variant="secondary" className="shrink-0">
                        <CheckCircle2 className="mr-1 h-3 w-3" />
                        Configured
                      </Badge>
                    ) : board.dpp ? (
                      <Badge variant="outline" className="shrink-0">{board.dpp}</Badge>
                    ) : null}
                  </div>

                  <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 border-t pt-3 text-xs">
                    <dt className="text-muted-foreground">Link</dt>
                    <dd className="text-right">{board.link_type}</dd>
                    <dt className="text-muted-foreground">
                      {board.link_type === 'A4818' ? 'PID' : 'Link Number'}
                    </dt>
                    <dd className="text-right font-mono">{board.link_num}</dd>
                    <dt className="text-muted-foreground">Node</dt>
                    <dd className="text-right font-mono">{board.id}</dd>
                    <dt className="text-muted-foreground">VME Address</dt>
                    <dd className="text-right font-mono">{board.vme}</dd>
                    {board.amc_firmware && (
                      <>
                        <dt className="text-muted-foreground">Firmware</dt>
                        <dd className="text-right font-mono">{board.amc_firmware}</dd>
                      </>
                    )}
                  </dl>

                  <Button
                    size="sm"
                    variant={configured ? "ghost" : "default"}
                    className="mt-3 w-full"
                    disabled={configured}
                    onClick={() => onUse(board, suggestedIdFor(board))}
                  >
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    {configured ? 'Already added' : 'Use these settings'}
                  </Button>
                </div>
                )
              })}
            </div>
          ) : (
            !running && (
              <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-10 text-center">
                <Radar className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  {status && status.status !== 'idle'
                    ? 'No boards answered. Check the cabling, or widen the scan in Options.'
                    : 'Scan to see which digitizers are connected.'}
                </p>
              </div>
            )
          )}
        </CardContent>
      </Card>

      <Dialog open={optionsOpen} onOpenChange={setOptionsOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Scan options</DialogTitle>
            <DialogDescription>
              Choose which links to probe. Scanning is only possible while no run is in progress.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="scan-usb"
                  checked={options.usb.enabled}
                  onCheckedChange={(checked) =>
                    setOptions(o => ({ ...o, usb: { ...o.usb, enabled: checked === true } }))}
                />
                <Label htmlFor="scan-usb">USB</Label>
              </div>
              <div className="flex items-center gap-2 pl-6">
                <Label htmlFor="scan-usb-links" className="text-xs text-muted-foreground">Links to try</Label>
                <Input
                  id="scan-usb-links"
                  className="h-8 w-20"
                  type="number"
                  min={1}
                  value={options.usb.links}
                  onChange={(e) =>
                    setOptions(o => ({ ...o, usb: { ...o.usb, links: Number(e.target.value) || 1 } }))}
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="scan-optical"
                  checked={options.optical.enabled}
                  onCheckedChange={(checked) =>
                    setOptions(o => ({ ...o, optical: { ...o.optical, enabled: checked === true } }))}
                />
                <Label htmlFor="scan-optical">Optical (CONET)</Label>
              </div>
              <div className="flex items-center gap-3 pl-6">
                <Label htmlFor="scan-optical-links" className="text-xs text-muted-foreground">Links</Label>
                <Input
                  id="scan-optical-links"
                  className="h-8 w-16"
                  type="number"
                  min={1}
                  value={options.optical.links}
                  onChange={(e) =>
                    setOptions(o => ({ ...o, optical: { ...o.optical, links: Number(e.target.value) || 1 } }))}
                />
                <Label htmlFor="scan-optical-nodes" className="text-xs text-muted-foreground">
                  Nodes per link
                </Label>
                <Input
                  id="scan-optical-nodes"
                  className="h-8 w-16"
                  type="number"
                  min={1}
                  value={options.optical.nodes}
                  onChange={(e) =>
                    setOptions(o => ({ ...o, optical: { ...o.optical, nodes: Number(e.target.value) || 1 } }))}
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="scan-a4818"
                  checked={options.a4818.enabled}
                  onCheckedChange={(checked) =>
                    setOptions(o => ({ ...o, a4818: { ...o.a4818, enabled: checked === true } }))}
                />
                <Label htmlFor="scan-a4818">A4818</Label>
              </div>
              <div className="space-y-1 pl-6">
                <Label htmlFor="scan-a4818-pids" className="text-xs text-muted-foreground">
                  PIDs (comma separated — leave empty to detect them from the USB bus)
                </Label>
                <Input
                  id="scan-a4818-pids"
                  className="h-8"
                  placeholder="e.g. 23456, 23457"
                  value={options.a4818.pids.join(', ')}
                  onChange={(e) =>
                    setOptions(o => ({
                      ...o,
                      a4818: {
                        ...o.a4818,
                        pids: e.target.value.split(',').map(p => p.trim()).filter(Boolean),
                      },
                    }))}
                />
              </div>
            </div>

            <div className="space-y-2 rounded-md border p-3">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="scan-vme"
                  checked={options.vme.enabled}
                  onCheckedChange={(checked) =>
                    setOptions(o => ({ ...o, vme: { ...o.vme, enabled: checked === true } }))}
                />
                <Label htmlFor="scan-vme">VME crate (through a bridge)</Label>
              </div>
              <p className="pl-6 text-xs text-muted-foreground">
                Boards in a crate are found by their base address, which the rotary switches set in
                steps of 0x10000. Keep the range near the addresses you use — a probe reads the
                configuration ROM at each address it tries.
              </p>
              <div className="grid grid-cols-2 gap-3 pl-6 pt-1">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Bridge link type</Label>
                  <Select
                    value={options.vme.link_type}
                    onValueChange={(value) =>
                      setOptions(o => ({ ...o, vme: { ...o.vme, link_type: value } }))}
                  >
                    <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Optical">Optical</SelectItem>
                      <SelectItem value="USB">USB</SelectItem>
                      <SelectItem value="A4818">A4818</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="scan-vme-link" className="text-xs text-muted-foreground">
                    {options.vme.link_type === 'A4818' ? 'Bridge PID' : 'Bridge link number'}
                  </Label>
                  <Input
                    id="scan-vme-link"
                    className="h-8"
                    value={options.vme.link_num}
                    onChange={(e) =>
                      setOptions(o => ({ ...o, vme: { ...o.vme, link_num: e.target.value } }))}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="scan-vme-start" className="text-xs text-muted-foreground">
                    First address (hex)
                  </Label>
                  <Input
                    id="scan-vme-start"
                    className="h-8 font-mono"
                    value={options.vme.start}
                    onChange={(e) =>
                      setOptions(o => ({ ...o, vme: { ...o.vme, start: e.target.value.trim() } }))}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="scan-vme-end" className="text-xs text-muted-foreground">
                    Last address (hex)
                  </Label>
                  <Input
                    id="scan-vme-end"
                    className="h-8 font-mono"
                    value={options.vme.end}
                    onChange={(e) =>
                      setOptions(o => ({ ...o, vme: { ...o.vme, end: e.target.value.trim() } }))}
                  />
                </div>
              </div>
              {options.vme.enabled && (
                <p className={`pl-6 text-xs ${
                  vmeProbes == null || vmeProbes > MAX_VME_PROBES
                    ? 'text-destructive' : 'text-muted-foreground'}`}>
                  {vmeProbes == null
                    ? 'That range is not valid — check the hexadecimal addresses.'
                    : vmeProbes > MAX_VME_PROBES
                      ? `${vmeProbes} addresses — over the limit of ${MAX_VME_PROBES}. Narrow the range.`
                      : `${vmeProbes} addresses to try, in steps of 0x${VME_STEP.toString(16).toUpperCase()}.`}
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOptionsOpen(false)}>Close</Button>
            <Button
              onClick={() => { setOptionsOpen(false); handleScan() }}
              disabled={options.vme.enabled && (vmeProbes == null || vmeProbes > MAX_VME_PROBES)}
            >
              <Search className="mr-1.5 h-4 w-4" />
              Scan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
