import { Loader2 } from "lucide-react"

/** Placeholder while a lazily loaded tab or page section arrives. */
export function TabLoading() {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground" role="status">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      Loading…
    </div>
  )
}
