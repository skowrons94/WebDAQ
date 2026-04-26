"use client"

import * as React from "react"
import { FileDown, Search, X, Filter } from "lucide-react"
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
    FilterFn,
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
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select"
import { mkConfig, generateCsv, download } from "export-to-csv"
import { COLUMN_LABELS } from "./columns"

interface DataTableProps<TData extends { [k: string]: any;[k: number]: any }, TValue> {
    columns: ColumnDef<TData, TValue>[]
    data: TData[]
    onDataChange?: () => void
}

// Global filter: case-insensitive substring match across the most useful fields.
const globalFilter: FilterFn<any> = (row, _columnId, value) => {
    if (!value) return true
    const needle = String(value).toLowerCase()
    const haystack = [
        row.original.run_number,
        row.original.target_name,
        row.original.run_type,
        row.original.flag,
        row.original.notes,
        row.original.terminal_voltage,
        row.original.probe_voltage,
    ]
        .map((v) => (v == null ? "" : String(v).toLowerCase()))
        .join(" ")
    return haystack.includes(needle)
}

export function DataTable<TData extends { [k: string]: any;[k: number]: any }, TValue>({
    columns,
    data,
}: DataTableProps<TData, TValue>) {
    const [sorting, setSorting] = React.useState<SortingState>([
        { id: "run_number", desc: true },
    ])
    const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([])
    const [globalFilterValue, setGlobalFilterValue] = React.useState("")

    // Persist column visibility across sessions.
    const STORAGE_KEY = "logbookTable_columnVisibility"
    const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>(() => {
        if (typeof window !== "undefined") {
            try {
                const saved = localStorage.getItem(STORAGE_KEY)
                if (saved) return JSON.parse(saved)
            } catch (e) {
                console.error("Failed to read column visibility:", e)
            }
        }
        // Sensible defaults: hide the less commonly used columns.
        return { end_time: false, probe_voltage: false }
    })

    React.useEffect(() => {
        if (typeof window === "undefined") return
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(columnVisibility))
        } catch (e) {
            console.error("Failed to save column visibility:", e)
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
        onGlobalFilterChange: setGlobalFilterValue,
        globalFilterFn: globalFilter,
        state: {
            sorting,
            columnFilters,
            columnVisibility,
            globalFilter: globalFilterValue,
        },
    })

    const csvConfig = mkConfig({
        fieldSeparator: ",",
        filename: "Logbook",
        decimalSeparator: ".",
        useKeysAsHeaders: true,
    })

    const exportExcel = (rows: Row<TData>[]) => {
        const rowData = rows.map((row) => {
            const startTime = row.original.start_time ? new Date(row.original.start_time) : null
            const endTime = row.original.end_time ? new Date(row.original.end_time) : null
            const durationSeconds =
                startTime && endTime
                    ? Math.round((endTime.getTime() - startTime.getTime()) / 1000)
                    : ""
            return {
                "Run Number": row.original.run_number,
                "Start Time": startTime ? startTime.toLocaleString() : "",
                "End Time": endTime ? endTime.toLocaleString() : "",
                "Duration (s)": durationSeconds,
                Target: row.original.target_name,
                "Run Type": row.original.run_type,
                "Terminal Voltage": row.original.terminal_voltage,
                "Probe Voltage": row.original.probe_voltage,
                "Accumulated Charge": row.original.accumulated_charge,
                Flag: row.original.flag,
                Notes: row.original.notes,
            }
        })
        const csv = generateCsv(csvConfig)(rowData as { [k: string]: any;[k: number]: any }[])
        download(csvConfig)(csv)
    }

    const runTypeFilter = (table.getColumn("run_type")?.getFilterValue() as string) ?? "all"
    const flagFilter = (table.getColumn("flag")?.getFilterValue() as string) ?? "all"

    const totalRows = table.getCoreRowModel().rows.length
    const filteredRows = table.getFilteredRowModel().rows.length
    const filtersActive =
        Boolean(globalFilterValue) || runTypeFilter !== "all" || flagFilter !== "all"

    const clearFilters = () => {
        setGlobalFilterValue("")
        table.getColumn("run_type")?.setFilterValue(undefined)
        table.getColumn("flag")?.setFilterValue(undefined)
    }

    return (
        <div className="space-y-3">
            {/* Toolbar */}
            <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[14rem] max-w-md">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                        placeholder="Search runs, targets, notes…"
                        value={globalFilterValue}
                        onChange={(e) => setGlobalFilterValue(e.target.value)}
                        className="pl-8 pr-8"
                    />
                    {globalFilterValue && (
                        <button
                            onClick={() => setGlobalFilterValue("")}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                            title="Clear search"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    )}
                </div>

                {/* Run type filter */}
                <Select
                    value={runTypeFilter}
                    onValueChange={(v) =>
                        table.getColumn("run_type")?.setFilterValue(v === "all" ? undefined : v)
                    }
                >
                    <SelectTrigger className="w-36 h-9">
                        <SelectValue placeholder="Run type" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">All types</SelectItem>
                        <SelectItem value="longrun">Long Run</SelectItem>
                        <SelectItem value="scan">Scan</SelectItem>
                        <SelectItem value="background">Background</SelectItem>
                        <SelectItem value="calibration">Calibration</SelectItem>
                    </SelectContent>
                </Select>

                {/* Flag filter */}
                <Select
                    value={flagFilter}
                    onValueChange={(v) =>
                        table.getColumn("flag")?.setFilterValue(v === "all" ? undefined : v)
                    }
                >
                    <SelectTrigger className="w-32 h-9">
                        <SelectValue placeholder="Flag" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">All flags</SelectItem>
                        <SelectItem value="good">Good</SelectItem>
                        <SelectItem value="unknown">Unknown</SelectItem>
                        <SelectItem value="bad">Bad</SelectItem>
                    </SelectContent>
                </Select>

                {filtersActive && (
                    <Button variant="ghost" size="sm" onClick={clearFilters}>
                        <X className="h-3.5 w-3.5 mr-1" />
                        Clear
                    </Button>
                )}

                <div className="ml-auto flex items-center gap-2">
                    <span className="text-xs text-muted-foreground tabular-nums hidden sm:inline">
                        {filteredRows === totalRows
                            ? `${totalRows} run${totalRows === 1 ? "" : "s"}`
                            : `${filteredRows} / ${totalRows}`}
                    </span>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="outline" size="sm">
                                <Filter className="h-3.5 w-3.5 mr-1.5" />
                                Columns
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            {table
                                .getAllColumns()
                                .filter((column) => column.getCanHide())
                                .map((column) => {
                                    const meta = column.columnDef.meta as
                                        | { label?: string }
                                        | undefined
                                    const label =
                                        meta?.label ?? COLUMN_LABELS[column.id] ?? column.id
                                    return (
                                        <DropdownMenuCheckboxItem
                                            key={column.id}
                                            checked={column.getIsVisible()}
                                            onCheckedChange={(value) =>
                                                column.toggleVisibility(!!value)
                                            }
                                        >
                                            {label}
                                        </DropdownMenuCheckboxItem>
                                    )
                                })}
                        </DropdownMenuContent>
                    </DropdownMenu>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => exportExcel(table.getFilteredRowModel().rows)}
                    >
                        <FileDown className="h-3.5 w-3.5 mr-1.5" />
                        Export CSV
                    </Button>
                </div>
            </div>

            {/* Table */}
            <div className="rounded-md border bg-background">
                <Table>
                    <TableHeader>
                        {table.getHeaderGroups().map((headerGroup) => (
                            <TableRow key={headerGroup.id}>
                                {headerGroup.headers.map((header) => (
                                    <TableHead
                                        key={header.id}
                                        className="whitespace-nowrap bg-muted/30"
                                    >
                                        {header.isPlaceholder
                                            ? null
                                            : flexRender(
                                                header.column.columnDef.header,
                                                header.getContext(),
                                            )}
                                    </TableHead>
                                ))}
                            </TableRow>
                        ))}
                    </TableHeader>
                    <TableBody>
                        {table.getRowModel().rows?.length ? (
                            table.getRowModel().rows.map((row) => (
                                <TableRow
                                    key={row.id}
                                    data-state={row.getIsSelected() && "selected"}
                                    className="align-top"
                                >
                                    {row.getVisibleCells().map((cell) => {
                                        const meta = cell.column.columnDef.meta as
                                            | { expand?: boolean }
                                            | undefined
                                        return (
                                            <TableCell
                                                key={cell.id}
                                                className={
                                                    meta?.expand
                                                        ? "w-full p-2 align-top"
                                                        : "whitespace-nowrap p-2 align-middle"
                                                }
                                            >
                                                {flexRender(
                                                    cell.column.columnDef.cell,
                                                    cell.getContext(),
                                                )}
                                            </TableCell>
                                        )
                                    })}
                                </TableRow>
                            ))
                        ) : (
                            <TableRow>
                                <TableCell
                                    colSpan={columns.length}
                                    className="h-24 text-center text-muted-foreground"
                                >
                                    No runs match the current filters.
                                </TableCell>
                            </TableRow>
                        )}
                    </TableBody>
                </Table>
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between gap-3">
                <div className="text-xs text-muted-foreground tabular-nums">
                    Page {table.getState().pagination.pageIndex + 1} of {Math.max(1, table.getPageCount())}
                </div>
                <div className="flex items-center gap-2">
                    <Select
                        value={String(table.getState().pagination.pageSize)}
                        onValueChange={(v) => table.setPageSize(Number(v))}
                    >
                        <SelectTrigger className="h-8 w-24">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {[10, 20, 50, 100].map((s) => (
                                <SelectItem key={s} value={String(s)}>
                                    {s} / page
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
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
        </div>
    )
}
