/**
 * One way to write a counting rate on every page: "96 Hz", "1.23 kHz",
 * "1.20 MHz". The run bar said kHz, Data rates "events/s" and the channel
 * chips Hz for the same number; what is counted (events, pile-ups…) is said by
 * the label next to it, not by the unit.
 */
export function formatHz(hz: number | null | undefined): string {
  if (hz === null || hz === undefined || !Number.isFinite(hz)) return '—'
  const a = Math.abs(hz)
  if (a >= 1e6) return `${(hz / 1e6).toFixed(2)} MHz`
  if (a >= 1e3) return `${(hz / 1e3).toFixed(2)} kHz`
  if (a >= 10) return `${hz.toFixed(0)} Hz`
  if (a === 0) return '0 Hz'
  return `${hz.toFixed(a >= 0.1 ? 1 : 2)} Hz`
}
