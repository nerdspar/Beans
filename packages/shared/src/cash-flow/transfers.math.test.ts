import { describe, expect, it } from 'vitest'
import {
  cumulativeDailyFlow,
  dayChange,
  latestMove,
  incomeByCategory,
  precedingWindow,
  isExcludedFromCashFlow,
  spendingByCategory,
  uncategorizedTotal,
  pairKeyFor,
  proposeTransferPairs,
  summarizeCashFlow,
  type PairableTransaction,
} from './transfers.js'

/**
 * The money that is neither earned nor spent.
 *
 * Everything here is about one failure: counting an internal movement as both income and spending.
 * A credit card payment is the highest-volume instance of it in real data, so these fixtures are
 * shaped after that rather than after something tidy.
 */

function entry(
  id: string,
  accountId: string,
  postedDate: string,
  amountCents: bigint,
): PairableTransaction {
  return { id, accountId, postedDate, amountCents }
}

describe('proposeTransferPairs', () => {
  it('pairs a credit card payment', () => {
    const pairs = proposeTransferPairs([
      entry('out', 'checking', '2026-08-01', -50_000n),
      entry('in', 'card', '2026-08-02', 50_000n),
    ])

    expect(pairs).toEqual([
      { fromTransactionId: 'out', toTransactionId: 'in', pairKey: pairKeyFor('out', 'in') },
    ])
  })

  /**
   * §9.1, and load-bearing. A mortgage payment leaves checking as one amount while the balance drops
   * by only the principal — the rest is interest, a real expense. The amounts do not match, so this
   * must decline. Loosening the tolerance would silently erase interest from cash flow.
   */
  it('refuses to pair a mortgage payment against a smaller principal reduction', () => {
    const pairs = proposeTransferPairs([
      entry('payment', 'checking', '2026-08-01', -200_000n),
      entry('principal', 'mortgage', '2026-08-01', 140_000n),
    ])

    expect(pairs).toEqual([])
  })

  it('never pairs within one account', () => {
    // A refund and a purchase of equal size on the same card are not a transfer.
    const pairs = proposeTransferPairs([
      entry('purchase', 'card', '2026-08-01', -4_523n),
      entry('refund', 'card', '2026-08-02', 4_523n),
    ])

    expect(pairs).toEqual([])
  })

  it('does not pair across a gap wider than a few days', () => {
    expect(
      proposeTransferPairs([
        entry('out', 'checking', '2026-08-01', -50_000n),
        entry('in', 'card', '2026-08-10', 50_000n),
      ]),
    ).toEqual([])
  })

  it('prefers the nearest candidate when several match', () => {
    const pairs = proposeTransferPairs([
      entry('out', 'checking', '2026-08-03', -50_000n),
      entry('far', 'card', '2026-08-01', 50_000n),
      entry('near', 'card', '2026-08-03', 50_000n),
    ])

    expect(pairs[0]?.toTransactionId).toBe('near')
  })

  it('uses each transaction at most once', () => {
    const pairs = proposeTransferPairs([
      entry('out1', 'checking', '2026-08-01', -50_000n),
      entry('out2', 'checking', '2026-08-01', -50_000n),
      entry('in1', 'card', '2026-08-01', 50_000n),
    ])

    expect(pairs).toHaveLength(1)
    const used = new Set(pairs.flatMap((pair) => [pair.fromTransactionId, pair.toTransactionId]))
    expect(used.size).toBe(2)
  })

  it('leaves transactions already in a confirmed pair alone', () => {
    const pairs = proposeTransferPairs(
      [entry('out', 'checking', '2026-08-01', -50_000n), entry('in', 'card', '2026-08-01', 50_000n)],
      new Set(['out']),
    )
    expect(pairs).toEqual([])
  })

  /** A dismissed pair must stay dismissed, or the user learns to ignore the prompt. */
  it('does not re-propose a rejected pair', () => {
    const transactions = [
      entry('out', 'checking', '2026-08-01', -50_000n),
      entry('in', 'card', '2026-08-01', 50_000n),
    ]

    expect(
      proposeTransferPairs(transactions, new Set(), new Set([pairKeyFor('out', 'in')])),
    ).toEqual([])
  })

  it('keys a pair the same regardless of which side is seen first', () => {
    expect(pairKeyFor('a', 'b')).toBe(pairKeyFor('b', 'a'))
  })

  it('always puts the outflow in from and the inflow in to', () => {
    // The partial unique indexes depend on this: a transaction has one sign, so it can never be
    // `from` in one pair and `to` in another.
    const pairs = proposeTransferPairs([
      entry('in', 'card', '2026-08-01', 50_000n),
      entry('out', 'checking', '2026-08-01', -50_000n),
    ])

    expect(pairs[0]).toMatchObject({ fromTransactionId: 'out', toTransactionId: 'in' })
  })

  it('produces pairs that sum to exactly zero', () => {
    const transactions = [
      entry('out', 'checking', '2026-08-01', -50_000n),
      entry('in', 'card', '2026-08-01', 50_000n),
    ]
    const byId = new Map(transactions.map((t) => [t.id, t]))

    for (const pair of proposeTransferPairs(transactions)) {
      const from = byId.get(pair.fromTransactionId)?.amountCents ?? 0n
      const to = byId.get(pair.toTransactionId)?.amountCents ?? 0n
      expect(from + to).toBe(0n)
    }
  })
})

