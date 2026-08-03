import { describe, expect, it } from 'vitest'
import { daysBetween } from '../balance-history/dates.js'
import {
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
