'use client'

import { useState, useEffect } from 'react'
import { RunMetadata, createColumns } from "./columns"
import { DataTable } from "./data-table"

import { getRunMetadataAll } from '@/lib/api'
import React from 'react'

export function Logbook() {
    const [data, setData] = React.useState<RunMetadata[]>([])
    const [loading, setLoading] = React.useState(true)

    // Function to fetch data
    const fetchData = React.useCallback(async () => {
        setLoading(true)
        try {
            const response = (await getRunMetadataAll()).data
            setData(response)
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
        createColumns({ onDataUpdate: fetchData }),
        [fetchData])

    if (loading) {
        return <div>Loading...</div>
    }

    return (
        <div className="container mx-auto py-10">
            <h1 className="text-3xl font-bold mb-4">Experiment Logbook</h1>
            <DataTable
                columns={columns}
                data={data}
                onDataChange={fetchData}
            />
        </div>
    )
}

export function LogbookOld() {
    const [data, setData] = useState<RunMetadata[]>([])

    useEffect(() => {
        fetchData()
    }, [])

    const fetchData = async () => {
        try {
            const response = (await getRunMetadataAll()).data
            setData(response)
        } catch (error) {
            console.error('Failed to fetch Data:', error)
        }
    }

    return (
        <div className="container mx-auto py-10">
            <h1 className="text-3xl font-bold mb-5">Logbook</h1>
            
        </div>
    )
}