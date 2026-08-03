import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { addDays, daysBetween, eachDay, toIsoDate } from './dates.js'
import {
  carryForward,
  carryStale,
  checkReconstruction,
  mergeSeries,
  reconstructBackward,
  type PostedTransaction,
} from './reconstruct.js'

/**
 * The balance reconstruction suite.
 *
 * Fixed dates throughout — never the wall clock. Every expected value here is hand-computed, so a
 * change in the implementation cannot quietly redefine what "correct" means.
 */

const AS_OF = '2026-08-03'
const COVERAGE = '2026-07-28'

describe('backward reconstruction', () => {
  /**
   * The defining property: balance(T) = current − sum of transactions posted after T.
   *
   * Worked by hand. Current balance on 8/3 is $1,000.00. Transactions: −$50 on 8/2, +$200 on 8/1.
   *   8/3 = 1000.00            (nothing posted after)
   *   8/2 = 1000.00            (nothing after 8/2 either — the 8/2 txn is not "after" 8/2)
   *   8/1 = 1000.00 + 50       = 1050.00
   *   7/31 = 1050.00 − 200     =  850.00
   */
  it('is exact against a hand-computed fixture', () => {
    const series = reconstructBackward({
      currentBalanceCents: 100_000n,
      balanceAsOf: AS_OF,
      transactions: [
        { date: '2026-08-02', amountCents: -5_000n },
        { date: '2026-08-01', amountCents: 20_000n },
      ],
      coverageStart: '2026-07-31',
    })

    expect(series).toEqual([
      { date: '2026-07-31', balanceCents: 85_000n, source: 'derived' },
      { date: '2026-08-01', balanceCents: 105_000n, source: 'derived' },
      { date: '2026-08-02', balanceCents: 100_000n, source: 'derived' },
      { date: '2026-08-03', balanceCents: 100_000n, source: 'derived' },
    ])
  })

  /**
   * The invariant the whole design rests on: `current_balance` is the input and the series is
   * derived from it, so if they ever disagree the reconstruction is wrong, not the balance
   * (ARCHITECTURE.md §4.1).
   */
  it('always ends exactly at the observed balance', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }),
        fc.array(
          fc.record({
            /**
             * Deliberately spans past the observed balance date. An earlier version of this range
             * stopped at 0, and the property passed while the implementation was wrong about
             * future-dated transactions — a fixture caught what the property had been shaped to
             * miss.
             */
            dayOffset: fc.integer({ min: -30, max: 5 }),
            amountCents: fc.bigInt({ min: -(10n ** 8n), max: 10n ** 8n }),
          }),
          { maxLength: 60 },
        ),
        (currentBalanceCents, rawTransactions) => {
          const transactions: PostedTransaction[] = rawTransactions.map((t) => ({
            date: addDays(AS_OF, t.dayOffset),
            amountCents: t.amountCents,
          }))

          const series = reconstructBackward({
            currentBalanceCents,
            balanceAsOf: AS_OF,
            transactions,
            coverageStart: addDays(AS_OF, -30),
          })

          expect(series.at(-1)?.balanceCents).toBe(currentBalanceCents)
        },
      ),
      { numRuns: 500 },
    )
  })

  it('is unaffected by the order transactions arrive in', () => {
    const transactions: PostedTransaction[] = [
      { date: '2026-08-02', amountCents: -5_000n },
      { date: '2026-07-30', amountCents: 12_345n },
      { date: '2026-08-01', amountCents: 20_000n },
      { date: '2026-07-30', amountCents: -1n },
    ]

    const build = (input: PostedTransaction[]) =>
      reconstructBackward({
        currentBalanceCents: 100_000n,
        balanceAsOf: AS_OF,
        transactions: input,
        coverageStart: COVERAGE,
      })

    expect(build([...transactions].reverse())).toEqual(build(transactions))
    // Out-of-order postings are the normal case, not an edge case: institutions backfill.
    expect(build([...transactions].sort(() => 1))).toEqual(build(transactions))
  })

  it('sums multiple transactions on the same day', () => {
    const series = reconstructBackward({
      currentBalanceCents: 0n,
      balanceAsOf: '2026-08-02',
      transactions: [
        { date: '2026-08-02', amountCents: -1_000n },
        { date: '2026-08-02', amountCents: -2_000n },
        { date: '2026-08-02', amountCents: 500n },
      ],
      coverageStart: '2026-08-01',
    })

    // 8/1 = 0 − (−1000 − 2000 + 500) = 2500
    expect(series).toEqual([
      { date: '2026-08-01', balanceCents: 2_500n, source: 'derived' },
      { date: '2026-08-02', balanceCents: 0n, source: 'derived' },
    ])
  })

  describe('boundaries', () => {
    it('treats a transaction dated on the as-of day as not after it', () => {
      // The single most likely off-by-one: "after T" must be strictly after.
      const series = reconstructBackward({
        currentBalanceCents: 100_000n,
        balanceAsOf: AS_OF,
        transactions: [{ date: AS_OF, amountCents: -5_000n }],
        coverageStart: AS_OF,
      })

      expect(series).toEqual([{ date: AS_OF, balanceCents: 100_000n, source: 'derived' }])
    })

    it('produces a single day when coverage starts on the as-of date', () => {
      const series = reconstructBackward({
        currentBalanceCents: 42n,
        balanceAsOf: AS_OF,
        transactions: [],
        coverageStart: AS_OF,
      })
      expect(series).toHaveLength(1)
    })

    it('produces nothing when coverage has not started', () => {
      // The honest answer for an account connected today with no history behind it.
      expect(
        reconstructBackward({
          currentBalanceCents: 42n,
          balanceAsOf: AS_OF,
          transactions: [],
          coverageStart: '2026-09-01',
        }),
      ).toEqual([])
    })

    it('never produces a date before the coverage boundary', () => {
      // Reconstruction would happily keep subtracting into a period with no transactions,
      // producing a smooth, confident, wrong line.
      const series = reconstructBackward({
        currentBalanceCents: 100_000n,
        balanceAsOf: AS_OF,
        transactions: [{ date: '2026-01-01', amountCents: 999_999n }],
        coverageStart: COVERAGE,
      })

      expect(series[0]?.date).toBe(COVERAGE)
      expect(series.every((entry) => entry.date >= COVERAGE)).toBe(true)
    })

    it('ignores transactions dated after the observed balance', () => {
      // A pending row dated tomorrow, or clock skew at the institution. The observed balance cannot
      // already include it, so subtracting it would offset the whole series.
      const series = reconstructBackward({
        currentBalanceCents: 100_000n,
        balanceAsOf: AS_OF,
        transactions: [{ date: '2026-08-05', amountCents: -5_000n }],
        coverageStart: AS_OF,
      })

      expect(series.at(-1)?.balanceCents).toBe(100_000n)
    })

    it('keeps the invariant when transactions straddle the observed balance date', () => {
      const series = reconstructBackward({
        currentBalanceCents: 100_000n,
        balanceAsOf: AS_OF,
        transactions: [
          { date: '2026-08-02', amountCents: -5_000n },
          { date: '2026-08-04', amountCents: -7_000n },
          { date: '2026-08-09', amountCents: 3_000n },
        ],
        coverageStart: '2026-08-01',
      })

      expect(series.at(-1)?.balanceCents).toBe(100_000n)
      // 8/1 = 100000 − (−5000) = 105000. The future rows contribute nothing.
      expect(series[0]?.balanceCents).toBe(105_000n)
    })
  })

  it('handles an account with no transactions in the window', () => {
    const series = reconstructBackward({
      currentBalanceCents: 54_770n,
      balanceAsOf: AS_OF,
      transactions: [],
      coverageStart: COVERAGE,
    })

    expect(series).toHaveLength(daysBetween(COVERAGE, AS_OF) + 1)
    // A dormant account is a flat line, not a gap.
    expect(series.every((entry) => entry.balanceCents === 54_770n)).toBe(true)
  })

  it('reconstructs a liability, whose balances are negative throughout', () => {
    // A mortgage: −$824,871.23 today, a $3,289.56 payment on 8/1 having reduced the debt.
    const series = reconstructBackward({
      currentBalanceCents: -82_487_123n,
      balanceAsOf: AS_OF,
      transactions: [{ date: '2026-08-01', amountCents: 328_956n }],
      coverageStart: '2026-07-31',
    })

    expect(series.at(-1)?.balanceCents).toBe(-82_487_123n)
    // Before the payment the debt was larger.
    expect(series[0]?.balanceCents).toBe(-82_816_079n)
    expect(series.every((entry) => entry.balanceCents < 0n)).toBe(true)
  })

  it('is exact well beyond Number.MAX_SAFE_INTEGER', () => {
    const series = reconstructBackward({
      currentBalanceCents: 9_007_199_254_740_993n,
      balanceAsOf: AS_OF,
      transactions: [{ date: '2026-08-02', amountCents: 1n }],
      coverageStart: '2026-08-01',
    })

    expect(series.at(-1)?.balanceCents).toBe(9_007_199_254_740_993n)
    expect(series[0]?.balanceCents).toBe(9_007_199_254_740_992n)
  })
})

