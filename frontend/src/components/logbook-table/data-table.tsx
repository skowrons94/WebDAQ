"use client"

import * as React from "react"
import { FileDown } from "lucide-react"
import {
    ColumnDef,
    ColumnFiltersState,
    SortingState,
    VisibilityState,
    flexRender,
    getCoreRowModel,
    getFilteredRowModel,
    getPaginationRowModel,
    useReactTable,
    getSortedRowModel,
    Row,
} from "@tanstack/react-table"

import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { mkConfig, generateCsv, download } from 'export-to-csv'
import { createColumns } from "./columns" // Make sure this path is correct
import { RunMetadata } from "./columns" // Import the type


interface DataTableProps<TData extends { [k: string]: any;[k: number]: any }, TValue> {
    columns: ColumnDef<TData, TValue>[]
    data: TData[]
    onDataChange?: () => void;
}

export function DataTable<TData extends { [k: string]: any;[k: number]: any }, TValue>({
    columns,
    data,
    onDataChange,
}: DataTableProps<TData, TValue>) {
    const [sorting, setSorting] = React.useState<SortingState>([{ id: "run_number", desc: true }])
    const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([])

    // LocalStorage key for saving column visibility
    const STORAGE_KEY = 'dataTable_columnVisibility'

    // Initialize column visibility state with localStorage values if available
    const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>(() => {
        if (typeof window !== 'undefined') {
            try {
                const savedVisibility = localStorage.getItem(STORAGE_KEY)
                if (savedVisibility) {
                    return JSON.parse(savedVisibility)
                }
            } catch (error) {
                console.error('Error loading column visibility from localStorage:', error)
            }
        }
        return {}
    })

    // Save column visibility to localStorage whenever it changes
    React.useEffect(() => {
        // Ensure we're in browser environment before accessing localStorage
        if (typeof window !== 'undefined') {
            try {
                // Only save if we have actual visibility settings
                // This prevents overwriting saved values with empty state during SSR
                if (Object.keys(columnVisibility).length > 0) {
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(columnVisibility))
                }
            } catch (error) {
                console.error('Error saving column visibility to localStorage:', error)
            }
        }
    }, [columnVisibility])

    const table = useReactTable({
        data,
        columns,
        getCoreRowModel: getCoreRowModel(),
        getPaginationRowModel: getPaginationRowModel(),
        onSortingChange: setSorting,
        getSortedRowModel: getSortedRowModel(),
        onColumnFiltersChange: setColumnFilters,
        getFilteredRowModel: getFilteredRowModel(),
        onColumnVisibilityChange: setColumnVisibility,
        state: {
            sorting,
            columnFilters,
            columnVisibility,
        }
    })

    const csvConfig = mkConfig({
        fieldSeparator: ',',
        filename: 'Logbook', // export file name (without .csv)
        decimalSeparator: '.',
        useKeysAsHeaders: true,
    })

    // export function
    const exportExcel = (rows: Row<TData>[]) => {
        //const rowData = rows.map((row) => row.original)
        const rowData = rows.map((row) => {
            return {
                'Run Number': row.original.run_number,
                'Start Time': row.original.start_time ?
                    new Date(row.original.start_time).toLocaleString() : '',
                'End Time': row.original.end_time ?
                    new Date(row.original.end_time).toLocaleString() : '',
                'Target': row.original.target_name,
                'Run Type': row.original.run_type,
                'Terminal Voltage': row.original.terminal_voltage,
                'Probe Voltage': row.original.probe_voltage,
                'Accumulated charge': row.original.accumulated_charge
            }
        })
        const csv = generateCsv(csvConfig)(rowData as { [k: string]: any;[k: number]: any }[])
        download(csvConfig)(csv)
    }

    return (
        <div>
            <div className="flex items-center py-4">
                <Input
                    placeholder="Filter targets..."
                    value={(table.getColumn("target_name")?.getFilterValue() as string) ?? ""}
                    onChange={(event) =>
                        table.getColumn("target_name")?.setFilterValue(event.target.value)
                    }
                    className="max-w-sm"
                />

                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="outline" className="ml-auto">
                            Columns
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        {table
                            .getAllColumns()
                            .filter(
                                (column) => column.getCanHide()
                            )
                            .map((column) => {
                                return (
                                    <DropdownMenuCheckboxItem
                                        key={column.id}
                                        className="capitalize"
                                        checked={column.getIsVisible()}
                                        onCheckedChange={(value) =>
                                            column.toggleVisibility(!!value)
                                        }
                                    >
                                        {column.id}
                                    </DropdownMenuCheckboxItem>
                                )
                            })}
                    </DropdownMenuContent>
                </DropdownMenu>
                <Button
                    variant="destructive"
                    className="ml-2"
                    onClick={() => exportExcel(table.getFilteredRowModel().rows)}
                >
                    <FileDown className="h-4 w-4 mr-2" />
                    Download CSV...
                </Button>
            </div>
            <div className="rounded-md border">
                <Table>
                    <TableHeader>
                        {table.getHeaderGroups().map((headerGroup) => (
                            <TableRow key={headerGroup.id}>
                                {headerGroup.headers.map((header) => {
                                    return (
                                        <TableHead key={header.id}>
                                            {header.isPlaceholder
                                                ? null
                                                : flexRender(
                                                    header.column.columnDef.header,
                                                    header.getContext()
                                                )}
                                        </TableHead>
                                    )
                                })}
                            </TableRow>
                        ))}
                    </TableHeader>
                    <TableBody>
                        {table.getRowModel().rows?.length ? (
                            table.getRowModel().rows.map((row) => (
                                <TableRow
                                    key={row.id}
                                    data-state={row.getIsSelected() && "selected"}
                                >
                                    {row.getVisibleCells().map((cell) => (
                                        <TableCell key={cell.id}>
                                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                        </TableCell>
                                    ))}
                                </TableRow>
                            ))
                        ) : (
                            <TableRow>
                                <TableCell colSpan={columns.length} className="h-24 text-center">
                                    No results.
                                </TableCell>
                            </TableRow>
                        )}
                    </TableBody>
                </Table>
            </div>
            <div className="flex items-center justify-end space-x-2 py-4">
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => table.previousPage()}
                    disabled={!table.getCanPreviousPage()}
                >
                    Previous
                </Button>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => table.nextPage()}
                    disabled={!table.getCanNextPage()}
                >
                    Next
                </Button>
            </div>
        </div>
    )
}