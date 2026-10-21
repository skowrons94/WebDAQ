'use client'

import { RunMetadata, createColumns } from "./columns"
import { DataTable } from "./data-table"

import { getRunMetadataAll, type AlertEvent } from '@/lib/api'
import { getAlertsByRun } from '@/lib/run-alerts'
import React from 'react'

export function Logbook() {
    const [data, setData] = React.useState<RunMetadata[]>([])
    const [loading, setLoading] = React.useState(true)
    // Runs with alerts are flagged in the table (a failed run used to look
    // like every other). Optional: a failure here leaves the table as it was.
    const [alertsByRun, setAlertsByRun] = React.useState<Map<number, AlertEvent[]>>(new Map())

    // Function to fetch data
    const fetchData = React.useCallback(async () => {
        setLoading(true)
        try {
            const response = (await getRunMetadataAll()).data
            setData(response)
            getAlertsByRun().then(setAlertsByRun).catch((error) => {
                console.error('Failed to fetch the alerts per run:', error)
            })
        } catch (error) {
            console.error('Failed to fetch Data:', error)
        } finally {
            setLoading(false)
        }
    }, [])

    // Initial data load
    React.useEffect(() => {
        fetchData()
    }, [fetchData])

    const columns = React.useMemo(() =>
        createColumns({ onDataUpdate: fetchData, alertsByRun }),
        [fetchData, alertsByRun])

    if (loading) {
        return <div>Loading...</div>
    }

    return (
        // The page heading is the route's PageHeader (app/logbook/page.tsx).
        <div className="mx-auto w-full max-w-[1600px]">
            <DataTable
                columns={columns}
                data={data}
                onDataChange={fetchData}
            />
        </div>
    )
}
