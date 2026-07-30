'use client'

import { useCallback, useEffect, useState } from 'react'
import { Eye, EyeOff, Gauge, Pencil, Plus, RefreshCw, Settings2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Layout } from '@/components/dashboard-layout'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useStatsStore } from '@/store/stats-store'
import {
  getStatsPaths,
  addStatsPath,
  removeStatsPath,
  updateStatsPath,
  getStatsMetricLastValue,
  getStatsMetricSeries,
  getStatsGraphiteConfig,
  setStatsGraphiteConfig,
  getStatsConnection,
} from '@/lib/api'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { MetricBrowser } from '@/components/stats/metric-browser'
import { MetricDetailsDialog } from '@/components/stats/metric-details-dialog'
import { Sparkline } from '@/components/stats/sparkline'

// How much history the trend line on each card covers. Graphite's minute unit
// is "min" — "-30m" is rejected outright ("Invalid offset unit 'm'").
const HISTORY_WINDOW = '-30min'
const VALUE_REFRESH_MS = 5000
const HISTORY_REFRESH_MS = 60000
const CONNECTION_REFRESH_MS = 15000

/** A reading is easier to compare across metrics when its magnitude decides the format. */
function formatValue(value: number): string {
  if (value === 0) return '0'
  const magnitude = Math.abs(value)
  if (magnitude >= 1e6 || magnitude < 1e-3) return value.toExponential(3)
  if (magnitude >= 100) return value.toFixed(1)
  return value.toFixed(3)
}

