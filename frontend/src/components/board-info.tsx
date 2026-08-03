"use client"

import { useState, useEffect, useCallback } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { ReloadIcon } from "@radix-ui/react-icons"
import { getBoardInfo, type CaenBoardInfo, type BoardInfoResponse } from "@/lib/api"

/**
 * Hardware and software provenance for the running acquisition.
 *
 * Everything shown here is captured into the run metadata at start (and written
 * to `metadata.json` next to the data), so a dataset can be traced back to the
 * exact boards, firmware and software that produced it — the "reproducible" half
 * of FAIR. Board fields come straight from the CAEN API; the acquisition
 * registers are read back from the hardware, not from the config file.
 */

const CONNECTION_TYPES: Record<number, string> = {
  0: "USB",
  1: "Optical",
  2: "A2818",
  3: "A3818",
  5: "A4818",
}

const FORM_FACTORS: Record<number, string> = {
  0: "VME64",
  1: "VME64X",
  2: "Desktop",
  3: "NIM",
}

/** One label/value row. Values that are absent read as "—", never as blank. */
function Field({ label, value, mono = false }: { label: string; value?: React.ReactNode; mono?: boolean }) {
  const empty = value === undefined || value === null || value === ""
  return (
    <div className="flex justify-between gap-4 py-1 border-b border-border/40 last:border-0">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <span className={`text-xs text-right ${mono ? "font-mono" : ""} ${empty ? "text-muted-foreground" : ""}`}>
        {empty ? "—" : value}
      </span>
    </div>
  )
}

const hex = (v: number) => `0x${(v >>> 0).toString(16).toUpperCase().padStart(4, "0")}`

function BoardCard({ board }: { board: CaenBoardInfo }) {
  const roleVariant =
    board.sync_role === "master" ? "default" : board.sync_role === "slave" ? "outline" : "secondary"

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          {board.configured_name ?? board.model_name}
          <Badge variant="outline" className="text-xs font-mono">{board.dpp_type}</Badge>
          <Badge variant={roleVariant} className="text-xs">{board.sync_role}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 lg:grid-cols-2 gap-x-8">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Identity
          </h4>
          <Field label="Model" value={`${board.model_name} (${board.model})`} />
          <Field label="Serial number" value={board.serial_number} />
          <Field label="Board ID" value={board.board_id} />
          <Field label="Board register ID" value={board.board_reg_id} />
          <Field label="Form factor" value={FORM_FACTORS[board.form_factor] ?? board.form_factor} />
          <Field label="PCB revision" value={board.pcb_revision || undefined} />
          <Field label="Channels" value={board.channels} />
          <Field label="ADC resolution" value={`${board.adc_bits} bit`} />
          <Field label="Sampling" value={board.ns_per_sample ? `${board.ns_per_sample} ns/sample` : undefined} />
          <Field label="Time tag" value={board.ns_per_timetag ? `${board.ns_per_timetag} ns` : undefined} />
        </div>

        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2 lg:mt-0 mt-4">
            Firmware &amp; connection
          </h4>
          <Field label="ROC firmware" value={board.roc_firmware} mono />
          <Field label="AMC firmware" value={board.amc_firmware} mono />
          <Field label="DPP licence" value={board.license || undefined} mono />
          <Field label="Connection" value={CONNECTION_TYPES[board.conn_type] ?? board.conn_type} />
          <Field label="Link" value={board.link_num} />
          {board.vme_base > 0 && <Field label="VME base" value={hex(board.vme_base)} mono />}

          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2 mt-4">
            Acquisition registers
          </h4>
          <Field label="Start mode (0x8100[1:0])" value={board.start_mode_name} />
          <Field label="Acquisition Control 0x8100" value={hex(board.acquisition_control)} mono />
          <Field label="Board Configuration 0x8000" value={hex(board.board_configuration)} mono />
          <Field label="Front Panel I/O 0x811C" value={hex(board.front_panel_io_control)} mono />
          <Field label="Global Trigger Mask 0x810C" value={hex(board.global_trigger_mask)} mono />
          <Field label="TRG-OUT Mask 0x8110" value={hex(board.trg_out_enable_mask)} mono />
          <Field label="Run Delay 0x8170" value={board.run_delay} mono />
          <Field label="Channel Enable Mask" value={hex(board.channel_enable_mask)} mono />
        </div>
      </CardContent>
    </Card>
  )
}

export default function BoardInfoPanel() {
  const [data, setData] = useState<BoardInfoResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await getBoardInfo())
      setError(null)
    } catch {
      setError("Could not load the board information.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  if (loading && !data) {
    return (
      <div className="flex justify-center items-center py-8">
        <ReloadIcon className="mr-2 h-4 w-4 animate-spin" />
        Loading board information...
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
  if (!data) return null

  const sw = data.software

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Acquisition Provenance</h3>
          <p className="text-sm text-muted-foreground">
            Recorded with every run, and written to <span className="font-mono">metadata.json</span>{" "}
            next to the data.
          </p>
        </div>
        <Button variant="outline" onClick={load} disabled={loading}>
          {loading && <ReloadIcon className="mr-2 h-4 w-4 animate-spin" />}
          Refresh
        </Button>
      </div>

      {/* Software versions — known whether or not a run is active. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            Software
            <Badge variant={sw.acquisition_mode === "hardware" ? "default" : "secondary"} className="text-xs">
              {sw.acquisition_mode === "hardware" ? "hardware" : "mock / test mode"}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-x-8">
          <div>
            <Field label="WebDAQ" value={sw.webdaq} mono />
            <Field label="CaenDAQ" value={sw.caendaq ?? undefined} mono />
            <Field
              label="CAEN hardware support"
              value={sw.caendaq_has_caen === null ? undefined : sw.caendaq_has_caen ? "yes" : "no (mock-only build)"}
            />
          </div>
          <div>
            <Field label="Python" value={sw.python} mono />
            <Field label="Platform" value={sw.platform} mono />
            <Field label="Synchronisation" value={data.sync_mode} />
          </div>
        </CardContent>
      </Card>

      {/* Board details are only readable while the digitizers are open. */}
      {data.boards.length === 0 ? (
        <Alert>
          <AlertTitle>No board details available</AlertTitle>
          <AlertDescription>
            The CAEN API only reports a board&apos;s identity and registers while the digitizers
            are open — that is, during a run. Start a run to see model, serial number, firmware
            and the acquisition registers as actually programmed.
          </AlertDescription>
        </Alert>
      ) : (
        data.boards.map(board => <BoardCard key={board.board_id} board={board} />)
      )}
    </div>
  )
}
