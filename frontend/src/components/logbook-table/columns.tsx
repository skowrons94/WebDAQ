"use client"

import { useState, useEffect } from "react"
import { ColumnDef } from "@tanstack/react-table"
import { MoreHorizontal, ArrowUpDown, ArrowUpRight, AlertTriangle } from "lucide-react"
import Link from "next/link"

import { Button } from "@/components/ui/button"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog"
import {
    Form,
    FormControl,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
} from "@/components/ui/form"
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { addRunMetadata, updateRunFlag, updateRunNotes, type AlertEvent } from "@/lib/api"
import { alertCount } from "@/lib/run-alerts"
import { useForm } from "react-hook-form"

export type RunMetadata = {
    id: string
    run_number: number
    start_time: string
    end_time: string
    notes: string
    target_name: string
    terminal_voltage: number
    probe_voltage: number
    run_type: string
    accumulated_charge: number
    user_id: number
    flag: string
}

interface EditRunFormProps {
    runData: RunMetadata
    onSubmit: (data: {
        run_number: number
        target_name: string
        terminal_voltage: string
        probe_voltage: string
        run_type: string
    }) => void
    onCancel: () => void
}

const EditRunForm = ({ runData, onSubmit, onCancel }: EditRunFormProps) => {
    const form = useForm({
        defaultValues: {
            run_number: runData.run_number,
            target_name: runData.target_name,
            terminal_voltage: runData.terminal_voltage.toString(),
            probe_voltage: runData.probe_voltage.toString(),
            run_type: runData.run_type,
        },
    })

    return (
        <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                    control={form.control}
                    name="run_number"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Run number</FormLabel>
                            <FormControl>
                                <Input type="number" {...field} value={field.value} onChange={e => field.onChange(parseInt(e.target.value))} />
                            </FormControl>
                            <FormMessage />
                        </FormItem>
                    )}
                />
                <FormField
                    control={form.control}
                    name="target_name"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Run name</FormLabel>
                            <FormControl>
                                <Input {...field} />
                            </FormControl>
                            <FormMessage />
                        </FormItem>
                    )}
                />
                <FormField
                    control={form.control}
                    name="terminal_voltage"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Terminal voltage (kV)</FormLabel>
                            <FormControl>
                                <Input {...field} />
                            </FormControl>
                            <FormMessage />
                        </FormItem>
                    )}
                />
                <FormField
                    control={form.control}
                    name="probe_voltage"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Probe voltage (kV)</FormLabel>
                            <FormControl>
                                <Input {...field} />
                            </FormControl>
                            <FormMessage />
                        </FormItem>
                    )}
                />
                <FormField
                    control={form.control}
                    name="run_type"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Run type</FormLabel>
                            <Select onValueChange={field.onChange} defaultValue={field.value}>
                                <FormControl>
                                    <SelectTrigger>
                                        <SelectValue placeholder="Select run type" />
                                    </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                    <SelectItem value="longrun">Long Run</SelectItem>
                                    <SelectItem value="scan">Scan</SelectItem>
                                    <SelectItem value="background">Background</SelectItem>
                                    <SelectItem value="calibration">Calibration</SelectItem>
                                </SelectContent>
                            </Select>
                            <FormMessage />
                        </FormItem>
                    )}
                />
                <DialogFooter>
                    <Button variant="outline" type="button" onClick={onCancel}>Cancel</Button>
                    <Button type="submit">Save changes</Button>
                </DialogFooter>
            </form>
        </Form>
    )
}

interface ColumnsProps {
    onDataUpdate?: () => void;
    /** Alert events by run number: a run that had any is flagged. */
    alertsByRun?: Map<number, AlertEvent[]>;
}

// Reusable sortable header with friendly label.
const sortableHeader = (label: string) =>
    function SortableHeader({ column }: any) {
        const sorted = column.getIsSorted()
        return (
            <Button
                variant="ghost"
                size="sm"
                onClick={() => column.toggleSorting(sorted === "asc")}
                className="-ml-2 h-8 data-[state=open]:bg-accent"
            >
                {label}
                <ArrowUpDown
                    className={`ml-2 h-3.5 w-3.5 ${sorted ? "opacity-100" : "opacity-40"}`}
                />
            </Button>
        )
    }

const RUN_TYPE_LABEL: Record<string, string> = {
    longrun: "Long Run",
    scan: "Scan",
    background: "Background",
    calibration: "Calibration",
}

export const COLUMN_LABELS: Record<string, string> = {
    run_number: "Run number",
    start_time: "Start time",
    end_time: "End time",
    duration: "Duration",
    accumulated_charge: "Accumulated charge (µC)",
    target_name: "Run name",
    terminal_voltage: "Terminal voltage (kV)",
    probe_voltage: "Probe voltage (kV)",
    run_type: "Run type",
    flag: "Flag",
    notes: "Notes",
    actions: "Actions",
}