describe('late-posting transactions rewrite only forward from their date', () => {
  /**
   * The property that bounds delta-sync volume: when a transaction posts late, dated in the past,
   * only snapshots from that date forward change. Earlier dates are provably unchanged, because the
   * shift in the current balance and the shift in the transaction sum cancel exactly
   * (ARCHITECTURE.md §4.2).
   */
  it('leaves dates before the late transaction untouched', () => {
    const before = reconstructBackward({
      currentBalanceCents: 100_000n,
      balanceAsOf: AS_OF,
      transactions: [{ date: '2026-08-01', amountCents: -1_000n }],
      coverageStart: COVERAGE,
    })

    // A −$50 transaction dated 7/31 posts late. The current balance drops by 50 accordingly.
    const after = reconstructBackward({
      currentBalanceCents: 95_000n,
      balanceAsOf: AS_OF,
      transactions: [
        { date: '2026-08-01', amountCents: -1_000n },
        { date: '2026-07-31', amountCents: -5_000n },
      ],
      coverageStart: COVERAGE,
    })

    const byDate = (series: typeof before) => new Map(series.map((e) => [e.date, e.balanceCents]))
    const [was, now] = [byDate(before), byDate(after)]

    // Before the late transaction's date: unchanged.
    for (const date of eachDay(COVERAGE, '2026-07-30')) {
      expect(now.get(date)).toBe(was.get(date))
    }

    // From its date forward: shifted by exactly the amount.
    for (const date of eachDay('2026-07-31', AS_OF)) {
      expect(now.get(date)).toBe((was.get(date) ?? 0n) - 5_000n)
    }
  })
})

