import * as React from "react"
import { AlertTriangle, Inbox } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Shared "nothing here yet" and "could not load" blocks, so every page says
 * it the same way: an icon, one line of what is (not) there, what to do, and
 * the action. Colours come from the tokens, so the error reads in dark mode.
 */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  children,
  action,
  className,
}: {
  icon?: React.ElementType
  title: React.ReactNode
  children?: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-4 py-12 text-center", className)}>
      <Icon className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
      <p className="font-semibold">{title}</p>
      {children && <div className="max-w-md text-sm text-muted-foreground">{children}</div>}
      {action && <div className="flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  )
}

export function ErrorState({
  title,
  children,
  action,
  className,
}: {
  title: React.ReactNode
  children?: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div
      role="alert"
      className={cn("flex flex-col items-center justify-center gap-3 rounded-lg border border-destructive/60 bg-destructive/5 px-4 py-10 text-center", className)}
    >
      <AlertTriangle className="h-8 w-8 text-destructive" aria-hidden="true" />
      <p className="font-semibold text-destructive">{title}</p>
      {children && <div className="max-w-md break-words text-sm text-muted-foreground">{children}</div>}
      {action && <div className="flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  )
}
