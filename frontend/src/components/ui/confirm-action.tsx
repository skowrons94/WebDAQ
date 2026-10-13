"use client"

import * as React from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * The one confirmation for every destructive action in LUNADAQ.
 *
 * - The title names the action, the description says what will happen
 *   ("the lifetime total is set to zero and cannot be recovered").
 * - The confirm button repeats the verb ("Stop run 12"), never "OK".
 * - Focus starts on Cancel (Radix AlertDialog's default), so a stray Enter
 *   or a double click does not confirm; Escape cancels.
 *
 * Either pass `trigger` (it opens the dialog) or control it with
 * `open`/`onOpenChange`. `onConfirm` runs after the dialog closes; errors are
 * the caller's to report.
 */
export interface ConfirmActionProps {
  trigger?: React.ReactElement
  open?: boolean
  onOpenChange?: (open: boolean) => void
  title: React.ReactNode
  description: React.ReactNode
  /** Extra content between the description and the buttons (e.g. a value). */
  children?: React.ReactNode
  confirmLabel: string
  cancelLabel?: string
  onConfirm: () => void | Promise<void>
  /** "destructive" (red, default) or "default" for a reversible confirmation. */
  variant?: "destructive" | "default"
}

export function ConfirmAction({
  trigger,
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  variant = "destructive",
}: ConfirmActionProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {trigger && <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>}
      <AlertDialogContent className="w-[calc(100%-2rem)] max-w-md rounded-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter className="gap-2 sm:gap-0">
          <AlertDialogCancel className="pointer-coarse:min-h-11">{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            className={cn(
              buttonVariants({ variant: variant === "destructive" ? "destructive" : "default" }),
            )}
            onClick={() => { void onConfirm() }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
