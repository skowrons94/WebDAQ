"use client"

import * as React from "react"
import { Input } from "@/components/ui/input"

export interface NumericInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> {
  /** Current committed value (shown when the field is not being edited). */
  value: number | string
  /** Called with the parsed number whenever the draft is a valid number. */
  onValueChange: (value: number) => void
}

/**
 * A number input that lets the user type freely.
 *
 * A plain controlled `<input type="number">` bound to a numeric value rejects
 * intermediate states: clearing the field yields "" which parses to NaN, the
 * parent ignores it, and the old value snaps back — so you cannot replace a
 * "0" by typing (you press 2 and still see 0). This keeps an internal draft
 * string while focused, commits the parsed number on every valid keystroke,
 * and only re-syncs from the prop when the field is not focused. On blur an
 * empty/invalid draft falls back to the last committed value.
 */
const NumericInput = React.forwardRef<HTMLInputElement, NumericInputProps>(
  ({ value, onValueChange, onBlur, onFocus, ...props }, ref) => {
    const [draft, setDraft] = React.useState<string>(String(value))
    const [focused, setFocused] = React.useState(false)

    // Mirror external updates only while the user isn't typing.
    React.useEffect(() => {
      if (!focused) setDraft(String(value))
    }, [value, focused])

    return (
      <Input
        {...props}
        ref={ref}
        type="number"
        value={draft}
        onFocus={(e) => {
          setFocused(true)
          onFocus?.(e)
        }}
        onChange={(e) => {
          const raw = e.target.value
          setDraft(raw)
          // Commit only when the draft is a real number; allow empty/"-"/"1."
          // to exist transiently without clobbering the parent state.
          if (raw.trim() !== "") {
            const num = Number(raw)
            if (Number.isFinite(num)) onValueChange(num)
          }
        }}
        onBlur={(e) => {
          setFocused(false)
          if (e.target.value.trim() === "" || !Number.isFinite(Number(e.target.value))) {
            setDraft(String(value))
          }
          onBlur?.(e)
        }}
      />
    )
  },
)
NumericInput.displayName = "NumericInput"

export { NumericInput }
