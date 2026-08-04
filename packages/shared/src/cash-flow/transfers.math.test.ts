import { describe, expect, it } from 'vitest'
import {
  isExcludedFromCashFlow,
  spendingByCategory,
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
