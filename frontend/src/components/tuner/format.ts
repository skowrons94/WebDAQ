import { formatHz } from '@/lib/format-rate'

/** A counting rate, written as on every other page ("812 Hz", "12.40 kHz"). */
export function formatRate(perS: number): string {
  return formatHz(perS)
}

/** ns → "480 ns", "4.0 µs". */
export function formatNs(ns: number): string {
  if (!Number.isFinite(ns)) return '–'
  return Math.abs(ns) >= 1000 ? `${(ns / 1000).toFixed(ns % 1000 === 0 ? 0 : 1)} µs` : `${Math.round(ns)} ns`
}