describe('carry forward, for observed and manual balances', () => {
  it('holds each observation until the next', () => {
    const series = carryForward(
      [
        { date: '2026-08-01', balanceCents: 115_780_000n },
        { date: '2026-08-03', balanceCents: 116_000_000n },
      ],
      '2026-08-01',
      '2026-08-04',
    )

    expect(series).toEqual([
      { date: '2026-08-01', balanceCents: 115_780_000n, source: 'observed' },
      { date: '2026-08-02', balanceCents: 115_780_000n, source: 'observed' },
      { date: '2026-08-03', balanceCents: 116_000_000n, source: 'observed' },
      { date: '2026-08-04', balanceCents: 116_000_000n, source: 'observed' },
    ])
  })

  it('uses an earlier observation to open the window', () => {
    // A manual account entered once a year still charts correctly.
    const series = carryForward(
      [{ date: '2025-01-01', balanceCents: 5_000_000n }],
      '2026-08-01',
      '2026-08-02',
    )

    expect(series).toEqual([
      { date: '2026-08-01', balanceCents: 5_000_000n, source: 'observed' },
      { date: '2026-08-02', balanceCents: 5_000_000n, source: 'observed' },
    ])
  })

  it('starts at the first observation rather than inventing the gap before it', () => {
    const series = carryForward(
      [{ date: '2026-08-03', balanceCents: 100n }],
      '2026-08-01',
      '2026-08-04',
    )

    expect(series[0]?.date).toBe('2026-08-03')
    expect(series).toHaveLength(2)
  })

  it('produces nothing when there are no observations', () => {
    expect(carryForward([], '2026-08-01', '2026-08-04')).toEqual([])
  })

  it('takes the last observation when several land on one day', () => {
    const series = carryForward(
      [
        { date: '2026-08-01', balanceCents: 1n },
        { date: '2026-08-01', balanceCents: 2n },
      ],
      '2026-08-01',
      '2026-08-01',
    )
    expect(series[0]?.balanceCents).toBe(2n)
  })
})

describe('carrying a stale account forward', () => {
  it('extends the last known value and marks it carried', () => {
    const series = reconstructBackward({
      currentBalanceCents: 54_770n,
      balanceAsOf: '2026-07-28',
      transactions: [],
      coverageStart: '2026-07-28',
    })

    const carried = carryStale(series, '2026-07-31')

    expect(carried).toHaveLength(4)
    // Held flat, and labelled so the UI can say so rather than implying it was observed.
    expect(carried.slice(1).every((e) => e.source === 'carried')).toBe(true)
    expect(carried.every((e) => e.balanceCents === 54_770n)).toBe(true)
  })

  it('does nothing when the series already reaches the target', () => {
    const series = [{ date: '2026-08-03', balanceCents: 1n, source: 'derived' as const }]
    expect(carryStale(series, '2026-08-03')).toEqual(series)
    expect(carryStale(series, '2026-08-01')).toEqual(series)
  })

  it('does nothing for an empty series', () => {
    // Nothing known, so nothing to carry. Inventing a zero would put a fake account in net worth.
    expect(carryStale([], '2026-08-03')).toEqual([])
  })
})

