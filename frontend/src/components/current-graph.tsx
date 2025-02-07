"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts"
import { getArrayDataCurrent } from '@/lib/api'

// Data are taken each second, so we should take present time and go back each second for each data point
const convertToChartData = (data) => {
    const now = new Date()
    return data.map((value, index) => ({
        time: new Date(now.valueOf() - (data.length - index) * 1000).toISOString().substr(11, 8),
        value: value
    }))
}

export default function CurrentGraph() {
  const [data, setData] = useState([])

  useEffect(() => {
    const fetchData = async () => {
      const newData = await getArrayDataCurrent()
      const newNewData = convertToChartData(newData)
      setData(newNewData)
    }

    fetchData() // Fetch initial data

    const intervalId = setInterval(fetchData, 1000) // Update every second

    return () => clearInterval(intervalId) // Clean up on unmount
  }, [])

  return (
    <div className="bg-white-900 p-4 rounded-lg">
      <h2 className="text-xl font-bold mb-4 text-black-100">Current on Target</h2>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#000" />
            <XAxis dataKey="time" stroke="#000" tick={{ fill: "#000" }} />
            <YAxis stroke="#000" tick={{ fill: "#000" }} label={{ value: "Current (uA)", angle: -90, position: "insideLeft", style: { textAnchor: "middle", fill: "#000" } }}/>
            <Tooltip
              contentStyle={{ backgroundColor: "#fff", border: "1px solid #000" }}
              labelStyle={{ color: "#000" }}
              itemStyle={{ color: "#000" }}
            />
            <Line type="monotone" dataKey="value" stroke="#ff0000" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}