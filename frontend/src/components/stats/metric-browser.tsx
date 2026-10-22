"use client"

import { useCallback, useEffect, useState } from 'react'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { ChevronRight, Folder, Gauge, Loader2, RefreshCw, Search, X } from 'lucide-react'
import Link from 'next/link'
import { browseMetrics, getRecentMetrics, getStatsConnection, type MetricNode, type RecentMetric } from '@/lib/api'
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Sparkline } from "@/components/stats/sparkline"
import { formatReading } from "@/components/card-holder"

function age(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 90) return `${Math.round(s)} s ago`
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  return `${(s / 3600).toFixed(1)} h ago`
}

/** What Graphite has had a value for in the last hour: the metrics worth adding. */
function ActiveMetrics({ existing, onSelect, onBrowseAll }: {
  existing: string[]
  onSelect: (path: string, leaf: string) => void
  onBrowseAll: () => void
}) {
  const [items, setItems] = useState<RecentMetric[] | null>(null)
  const [info, setInfo] = useState<{ scanned: number; truncated: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (refresh = false) => {
    setLoading(true)
    try {
      const r = await getRecentMetrics(refresh)
      // An unreachable Graphite also comes back as an empty list (nothing
      // scanned), which would read as "nothing updated lately". Ask whether
      // it answers at all, so the two are told apart.
      if (r.metrics.length === 0 && r.scanned === 0) {
        const c = await getStatsConnection().catch(() => null)
        if (c && !c.reachable) {
          setItems(null)
          setInfo(null)
          setError(`Graphite at ${c.host}:${c.port}: ${c.error || 'no answer.'}`)
          return
        }
      }
      setItems(r.metrics)
      setInfo({ scanned: r.scanned, truncated: r.truncated })
      setError(null)
    } catch (e) {
      const serverMessage = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
      setError(serverMessage ?? 'Could not reach the Graphite server.')
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { load() }, [load])

  const shown = (items ?? []).filter((m) => !filter || m.path.toLowerCase().includes(filter.toLowerCase()))
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter (e.g. voltage)" className="h-9" />
        <Button variant="outline" size="sm" className="h-9" onClick={() => load(true)} disabled={loading}
                aria-label="Look again" title="Look again (the list is kept for a minute)">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>
      <ScrollArea className="h-72 rounded-md border">
        {loading && items === null ? (
          <div className="flex h-72 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />Looking for metrics updated in the last hour…
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-2 p-6 text-center text-sm">
            <p className="text-destructive">{error}</p>
            <Link href="/settings?view=monitoring" className="text-primary underline underline-offset-2">
              Check the address in Settings → Monitoring
            </Link>
          </div>
        ) : shown.length === 0 ? (
          items?.length ? (
            <p className="p-6 text-center text-sm text-muted-foreground">Nothing matches that filter.</p>
          ) : (
            <div className="flex flex-col items-center gap-3 p-6 text-center text-sm text-muted-foreground">
              <p>No metric has been updated in the last hour.</p>
              <Button variant="outline" size="sm" onClick={onBrowseAll}>Browse all metrics</Button>
            </div>
          )
        ) : (
          <div className="divide-y">
            {shown.map((m) => {
              const label = m.path.split('.').pop() ?? m.path
              const already = existing.includes(m.path)
              return (
                <button key={m.path} disabled={already} onClick={() => onSelect(m.path, label)}
                        className="grid w-full grid-cols-[1fr_auto] items-center gap-x-3 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/60 disabled:opacity-50 disabled:hover:bg-transparent sm:grid-cols-[1fr_5rem_auto]">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{label}</span>
                    <span className="block truncate text-xs text-muted-foreground">{m.path}</span>
                  </span>
                  <Sparkline values={m.trend} height={24} className="hidden text-primary sm:block" />
                  <span className="text-right">
                    <span className="block font-mono text-sm tabular-nums">{formatReading(m.value)}</span>
                    <span className="block text-xs text-muted-foreground">{already ? 'added' : age(m.timestamp)}</span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </ScrollArea>
      {info && (
        <p className="text-xs text-muted-foreground">
          {items?.length ?? 0} of {info.scanned} metrics had a value in the last hour
          {info.truncated ? ' (the tree is large: only the first part was looked at — browse for the rest)' : ''}.
          The DAQ's own rates are on the Data rates page.
        </p>
      )}
    </div>
  )
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the full path of the metric that was picked. */
  onSelect: (path: string, leafName: string) => void
  /** Paths already on the page — shown as such so they are not added twice. */
  existing?: string[]
}

/**
 * Pick a metric out of Graphite instead of typing its path.
 *
 * Graphite matches one level at a time, so the browser walks the tree branch by
 * branch. Searching asks each of the first few levels at once, which is how a
 * name can be found without knowing which branch it lives under.
 */
export function MetricBrowser({ open, onOpenChange, onSelect, existing = [] }: Props) {
  const [prefix, setPrefix] = useState('')
  const [nodes, setNodes] = useState<MetricNode[]>([])
  const [search, setSearch] = useState('')
  const [activeSearch, setActiveSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState('active')

  const load = useCallback(async (branch: string, term: string) => {
    setLoading(true)
    try {
      const data = await browseMetrics(branch, term)
      setNodes(data.nodes)
      setError(null)
    } catch (e) {
      const serverMessage = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
      setError(serverMessage ?? 'Could not reach the Graphite server. Check its address in Settings → Monitoring.')
      setNodes([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setTab('active')
    setPrefix('')
    setSearch('')
    setActiveSearch('')
    load('', '')
  }, [open, load])

  function openBranch(path: string) {
    setActiveSearch('')
    setSearch('')
    setPrefix(path)
    load(path, '')
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    const term = search.trim()
    setActiveSearch(term)
    load(term ? '' : prefix, term)
  }

  // "accelerator.beam" -> [accelerator, beam], for the breadcrumb.
  const crumbs = prefix ? prefix.split('.') : []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a metric</DialogTitle>
          <DialogDescription>
            Pick one of the metrics Graphite has had values for in the last hour, or browse them all.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="active">Active in the last hour</TabsTrigger>
            <TabsTrigger value="all">Browse all</TabsTrigger>
          </TabsList>
          <TabsContent value="active">
            {open && <ActiveMetrics existing={existing} onSelect={onSelect} onBrowseAll={() => setTab('all')} />}
          </TabsContent>
          <TabsContent value="all" className="space-y-3">

        <form onSubmit={handleSearch} className="flex gap-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search all metrics (e.g. voltage)"
            className="h-9"
          />
          <Button type="submit" variant="outline" size="sm" className="h-9">
            <Search className="h-4 w-4" />
          </Button>
          {activeSearch && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-9"
              onClick={() => { setSearch(''); setActiveSearch(''); load(prefix, '') }}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </form>

        {!activeSearch && (
          <div className="flex flex-wrap items-center gap-1 text-sm">
            <button
              className="rounded px-1.5 py-0.5 hover:bg-muted"
              onClick={() => openBranch('')}
            >
              All metrics
            </button>
            {crumbs.map((crumb, i) => (
              <span key={i} className="flex items-center gap-1">
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
                <button
                  className="rounded px-1.5 py-0.5 hover:bg-muted"
                  onClick={() => openBranch(crumbs.slice(0, i + 1).join('.'))}
                >
                  {crumb}
                </button>
              </span>
            ))}
          </div>
        )}

        <ScrollArea className="h-72 rounded-md border">
          {loading ? (
            <div className="flex h-72 items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <p className="p-6 text-center text-sm text-destructive">{error}</p>
          ) : nodes.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              {activeSearch ? 'Nothing matched that search.' : 'This branch is empty.'}
            </p>
          ) : (
            <div className="divide-y">
              {nodes.map(node => {
                const label = node.path.split('.').pop() ?? node.path
                const already = existing.includes(node.path)
                return (
                  <button
                    key={node.path}
                    disabled={node.is_leaf && already}
                    onClick={() => node.is_leaf ? onSelect(node.path, label) : openBranch(node.path)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/60 disabled:opacity-50 disabled:hover:bg-transparent"
                  >
                    {node.is_leaf
                      ? <Gauge className="h-4 w-4 shrink-0 text-primary" />
                      : <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 flex-1 truncate">
                      {activeSearch ? node.path : label}
                    </span>
                    {node.is_leaf
                      ? (already && <span className="text-xs text-muted-foreground">added</span>)
                      : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
                  </button>
                )
              })}
            </div>
          )}
        </ScrollArea>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