describe('merging series at the import seam', () => {
  it('lets later sources win, with no gap and no double counting', () => {
    const imported = [
      { date: '2026-07-30', balanceCents: 100n, source: 'imported' as const },
      { date: '2026-07-31', balanceCents: 200n, source: 'imported' as const },
      { date: '2026-08-01', balanceCents: 300n, source: 'imported' as const },
    ]
    const derived = [
      { date: '2026-08-01', balanceCents: 999n, source: 'derived' as const },
      { date: '2026-08-02', balanceCents: 400n, source: 'derived' as const },
    ]

    const merged = mergeSeries(imported, derived)

    expect(merged.map((e) => e.date)).toEqual([
      '2026-07-30',
      '2026-07-31',
      '2026-08-01',
      '2026-08-02',
    ])
    // Synced data owns the overlap day.
    expect(merged[2]).toEqual({ date: '2026-08-01', balanceCents: 999n, source: 'derived' })
    // One entry per day — a duplicated seam day would double-count in every household total.
    expect(new Set(merged.map((e) => e.date)).size).toBe(merged.length)
  })

  it('produces one continuous run of days across the seam', () => {
    const merged = mergeSeries(
      [{ date: '2026-07-30', balanceCents: 1n, source: 'imported' }],
      [{ date: '2026-07-31', balanceCents: 2n, source: 'derived' }],
    )

    expect(daysBetween(merged[0]!.date, merged.at(-1)!.date)).toBe(merged.length - 1)
  })
})

describe('reconstruction consistency check', () => {
  it('passes for a correct series', () => {
    const series = reconstructBackward({
      currentBalanceCents: 100_000n,
      balanceAsOf: AS_OF,
      transactions: [{ date: '2026-08-01', amountCents: -5_000n }],
      coverageStart: COVERAGE,
    })

    expect(checkReconstruction(series, 100_000n)).toEqual({ consistent: true, difference: 0n })
  })

  /**
   * The failure this exists to catch: an institution reporting its balance and its transactions in
   * opposite sign conventions still produces a perfectly smooth line — one that drifts steadily
   * away from reality rather than failing. There is no error, and the chart looks plausible.
   */
  it('detects a series that drifts from the observed balance', () => {
    const drifted = [
      { date: '2026-08-02', balanceCents: 90_000n, source: 'derived' as const },
      { date: AS_OF, balanceCents: 90_000n, source: 'derived' as const },
    ]

    expect(checkReconstruction(drifted, 100_000n)).toEqual({
      consistent: false,
      difference: -10_000n,
    })
  })

  it('treats an empty series as consistent', () => {
    // Nothing was derived, so nothing can disagree.
    expect(checkReconstruction([], 100_000n)).toEqual({ consistent: true, difference: 0n })
  })
})

describe('date helpers', () => {
  it('adds and subtracts days across month and year boundaries', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    // 2028 is a leap year.
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29')
  })

  it('counts days between dates', () => {
    expect(daysBetween('2026-08-01', '2026-08-03')).toBe(2)
    expect(daysBetween('2026-08-03', '2026-08-01')).toBe(-2)
    expect(daysBetween('2026-08-03', '2026-08-03')).toBe(0)
  })

  /**
   * Dates never pass through a local-timezone conversion. This is the same class of bug that made
   * node-postgres return the previous day for `date` columns.
   */
  it('is unaffected by the local timezone', () => {
    expect(toIsoDate(new Date('2026-08-03T23:59:59.999Z'))).toBe('2026-08-03')
    expect(toIsoDate(new Date('2026-08-03T00:00:00.000Z'))).toBe('2026-08-03')
  })

  it('enumerates inclusive ranges', () => {
    expect(eachDay('2026-08-01', '2026-08-03')).toEqual(['2026-08-01', '2026-08-02', '2026-08-03'])
    expect(eachDay('2026-08-01', '2026-08-01')).toEqual(['2026-08-01'])
    expect(eachDay('2026-08-03', '2026-08-01')).toEqual([])
  })

  it('spans a leap year without drifting', () => {
    const days = eachDay('2028-01-01', '2028-12-31')
    expect(days).toHaveLength(366)
    expect(days.at(-1)).toBe('2028-12-31')
  })
})
