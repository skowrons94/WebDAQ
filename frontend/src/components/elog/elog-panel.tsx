"use client"

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useToast } from "@/components/ui/use-toast"
import { BookOpen, MessageSquarePlus, Paperclip, RefreshCw, Reply, Search } from 'lucide-react'
import { getElogEntries, type ElogEntry } from '@/lib/api'
import { ElogAttachment } from '@/components/elog/elog-attachment'
import { ElogComposer } from '@/components/elog/elog-composer'

const PAGE_SIZE = 20

/** ELOG entries may be plain, ELCode or HTML; show them all as readable text. */
function asText(entry: ElogEntry): string {
  if (!entry.text) return ''
  if ((entry.encoding || '').toLowerCase() !== 'html') return entry.text
  // Parsed, not rendered: nothing in the entry executes, and the reader still
  // gets the words rather than a wall of markup.
  if (typeof window === 'undefined') return entry.text
  return new DOMParser().parseFromString(entry.text, 'text/html').body.textContent ?? ''
}

function formatWhen(entry: ElogEntry): string {
  if (entry.date) return entry.date
  const seconds = Number(entry.when)
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toLocaleString() : ''
}

export function ElogPanel() {
  const { toast } = useToast()
  const [entries, setEntries] = useState<ElogEntry[]>([])
  const [selected, setSelected] = useState<ElogEntry | null>(null)
  const [search, setSearch] = useState('')
  const [activeSearch, setActiveSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [composerOpen, setComposerOpen] = useState(false)
  const [replyTo, setReplyTo] = useState<ElogEntry | null>(null)

  const load = useCallback(async (options: { append?: boolean; search?: string } = {}) => {
    const { append = false, search: term = activeSearch } = options
    setLoading(true)
    try {
      const data = await getElogEntries({
        limit: PAGE_SIZE,
        offset: append ? entries.length : 0,
        ...(term ? { search: term } : {}),
      })
      setEntries(prev => (append ? [...prev, ...data.entries] : data.entries))
      setHasMore(data.has_more)
      setError(null)
      if (!append) setSelected(data.entries[0] ?? null)
    } catch (e) {
      const serverMessage = (e as { response?: { data?: { message?: string } } })?.response?.data?.message
      setError(serverMessage ?? 'Could not reach the ELOG server.')
      if (!append) { setEntries([]); setSelected(null) }
    } finally {
      setLoading(false)
    }
  }, [activeSearch, entries.length])

  // Only on mount and when the search term changes — `load` also depends on the
  // current entry count, which would otherwise reload the list after every page.
  useEffect(() => { load({ search: activeSearch }) }, [activeSearch])   // eslint-disable-line react-hooks/exhaustive-deps

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    setActiveSearch(search.trim())
  }

  function handlePosted(id: number) {
    toast({ title: `Entry #${id} posted`, description: "Refreshing the logbook." })
    setActiveSearch('')
    setSearch('')
    load({ search: '' })
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex flex-col gap-4 space-y-0 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>ELOG</CardTitle>
            <CardDescription>
              Entries from the shared logbook. Posting signs your WebDAQ user as the author.
            </CardDescription>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <form onSubmit={handleSearch} className="flex gap-2">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search entries…"
                className="h-9 w-48"
              />
              <Button type="submit" variant="outline" size="sm" className="h-9">
                <Search className="h-4 w-4" />
              </Button>
            </form>
            <Button variant="outline" size="sm" className="h-9" onClick={() => load()} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            <Button
              size="sm"
              className="h-9"
              onClick={() => { setReplyTo(null); setComposerOpen(true) }}
            >
              <MessageSquarePlus className="mr-1.5 h-4 w-4" />
              New entry
            </Button>
          </div>
        </CardHeader>

        {error && (
          <CardContent>
            <div className="rounded-lg border border-dashed p-6 text-center">
              <p className="text-sm text-destructive">{error}</p>
              <p className="mt-2 text-sm text-muted-foreground">
                Check the logbook URL and account in{' '}
                <Link href="/settings?view=elog" className="underline">Settings → ELOG</Link>.
              </p>
            </div>
          </CardContent>
        )}
      </Card>

      {!error && (
        <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
          <Card className="overflow-hidden">
            <ScrollArea className="h-[65vh]">
              <div className="divide-y">
                {entries.length === 0 && !loading && (
                  <p className="p-6 text-center text-sm text-muted-foreground">
                    {activeSearch ? 'No entries matched that search.' : 'The logbook is empty.'}
                  </p>
                )}
                {entries.map(entry => (
                  <button
                    key={entry.id}
                    onClick={() => setSelected(entry)}
                    className={`w-full px-4 py-3 text-left transition-colors hover:bg-muted/50 ${
                      selected?.id === entry.id ? 'bg-muted' : ''}`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="truncate text-sm font-medium">
                        {entry.subject || `Entry #${entry.id}`}
                      </p>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        #{entry.id}
                      </span>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {entry.author || 'unknown'} — {formatWhen(entry)}
                    </p>
                    <div className="mt-1 flex items-center gap-1.5">
                      {entry.type && <Badge variant="outline" className="text-[10px]">{entry.type}</Badge>}
                      {entry.attachments.length > 0 && (
                        <span className="flex items-center text-[10px] text-muted-foreground">
                          <Paperclip className="mr-0.5 h-3 w-3" />
                          {entry.attachments.length}
                        </span>
                      )}
                    </div>
                  </button>
                ))}
                {hasMore && (
                  <div className="p-3">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full"
                      disabled={loading}
                      onClick={() => load({ append: true })}
                    >
                      Load more
                    </Button>
                  </div>
                )}
              </div>
            </ScrollArea>
          </Card>

          <Card>
            {selected ? (
              <>
                <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
                  <div className="min-w-0">
                    <CardTitle className="break-words">
                      {selected.subject || `Entry #${selected.id}`}
                    </CardTitle>
                    <CardDescription>
                      #{selected.id} — {selected.author || 'unknown'} — {formatWhen(selected)}
                      {selected.in_reply_to && ` — in reply to #${selected.in_reply_to}`}
                    </CardDescription>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => { setReplyTo(selected); setComposerOpen(true) }}
                  >
                    <Reply className="mr-1.5 h-4 w-4" />
                    Reply
                  </Button>
                </CardHeader>
                <CardContent className="space-y-4">
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-y py-3 text-xs">
                    {Object.entries(selected.attributes)
                      .filter(([name]) => !name.startsWith('$') && name !== 'Attachment')
                      .map(([name, value]) => (
                        <div key={name} className="contents">
                          <dt className="text-muted-foreground">{name}</dt>
                          <dd className="break-words">{String(value)}</dd>
                        </div>
                      ))}
                  </dl>

                  <ScrollArea className="h-[40vh]">
                    <p className="whitespace-pre-wrap break-words text-sm">{asText(selected)}</p>

                    {selected.attachments.length > 0 && (
                      <div className="mt-6 space-y-3 border-t pt-4">
                        <p className="text-xs font-medium text-muted-foreground">Attachments</p>
                        {selected.attachments.map(url => (
                          <ElogAttachment key={url} url={url} />
                        ))}
                      </div>
                    )}
                  </ScrollArea>
                </CardContent>
              </>
            ) : (
              <CardContent className="flex h-full flex-col items-center justify-center gap-2 py-20 text-center">
                <BookOpen className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  {loading ? 'Loading the logbook…' : 'Select an entry to read it.'}
                </p>
              </CardContent>
            )}
          </Card>
        </div>
      )}

      <ElogComposer
        open={composerOpen}
        onOpenChange={setComposerOpen}
        replyTo={replyTo}
        onPosted={handlePosted}
      />
    </div>
  )
}
