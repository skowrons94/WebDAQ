"use client"

import { useCallback, useEffect, useState } from 'react'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { ChevronRight, Folder, Gauge, Loader2, Search, X } from 'lucide-react'
import { browseMetrics, type MetricNode } from '@/lib/api'

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

  const load = useCallback(async (branch: string, term: string) => {
    setLoading(true)
    try {
      const data = await browseMetrics(branch, term)
      setNodes(data.nodes)
      setError(null)
    } catch (e) {
      const serverMessage = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
      setError(serverMessage ?? 'Could not reach the Graphite server. Check its address below.')
      setNodes([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
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
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add a metric</DialogTitle>
          <DialogDescription>
            Browse what the Graphite server is collecting, or search for a name.
          </DialogDescription>
        </DialogHeader>

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

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