describe('isExcludedFromCashFlow', () => {
  const base = { id: 'x', postedDate: '2026-08-01', amountCents: -1_000n }

  it('excludes a confirmed pair member', () => {
    expect(isExcludedFromCashFlow(base, new Set(['x']))).toBe(true)
  })

  it('excludes anything categorized as a transfer', () => {
    // Money sent to an account Beans does not track has no counterpart to pair with, and would
    // otherwise read as spending forever.
    expect(isExcludedFromCashFlow({ ...base, categoryKind: 'transfer' }, new Set())).toBe(true)
  })

  it('excludes a voided transaction', () => {
    expect(isExcludedFromCashFlow({ ...base, status: 'void' }, new Set())).toBe(true)
  })

  it('includes ordinary spending', () => {
    expect(isExcludedFromCashFlow({ ...base, categoryKind: 'expense' }, new Set())).toBe(false)
  })
})

describe('summarizeCashFlow', () => {
  const transactions = [
    { id: 'salary', postedDate: '2026-07-31', amountCents: 500_000n },
    { id: 'rent', postedDate: '2026-07-31', amountCents: -180_000n },
    { id: 'shop', postedDate: '2026-08-02', amountCents: -4_523n },
    { id: 'pay-out', postedDate: '2026-08-03', amountCents: -50_000n },
    { id: 'pay-in', postedDate: '2026-08-03', amountCents: 50_000n },
  ]

  it('keeps spending negative so it adds directly to net', () => {
    const summary = summarizeCashFlow(transactions)
    expect(summary.spendingCents).toBeLessThan(0n)
    expect(summary.netCents).toBe(summary.incomeCents + summary.spendingCents)
  })

  /** The whole point: a card payment must not appear as both income and spending. */
  it('a confirmed transfer changes neither side', () => {
    const withTransfer = summarizeCashFlow(transactions, new Set(['pay-out', 'pay-in']))
    const withoutTheTransferRows = summarizeCashFlow(
      transactions.filter((t) => !t.id.startsWith('pay-')),
    )

    expect(withTransfer.incomeCents).toBe(withoutTheTransferRows.incomeCents)
    expect(withTransfer.spendingCents).toBe(withoutTheTransferRows.spendingCents)
    expect(withTransfer.excludedCount).toBe(2)
  })

  it('inflates both sides when the transfer is not excluded — the bug this prevents', () => {
    const naive = summarizeCashFlow(transactions)
    const correct = summarizeCashFlow(transactions, new Set(['pay-out', 'pay-in']))

    expect(naive.incomeCents - correct.incomeCents).toBe(50_000n)
    expect(correct.spendingCents - naive.spendingCents).toBe(50_000n)
    // Net is unaffected, which is exactly why the error is easy to miss.
    expect(naive.netCents).toBe(correct.netCents)
  })

  it('buckets by calendar month, in order', () => {
    expect(summarizeCashFlow(transactions).periods.map((p) => p.month)).toEqual([
      '2026-07',
      '2026-08',
    ])
  })

  it('returns nothing rather than a zero month when there is nothing to report', () => {
    expect(summarizeCashFlow([])).toMatchObject({ periods: [], incomeCents: 0n, netCents: 0n })
  })
})

