"use client"

import { useEffect, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  Bold,
  Code2,
  Eye,
  Heading2,
  Italic,
  Link2,
  List,
  ListOrdered,
  MessageSquareQuote,
  Pencil,
  RotateCcw,
  Save,
  Columns2,
} from "lucide-react"

import { updateRunNotes } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/components/ui/use-toast"
import { cn } from "@/lib/utils"

type EditorMode = "write" | "split" | "preview"

interface RunNotesEditorProps {
  runNumber: number
  notes: string | null
  onSaved: (notes: string) => void
}

const EMPTY_NOTE = `## Run notes

Add observations, interventions, beam conditions, anomalies, and anything else needed to interpret this run later.
`

export function MarkdownPreview({
  value,
  compact = false,
}: {
  value: string
  compact?: boolean
}) {
  if (!value.trim()) {
    if (compact) {
      return <p className="text-sm text-muted-foreground">No notes recorded for this run.</p>
    }
    return (
      <div className="flex min-h-72 items-center justify-center rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        Nothing to preview yet. Start writing, or use the template button below the editor.
      </div>
    )
  }

  return (
    <div className={cn(!compact && "min-h-72 rounded-lg border bg-background p-5")}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="mb-4 mt-6 text-2xl font-bold first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-3 mt-6 text-xl font-semibold first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-2 mt-5 text-base font-semibold">{children}</h3>,
          p: ({ children }) => <p className="my-3 text-sm leading-7">{children}</p>,
          ul: ({ children }) => <ul className="my-3 list-disc space-y-1 pl-6 text-sm">{children}</ul>,
          ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-6 text-sm">{children}</ol>,
          li: ({ children }) => <li className="leading-6">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="my-4 border-l-2 border-primary/50 bg-muted/40 px-4 py-1 text-muted-foreground">
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-primary underline underline-offset-4"
            >
              {children}
            </a>
          ),
          code: ({ children, className }) => (
            <code className={cn("rounded bg-muted px-1.5 py-0.5 font-mono text-xs", className)}>
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="my-4 overflow-auto rounded-lg border bg-muted/60 p-4 text-xs leading-6">
              {children}
            </pre>
          ),
          hr: () => <Separator className="my-6" />,
          table: ({ children }) => (
            <div className="my-4 overflow-auto rounded-lg border">
              <table className="w-full text-sm">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="border-b bg-muted/50 px-3 py-2 text-left font-semibold">{children}</th>,
          td: ({ children }) => <td className="border-b px-3 py-2 align-top">{children}</td>,
        }}
      >
        {value}
      </ReactMarkdown>
    </div>
  )
}

