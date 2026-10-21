/**
 * The one way a charge is written, in µC from the server: µC below 1000 µC,
 * mC up to 1000 mC, C above. The overview, the beam panel and the Logbook all
 * use it, so the same run never reads "0.85 mC" on one page and "850 µC" on
 * the next.
 */
export function formatCharge(microCoulombs: number | null | undefined): string {
  if (microCoulombs === null || microCoulombs === undefined) return '—'
  const value = Number(microCoulombs)
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 1e6) return `${(value / 1e6).toFixed(3)} C`
  if (abs >= 1e3) return `${(value / 1e3).toFixed(3)} mC`
  return `${value.toFixed(2)} µC`
}