describe('spendingByCategory', () => {
  const rows = [
    { id: 'a', postedDate: '2026-08-01', amountCents: -20_000n, categoryId: 'groceries' },
    { id: 'b', postedDate: '2026-08-02', amountCents: -5_000n, categoryId: 'groceries' },
    { id: 'c', postedDate: '2026-08-03', amountCents: -40_000n, categoryId: 'rent' },
    { id: 'd', postedDate: '2026-08-04', amountCents: -1_000n, categoryId: null },
    { id: 'income', postedDate: '2026-08-05', amountCents: 500_000n, categoryId: 'salary' },
  ]

  it('sums spending per category, largest first', () => {
    expect(spendingByCategory(rows)).toEqual([
      { categoryId: 'rent', cents: -40_000n },
      { categoryId: 'groceries', cents: -25_000n },
      { categoryId: null, cents: -1_000n },
    ])
  })

  it('leaves income out — this is a spending breakdown', () => {
    expect(spendingByCategory(rows).some((total) => total.categoryId === 'salary')).toBe(false)
  })

  /** Hiding it would make a third of the spending vanish from a chart that claims to be complete. */
  it('reports uncategorized as its own bucket rather than dropping it', () => {
    expect(spendingByCategory(rows).find((total) => total.categoryId === null)?.cents).toBe(-1_000n)
  })

  it('excludes confirmed transfers, like every other total', () => {
    const withTransfer = [
      ...rows,
      { id: 'pay', postedDate: '2026-08-06', amountCents: -50_000n, categoryId: null },
    ]
    const totals = spendingByCategory(withTransfer, new Set(['pay']))
    expect(totals.find((t) => t.categoryId === null)?.cents).toBe(-1_000n)
  })
})

/**
 * Money coming in, broken down the same way.
 *
 * A separate direction rather than one sign-agnostic breakdown: categories only mean something once
 * a direction is chosen, since groceries and a paycheck cannot share a ranking and the figure they
 * would sum to is net — which nobody breaks down by category.
 */
describe('incomeByCategory', () => {
  const rows = [
    { id: 'pay1', postedDate: '2026-08-01', amountCents: 300_000n, categoryId: 'salary' },
    { id: 'pay2', postedDate: '2026-08-15', amountCents: 300_000n, categoryId: 'salary' },
    { id: 'interest', postedDate: '2026-08-03', amountCents: 1_200n, categoryId: 'interest' },
    { id: 'refund', postedDate: '2026-08-04', amountCents: 5_000n, categoryId: null },
    { id: 'rent', postedDate: '2026-08-05', amountCents: -180_000n, categoryId: 'housing' },
  ]

  it('sums income per category, largest first', () => {
    expect(incomeByCategory(rows)).toEqual([
      { categoryId: 'salary', cents: 600_000n },
      { categoryId: null, cents: 5_000n },
      { categoryId: 'interest', cents: 1_200n },
    ])
  })

  it('leaves spending out — this is an income breakdown', () => {
    expect(incomeByCategory(rows).some((total) => total.categoryId === 'housing')).toBe(false)
  })

  it('excludes confirmed transfers, like every other total', () => {
    const withTransfer = [
      ...rows,
      { id: 'in', postedDate: '2026-08-06', amountCents: 50_000n, categoryId: null },
    ]
    expect(incomeByCategory(withTransfer, new Set(['in'])).find((t) => t.categoryId === null)?.cents).toBe(
      5_000n,
    )
  })

  /** A reversed pending credit is not income, and is not spending either. */
  it('puts a zero amount in neither direction', () => {
    const zero = [{ id: 'z', postedDate: '2026-08-01', amountCents: 0n, categoryId: 'x' }]
    expect(incomeByCategory(zero)).toEqual([])
    expect(spendingByCategory(zero)).toEqual([])
  })

  it('ranks spending by magnitude, not by signed value', () => {
    // Most negative is the largest spend; sorting signed would already do this, but the shared
    // comparator now handles both directions and this pins the spending side of it.
    expect(spendingByCategory(rows).map((total) => total.categoryId)).toEqual(['housing'])
  })
})

describe('uncategorizedTotal', () => {
  it('reports the uncategorized bucket as a magnitude, whichever way it points', () => {
    expect(uncategorizedTotal([{ categoryId: null, cents: -4_200n }])).toBe(4_200n)
    expect(uncategorizedTotal([{ categoryId: null, cents: 4_200n }])).toBe(4_200n)
  })

  it('is zero when everything has a category', () => {
    expect(uncategorizedTotal([{ categoryId: 'groceries', cents: -900n }])).toBe(0n)
  })

  it('is zero when there is nothing at all', () => {
    expect(uncategorizedTotal([])).toBe(0n)
  })
})

