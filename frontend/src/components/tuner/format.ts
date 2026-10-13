/** Events per second → "812 /s", "12.4 k/s", "1.20 M/s". */
export function formatRate(perS: number): string {
  if (!Number.isFinite(perS)) return '–'
  if (perS >= 1e6) return `${(perS / 1e6).toFixed(2)} M/s`
  if (perS >= 1e3) return `${(perS / 1e3).toFixed(1)} k/s`
  if (perS >= 10) return `${Math.round(perS)} /s`
  return `${perS.toFixed(1)} /s`
}

/** ns → "480 ns", "4.0 µs". */
export function formatNs(ns: number): string {
  if (!Number.isFinite(ns)) return '–'
  return Math.abs(ns) >= 1000 ? `${(ns / 1000).toFixed(ns % 1000 === 0 ? 0 : 1)} µs` : `${Math.round(ns)} ns`
}
