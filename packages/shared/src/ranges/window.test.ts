import { describe, expect, it } from 'vitest'
import { daysBetween } from '../balance-history/dates.js'
import {
  monthWindow,
  previousMonthWindow,
  resolveWindow,
  sliceToWindow,
  validateCustomRange,
  type PresetRangeKey,
} from './window.js'

const PRESETS: PresetRangeKey[] = ['this-month', 'last-month', '90-days', '1-year', 'ytd', 'last-year']

function windowFor(key: PresetRangeKey, today: string) {
  return resolveWindow({ kind: 'preset', key }, today)
}

describe('resolveWindow', () => {
  it('spans exactly the number of days it is named after', () => {
    // Inclusive of both endpoints, so a 90-day range is 89 days of span.
    const ninety = windowFor('90-days', '2026-08-03')
    expect(daysBetween(ninety.start, ninety.end)).toBe(89)

    const year = windowFor('1-year', '2026-08-03')
    expect(daysBetween(year.start, year.end)).toBe(364)
  })

  it('starts this month on the 1st', () => {
    expect(windowFor('this-month', '2026-08-03')).toEqual({ start: '2026-08-01', end: '2026-08-03' })
  })

  it('covers last month end to end', () => {
    expect(windowFor('last-month', '2026-08-03')).toEqual({ start: '2026-07-01', end: '2026-07-31' })
  })

  it('rolls back across a year boundary for last month', () => {
    expect(windowFor('last-month', '2026-01-15')).toEqual({ start: '2025-12-01', end: '2025-12-31' })
  })

  it('gets February right in a leap year without a month-length table', () => {
    expect(windowFor('last-month', '2024-03-10')).toEqual({ start: '2024-02-01', end: '2024-02-29' })
    expect(windowFor('last-month', '2026-03-10')).toEqual({ start: '2026-02-01', end: '2026-02-28' })
  })

  it('ends last month on the last day of a 30-day month', () => {
    expect(windowFor('last-month', '2026-05-01')).toEqual({ start: '2026-04-01', end: '2026-04-30' })
  })

  it('runs YTD from January 1st', () => {
    expect(windowFor('ytd', '2026-08-03')).toEqual({ start: '2026-01-01', end: '2026-08-03' })
  })

  it('collapses YTD to a single day on January 1st', () => {
    expect(windowFor('ytd', '2026-01-01')).toEqual({ start: '2026-01-01', end: '2026-01-01' })
  })

  it('closes last year rather than running it to today', () => {
    expect(windowFor('last-year', '2026-08-03')).toEqual({ start: '2025-01-01', end: '2025-12-31' })
  })

  it('passes a custom selection through untouched', () => {
    expect(resolveWindow({ kind: 'custom', start: '2024-02-29', end: '2025-07-04' }, '2026-08-03')).toEqual(
      { start: '2024-02-29', end: '2025-07-04' },
    )
  })

  it('never produces an inverted window, on any day of any month', () => {
    for (const key of PRESETS) {
      // Every month boundary and every month length, across a leap year and a common one.
      for (const month of Array.from({ length: 12 }, (_, index) => index + 1)) {
        for (const day of [1, 28, 29]) {
          for (const year of [2024, 2026]) {
            const today = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
            const { start, end } = windowFor(key, today)
            expect(daysBetween(start, end), `${key} on ${today}`).toBeGreaterThanOrEqual(0)
          }
        }
      }
    }
  })

  it('never lets a today-anchored preset end in the future', () => {
    // The two closed-period presets are excluded: they legitimately end before today.
    for (const key of PRESETS.filter((k) => k !== 'last-month' && k !== 'last-year')) {
      expect(windowFor(key, '2026-08-03').end).toBe('2026-08-03')
    }
  })
})

describe('sliceToWindow', () => {
  const series = ['2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02'].map((date) => ({ date }))

  it('includes both endpoints', () => {
    expect(sliceToWindow(series, { start: '2026-07-31', end: '2026-08-01' })).toEqual([
      { date: '2026-07-31' },
      { date: '2026-08-01' },
    ])
  })

  it('returns nothing for a window the series does not reach', () => {
    expect(sliceToWindow(series, { start: '2025-01-01', end: '2025-12-31' })).toEqual([])
  })

  it('does not invent points for days the series is missing', () => {
    // A window wider than the data yields the data, not a padded range.
    expect(sliceToWindow(series, { start: '2020-01-01', end: '2030-01-01' })).toHaveLength(4)
  })
})

