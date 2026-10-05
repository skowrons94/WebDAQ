'use client'

import { Tooltip as Primitive } from 'radix-ui'
import type { ReactElement, ReactNode } from 'react'

export const TooltipProvider = Primitive.Provider

/** Shared, keyboard-accessible help with a short hover delay. */
export function HelpTooltip({ children, content }: { children: ReactElement; content: ReactNode }) {
  return <Primitive.Root delayDuration={150}>
    <Primitive.Trigger asChild>{children}</Primitive.Trigger>
    <Primitive.Portal><Primitive.Content sideOffset={6} collisionPadding={12}
      className="z-[100] max-w-72 rounded-lg border bg-popover px-3 py-2 text-xs leading-relaxed text-popover-foreground shadow-lg animate-in fade-in-0 zoom-in-95">
      {content}
    </Primitive.Content></Primitive.Portal>
  </Primitive.Root>
}
