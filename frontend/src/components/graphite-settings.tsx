'use client'

/**
 * The statistics server: where the DAQ writes its counting rates (Carbon) and
 * where the Stats page reads the accelerator's metrics from (the web API).
 */

import { useEffect, useState } from 'react'
import { getStatsConnection, getStatsGraphiteConfig, setStatsGraphiteConfig } from '@/lib/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/status-badge'
import { useToast } from '@/components/ui/use-toast'
import { useRunStatus } from '@/hooks/use-run-status'

export function GraphiteSettings() {
  const { toast } = useToast()
  const isRunning = useRunStatus((st) => st.isRunning)
  const [host, setHost] = useState('localhost')
  const [port, setPort] = useState('80')
  const [carbonPort, setCarbonPort] = useState('2003')
  const [prefix, setPrefix] = useState('ancillary.rates')
  const [connection, setConnection] = useState<{ reachable: boolean; error: string } | null>(null)
  const [saving, setSaving] = useState(false)

  const check = () => getStatsConnection()
    .then((s) => setConnection({ reachable: s.reachable, error: s.error }))
    .catch(() => setConnection({ reachable: false, error: 'The LUNADAQ server did not answer.' }))

  useEffect(() => {
    getStatsGraphiteConfig().then((c) => {
      setHost(c.graphite_host || 'localhost')
      setPort(String(c.graphite_port || 80))
      setCarbonPort(String(c.carbon_port || 2003))
      setPrefix(c.graphite_prefix || 'ancillary.rates')
    }).catch(() => {})
    check()
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      const saved = await setStatsGraphiteConfig(host.trim(), parseInt(port), prefix, parseInt(carbonPort))
      if (saved?.graphite_prefix) setPrefix(saved.graphite_prefix)
      toast({ title: 'Saved', description: `Rates go to ${host}:${carbonPort} under ${saved?.graphite_prefix ?? prefix}.` })
      check()
    } catch (e: any) {
      toast({ title: 'Not saved', description: e?.response?.data?.error ?? 'Could not save the Graphite server', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>Graphite server</CardTitle>
            <CardDescription>
              The DAQ writes its counting rates there, and the Stats page reads the accelerator's
              metrics from it.
            </CardDescription>
          </div>
          {connection && (
            <StatusBadge state={connection.reachable ? 'ready' : 'error'}
                         label={connection.reachable ? 'Reachable' : 'Unreachable'}
                         title={connection.reachable ? undefined : connection.error} />
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2 sm:col-span-3 md:col-span-1">
            <Label htmlFor="graphite-host">Host</Label>
            <Input id="graphite-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="lunaserver" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="graphite-port">Web port</Label>
            <Input id="graphite-port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} placeholder="80" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="carbon-port">Carbon port</Label>
            <Input id="carbon-port" inputMode="numeric" value={carbonPort} onChange={(e) => setCarbonPort(e.target.value)} placeholder="2003" />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="graphite-prefix">Metric prefix (experiment)</Label>
          <Input id="graphite-prefix" value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="ancillary.rates.12c12c" />
          <p className="text-xs text-muted-foreground">
            Give each experiment its own subtree so campaigns never share a series: rates land under{' '}
            <code className="break-all font-mono">{prefix || 'ancillary.rates'}.bo_&lt;board&gt;.ch_&lt;channel&gt;.totalRate</code>.
            A running acquisition picks a change up at its next statistics interval.
          </p>
        </div>
        {/* The running acquisition takes the new address up within one
            statistics interval: say so before it is changed mid-run. */}
        {isRunning && (
          <p className="text-xs text-warning" role="note">
            A run is going: this applies now, and the run&apos;s rates go to the new server from its next statistics interval.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
          <p className="text-xs text-muted-foreground">
            No Graphite in the lab? <code className="font-mono">scripts/monitoring.sh start</code> runs
            Graphite and Grafana on this PC in Docker.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
