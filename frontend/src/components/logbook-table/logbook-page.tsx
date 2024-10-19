'use client'

import { useState, useEffect } from 'react'
import { RunMetadata, columns } from "./columns"
import { DataTable } from "./data-table"

import { getRunMetadataAll } from '@/lib/api'



export function Logbook() {
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
            <DataTable columns={columns} data={data} />
        </div>
    )
}