"use client"

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { useToast } from "@/components/ui/use-toast"
import { Send, Paperclip, FileText, Loader2 } from 'lucide-react'
import {
  getElogFields, getElogRuns, getElogRunDraft, postElogEntry,
  type ElogEntry, type ElogField, type ElogRunSummary,
} from '@/lib/api'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Set to reply to an entry instead of starting a new thread. */
  replyTo?: ElogEntry | null
  onPosted: (id: number) => void
}

// Radix selects cannot hold an empty value, so an optional field offers this
// sentinel to mean "leave it blank".
const NONE = '__none__'

/** ELOG stores a multiple-choice attribute as its selections joined by '|'. */
const splitChecks = (value: string) =>
  value ? value.split('|').map(v => v.trim()).filter(Boolean) : []

export function ElogComposer({ open, onOpenChange, replyTo, onPosted }: Props) {
  const { toast } = useToast()
  const [fields, setFields] = useState<ElogField[]>([])
  const [attributes, setAttributes] = useState<Record<string, string>>({})
  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [loadingFields, setLoadingFields] = useState(false)

  const [runs, setRuns] = useState<ElogRunSummary[]>([])
  const [selectedRun, setSelectedRun] = useState<string>('')
  const [drafting, setDrafting] = useState(false)
  const [suppressEmail, setSuppressEmail] = useState(false)

  // The field a logbook keys the rest of its form on (ELOG conditional
  // attributes). Picking a value for it changes which fields exist, so the form
  // has to be fetched again with that value.
  const conditionalField = useMemo(
    () => fields.find(f => f.conditional) ?? null,
    [fields],
  )

  const loadFields = useCallback(async (condition: Record<string, string>) => {
    setLoadingFields(true)
    try {
      const { fields, defaults, author } = await getElogFields(condition)
      setFields(fields)
      setAttributes(previous => {
        const next: Record<string, string> = { ...defaults, ...previous }
        for (const field of fields) {
          // ELOG fills these itself; show what it will use rather than an
          // editable box the server would ignore.
          if (field.type === 'fixed') next[field.label] = field.value
          else if (next[field.label] === undefined && field.value) next[field.label] = field.value
        }
        if (author && !next.Author) next.Author = author
        return next
      })
    } catch {
      setFields([])
      toast({
        title: "Could not read the logbook's form",
        description: "Check the ELOG settings — the entry fields are unknown.",
        variant: "destructive",
      })
    } finally {
      setLoadingFields(false)
    }
  }, [toast])

  useEffect(() => {
    if (!open) return
    setText('')
    setFiles([])
    setSelectedRun('')
    setSuppressEmail(false)

    // A reply keeps the thread's own field values; a new entry starts clean.
    const initial: Record<string, string> = {}
    if (replyTo) {
      for (const [key, value] of Object.entries(replyTo.attributes ?? {})) {
        if (key === 'Author' || key === 'Subject' || !value) continue
        initial[key] = value
      }
      const subject = replyTo.attributes?.Subject ?? ''
      initial.Subject = subject.startsWith('Re:') ? subject : `Re: ${subject}`.trim()
    }
    setAttributes(initial)

    const condition: Record<string, string> = replyTo?.attributes?.Category
      ? { Category: replyTo.attributes.Category }
      : {}
    void loadFields(condition)
    getElogRuns(50).then(({ runs }) => setRuns(runs)).catch(() => setRuns([]))
  }, [open, replyTo, loadFields])

  function setAttribute(label: string, value: string) {
    setAttributes(a => ({ ...a, [label]: value }))
    const field = fields.find(f => f.label === label)
    if (field?.conditional) void loadFields({ [field.name]: value })
  }

  async function generateFromRun(runNumber: string) {
    setSelectedRun(runNumber)
    if (!runNumber) return
    setDrafting(true)
    try {
      const draft = await getElogRunDraft(Number(runNumber))
      setText(draft.text)
      // Only take attributes this logbook actually has a field for.
      const known = new Set(fields.map(f => f.label))
      setAttributes(a => {
        const next = { ...a }
        for (const [key, value] of Object.entries(draft.attributes)) {
          if (known.has(key) || key === 'Author') next[key] = value
        }
        return next
      })
      const condition = draft.attributes[conditionalField?.label ?? '']
      if (conditionalField && condition) void loadFields({ [conditionalField.name]: condition })

      const missing = Object.entries(draft.sources)
        .filter(([, found]) => !found)
        .map(([what]) => what)
      toast({
        title: `Draft written from run ${draft.run_number}`,
        description: missing.length
          ? `No ${missing.join(', ')} for this run — check the entry before posting.`
          : "Review and edit it before posting.",
      })
    } catch (error) {
      const serverMessage =
        (error as { response?: { data?: { message?: string } } })?.response?.data?.message
      toast({
        title: "Could not draft the entry",
        description: serverMessage ?? `Run ${runNumber} could not be read.`,
        variant: "destructive",
      })
    } finally {
      setDrafting(false)
    }
  }

  // ELOG refuses an entry whose required attributes are empty, and its rejection
  // arrives only after the operator has written the whole thing — so the same
  // rule is enforced here first.
  const missingRequired = useMemo(
    () => fields
      .filter(f => f.required && f.type !== 'fixed' && !(attributes[f.label] ?? '').trim())
      .map(f => f.label),
    [fields, attributes],
  )

  async function handleSubmit() {
    setSubmitting(true)
    try {
      // Only what this logbook actually has a field for. Changing a conditional
      // attribute swaps the form out, and a value left over from the previous
      // one would be an attribute the logbook does not know.
      const payload: Record<string, string> = {}
      for (const field of fields) {
        if (field.type === 'fixed') continue     // ELOG fills these itself
        const value = attributes[field.label]
        if (value?.trim()) payload[field.label] = value
      }
      if (attributes.Author?.trim()) payload.Author = attributes.Author
      const { id } = await postElogEntry(
        {
          text, attributes: payload, reply_to: replyTo?.id ?? null,
          encoding: 'plain', suppress_email: suppressEmail,
        },
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

  function renderField(field: ElogField) {
    const value = attributes[field.label] ?? ''
    const id = `elog-attr-${field.name}`

    if (field.type === 'fixed') {
      return <Input id={id} value={field.value} readOnly disabled />
    }

    if (field.type === 'select' || field.type === 'radio') {
      return (
        <Select
          value={value || NONE}
          onValueChange={v => setAttribute(field.label, v === NONE ? '' : v)}
        >
          <SelectTrigger id={id}>
            <SelectValue placeholder="Choose…" />
          </SelectTrigger>
          <SelectContent>
            {!field.required && <SelectItem value={NONE}>— none —</SelectItem>}
            {field.options.map(option => (
              <SelectItem key={option} value={option}>{option}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
    }

    if (field.type === 'checkbox') {
      const checked = splitChecks(value)
      return (
        <div className="flex flex-wrap gap-x-4 gap-y-2 pt-1">
          {field.options.map(option => (
            <label key={option} className="flex items-center gap-1.5 text-sm">
              <Checkbox
                checked={checked.includes(option)}
                onCheckedChange={on => setAttribute(
                  field.label,
                  (on ? [...checked, option] : checked.filter(c => c !== option)).join(' | '),
                )}
              />
              {option}
            </label>
          ))}
        </div>
      )
    }

    return (
      <Input
        id={id}
        value={value}
        onChange={e => setAttribute(field.label, e.target.value)}
      />
    )
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
          {!replyTo && (
            <div className="rounded-md border bg-muted/40 p-3 space-y-2">
              <Label htmlFor="elog-run" className="flex items-center gap-1.5 text-xs font-medium">
                <FileText className="h-3.5 w-3.5" />
                Write up a run
              </Label>
              <div className="flex gap-2">
                <Select value={selectedRun} onValueChange={generateFromRun} disabled={drafting}>
                  <SelectTrigger id="elog-run" className="flex-1">
                    <SelectValue placeholder={runs.length ? 'Choose a run…' : 'No runs recorded'} />
                  </SelectTrigger>
                  <SelectContent>
                    {runs.map(run => (
                      <SelectItem key={run.run_number} value={String(run.run_number)}>
                        Run {run.run_number}
                        {run.run_type ? ` — ${run.run_type}` : ''}
                        {run.target_name ? ` (${run.target_name})` : ''}
                        {run.complete ? '' : ' — still running'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {drafting && <Loader2 className="h-4 w-4 animate-spin self-center" />}
              </div>
              <p className="text-xs text-muted-foreground">
                Fills the entry from the run&apos;s own record — timing, beam current, ROIs and
                board configuration. Everything stays editable.
              </p>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            {fields.map(field => (
              <div
                key={field.name}
                className={field.type === 'checkbox' ? 'space-y-1 sm:col-span-2' : 'space-y-1'}
              >
                <Label
                  htmlFor={`elog-attr-${field.name}`}
                  className="text-xs text-muted-foreground"
                >
                  {field.label}
                  {field.required && <span className="ml-0.5 text-destructive">*</span>}
                </Label>
                {renderField(field)}
              </div>
            ))}
            {loadingFields && !fields.length && (
              <p className="text-xs text-muted-foreground sm:col-span-2">Reading the logbook&apos;s form…</p>
            )}
          </div>

          <div className="space-y-1">
            <Label htmlFor="elog-text">Entry</Label>
            <Textarea
              id="elog-text"
              rows={14}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="What happened?"
              className="font-mono text-xs"
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

          <label className="flex items-center gap-2 text-sm">
            <Switch checked={suppressEmail} onCheckedChange={setSuppressEmail} />
            Do not send the logbook&apos;s email notification
          </label>

          {missingRequired.length > 0 && (
            <p className="text-xs text-destructive">
              The logbook requires {missingRequired.join(', ')}.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={handleSubmit}
            disabled={
              submitting || missingRequired.length > 0 || (!text.trim() && files.length === 0)
            }
          >
            <Send className="mr-1.5 h-4 w-4" />
            {submitting ? 'Posting…' : replyTo ? 'Post reply' : 'Post entry'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
