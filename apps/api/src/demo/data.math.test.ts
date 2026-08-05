import { describe, expect, it } from 'vitest'
import { jitter, monthlyDates, monthsBefore, seededRandom } from './data.js'

describe('monthlyDates', () => {
  it('lands once a month between the bounds', () => {
    expect(monthlyDates('2026-01-01', '2026-04-30', 15)).toEqual([
      '2026-01-15',
      '2026-02-15',
      '2026-03-15',
      '2026-04-15',
    ])
  })

  /**
   * The one that silently loses a twelfth of the history: a 30th-of-the-month payday has no 30th
   * of February, and skipping it would drop a paycheck every year with nothing to show for it.
   */
  it('clamps to the last day of a short month', () => {
    expect(monthlyDates('2026-01-01', '2026-03-31', 30)).toEqual([
      '2026-01-30',
      '2026-02-28',
      '2026-03-30',
    ])
  })

  it('handles a leap February', () => {
    expect(monthlyDates('2028-02-01', '2028-02-29', 31)).toEqual(['2028-02-29'])
  })

  it('excludes dates outside the bounds', () => {
    expect(monthlyDates('2026-01-20', '2026-02-10', 15)).toEqual([])
  })

  it('crosses a year boundary', () => {
    expect(monthlyDates('2025-11-01', '2026-02-28', 1)).toEqual([
      '2025-11-01',
      '2025-12-01',
      '2026-01-01',
      '2026-02-01',
    ])
  })
})

describe('monthsBefore', () => {
  it('steps back within a year', () => {
    expect(monthsBefore('2026-08-05', 3)).toBe('2026-05-01')
  })

  it('crosses the year boundary', () => {
    expect(monthsBefore('2026-02-05', 4)).toBe('2025-10-01')
  })

  it('handles a whole number of years', () => {
    expect(monthsBefore('2026-08-05', 24)).toBe('2024-08-01')
  })
})

describe('seededRandom', () => {
  /** The whole reason it exists: a re-seed must produce the same household. */
  it('produces the same sequence from the same seed', () => {
    const first = seededRandom(42)
    const second = seededRandom(42)

    expect([first(), first(), first()]).toEqual([second(), second(), second()])
  })

  it('produces a different sequence from a different seed', () => {
    expect(seededRandom(1)()).not.toBe(seededRandom(2)())
  })

  it('stays inside the unit interval', () => {
    const random = seededRandom(7)
    for (let index = 0; index < 200; index += 1) {
      const value = random()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})

describe('jitter', () => {
  it('leaves a fixed amount exactly alone', () => {
    expect(jitter(-2_310_00n, 0, seededRandom(1))).toBe(-2_310_00n)
  })

  it('keeps the sign of a spend', () => {
    const random = seededRandom(3)
    for (let index = 0; index < 50; index += 1) {
      expect(jitter(-168_40n, 0.3, random) < 0n).toBe(true)
    }
  })

  it('stays within the stated variance', () => {
    const random = seededRandom(9)
    for (let index = 0; index < 200; index += 1) {
      const value = jitter(100_00n, 0.25, random)
      expect(value).toBeGreaterThanOrEqual(7_500n)
      expect(value).toBeLessThanOrEqual(12_500n)
    }
  })

  it('lands on whole cents', () => {
    const value = jitter(168_40n, 0.3, seededRandom(11))
    expect(value).toBe(BigInt(value.toString()))
  })
})
