"use client"

import { StatusBadge } from '@/components/ui/status-badge'
import { ConfirmAction } from '@/components/ui/confirm-action'
import { useRunStatus } from '@/hooks/use-run-status'
import { useState, useEffect, useCallback, useRef } from 'react'
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import * as z from "zod"
import { getBoardConfiguration, addBoard, removeBoard, getBoardConnectivity, type DiscoveredBoard } from '@/lib/api'
import { useToast } from "@/components/ui/use-toast"
import { Cpu, Plus, Trash2 } from 'lucide-react'
import { BoardScan } from '@/components/board-scan'
import { Sis3316AddBoard } from '@/components/sis3316/sis3316-add-board'
import { boardLabel } from '@/lib/board-label'

const formSchema = z.object({
  id: z.string().min(1, "Board ID is required"),
  vme: z.string().min(1, "VME Address is required"),
  link_type: z.enum(["Optical", "USB", "A4818"]),
  link_num: z.string().min(1, "Link Number/PID is required"),
  dpp: z.enum(["DPP-PHA", "DPP-PSD"])
})

type BoardData = z.infer<typeof formSchema>
// A configured board as the server lists it: CAEN boards, or an SIS3316
// (vendor 'sis3316', IP address in link_num).
type ConfiguredBoard = Omit<BoardData, 'link_type' | 'dpp'> & {
  link_type: string
  dpp: string
  vendor?: string
  /** Model, e.g. "V1725S", once the board has been opened. */
  name?: string
}

type Connectivity = { connected: boolean; ready: boolean; failed: boolean }

