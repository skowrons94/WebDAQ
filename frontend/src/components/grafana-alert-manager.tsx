'use client'

import { useState, useEffect, useCallback } from 'react'
import { Bell, BellOff, Check, ExternalLink, Pencil, RefreshCw, Shield, X, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { useToast } from '@/components/ui/use-toast'
import {
  fetchAlertRules,
  setAlertPauseState,
  updateAlertThreshold,
  extractThreshold,
  GRAFANA_URL,
} from '@/lib/grafana-api'
import { useGrafanaAlertsStore } from '@/store/grafana-alerts-store'
import useRunControlStore from '@/store/run-control-store'

interface AlertRule {
  uid: string
  title: string
  ruleGroup: string
  isPaused: boolean
  threshold: number | null
}

type FilterMode = 'all' | 'active' | 'paused'

export default function GrafanaAlertManager() {
  const { toast } = useToast()
  const { autoManageUids, toggleAutoManage } = useGrafanaAlertsStore()
  const isRunning = useRunControlStore((state) => state.isRunning)

  const [alerts, setAlerts] = useState<AlertRule[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterMode>('all')
  const [search, setSearch] = useState('')
  const [pendingActions, setPendingActions] = useState<string[]>([])
  const [editingUid, setEditingUid] = useState<string | null>(null)
  const [editingValue, setEditingValue] = useState<string>('')

  // ─── Load alerts ───────────────────────────────────────────────────────────
  const loadAlerts = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true)
      else setLoading(true)
      setError(null)
      const rules = await fetchAlertRules()
      setAlerts(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rules.map((r: any) => ({
          uid: r.uid,
          title: r.title,
          ruleGroup: r.ruleGroup || '—',
          isPaused: r.isPaused || false,
          threshold: extractThreshold(r),
        }))
      )
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    loadAlerts()
  }, [loadAlerts])

  // ─── Toggle pause state ────────────────────────────────────────────────────
  const handleTogglePause = async (uid: string, currentlyPaused: boolean) => {
    setPendingActions((p) => [...p, uid])
    try {
      await setAlertPauseState(uid, !currentlyPaused)
      setAlerts((prev) =>
        prev.map((a) => (a.uid === uid ? { ...a, isPaused: !currentlyPaused } : a))
      )
      toast({
        title: currentlyPaused ? 'Alert activated' : 'Alert silenced',
        description: currentlyPaused
          ? 'The alert rule is now active.'
          : 'The alert rule has been paused.',
      })
    } catch (e: unknown) {
      toast({
        title: 'Error',
        description: e instanceof Error ? e.message : 'Failed to update alert.',
        variant: 'destructive',
      })
    } finally {
      setPendingActions((p) => p.filter((id) => id !== uid))
    }
  }

  // ─── Threshold editing ─────────────────────────────────────────────────────
  const handleThresholdSave = async (uid: string) => {
    const threshold = parseFloat(editingValue)
    if (isNaN(threshold)) return
    setPendingActions((p) => [...p, uid])
    try {
      await updateAlertThreshold(uid, threshold)
      setAlerts((prev) =>
        prev.map((a) => (a.uid === uid ? { ...a, threshold } : a))
      )
      setEditingUid(null)
      toast({ title: 'Threshold updated', description: `New value: ${threshold}` })
    } catch (e: unknown) {
      toast({
        title: 'Error',
        description: e instanceof Error ? e.message : 'Failed to update threshold.',
        variant: 'destructive',
      })
    } finally {
      setPendingActions((p) => p.filter((id) => id !== uid))
    }
  }

  // ─── Bulk actions ──────────────────────────────────────────────────────────
  const bulkAction = async (action: 'pause' | 'unpause') => {
    const targets = filteredAlerts.filter((a) =>
      action === 'pause' ? !a.isPaused : a.isPaused
    )
    if (targets.length === 0) return
    const uids = targets.map((a) => a.uid)
    setPendingActions((p) => [...p, ...uids])

    await Promise.allSettled(
      targets.map((a) => setAlertPauseState(a.uid, action === 'pause'))
    )

    setAlerts((prev) =>
      prev.map((a) =>
        uids.includes(a.uid) ? { ...a, isPaused: action === 'pause' } : a
      )
    )
    setPendingActions((p) => p.filter((id) => !uids.includes(id)))
    toast({
      title: `${targets.length} alert(s) ${action === 'pause' ? 'paused' : 'activated'}`,
    })
  }

  // ─── Filtering ─────────────────────────────────────────────────────────────
  const filteredAlerts = alerts.filter((a) => {
    const matchFilter =
      filter === 'all' ||
      (filter === 'active' && !a.isPaused) ||
      (filter === 'paused' && a.isPaused)
    const matchSearch =
      !search ||
      a.title.toLowerCase().includes(search.toLowerCase()) ||
      a.uid.toLowerCase().includes(search.toLowerCase()) ||
      a.ruleGroup.toLowerCase().includes(search.toLowerCase())
    return matchFilter && matchSearch
  })

  const activeCount = alerts.filter((a) => !a.isPaused).length
  const pausedCount = alerts.filter((a) => a.isPaused).length

  return (
    <div className="space-y-4">
      {/* Header card */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                <Shield className="h-5 w-5" />
              </div>
              <div>
                <CardTitle className="text-xl">Alert Manager</CardTitle>
                <p className="text-sm text-muted-foreground">Grafana Alert Control Panel</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                onClick={() => loadAlerts(true)}
                disabled={refreshing}
                title="Refresh"
              >
                <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
              </Button>
              <Button variant="outline" size="icon" asChild title="Open Grafana">
                <a href={`${GRAFANA_URL}/alerting/list`} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4" />
                </a>
              </Button>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Run status + auto-managed count */}
      <Card>
        <CardContent className="flex items-center justify-between pt-5 pb-5">
          <div className="flex items-center gap-3">
            <span
              className={`h-3 w-3 rounded-full animate-pulse ${
                isRunning ? 'bg-green-500' : 'bg-muted-foreground'
              }`}
            />
            <div>
              <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                DAQ Run Status
              </p>
              <p className="text-base font-semibold">
                {isRunning ? 'Running' : 'Stopped'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 text-sm font-medium text-primary">
            <Zap className="h-4 w-4" />
            {autoManageUids.length} auto-managed
          </div>
        </CardContent>
      </Card>

      {/* Stats bar */}
      <div className="grid grid-cols-3 gap-3">
        <Card>
          <CardContent className="flex flex-col items-center justify-center pt-4 pb-4 gap-0.5">
            <span className="text-2xl font-bold">{alerts.length}</span>
            <span className="text-xs text-muted-foreground font-medium">Total</span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col items-center justify-center pt-4 pb-4 gap-0.5">
            <span className="text-2xl font-bold text-green-500">{activeCount}</span>
            <span className="text-xs text-muted-foreground font-medium">Active</span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col items-center justify-center pt-4 pb-4 gap-0.5">
            <span className="text-2xl font-bold text-amber-500">{pausedCount}</span>
            <span className="text-xs text-muted-foreground font-medium">Paused</span>
          </CardContent>
        </Card>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Filter buttons */}
        <div className="flex overflow-hidden rounded-lg border bg-background">
          {(['all', 'active', 'paused'] as FilterMode[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-4 py-2 text-sm font-medium transition-colors ${
                filter === f
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>

        {/* Search */}
        <Input
          type="text"
          placeholder="Search alerts…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-40"
        />

        {/* Bulk actions */}
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => bulkAction('pause')}>
            <BellOff className="mr-1.5 h-3.5 w-3.5" />
            Pause All
          </Button>
          <Button variant="outline" size="sm" onClick={() => bulkAction('unpause')}>
            <Bell className="mr-1.5 h-3.5 w-3.5" />
            Unpause All
          </Button>
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <Card>
          <CardContent className="flex items-center justify-center gap-3 py-16 text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin" />
            Loading alerts…
          </CardContent>
        </Card>
      ) : error ? (
        <Card className="border-destructive">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-lg font-bold text-destructive">Connection Error</p>
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button onClick={() => loadAlerts()} variant="outline" size="sm">
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : filteredAlerts.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            No alerts found{search ? ` matching "${search}"` : ''}.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto rounded-lg">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Status
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Alert Name
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Group
                    </th>
                    <th className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Threshold
                    </th>
                    <th className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Auto
                    </th>
                    <th className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAlerts.map((alert) => {
                    const isPending = pendingActions.includes(alert.uid)
                    const isAuto = autoManageUids.includes(alert.uid)
                    return (
                      <tr
                        key={alert.uid}
                        className="border-b last:border-0 transition-colors hover:bg-muted/30"
                        style={{ opacity: isPending ? 0.6 : 1 }}
                      >
                        {/* Status */}
                        <td className="px-4 py-3 text-center">
                          <Badge
                            variant={alert.isPaused ? 'secondary' : 'default'}
                            className={`gap-1.5 ${
                              alert.isPaused
                                ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400'
                                : 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                            }`}
                          >
                            {alert.isPaused ? (
                              <BellOff className="h-3 w-3" />
                            ) : (
                              <Bell className="h-3 w-3" />
                            )}
                            {alert.isPaused ? 'Paused' : 'Active'}
                          </Badge>
                        </td>

                        {/* Name */}
                        <td className="px-4 py-3 text-left">
                          <p className="font-semibold">{alert.title}</p>
                          <p className="font-mono text-xs text-muted-foreground mt-0.5">
                            {alert.uid}
                          </p>
                        </td>

                        {/* Group */}
                        <td className="px-4 py-3 text-left">
                          <Badge variant="secondary">{alert.ruleGroup}</Badge>
                        </td>

                        {/* Threshold */}
                        <td className="px-4 py-3 text-center">
                          {alert.threshold === null ? (
                            <span className="text-muted-foreground text-xs">—</span>
                          ) : editingUid === alert.uid ? (
                            <div className="flex items-center gap-1 justify-center">
                              <Input
                                type="number"
                                value={editingValue}
                                onChange={(e) => setEditingValue(e.target.value)}
                                className="h-7 w-24 text-sm text-right"
                                autoFocus
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleThresholdSave(alert.uid)
                                  if (e.key === 'Escape') setEditingUid(null)
                                }}
                              />
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7"
                                onClick={() => handleThresholdSave(alert.uid)}
                                disabled={isPending}
                              >
                                <Check className="h-3.5 w-3.5 text-green-600" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7"
                                onClick={() => setEditingUid(null)}
                              >
                                <X className="h-3.5 w-3.5 text-muted-foreground" />
                              </Button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5 justify-center">
                              <span className="font-mono text-sm">{alert.threshold}</span>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-6 w-6 opacity-50 hover:opacity-100"
                                disabled={isPending}
                                onClick={() => {
                                  setEditingUid(alert.uid)
                                  setEditingValue(alert.threshold!.toString())
                                }}
                              >
                                <Pencil className="h-3 w-3" />
                              </Button>
                            </div>
                          )}
                        </td>

                        {/* Auto-manage toggle */}
                        <td className="px-4 py-3 text-center">
                          <Button
                            variant={isAuto ? 'default' : 'outline'}
                            size="icon"
                            className={`h-8 w-8 ${
                              isAuto
                                ? 'bg-primary text-primary-foreground'
                                : 'text-muted-foreground'
                            }`}
                            onClick={() => toggleAutoManage(alert.uid)}
                            title={
                              isAuto
                                ? 'Remove from auto-manage'
                                : 'Add to auto-manage (activate on run start, silence on stop)'
                            }
                          >
                            <Zap className="h-3.5 w-3.5" />
                          </Button>
                        </td>

                        {/* Action button */}
                        <td className="px-4 py-3 text-center">
                          <Button
                            size="sm"
                            variant={alert.isPaused ? 'default' : 'secondary'}
                            className={
                              alert.isPaused
                                ? 'bg-green-600 hover:bg-green-700 text-white'
                                : 'bg-amber-500 hover:bg-amber-600 text-white'
                            }
                            disabled={isPending}
                            onClick={() => handleTogglePause(alert.uid, alert.isPaused)}
                          >
                            {isPending ? (
                              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                            ) : alert.isPaused ? (
                              <>
                                <Bell className="mr-1.5 h-3.5 w-3.5" />
                                Activate
                              </>
                            ) : (
                              <>
                                <BellOff className="mr-1.5 h-3.5 w-3.5" />
                                Silence
                              </>
                            )}
                          </Button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
        <span>
          Showing {filteredAlerts.length} of {alerts.length} alert rules
        </span>
        {autoManageUids.length > 0 && (
          <span className="flex items-center gap-1.5 font-medium text-primary">
            <Zap className="h-3.5 w-3.5" />
            {autoManageUids.length} alert(s) linked to run lifecycle
          </span>
        )}
      </div>
    </div>
  )
}