/**
 * The running total across a window.
 *
 * Read for shape rather than for a figure — the header already gives the total. What the line says
 * is *when* the money moved, and whether this period is ahead of or behind the last one at the same
 * point in it.
 */
describe('cumulativeDailyFlow', () => {
  const august = [
    { id: 'pay', postedDate: '2026-08-02', amountCents: 300_000n },
    { id: 'rent', postedDate: '2026-08-03', amountCents: -180_000n },
    { id: 'shop', postedDate: '2026-08-05', amountCents: -2_000n },
  ]

  it('accumulates day by day', () => {
    const points = cumulativeDailyFlow(august, '2026-08-01', '2026-08-05', 'net')

    expect(points.map((point) => point.cumulativeCents)).toEqual([
      0n,
      300_000n,
      120_000n,
      120_000n,
      118_000n,
    ])
  })

  /**
   * A line that skipped empty days would compress a quiet fortnight into the same width as a busy
   * one, so its slope would stop meaning rate — the only thing a cumulative line is read for.
   */
  it('gives every day a point, including days when nothing happened', () => {
    const points = cumulativeDailyFlow(august, '2026-08-01', '2026-08-07', 'net')

    expect(points).toHaveLength(7)
    expect(points.map((point) => point.date)).toContain('2026-08-04')
    // The 4th holds the 3rd's total rather than dropping to zero or vanishing.
    expect(points.find((point) => point.date === '2026-08-04')?.cumulativeCents).toBe(120_000n)
  })

  it('starts at the window, not at the first transaction', () => {
    // Point 1 is the first day of the window, so two windows compare by index.
    const points = cumulativeDailyFlow(august, '2026-07-30', '2026-08-03', 'net')
    expect(points[0]).toEqual({ date: '2026-07-30', cumulativeCents: 0n })
  })

  it('follows one direction when asked', () => {
    const income = cumulativeDailyFlow(august, '2026-08-01', '2026-08-05', 'in')
    const spending = cumulativeDailyFlow(august, '2026-08-01', '2026-08-05', 'out')

    expect(income.at(-1)?.cumulativeCents).toBe(300_000n)
    expect(spending.at(-1)?.cumulativeCents).toBe(-182_000n)
  })

  it('excludes confirmed transfers, like every other total', () => {
    const withTransfer = [
      ...august,
      { id: 'out', postedDate: '2026-08-04', amountCents: -50_000n },
    ]
    const points = cumulativeDailyFlow(
      withTransfer,
      '2026-08-01',
      '2026-08-05',
      'net',
      new Set(['out']),
    )

    expect(points.at(-1)?.cumulativeCents).toBe(118_000n)
  })

  it('ignores anything outside the window', () => {
    const points = cumulativeDailyFlow(august, '2026-08-04', '2026-08-05', 'net')
    expect(points[0]?.cumulativeCents).toBe(0n)
    expect(points.at(-1)?.cumulativeCents).toBe(-2_000n)
  })

  it('ends flat when the window runs past the last transaction', () => {
    const points = cumulativeDailyFlow(august, '2026-08-01', '2026-08-09', 'net')
    expect(points.at(-1)?.cumulativeCents).toBe(118_000n)
  })
})

describe('precedingWindow', () => {
  /** Equal length, not the previous calendar month — 31 days against 28 flatters February. */
  it('returns the window of equal length immediately before', () => {
    expect(precedingWindow('2026-08-01', '2026-08-31')).toEqual({
      start: '2026-07-01',
      end: '2026-07-31',
    })
  })

  it('leaves no gap and no overlap with the window it precedes', () => {
    const previous = precedingWindow('2026-08-01', '2026-08-31')
    // The day after the previous window ends is the day this one starts.
    expect(previous.end).toBe('2026-07-31')
  })

  it('keeps a short window short', () => {
    expect(precedingWindow('2026-08-10', '2026-08-12')).toEqual({
      start: '2026-08-07',
      end: '2026-08-09',
    })
  })

  /** February against January is the case a calendar-month rule gets wrong. */
  it('compares equal spans across months of different lengths', () => {
    const previous = precedingWindow('2026-02-01', '2026-02-28')
    expect(previous).toEqual({ start: '2026-01-04', end: '2026-01-31' })
  })
})

/**
 * A day's performance, with the money separated from the market.
 *
 * The number everyone else shows is the balance delta, which counts a deposit as a gain. On the day
 * somebody moves a bonus into a brokerage that reads as the best day they have ever had.
 */