export function Board() {
  // Removing a board mid-run would pull it out from under the acquisition.
  // Unknown (no answer yet) counts as running.
  const runActive = useRunStatus((st) => st.isRunning || !st.known || st.unreachable)
  const [boards, setBoards] = useState<ConfiguredBoard[]>([])
  const [connectivity, setConnectivity] = useState<Record<string, Connectivity>>({})
  const { toast } = useToast()
  const addFormRef = useRef<HTMLDivElement>(null)

  const form = useForm<BoardData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      id: "0",
      vme: "0",
      link_type: "Optical",
      link_num: "0",
      dpp: "DPP-PHA"
    },
  })

  const fetchConnectivity = useCallback(async () => {
    try {
      const data = await getBoardConnectivity()
      if (data && typeof data === 'object' && !data.error) {
        setConnectivity(data)
      }
    } catch (error) {
      // Server may be offline or boards not yet connected — leave status unknown.
      console.error('Failed to fetch board connectivity:', error)
    }
  }, [])

  useEffect(() => {
    fetchBoardConfiguration()
    fetchConnectivity()
    const interval = setInterval(fetchConnectivity, 5000)
    return () => clearInterval(interval)
  }, [fetchConnectivity])

  async function fetchBoardConfiguration() {
    try {
      const response = await getBoardConfiguration()
      setBoards(response.data)
      // The form starts on the next free ID rather than one already in use;
      // an ID the operator typed (or a scan suggested) is left alone unless
      // it is taken.
      const list: ConfiguredBoard[] = Array.isArray(response.data) ? response.data : []
      const taken = new Set(list.map((b) => String(b.id)))
      if (taken.has(String(form.getValues('id')))) {
        let next = 0
        while (taken.has(String(next))) next++
        form.setValue('id', String(next))
      }
    } catch (error) {
      console.error('Failed to fetch board configuration:', error)
      toast({
        title: "Error",
        description: "Failed to fetch board configuration. Please try again.",
        variant: "destructive",
      })
    }
  }

  async function onSubmit(values: BoardData) {
    try {
      await addBoard(values)
      // Reset first, so the re-read below moves the ID on to the next free one.
      form.reset()
      await fetchBoardConfiguration()
      fetchConnectivity()
      toast({
        title: "Success",
        description: "Board added successfully.",
      })
    } catch (error) {
      console.error('Failed to add board:', error)
      // The server explains configuration problems (a duplicate board ID, say)
      // in terms the operator can act on — show that instead of a generic error.
      const serverMessage =
        (error as { response?: { data?: { message?: string } } })?.response?.data?.message
      toast({
        title: serverMessage ? "Cannot add this board" : "Error",
        description: serverMessage ?? "Failed to add board. Please try again.",
        variant: "destructive",
      })
    }
  }

  // A scan result fills the form rather than adding the board outright: the ID
  // and the DPP firmware are the operator's call (the DPP is only inferred from
  // the firmware code), and this way the settings are visible before committing.
  function handleUseDiscovered(board: DiscoveredBoard, suggestedId: string) {
    form.reset({
      id: suggestedId,
      vme: board.vme,
      link_type: board.link_type as BoardData["link_type"],
      link_num: board.link_num,
      dpp: (board.dpp ?? "DPP-PHA") as BoardData["dpp"],
    })
    addFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    toast({
      title: `${board.model} ready to add`,
      description: board.dpp
        ? `Firmware ${board.amc_firmware} looks like ${board.dpp}. Check the ID and firmware, then add it.`
        : "The DPP firmware could not be read from the board — pick it before adding.",
    })
  }

  // "Add this board" on a scan result: the same add as the form, with the
  // suggested ID and the DPP read from the firmware.
  async function handleAddDiscovered(board: DiscoveredBoard, suggestedId: string) {
    await onSubmit({
      id: suggestedId,
      vme: board.vme,
      link_type: board.link_type as BoardData["link_type"],
      link_num: board.link_num,
      dpp: (board.dpp ?? "DPP-PHA") as BoardData["dpp"],
    })
  }

  async function handleRemoveBoard(boardId: string) {
    try {
      await removeBoard(boardId)
      await fetchBoardConfiguration()
      fetchConnectivity()
      toast({
        title: "Success",
        description: "Board removed successfully.",
      })
    } catch (error) {
      console.error('Failed to remove board:', error)
      toast({
        title: "Error",
        description: "Failed to remove board. Please try again.",
        variant: "destructive",
      })
    }
  }

  return (
    <div className="flex flex-col text-foreground gap-8">
        {/* Added boards — shown first, as a grid of status cards */}
        <Card className="w-full mx-auto">
          <CardHeader>
            <CardTitle>Added boards</CardTitle>
            <CardDescription>
              Configured digitizers and their live connection status.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {boards.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-10 text-center">
                <Cpu className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  No boards configured yet. Add one below to get started.
                </p>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {boards.map((board) => {
                  const conn = connectivity[String(board.id)]
                  const status = conn?.failed
                    ? { label: "Failed", state: "error" as const }
                    : conn?.connected
                      ? { label: "Connected", state: "ready" as const }
                      : { label: "Disconnected", state: "off" as const }
                  return (
                    <div
                      key={board.id}
                      className="relative rounded-lg border bg-card p-4 shadow-sm transition-colors hover:bg-muted/30"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10">
                            <Cpu className="h-5 w-5 text-primary" />
                          </div>
                          <div className="min-w-0">
                            <p className="font-semibold leading-tight">{boardLabel(board)}</p>
                            <p className="text-xs text-muted-foreground">{board.dpp}</p>
                          </div>
                        </div>
                        <StatusBadge state={status.state} label={status.label} />
                      </div>

                      {board.vendor === "sis3316" ? (
                        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs border-t pt-3">
                          <dt className="text-muted-foreground">Model</dt>
                          <dd className="text-right">Struck SIS3316</dd>
                          <dt className="text-muted-foreground">Link type</dt>
                          <dd className="text-right">Ethernet</dd>
                          <dt className="text-muted-foreground">IP address</dt>
                          <dd className="text-right font-mono">{board.link_num}</dd>
                        </dl>
                      ) : (
                        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs border-t pt-3">
                          <dt className="text-muted-foreground">VME address</dt>
                          <dd className="text-right font-mono">{board.vme}</dd>
                          <dt className="text-muted-foreground">Link type</dt>
                          <dd className="text-right">{board.link_type}</dd>
                          <dt className="text-muted-foreground">
                            {board.link_type === "A4818" ? "PID" : "Link number"}
                          </dt>
                          <dd className="text-right font-mono">{board.link_num}</dd>
                        </dl>
                      )}

                      <ConfirmAction
                        trigger={
                          <Button
                            variant="ghost"
                            size="sm"
                            className="mt-3 w-full text-destructive hover:text-destructive"
                            disabled={runActive}
                            title={runActive ? "Boards cannot be removed while a run is going" : undefined}
                          >
                            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                            Remove
                          </Button>
                        }
                        title={`Remove ${boardLabel(board)}?`}
                        description={
                          <p>
                            {boardLabel(board)} ({board.dpp}) leaves the DAQ configuration and the next
                            run does not read it. Its energy calibration file is deleted, so the
                            board has to be calibrated again if it is added back.
                          </p>
                        }
                        confirmLabel={`Remove ${boardLabel(board)}`}
                        onConfirm={() => handleRemoveBoard(board.id)}
                      />
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Discover what is actually connected */}
        <BoardScan boards={boards as BoardData[]} onUse={handleUseDiscovered} onAdd={handleAddDiscovered} />

        {/* Add a new board */}
        <Card className="w-full mx-auto" ref={addFormRef}>
          <CardHeader>
            <CardTitle>Add a CAEN board</CardTitle>
            <CardDescription>Enter the details of the CAEN board you want to add.</CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                {/* Two columns from sm up, like the SIS3316 form below: one
                    column of 1100 px wide inputs was hard to read. */}
                <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Board ID</FormLabel>
                      <FormControl>
                        <Input placeholder="0" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="vme"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>VME address</FormLabel>
                      <FormControl>
                        <Input placeholder="0" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="link_type"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Link type</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select link type" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="Optical">Optical</SelectItem>
                          <SelectItem value="USB">USB</SelectItem>
                          <SelectItem value="A4818">A4818</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="link_num"
                  render={({ field }) => {
                    const linkType = form.watch("link_type")
                    const isA4818 = linkType === "A4818"

                    return (
                      <FormItem>
                        <FormLabel>{isA4818 ? "PID" : "Link number"}</FormLabel>
                        {isA4818 ? (
                          <FormControl>
                            <Input
                              placeholder="Enter PID (e.g., 23456)"
                              {...field}
                            />
                          </FormControl>
                        ) : (
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue placeholder="Select link number" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {["0", "1", "2", "3"].map((num) => (
                                <SelectItem key={num} value={num}>{num}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                        <FormMessage />
                      </FormItem>
                    )
                  }}
                />
                <FormField
                  control={form.control}
                  name="dpp"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>DPP firmware</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select DPP firmware" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="DPP-PHA">DPP-PHA</SelectItem>
                          <SelectItem value="DPP-PSD">DPP-PSD</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                </div>
                <Button type="submit">
                  <Plus className="mr-1.5 h-4 w-4" />
                  Add board
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>

        {/* Struck SIS3316 over Ethernet: no CAEN link, found by IP address */}
        <Sis3316AddBoard
          existingIds={boards.map((b) => String(b.id))}
          existingHosts={boards.filter((b) => b.vendor === "sis3316").map((b) => String(b.link_num))}
          disabled={runActive}
          onAdded={() => { fetchBoardConfiguration(); fetchConnectivity() }}
        />
    </div>
  )
}