describe('validateCustomRange', () => {
  it('accepts a single-day range', () => {
    expect(validateCustomRange('2026-08-03', '2026-08-03', '2026-08-03')).toBeNull()
  })

  it('rejects an end before the start', () => {
    expect(validateCustomRange('2026-08-03', '2026-08-02', '2026-08-03')).toBe('order')
  })

  it('rejects an end in the future rather than clamping it', () => {
    expect(validateCustomRange('2026-01-01', '2026-08-04', '2026-08-03')).toBe('future')
  })

  it('allows a start in the future to be reported as an ordering problem, not silently accepted', () => {
    expect(validateCustomRange('2027-01-01', '2027-02-01', '2026-08-03')).toBe('future')
  })
})

/**
 * The chart's window, which is not the totals' window.
 *
 * "This month" ends today — that is what the totals should cover. A chart drawn over the same span
 * would redraw its own axis every day and give a month in progress no room to run into.
 */
describe('monthWindow', () => {
  it('covers the whole month a date falls in', () => {
    expect(monthWindow('2026-08-04')).toEqual({ start: '2026-08-01', end: '2026-08-31' })
  })

  it('handles a thirty-day month', () => {
    expect(monthWindow('2026-09-15')).toEqual({ start: '2026-09-01', end: '2026-09-30' })
  })

  it('handles February', () => {
    expect(monthWindow('2026-02-10')).toEqual({ start: '2026-02-01', end: '2026-02-28' })
  })

  /** The case a month-length table gets wrong, which is why there is not one. */
  it('handles a leap February', () => {
    expect(monthWindow('2028-02-10')).toEqual({ start: '2028-02-01', end: '2028-02-29' })
  })

  it('is stable on the first and last days', () => {
    expect(monthWindow('2026-08-01')).toEqual(monthWindow('2026-08-31'))
  })
})

describe('previousMonthWindow', () => {
  it('returns the whole month before', () => {
    expect(previousMonthWindow('2026-08-04')).toEqual({ start: '2026-07-01', end: '2026-07-31' })
  })

  it('crosses a year boundary', () => {
    expect(previousMonthWindow('2026-01-09')).toEqual({ start: '2025-12-01', end: '2025-12-31' })
  })

  /**
   * A calendar month rather than an equal-length span, for a range that *is* a calendar month.
   * "This month against last month" is the question; 31 days against the previous 31 is not.
   */
  it('gives February the month before it, not thirty-one days back', () => {
    expect(previousMonthWindow('2026-03-05')).toEqual({ start: '2026-02-01', end: '2026-02-28' })
  })
})

/**
 * All time.
 *
 * Added so a household with years of history can reach it without retyping a custom start every
 * time. It resolves to a fixed floor rather than to the data's own earliest date, because this
 * function is pure and has never seen the data — and the two behave identically anyway, since
 * `sliceToWindow` keeps only what exists.
 */
describe('all time', () => {
  const TODAY = '2026-08-05'

  it('starts before any plausible history and ends today', () => {
    const window = resolveWindow({ kind: 'preset', key: 'all' }, TODAY)

    expect(window.start).toBe('1970-01-01')
    expect(window.end).toBe(TODAY)
  })

  it('keeps every point in the series', () => {
    const series = [{ date: '2019-01-02' }, { date: '2023-06-06' }, { date: TODAY }]
    const window = resolveWindow({ kind: 'preset', key: 'all' }, TODAY)

    expect(sliceToWindow(series, window)).toHaveLength(3)
  })

  /**
   * The property the history backfill depends on.
   *
   * It fetches when the window starts earlier than the cache reaches, and the server echoes the
   * requested start back as the cache's new reach. A floor that stays put means one fetch settles
   * it; a start derived from "now" would drift earlier on every render and re-fetch forever.
   */
  it('does not move as today moves', () => {
    expect(resolveWindow({ kind: 'preset', key: 'all' }, '2026-08-05').start).toBe(
      resolveWindow({ kind: 'preset', key: 'all' }, '2030-01-01').start,
    )
  })

  it('is the widest preset', () => {
    const starts = (['this-month', 'last-month', '90-days', '1-year', 'ytd', 'last-year'] as const)
      .map((key) => resolveWindow({ kind: 'preset', key }, TODAY).start)

    for (const start of starts) {
      expect(resolveWindow({ kind: 'preset', key: 'all' }, TODAY).start < start).toBe(true)
    }
  })
})
