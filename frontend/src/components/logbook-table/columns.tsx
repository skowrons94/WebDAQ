"use client"

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
}

export const columns: ColumnDef<RunMetadata>[] = [
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
                                : row.original.run_type}
                </div>
            )
        }
    },
    {
        id: "actions",
        cell: ({ row }) => {
            const data = row.original

            return (
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
                            onClick={() => navigator.clipboard.writeText(data.run_number.toString())}
                        >
                            Copy Run Number
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem>Prova</DropdownMenuItem>
                        <DropdownMenuItem>Another Option</DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            )
        },
    },
]