export function RunNotesEditor({ runNumber, notes, onSaved }: RunNotesEditorProps) {
  const initialValue = notes ?? ""
  const [draft, setDraft] = useState(initialValue)
  const [savedValue, setSavedValue] = useState(initialValue)
  const [mode, setMode] = useState<EditorMode>("split")
  const [saving, setSaving] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { toast } = useToast()

  useEffect(() => {
    const next = notes ?? ""
    setDraft(next)
    setSavedValue(next)
  }, [runNumber, notes])

  const dirty = draft !== savedValue

  useEffect(() => {
    if (!dirty) return
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", warnBeforeLeaving)
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving)
  }, [dirty])

  const restoreSelection = (start: number, end: number) => {
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(start, end)
    })
  }

  const wrapSelection = (before: string, after: string, fallback: string) => {
    const textarea = textareaRef.current
    if (!textarea) return
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const selected = draft.slice(start, end) || fallback
    const next = `${draft.slice(0, start)}${before}${selected}${after}${draft.slice(end)}`
    setDraft(next)
    restoreSelection(start + before.length, start + before.length + selected.length)
  }

  const prefixLines = (prefix: string) => {
    const textarea = textareaRef.current
    if (!textarea) return
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const lineStart = draft.lastIndexOf("\n", start - 1) + 1
    const lineEndIndex = draft.indexOf("\n", end)
    const lineEnd = lineEndIndex === -1 ? draft.length : lineEndIndex
    const block = draft
      .slice(lineStart, lineEnd)
      .split("\n")
      .map((line) => `${prefix}${line}`)
      .join("\n")
    setDraft(`${draft.slice(0, lineStart)}${block}${draft.slice(lineEnd)}`)
    restoreSelection(lineStart, lineStart + block.length)
  }

  const save = async () => {
    setSaving(true)
    try {
      await updateRunNotes(runNumber, draft)
      setSavedValue(draft)
      onSaved(draft)
      toast({
        title: "Notes saved",
        description: `The Markdown notes for run ${runNumber} were updated.`,
      })
    } catch {
      toast({
        title: "Could not save notes",
        description: "The logbook entry was not updated. Your draft is still here.",
        variant: "destructive",
      })
    } finally {
      setSaving(false)
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(event.metaKey || event.ctrlKey)) return
    if (event.key.toLowerCase() === "b") {
      event.preventDefault()
      wrapSelection("**", "**", "bold text")
    }
    if (event.key.toLowerCase() === "i") {
      event.preventDefault()
      wrapSelection("_", "_", "italic text")
    }
    if (event.key.toLowerCase() === "s") {
      event.preventDefault()
      if (dirty && !saving) save()
    }
  }

  const toolbar = [
    { label: "Bold", icon: Bold, action: () => wrapSelection("**", "**", "bold text") },
    { label: "Italic", icon: Italic, action: () => wrapSelection("_", "_", "italic text") },
    { label: "Heading", icon: Heading2, action: () => prefixLines("## ") },
    { label: "Bulleted list", icon: List, action: () => prefixLines("- ") },
    { label: "Numbered list", icon: ListOrdered, action: () => prefixLines("1. ") },
    { label: "Quote", icon: MessageSquareQuote, action: () => prefixLines("> ") },
    { label: "Link", icon: Link2, action: () => wrapSelection("[", "](https://)", "link text") },
    { label: "Inline code", icon: Code2, action: () => wrapSelection("`", "`", "code") },
  ]

  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b bg-muted/20 pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">Run notes</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Markdown is stored directly in the run&apos;s database record.
            </p>
          </div>
          <div className="flex items-center rounded-lg border bg-background p-1">
            {([
              ["write", Pencil, "Write"],
              ["split", Columns2, "Split"],
              ["preview", Eye, "Preview"],
            ] as const).map(([value, Icon, label]) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={mode === value ? "secondary" : "ghost"}
                className="h-8 gap-1.5 px-2.5"
                onClick={() => setMode(value)}
                aria-label={label}
                title={label}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{label}</span>
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        {mode !== "preview" && (
          <div className="flex flex-wrap items-center gap-1 border-b bg-muted/10 px-3 py-2">
            {toolbar.map(({ label, icon: Icon, action }) => (
              <Button
                key={label}
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                title={label}
                aria-label={label}
                onClick={action}
              >
                <Icon className="h-4 w-4" />
              </Button>
            ))}
            <Separator orientation="vertical" className="mx-1 h-6" />
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
              {draft.length.toLocaleString()} characters
            </span>
          </div>
        )}

        <div
          className={cn(
            "grid",
            mode === "split" && "lg:grid-cols-2",
          )}
        >
          {mode !== "preview" && (
            <div className={cn("p-4", mode === "split" && "border-b lg:border-b-0 lg:border-r")}>
              <Textarea
                ref={textareaRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Write the run notes in Markdown…"
                spellCheck
                className="min-h-[26rem] resize-y border-0 bg-transparent p-1 font-mono text-sm leading-7 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
              />
            </div>
          )}
          {mode !== "write" && (
            <div className="bg-muted/10 p-4">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Preview
              </div>
              <MarkdownPreview value={draft} />
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t bg-muted/20 px-4 py-3">
          {!draft && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(EMPTY_NOTE)}>
              Use notes template
            </Button>
          )}
          <span className={cn("text-xs", dirty ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
            {dirty ? "Unsaved changes" : "All changes saved"}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!dirty || saving}
              onClick={() => setDraft(savedValue)}
            >
              <RotateCcw className="mr-2 h-3.5 w-3.5" />
              Discard
            </Button>
            <Button type="button" size="sm" disabled={!dirty || saving} onClick={save}>
              <Save className="mr-2 h-3.5 w-3.5" />
              {saving ? "Saving…" : "Save notes"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
