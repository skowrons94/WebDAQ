'use client'

import { useEffect, useRef, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { getCalib, getHistogram } from '@/lib/api'

/** Calibration (offset a, slope b) for a channel; null when uncalibrated (0, 1) or unknown. */
export async function readCalibration(boardName: string, boardId: string, channel: number): Promise<{ a: number; b: number } | null> {
  try {
    const res = await getCalib(boardName, boardId, String(channel))
    if (res?.data?.status !== 'success') return null
    const a = Number(res.data.a), b = Number(res.data.b)
    if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null
    if (a === 0 && b === 1) return null
    return { a, b }
  } catch {
    return null
  }
}

/** X-axis title of the channel spectrum: calibrated energy, or channels (Q-long for PSD). */
export function spectrumAxisTitle(psd: boolean, calibrated: boolean): string {
  if (calibrated) return psd ? 'Q-long (keV)' : 'Energy (keV)'
  return psd ? 'Q-long (ch)' : 'Energy (ch)'
}

/**
 * The channel's spectrum, drawn with named axes. The server applies the
 * calibration to the axis, so the title only has to say which it is.
 */
export function SpectrumPanel({
  boardId, boardName, channel, psd, jsrootLoaded, refreshTick,
}: {
  boardId: string
  boardName: string
  channel: number
  psd: boolean
  jsrootLoaded: boolean
  refreshTick: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [calibrated, setCalibrated] = useState(false)
  const [logY, setLogY] = useState(false)
  const [empty, setEmpty] = useState(false)

  useEffect(() => {
    let alive = true
    readCalibration(boardName, boardId, channel).then((c) => { if (alive) setCalibrated(!!c) })
    return () => { alive = false }
  }, [boardName, boardId, channel])

  useEffect(() => {
    if (!jsrootLoaded || !boardId) return
    const el = ref.current
    if (!el || !window.JSROOT) return
    let alive = true
    ;(async () => {
      try {
        const data = await getHistogram(boardId, String(channel))
        if (!alive) return
        const h = window.JSROOT.parse(data)
        let sum = 0
        const arr: ArrayLike<number> = h?.fArray ?? []
        for (let i = 1; i < arr.length - 1; i++) sum += Number(arr[i]) || 0
        setEmpty(sum === 0)
        if (h?.fXaxis) h.fXaxis.fTitle = spectrumAxisTitle(psd, calibrated)
        if (h?.fYaxis) h.fYaxis.fTitle = 'Counts'
        await window.JSROOT.redraw(el, h, logY ? 'hist;logy' : 'hist')
      } catch {
        /* the next tick retries */
      }
    })()
    return () => { alive = false }
  }, [jsrootLoaded, refreshTick, boardId, channel, psd, calibrated, logY])

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle>
          {psd ? 'Q-long spectrum' : 'Energy spectrum'}
          <span className="ml-2 text-base font-normal text-muted-foreground">{boardName} — Channel {channel}</span>
        </CardTitle>
        <div className="flex items-center gap-2">
          <Switch id="tuner-spectrum-logy" checked={logY} onCheckedChange={setLogY} />
          <Label htmlFor="tuner-spectrum-logy" className="text-sm">Log scale</Label>
        </div>
      </CardHeader>
      <CardContent>
        <div className="relative">
          <div ref={ref} className="h-80 w-full rounded-lg border shadow-sm max-md:aspect-[4/3] max-md:h-auto" data-testid="tuner-spectrum" />
          {empty && (
            <p className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-sm text-muted-foreground">
              No counts yet: the spectrum fills while a run is on.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