export default function StatsPage() {
  const { toast } = useToast()
  const { paths, currentValues, setCurrentValue, setPaths } = useStatsStore()
  const [isLoading, setIsLoading] = useState(false)
  const [pathToDelete, setPathToDelete] = useState<string | null>(null)
  const [error, setLocalError] = useState<string | null>(null)
  const [browserOpen, setBrowserOpen] = useState(false)
  const [history, setHistory] = useState<Record<string, (number | null)[]>>({})
  // null while the first check is in flight, so the light can say "checking"
  // instead of claiming the server is down.
  const [connection, setConnection] = useState<{ reachable: boolean; error: string } | null>(null)
  // The metric being named: a new one picked in the browser, or an existing one
  // being renamed. Both use the same dialog.
  const [details, setDetails] = useState<
    { mode: 'add' | 'edit'; path: string; name: string; unit: string } | null
  >(null)

  // Graphite configuration — needed rarely, so it stays folded away.
  const [graphiteHost, setGraphiteHost] = useState('localhost')
  const [graphitePort, setGraphitePort] = useState('80')
  // Root of the metric tree the DAQ writes rates into. It names the experiment,
  // not a board — each campaign gets its own subtree so their series never mix.
  const [graphitePrefix, setGraphitePrefix] = useState('ancillary.rates')
  const [showGraphiteConfig, setShowGraphiteConfig] = useState(false)

  useEffect(() => {
    const loadGraphiteConfig = async () => {
      try {
        const config = await getStatsGraphiteConfig()
        setGraphiteHost(config.graphite_host || 'localhost')
        setGraphitePort(String(config.graphite_port || 80))
        setGraphitePrefix(config.graphite_prefix || 'ancillary.rates')
      } catch (error) {
        console.error('Failed to load graphite config:', error)
      }
    }
    loadGraphiteConfig()
  }, [])

  // Is Graphite answering? Without this, a server that is down looks exactly
  // like metrics that happen to have no data.
  useEffect(() => {
    const check = async () => {
      try {
        const status = await getStatsConnection()
        setConnection({ reachable: status.reachable, error: status.error })
      } catch {
        setConnection({ reachable: false, error: 'The WebDAQ server did not answer.' })
      }
    }
    check()
    const interval = setInterval(check, CONNECTION_REFRESH_MS)
    return () => clearInterval(interval)
  }, [graphiteHost, graphitePort])

  const reloadPaths = useCallback(async () => {
    const data = await getStatsPaths()
    setPaths(data || [])
    return data || []
  }, [setPaths])

  useEffect(() => {
    const loadPaths = async () => {
      try {
        setIsLoading(true)
        await reloadPaths()
        setLocalError(null)
      } catch (err) {
        setLocalError(err instanceof Error ? err.message : 'Failed to load paths')
      } finally {
        setIsLoading(false)
      }
    }
    loadPaths()
  }, [reloadPaths])

  // Latest reading of every enabled metric.
  useEffect(() => {
    const refreshValues = async () => {
      for (const path of paths.filter(p => p.enabled)) {
        try {
          const data = await getStatsMetricLastValue(path.path)
          if (data && data.value !== undefined) {
            setCurrentValue(path.path, data.value, data.timestamp)
          }
        } catch (err) {
          console.error(`Failed to fetch value for ${path.path}:`, err)
        }
      }
    }
    if (paths.length === 0) return
    refreshValues()
    const interval = setInterval(refreshValues, VALUE_REFRESH_MS)
    return () => clearInterval(interval)
  }, [paths, setCurrentValue])

  // History for the trend lines. Far more data per request than the readings,
  // so it refreshes on its own, slower schedule.
  useEffect(() => {
    const refreshHistory = async () => {
      for (const path of paths.filter(p => p.enabled)) {
        try {
          const series = await getStatsMetricSeries(path.path, HISTORY_WINDOW)
          setHistory(prev => ({
            ...prev,
            [path.path]: Array.isArray(series) ? series.map(point => point?.[1] ?? null) : [],
          }))
        } catch {
          setHistory(prev => ({ ...prev, [path.path]: [] }))
        }
      }
    }
    if (paths.length === 0) return
    refreshHistory()
    const interval = setInterval(refreshHistory, HISTORY_REFRESH_MS)
    return () => clearInterval(interval)
  }, [paths])

  const handleAddPath = async (path: string, alias: string, unit: string) => {
    try {
      setIsLoading(true)
      await addStatsPath(path, alias || path, unit)
      await reloadPaths()
      setLocalError(null)
      toast({ title: 'Metric added', description: unit ? `${alias} [${unit}]` : alias })
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to add path')
    } finally {
      setIsLoading(false)
    }
  }

  const handleEditPath = async (path: string, alias: string, unit: string) => {
    try {
      setIsLoading(true)
      await updateStatsPath(path, alias, undefined, unit)
      await reloadPaths()
      setLocalError(null)
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to update the metric')
    } finally {
      setIsLoading(false)
    }
  }

  const handleDeletePath = async (path: string) => {
    try {
      setIsLoading(true)
      await removeStatsPath(path)
      await reloadPaths()
      setPathToDelete(null)
      setLocalError(null)
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to delete path')
    } finally {
      setIsLoading(false)
    }
  }

  const handleTogglePath = async (path: string, currentEnabled: boolean) => {
    try {
      setIsLoading(true)
      await updateStatsPath(path, undefined, !currentEnabled)
      await reloadPaths()
      setLocalError(null)
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to update path')
    } finally {
      setIsLoading(false)
    }
  }

  const handleRefreshValues = async () => {
    try {
      setIsLoading(true)
      for (const path of paths.filter(p => p.enabled)) {
        try {
          const data = await getStatsMetricLastValue(path.path)
          if (data && data.value !== undefined) {
            setCurrentValue(path.path, data.value, data.timestamp)
          }
        } catch (err) {
          console.error(`Failed to fetch value for ${path.path}:`, err)
        }
      }
      setLocalError(null)
    } finally {
      setIsLoading(false)
    }
  }

  const handleSaveGraphiteConfig = async () => {
    try {
      const saved = await setStatsGraphiteConfig(
        graphiteHost, parseInt(graphitePort), graphitePrefix)
      // The server normalises the prefix (dots kept, everything Graphite would
      // choke on becomes '_'), so show what will actually be written.
      if (saved?.graphite_prefix) setGraphitePrefix(saved.graphite_prefix)
      toast({
        title: 'Saved',
        description: `Graphite server updated — rates go to ${saved?.graphite_prefix ?? graphitePrefix}.bo_<board>`,
      })
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.response?.data?.error || 'Failed to save the Graphite configuration',
        variant: 'destructive',
      })
    }
  }

  const enabledCount = paths.filter(p => p.enabled).length

  return (
    <Layout>
      <div className="space-y-6 p-6">
        {/* Header — what the page is, and the two things you do here */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Stats</h1>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {/* The light: green while Graphite answers, red when it does not,
                  grey until the first check comes back. */}
              <span
                className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${
                  connection === null
                    ? 'bg-muted-foreground/40'
                    : connection.reachable
                      ? 'bg-green-500'
                      : 'bg-red-500 animate-pulse'
                }`}
                title={
                  connection === null
                    ? 'Checking the Graphite server…'
                    : connection.reachable
                      ? `Graphite at ${graphiteHost}:${graphitePort} is answering`
                      : connection.error || 'No answer from the Graphite server'
                }
              />
              <span>
                {connection === null
                  ? `Checking ${graphiteHost}…`
                  : connection.reachable
                    ? `${graphiteHost} connected`
                    : `${graphiteHost} unreachable`}
              </span>
              {paths.length > 0 && (
                <span>
                  · {enabledCount} of {paths.length} metric{paths.length === 1 ? '' : 's'} shown
                </span>
              )}
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={handleRefreshValues} disabled={isLoading} variant="outline" size="sm">
              <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button onClick={() => setBrowserOpen(true)} size="sm">
              <Plus className="mr-2 h-4 w-4" />
              Add metric
            </Button>
          </div>
        </div>

        {error && (
          <Card className="border-destructive">
            <CardContent className="flex items-center justify-between gap-4 pt-6">
              <p className="text-sm text-destructive">{error}</p>
              <Button onClick={() => setLocalError(null)} variant="ghost" size="sm">
                Dismiss
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Metrics — the reason for the page, so they come first */}
        {paths.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-16 text-center">
            <Gauge className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No metrics yet. Browse what Graphite is collecting and pick the ones to watch.
            </p>
            <Button onClick={() => setBrowserOpen(true)} size="sm" variant="outline">
              <Plus className="mr-2 h-4 w-4" />
              Add metric
            </Button>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {paths.map((path) => {
              const reading = currentValues[path.path]
              const value = reading?.value
              const hasValue = path.enabled && value !== undefined && value !== null
              return (
                <Card key={path.path} className={path.enabled ? '' : 'opacity-60'}>
                  <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 pb-2">
                    <div className="min-w-0">
                      <CardTitle className="truncate text-sm font-medium" title={path.alias}>
                        {path.alias}
                      </CardTitle>
                      <p className="truncate text-xs text-muted-foreground" title={path.path}>
                        {path.path}
                      </p>
                    </div>
                    <div className="flex shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => setDetails({
                          mode: 'edit',
                          path: path.path,
                          name: path.alias,
                          unit: path.unit ?? '',
                        })}
                        disabled={isLoading}
                        title="Rename or set the unit"
                      >
                        <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => handleTogglePath(path.path, path.enabled)}
                        disabled={isLoading}
                        title={path.enabled ? 'Stop reading this metric' : 'Read this metric again'}
                      >
                        {path.enabled
                          ? <Eye className="h-3.5 w-3.5 text-green-600" />
                          : <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => setPathToDelete(path.path)}
                        disabled={isLoading}
                        title="Remove"
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-2xl font-bold">
                        {hasValue ? formatValue(Number(value)) : (path.enabled ? 'N/A' : 'Off')}
                      </span>
                      {hasValue && path.unit && (
                        <span className="text-sm text-muted-foreground">{path.unit}</span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {path.enabled && reading?.timestamp
                        ? new Date(reading.timestamp as string).toLocaleTimeString()
                        : path.enabled ? 'No data in the last readings' : 'Disabled'}
                    </p>
                    {path.enabled && (
                      <div className="mt-2 border-t pt-2">
                        <Sparkline values={history[path.path] ?? []} />
                      </div>
                    )}
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}

        {/* Server settings — needed once per setup, so out of the way */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 py-4">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Settings2 className="h-4 w-4" />
              Graphite server
              <span className="font-normal text-muted-foreground">
                {graphiteHost}:{graphitePort}
              </span>
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={() => setShowGraphiteConfig(!showGraphiteConfig)}>
              {showGraphiteConfig ? 'Hide' : 'Change'}
            </Button>
          </CardHeader>
          {showGraphiteConfig && (
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="stats-graphite-host">Host</Label>
                  <Input
                    id="stats-graphite-host"
                    value={graphiteHost}
                    onChange={(e) => setGraphiteHost(e.target.value)}
                    placeholder="lunaserver"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="stats-graphite-port">Port</Label>
                  <Input
                    id="stats-graphite-port"
                    value={graphitePort}
                    onChange={(e) => setGraphitePort(e.target.value)}
                    placeholder="80"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="stats-graphite-prefix">Metric prefix (experiment)</Label>
                <Input
                  id="stats-graphite-prefix"
                  value={graphitePrefix}
                  onChange={(e) => setGraphitePrefix(e.target.value)}
                  placeholder="ancillary.rates.12c12c"
                />
                <p className="text-xs text-muted-foreground">
                  Where the DAQ writes its rates. Give each experiment its own subtree so
                  campaigns never share a series — rates land under{' '}
                  <code className="font-mono">
                    {(graphitePrefix || 'ancillary.rates')}.bo_&lt;board&gt;.ch_&lt;channel&gt;.totalRate
                  </code>
                  . A live run picks up a change on its next stats interval.
                </p>
              </div>
              <Button onClick={handleSaveGraphiteConfig}>Save</Button>
            </CardContent>
          )}
        </Card>

        <MetricBrowser
          open={browserOpen}
          onOpenChange={setBrowserOpen}
          existing={paths.map(p => p.path)}
          onSelect={(path, leafName) => {
            // Picking the metric is only half of it: name and unit come next,
            // because both end up in the run's stats.csv.
            setBrowserOpen(false)
            setDetails({ mode: 'add', path, name: leafName, unit: '' })
          }}
        />

        {details && (
          <MetricDetailsDialog
            open={!!details}
            onOpenChange={(open) => !open && setDetails(null)}
            mode={details.mode}
            path={details.path}
            initialName={details.name}
            initialUnit={details.unit}
            onSubmit={(name, unit) => {
              const { mode, path } = details
              setDetails(null)
              if (mode === 'add') handleAddPath(path, name, unit)
              else handleEditPath(path, name, unit)
            }}
          />
        )}

        <AlertDialog open={!!pathToDelete} onOpenChange={(open) => !open && setPathToDelete(null)}>
          <AlertDialogContent>
            <AlertDialogTitle>Remove this metric?</AlertDialogTitle>
            <AlertDialogDescription>
              It disappears from this page. The data itself stays in Graphite, so you can add it
              back at any time.
            </AlertDialogDescription>
            <div className="flex justify-end gap-2">
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => pathToDelete && handleDeletePath(pathToDelete)}
                className="bg-destructive hover:bg-destructive/90"
              >
                Remove
              </AlertDialogAction>
            </div>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </Layout>
  )
}