describe('dayChange', () => {
  it('reports the market move when nothing was paid in', () => {
    const change = dayChange(100_000_00n, 101_000_00n, 0n)
    expect(change.marketCents).toBe(1_000_00n)
    expect(change.fraction).toBeCloseTo(0.01)
  })

  /** The case the whole function exists for. */
  it('does not count a deposit as a gain', () => {
    // Opened at $100k, paid in $5k, closed at $105k: the market did nothing.
    const change = dayChange(100_000_00n, 105_000_00n, 5_000_00n)
    expect(change.marketCents).toBe(0n)
    expect(change.fraction).toBe(0)
  })

  it('does not count a withdrawal as a loss', () => {
    const change = dayChange(100_000_00n, 95_000_00n, -5_000_00n)
    expect(change.marketCents).toBe(0n)
  })

  it('separates a real gain from a deposit made the same day', () => {
    // Paid in $5k and gained $1k on top.
    const change = dayChange(100_000_00n, 106_000_00n, 5_000_00n)
    expect(change.marketCents).toBe(1_000_00n)
  })

  it('reports a loss as a loss', () => {
    const change = dayChange(100_000_00n, 98_000_00n, 0n)
    expect(change.marketCents).toBe(-2_000_00n)
    expect(change.fraction).toBeCloseTo(-0.02)
  })

  /**
   * Against the opening plus what was paid in, which is the money actually exposed that day.
   * Against the opening alone, a deposit larger than the account would flatter every percentage.
   */
  it('measures the percentage against the money that was exposed', () => {
    const change = dayChange(0n, 101_000_00n, 100_000_00n)
    expect(change.marketCents).toBe(1_000_00n)
    expect(change.fraction).toBeCloseTo(0.01)
  })

  it('reports no percentage when there was nothing to measure against', () => {
    expect(dayChange(0n, 0n, 0n).fraction).toBeNull()
  })

  it('keeps the flow, so a screen can explain an odd-looking figure', () => {
    expect(dayChange(100_000_00n, 105_000_00n, 5_000_00n).flowCents).toBe(5_000_00n)
  })
})

/**
 * Finding the last real change in a series that is flat between readings.
 *
 * An investment account's series holds each reading flat until the next: providers date a balance
 * to the previous market close, a sync can miss a day, and weekends never move. Comparing the last
 * two days therefore returns zero most of the time — which is what "every account shows $0" looks
 * like.
 */
describe('latestMove', () => {
  const at = (date: string, value: bigint) => ({ date, value })

  it('finds a change between consecutive days', () => {
    const move = latestMove([at('2026-08-01', 100n), at('2026-08-02', 110n)])
    expect(move).toEqual({
      fromDate: '2026-08-01',
      toDate: '2026-08-02',
      days: 1,
      openingCents: 100n,
      closingCents: 110n,
    })
  })

  /** The case that produced zero everywhere: the last two days are a flat fill. */
  it('reaches back past days the value did not change', () => {
    const move = latestMove([
      at('2026-08-01', 100n),
      at('2026-08-02', 110n),
      at('2026-08-03', 110n),
      at('2026-08-04', 110n),
    ])

    expect(move?.openingCents).toBe(100n)
    expect(move?.closingCents).toBe(110n)
    expect(move?.fromDate).toBe('2026-08-01')
    // Stated, so the screen can name the period instead of calling three days "1-day".
    expect(move?.days).toBe(3)
  })

  it('reports nothing for a window that never moved', () => {
    expect(latestMove([at('2026-08-01', 100n), at('2026-08-02', 100n)])).toBeNull()
  })

  it('reports nothing for a single point', () => {
    expect(latestMove([at('2026-08-01', 100n)])).toBeNull()
  })

  it('reports nothing for an empty series', () => {
    expect(latestMove([])).toBeNull()
  })

  it('finds a fall as readily as a rise', () => {
    const move = latestMove([at('2026-08-01', 110n), at('2026-08-02', 90n)])
    expect(move?.closingCents).toBe(90n)
    expect(move?.openingCents).toBe(110n)
  })

  /** Only the most recent move — an earlier one is history, not today's figure. */
  it('ignores changes before the last one', () => {
    const move = latestMove([
      at('2026-08-01', 50n),
      at('2026-08-02', 100n),
      at('2026-08-03', 110n),
    ])
    expect(move?.openingCents).toBe(100n)
    expect(move?.fromDate).toBe('2026-08-02')
  })
})
