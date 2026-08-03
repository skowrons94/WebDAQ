"use client"

import { useEffect, useState } from 'react'
import { Button } from "@/components/ui/button"
import { Paperclip, Download } from 'lucide-react'
import { getElogAttachment } from '@/lib/api'

/**
 * One ELOG attachment.
 *
 * The browser has no session on the ELOG server, so the file comes through the
 * WebDAQ API and is shown from an object URL. Pictures are displayed; anything
 * else is offered as a download.
 */
export function ElogAttachment({ url }: { url: string }) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [isImage, setIsImage] = useState(false)
  const [failed, setFailed] = useState(false)

  const name = decodeURIComponent(url.split('/').pop()?.split('?')[0] ?? 'attachment')
  // ELOG prefixes stored files with an upload timestamp (240727_101530_note.png).
  const displayName = name.replace(/^\d{6}_\d{6}_/, '')

  useEffect(() => {
    let revoked: string | null = null
    let cancelled = false

    getElogAttachment(url)
      .then(blob => {
        if (cancelled) return
        revoked = URL.createObjectURL(blob)
        setObjectUrl(revoked)
        setIsImage(blob.type.startsWith('image/') && blob.type !== 'image/svg+xml')
      })
      .catch(() => { if (!cancelled) setFailed(true) })

    return () => {
      cancelled = true
      if (revoked) URL.revokeObjectURL(revoked)
    }
  }, [url])

  if (failed) {
    return (
      <p className="text-xs text-muted-foreground">
        <Paperclip className="mr-1 inline h-3 w-3" />
        {displayName} — could not be downloaded
      </p>
    )
  }

  if (!objectUrl) {
    return (
      <p className="text-xs text-muted-foreground">
        <Paperclip className="mr-1 inline h-3 w-3" />
        {displayName}…
      </p>
    )
  }

  if (isImage) {
    return (
      <figure className="space-y-1">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={objectUrl} alt={displayName} className="max-h-96 max-w-full rounded-md border" />
        <figcaption className="text-xs text-muted-foreground">{displayName}</figcaption>
      </figure>
    )
  }

  return (
    <Button variant="outline" size="sm" asChild>
      <a href={objectUrl} download={displayName}>
        <Download className="mr-1.5 h-3.5 w-3.5" />
        {displayName}
      </a>
    </Button>
  )
}
