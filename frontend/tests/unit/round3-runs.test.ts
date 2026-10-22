import { describe, expect, it } from 'vitest'
import { niceAxis } from '@/lib/nice-axis'
import { formatRunDate, runRowNote, runRowState, signed } from '@/lib/run-rows'

// ── UI 1: the beam-current axis reaches at least the largest value ──
describe('niceAxis', () => {
  it('ends on a tick at or above the maximum', () => {
    for (const [lo, hi] of [[0, 11.13], [0, 10.9], [0, 10], [-0.31, 7.4], [0, 0.0123], [5, 5]]) {
      const ax = niceAxis(lo, hi)!
      expect(ax.ticks[ax.ticks.length - 1]).toBeGreaterThanOrEqual(hi)
      expect(ax.ticks[0]).toBeLessThanOrEqual(lo)
    }
  })
  it('does not add a tick past an exact maximum', () => {
    expect(niceAxis(0, 10)!.ticks).toEqual([0, 5, 10])
    expect(niceAxis(0, 11.13)!.ticks).toEqual([0, 5, 10, 15])
  })
})

// ── UI 3 / S2: what a run row is, from the server's data ──
describe('runRowState / runRowNote', () => {
  const stopped = { isRunning: false, runNumber: 7, saving: true }
  it('a finished run has no note', () => {
    expect(runRowNote({ run_number: 6, end_time: '2026-10-22T01:00:00', has_data: true }, stopped)).toBeNull()
  })
  it('the running run is live', () => {
    expect(runRowState({ run_number: 7, has_data: true }, { isRunning: true, runNumber: 7, saving: true })).toBe('live')
  })
  it('no end, no data, number about to be reused', () => {
    expect(runRowNote({ run_number: 7, has_data: false }, stopped)).toBe('Not saved – number reused')
    expect(runRowNote({ run_number: 5, has_data: false }, stopped)).toBe('Not saved')
  })
  it('no end but data: never stopped properly', () => {
    expect(runRowNote({ run_number: 7, has_data: true }, stopped)).toBe('Never stopped properly')
  })
  it('an unsaved run going with the same number does not make the old row live', () => {
    expect(runRowState({ run_number: 7, has_data: true }, { isRunning: true, runNumber: 7, saving: false })).toBe('unfinished')
  })
})

describe('formatRunDate / signed', () => {
  it('one format, local time', () => {
    expect(formatRunDate('2026-10-22T09:05:57.489797')).toBe('2026-10-22 09:05')
    expect(formatRunDate(null)).toBe('—')
    expect(formatRunDate('garbage')).toBe('—')
  })
  it('uses a real minus sign', () => {
    expect(signed(-0.31, 2)).toBe('−0.31')
    expect(signed(0.44, 2)).toBe('+0.44')
    expect(signed(-0.001, 2)).toBe('0.00')
    expect(signed(7.05, 2, false)).toBe('7.05')
  })
})
