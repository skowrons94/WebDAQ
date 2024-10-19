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
            const date = new Date(row.original.start_time)
            return (
                <div className="text-left">
                    {date.toLocaleDateString()} {date.toLocaleTimeString()}
                </div>
            )
        }
    },
    {
        accessorKey: "notes",
        header: "Notes",
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