export const createColumns = ({ onDataUpdate, alertsByRun }: ColumnsProps = {}): ColumnDef<RunMetadata>[] => [
    {
        accessorKey: "run_number",
        meta: { label: COLUMN_LABELS.run_number },
        header: sortableHeader("Run #"),
        cell: ({ row }) => {
            // A run during which an alert fired (a board failure, a stall…) is
            // marked: otherwise it reads as clean as any other.
            const alerts = alertsByRun?.get(row.original.run_number)?.length ?? 0
            const label = `Open logbook entry for run ${row.original.run_number}`
                + (alerts ? ` (${alertCount(alerts)} during this run)` : "")
            return (
                <Button
                    asChild
                    variant="ghost"
                    size="sm"
                    className="h-8 w-full justify-center gap-1.5 px-2 font-mono"
                >
                    <Link
                        href={`/logbook/${row.original.run_number}`}
                        aria-label={label}
                        title={alerts ? `${alertCount(alerts)} during this run` : undefined}
                    >
                        {alerts > 0 && <AlertTriangle className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />}
                        {row.original.run_number}
                        <ArrowUpRight className="h-3.5 w-3.5" />
                    </Link>
                </Button>
            )
        },
        size: 80,
    },
    {
        accessorKey: "start_time",
        meta: { label: COLUMN_LABELS.start_time },
        header: sortableHeader("Start"),
        cell: ({ row }) => {
            if (!row.original.start_time) return <div className="text-muted-foreground">—</div>
            const date = new Date(row.original.start_time)
            return (
                <div className="whitespace-nowrap text-sm">
                    {date.toLocaleDateString()}{" "}
                    <span className="text-muted-foreground">
                        {date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                </div>
            )
        },
    },
    {
        accessorKey: "end_time",
        meta: { label: COLUMN_LABELS.end_time },
        header: sortableHeader("End"),
        cell: ({ row }) => {
            if (!row.original.end_time) return <div className="text-muted-foreground">—</div>
            const date = new Date(row.original.end_time)
            return (
                <div className="whitespace-nowrap text-sm">
                    {date.toLocaleDateString()}{" "}
                    <span className="text-muted-foreground">
                        {date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                </div>
            )
        },
    },
    {
        id: "duration",
        meta: { label: COLUMN_LABELS.duration },
        header: sortableHeader("Duration"),
        accessorFn: (row) => {
            if (!row.start_time || !row.end_time) return 0
            return Math.round(
                (new Date(row.end_time).getTime() - new Date(row.start_time).getTime()) / 1000,
            )
        },
        cell: ({ row }) => {
            const start = row.original.start_time ? new Date(row.original.start_time) : null
            const end = row.original.end_time ? new Date(row.original.end_time) : null
            if (!start || !end) return <div className="text-muted-foreground text-center">—</div>
            const seconds = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000))
            const h = Math.floor(seconds / 3600)
            const m = Math.floor((seconds % 3600) / 60)
            const s = seconds % 60
            const pretty =
                h > 0
                    ? `${h}h ${m.toString().padStart(2, "0")}m`
                    : m > 0
                        ? `${m}m ${s.toString().padStart(2, "0")}s`
                        : `${s}s`
            return <div className="text-center text-sm tabular-nums">{pretty}</div>
        },
    },
    {
        accessorKey: "accumulated_charge",
        meta: { label: COLUMN_LABELS.accumulated_charge },
        header: sortableHeader("Charge (µC)"),
        cell: ({ row }) => (
            <div className="text-right tabular-nums text-sm">
                {row.original.accumulated_charge != null
                    ? Number(row.original.accumulated_charge).toFixed(2)
                    : "—"}
            </div>
        ),
    },
    {
        accessorKey: "target_name",
        meta: { label: COLUMN_LABELS.target_name },
        header: sortableHeader("Run name"),
        cell: ({ row }) => (
            <div className="text-sm font-medium">{row.original.target_name || "—"}</div>
        ),
    },
    {
        accessorKey: "terminal_voltage",
        meta: { label: COLUMN_LABELS.terminal_voltage },
        header: sortableHeader("Terminal voltage (kV)"),
        cell: ({ row }) => (
            <div className="text-right tabular-nums text-sm">
                {row.original.terminal_voltage ?? "—"}
            </div>
        ),
    },
    {
        accessorKey: "probe_voltage",
        meta: { label: COLUMN_LABELS.probe_voltage },
        header: sortableHeader("Probe voltage (kV)"),
        cell: ({ row }) => (
            <div className="text-right tabular-nums text-sm">
                {row.original.probe_voltage ?? "—"}
            </div>
        ),
    },
    {
        accessorKey: "run_type",
        meta: { label: COLUMN_LABELS.run_type },
        header: sortableHeader("Type"),
        // Equality filter (drives the type dropdown)
        filterFn: (row, columnId, value) =>
            !value || value === "all" ? true : row.getValue(columnId) === value,
        cell: ({ row }) => {
            const type = row.original.run_type
            return (
                <div className="text-sm">{RUN_TYPE_LABEL[type] ?? type ?? "—"}</div>
            )
        },
    },
    {
        accessorKey: "flag",
        meta: { label: COLUMN_LABELS.flag },
        header: sortableHeader("Flag"),
        filterFn: (row, columnId, value) =>
            !value || value === "all" ? true : (row.getValue(columnId) || "unknown") === value,
        cell: ({ row }) => {
            const [flag, setFlag] = useState(row.original.flag || "unknown")

            useEffect(() => {
                setFlag(row.original.flag || "unknown")
            }, [row.original.flag])

            const handleFlagChange = async (newFlag: string) => {
                try {
                    await updateRunFlag(row.original.run_number, newFlag)
                    setFlag(newFlag)
                    onDataUpdate?.()
                } catch (error) {
                    console.error("Failed to update flag:", error)
                }
            }

            const flagClass =
                flag === "good"
                    ? "text-success bg-success/10 border-success"
                    : flag === "bad"
                        ? "text-destructive bg-destructive/10 border-destructive"
                        // "Unknown" is the default of every run, not a warning:
                        // neutral, so a real "Bad" (or an alert) stands out.
                        : "text-muted-foreground bg-muted/50 border-border"

            return (
                <Select value={flag} onValueChange={handleFlagChange}>
                    <SelectTrigger className={`h-8 w-auto min-w-[6.5rem] gap-2 ${flagClass}`} aria-label={`Quality flag of run ${row.original.run_number}`}>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="good" className="text-success">Good</SelectItem>
                        <SelectItem value="unknown">Unknown</SelectItem>
                        <SelectItem value="bad" className="text-destructive">Bad</SelectItem>
                    </SelectContent>
                </Select>
            )
        },
    },
    {
        accessorKey: "notes",
        meta: { label: COLUMN_LABELS.notes, expand: true },
        // Notes is the wide column — simple "Notes" header, sorting wouldn't be useful.
        header: () => <div className="text-sm font-medium">Notes</div>,
        cell: ({ row }) => {
            const [notes, setNotes] = useState(row.original.notes || "")
            const [isEditing, setIsEditing] = useState(false)

            useEffect(() => {
                setNotes(row.original.notes || "")
            }, [row.original.notes])

            const handleNotesSubmit = async () => {
                try {
                    await updateRunNotes(row.original.run_number, notes)
                    setIsEditing(false)
                    onDataUpdate?.()
                } catch (error) {
                    console.error("Failed to update notes:", error)
                }
            }

            const handleKeyDown = (e: React.KeyboardEvent) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    handleNotesSubmit()
                } else if (e.key === "Escape") {
                    setNotes(row.original.notes || "")
                    setIsEditing(false)
                }
            }

            return (
                <div className="min-w-[28rem] w-full">
                    {isEditing ? (
                        <Textarea
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            onBlur={handleNotesSubmit}
                            onKeyDown={handleKeyDown}
                            className="min-h-32 text-sm w-full resize-y"
                            placeholder="Add notes (Ctrl/⌘+Enter to save, Esc to cancel)"
                            autoFocus
                        />
                    ) : (
                        <div
                            className="cursor-pointer rounded p-2 min-h-12 text-sm hover:bg-muted/50 whitespace-pre-wrap break-words"
                            onClick={() => setIsEditing(true)}
                            title="Click to edit"
                        >
                            {notes || (
                                <span className="text-muted-foreground italic">
                                    Click to add notes…
                                </span>
                            )}
                        </div>
                    )}
                </div>
            )
        },
    },
    {
        id: "actions",
        meta: { label: COLUMN_LABELS.actions },
        enableHiding: false,
        cell: ({ row }) => {
            const data = row.original
            const [open, setOpen] = useState(false)

            const handleEditSubmit = (formData: {
                run_number: number
                target_name: string
                terminal_voltage: string
                probe_voltage: string
                run_type: string
            }) => {
                addRunMetadata(
                    formData.run_number,
                    formData.target_name,
                    formData.terminal_voltage,
                    formData.probe_voltage,
                    formData.run_type,
                )
                    .then(() => {
                        setOpen(false)
                        onDataUpdate?.()
                    })
                    .catch((error) => {
                        console.error("Failed to update run metadata:", error)
                    })
            }

            return (
                <>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" className="h-8 w-8 p-0">
                                <span className="sr-only">Open menu</span>
                                <MoreHorizontal className="h-4 w-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuLabel>Actions</DropdownMenuLabel>
                            <DropdownMenuItem asChild>
                                <Link href={`/logbook/${data.run_number}`}>
                                    Open run page
                                </Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onClick={() =>
                                    navigator.clipboard.writeText(
                                        data.accumulated_charge?.toString() ?? "",
                                    )
                                }
                            >
                                Copy charge
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => setOpen(true)}>
                                Edit entry…
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>

                    <Dialog open={open} onOpenChange={setOpen}>
                        <DialogContent className="sm:max-w-md">
                            <DialogHeader>
                                <DialogTitle>Edit run metadata</DialogTitle>
                                <DialogDescription>
                                    Update the metadata for run #{data.run_number}
                                </DialogDescription>
                            </DialogHeader>
                            <EditRunForm
                                runData={data}
                                onSubmit={handleEditSubmit}
                                onCancel={() => setOpen(false)}
                            />
                        </DialogContent>
                    </Dialog>
                </>
            )
        },
    },
]
