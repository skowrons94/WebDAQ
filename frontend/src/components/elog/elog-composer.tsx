"use client"

import { useEffect, useState } from 'react'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { useToast } from "@/components/ui/use-toast"
import { Send, Paperclip } from 'lucide-react'
import { getElogAttributes, postElogEntry, type ElogEntry } from '@/lib/api'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Set to reply to an entry instead of starting a new thread. */
  replyTo?: ElogEntry | null
  onPosted: (id: number) => void
}

export function ElogComposer({ open, onOpenChange, replyTo, onPosted }: Props) {
  const { toast } = useToast()
  const [names, setNames] = useState<string[]>([])
  const [attributes, setAttributes] = useState<Record<string, string>>({})
  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [submitting, setSubmitting] = useState(false)

  // ELOG has no API for a logbook's configuration, so the fields are learned
  // from recent entries and merged with the defaults from settings.
  useEffect(() => {
    if (!open) return
    setText('')
    setFiles([])

    getElogAttributes()
      .then(({ names, defaults, author }) => {
        const fields = names.length ? names : ['Author', 'Type', 'Subject']
        setNames(fields)
        const initial: Record<string, string> = { ...defaults }
        if (author) initial.Author = author
        if (replyTo) {
          // Keep the thread's fields, and mark the subject as a reply once.
          for (const field of fields) {
            if (field === 'Author' || field === 'Subject') continue
            if (replyTo.attributes[field]) initial[field] = replyTo.attributes[field]
          }
          const subject = replyTo.attributes.Subject ?? ''
          initial.Subject = subject.startsWith('Re:') ? subject : `Re: ${subject}`.trim()
        }
        setAttributes(initial)
      })
      .catch(() => {
        setNames(['Author', 'Type', 'Subject'])
        setAttributes({})
      })
  }, [open, replyTo])

  async function handleSubmit() {
    setSubmitting(true)
    try {
      const { id } = await postElogEntry(
        { text, attributes, reply_to: replyTo?.id ?? null, encoding: 'plain' },
        files,
      )
      toast({ title: "Entry posted", description: `ELOG entry #${id} was created.` })
      onOpenChange(false)
      onPosted(id)
    } catch (error) {
      const serverMessage =
        (error as { response?: { data?: { message?: string } } })?.response?.data?.message
      toast({
        title: "Could not post the entry",
        description: serverMessage ?? "The ELOG server did not accept the entry.",
        variant: "destructive",
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{replyTo ? `Reply to entry #${replyTo.id}` : 'New ELOG entry'}</DialogTitle>
          <DialogDescription>
            Posted to the configured logbook. The Author field signs the entry with your
            WebDAQ user — the connection itself uses the shared account.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {names.map(name => (
              <div key={name} className="space-y-1">
                <Label htmlFor={`elog-attr-${name}`} className="text-xs text-muted-foreground">
                  {name}
                </Label>
                <Input
                  id={`elog-attr-${name}`}
                  value={attributes[name] ?? ''}
                  onChange={(e) => setAttributes(a => ({ ...a, [name]: e.target.value }))}
                />
              </div>
            ))}
          </div>

          <div className="space-y-1">
            <Label htmlFor="elog-text">Entry</Label>
            <Textarea
              id="elog-text"
              rows={12}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="What happened?"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="elog-files" className="flex items-center gap-1.5">
              <Paperclip className="h-3.5 w-3.5" />
              Attachments
            </Label>
            <Input
              id="elog-files"
              type="file"
              multiple
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
            {files.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {files.map(f => f.name).join(', ')}
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={submitting || (!text.trim() && files.length === 0)}>
            <Send className="mr-1.5 h-4 w-4" />
            {submitting ? 'Posting…' : replyTo ? 'Post reply' : 'Post entry'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
