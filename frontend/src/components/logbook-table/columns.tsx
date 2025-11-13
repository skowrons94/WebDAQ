"use client"

import { useState, useEffect } from "react"
import { ColumnDef } from "@tanstack/react-table"
import { MoreHorizontal } from "lucide-react"
import { ArrowUpDown } from "lucide-react"

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
    DialogTrigger,
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
import { addRunMetadata, updateRunFlag, updateRunNotes } from "@/lib/api"
import { useForm } from "react-hook-form"

// This type is used to define the shape of our data.
// You can use a Zod schema here if you want.
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
                            <FormLabel>Run Number</FormLabel>
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
                            <FormLabel>Target Name</FormLabel>
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
                            <FormLabel>Terminal Voltage</FormLabel>
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
                            <FormLabel>Probe Voltage</FormLabel>
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
                            <FormLabel>Run Type</FormLabel>
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
}

export const createColumns = ({ onDataUpdate }: ColumnsProps = {}): ColumnDef<RunMetadata>[] => [
    {
        accessorKey: "run_number",
        header: ({ column }) => {
            return (
                <Button
                    variant="ghost"
                    onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
                >
                    Run Number
                    <ArrowUpDown className="ml-2 h-4 w-4" />
                </Button>
            )
        },
        cell: ({ row }) => {
            return (
                <div className="text-center">
                    {row.original.run_number}
                </div>
            )
        },
    },
    {
        accessorKey: "start_time",
        header: "Start Time",
        cell: ({ row }) => {
            // Parse the date and time
            const date = new Date(row.original.start_time)
            return (
                <div className="text-left">
                    {date.toLocaleDateString()} {date.toLocaleTimeString()}
                </div>
            )
        }
    },
    {
        accessorKey: "end_time",
        header: "End Time",
        cell: ({ row }) => {
            // Parse the date and time
            const date = new Date(row.original.end_time)
            return (
                <div className="text-left">
                    {date.toLocaleDateString()} {date.toLocaleTimeString()}
                </div>
            )
        }
    },
    {
        id: "duration",
        header: "Duration (s)",
        cell: ({ row }) => {
            const startTime = new Date(row.original.start_time)
            const endTime = new Date(row.original.end_time)
            const durationSeconds = Math.round((endTime.getTime() - startTime.getTime()) / 1000)
            return (
                <div className="text-center">
                    {durationSeconds}
                </div>
            )
        }
    },
    {
        accessorKey: "accumulated_charge",
        header: "Accumulated Charge",
        cell: ({ row }) => {
            return (
                <div className="text-center">
                    {row.original.accumulated_charge}
                </div>
            )
        }
    },
    {
        accessorKey: "target_name",
        header: "Target Name",
    },
    {
        accessorKey: "terminal_voltage",
        header: "Terminal Voltage",
    },
    {
        accessorKey: "probe_voltage",
        header: "Probe Voltage",
    },
    {
        accessorKey: "run_type",
        header: "Run Type",
        cell: ({ row }) => {
            return (
                <div className="text-center">
                    {row.original.run_type === "longrun" ? "Long Run"
                        : row.original.run_type === "scan" ? "Scan"
                            : row.original.run_type === "background" ? "Background"
                                : row.original.run_type === "calibration" ? "Calibration"
                                    : row.original.run_type}
                </div>
            )
        }
    },
    {
        accessorKey: "flag",
        header: "Flag",
        cell: ({ row }) => {
            const [flag, setFlag] = useState(row.original.flag || 'unknown')
            
            // Sync local state with row data when it changes
            useEffect(() => {
                setFlag(row.original.flag || 'unknown')
            }, [row.original.flag])
            
            const handleFlagChange = async (newFlag: string) => {
                console.log('Updating flag for run', row.original.run_number, 'to', newFlag)
                try {
                    const response = await updateRunFlag(row.original.run_number, newFlag)
                    console.log('Flag update response:', response)
                    setFlag(newFlag)
                    onDataUpdate?.()
                } catch (error) {
                    console.error("Failed to update flag:", error)
                }
            }

            const getFlagColor = (flag: string) => {
                switch (flag) {
                    case 'good': return 'text-green-600 bg-green-50'
                    case 'bad': return 'text-red-600 bg-red-50'
                    default: return 'text-orange-600 bg-orange-50'
                }
            }

            return (
                <Select value={flag} onValueChange={handleFlagChange}>
                    <SelectTrigger className={`w-24 h-8 ${getFlagColor(flag)}`}>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="good" className="text-green-600">Good</SelectItem>
                        <SelectItem value="unknown" className="text-orange-600">Unknown</SelectItem>
                        <SelectItem value="bad" className="text-red-600">Bad</SelectItem>
                    </SelectContent>
                </Select>
            )
        }
    },
    {
        accessorKey: "notes",
        header: "Notes",
        cell: ({ row }) => {
            const [notes, setNotes] = useState(row.original.notes || '')
            const [isEditing, setIsEditing] = useState(false)
            
            // Sync local state with row data when it changes
            useEffect(() => {
                setNotes(row.original.notes || '')
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
                if (e.key === 'Enter' && e.ctrlKey) {
                    handleNotesSubmit()
                } else if (e.key === 'Escape') {
                    setNotes(row.original.notes || '')
                    setIsEditing(false)
                }
            }

            return (
                <div className="max-w-xs">
                    {isEditing ? (
                        <Textarea
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            onBlur={handleNotesSubmit}
                            onKeyDown={handleKeyDown}
                            className="min-h-16 text-sm"
                            placeholder="Add notes (Ctrl+Enter to save, Esc to cancel)"
                            autoFocus
                        />
                    ) : (
                        <div 
                            className="cursor-pointer p-2 min-h-8 text-sm hover:bg-gray-50 rounded"
                            onClick={() => setIsEditing(true)}
                        >
                            {notes || <span className="text-gray-400">Click to add notes...</span>}
                        </div>
                    )}
                </div>
            )
        }
    },
    {
        id: "actions",
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
                    formData.run_type
                ).then(() => {
                    // Close the dialog
                    setOpen(false)
                    // refresh the data table
                    // add a refresh callback here
                    onDataUpdate?.()
                }).catch(error => {
                    console.error("Failed to update run metadata:", error)
                    // Handle error (show toast notification, etc)
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
                            <DropdownMenuItem
                                onClick={() => navigator.clipboard.writeText(data.accumulated_charge.toString())}
                            >
                                Copy charge to clipboard
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => setOpen(true)}>
                                Edit entry...
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>

                    <Dialog open={open} onOpenChange={setOpen}>
                        <DialogContent className="sm:max-w-md">
                            <DialogHeader>
                                <DialogTitle>Edit Run Metadata</DialogTitle>
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