import { describe, expect, it } from 'vitest'
import { toIsoDate } from '@beans/shared'
import { localIsoDate } from './today.js'

/**
 * The reader's calendar date, not UTC's.
 *
 * Fixed instants throughout, and built from local components deliberately: `new Date(y, m, d, …)`
 * means "this wall clock, here", which is exactly the thing under test and is deterministic in any
 * timezone the suite happens to run in.
 */
describe('localIsoDate', () => {
  it('reads the date off the local wall clock', () => {
    expect(localIsoDate(new Date(2026, 7, 4, 23, 45))).toBe('2026-08-04')
  })

  it('pads months and days to two digits', () => {
    expect(localIsoDate(new Date(2026, 0, 9, 12, 0))).toBe('2026-01-09')
  })

  it('is stable across the whole of a local day', () => {
    expect(localIsoDate(new Date(2026, 7, 4, 0, 0))).toBe('2026-08-04')
    expect(localIsoDate(new Date(2026, 7, 4, 23, 59, 59))).toBe('2026-08-04')
  })

  /**
   * The bug this exists for.
   *
   * Late evening west of Greenwich, the UTC date has already rolled over. Asserted only where the
   * suite actually runs in such a zone, so this documents the divergence without making the test
   * depend on the runner's timezone.
   */
  it('differs from the UTC date late in the evening, where the zone is behind UTC', () => {
    const lateEvening = new Date(2026, 7, 4, 23, 45)

    if (lateEvening.getTimezoneOffset() > 0) {
      expect(toIsoDate(lateEvening)).toBe('2026-08-05')
      expect(localIsoDate(lateEvening)).toBe('2026-08-04')
    } else {
      expect(localIsoDate(lateEvening)).toBe('2026-08-04')
    }
  })
})
