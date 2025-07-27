'use client'

import CurrentGraph from "@/components/current-graph"

/**
 * CurrentPlot Component
 * 
 * A wrapper component for the current measurement graph.
 * This component provides a clean interface for displaying
 * real-time current measurements from the TetrAMM device.
 * 
 * The actual graph implementation is handled by the CurrentGraph
 * component which contains the chart logic and data fetching.
 */
export function CurrentPlot() {
  return (
    <div className="gap-4">
      <CurrentGraph />
    </div>
  )
}