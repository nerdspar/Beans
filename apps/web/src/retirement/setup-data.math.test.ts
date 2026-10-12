import { describe, expect, it } from 'vitest'
import { planAccounts, spendingReview, type PlanAccountInput } from './setup-data.js'

/**
 * Building the setup screens from the working set.
 *
 * The review and the server's own baseline have to agree about what a year of spending was — they
 * run the same shared helpers over the same window, and these tests pin the parts that are this
 * module's own: the window, the month count, and which accounts are worth listing.
 *
 * Fixed dates throughout (CLAUDE.md).
 */

const TODAY = '2026-10-11'

const transaction = (
  id: string,
  postedDate: string,
  amountCents: bigint,
  categoryId: string | null = 'living',
  status: 'active' | 'void' = 'active',
) => ({ id, postedDate, amountCents, categoryId, status })

const categories = [
  { id: 'living', name: 'Groceries', kind: 'expense' as const },
  { id: 'moving', name: 'Transfers', kind: 'transfer' as const },
]

const review = (
  transactions: ReturnType<typeof transaction>[],
  confirmedTransferIds: string[] = [],
) =>
  spendingReview({
    transactions,
    categories,
    confirmedTransferIds: new Set(confirmedTransferIds),
    today: TODAY,
    uncategorizedLabel: 'Uncategorized',
  })

describe('spendingReview', () => {
  it('sums a category over the trailing year, largest first', () => {
    const result = review([
      transaction('a', '2026-09-05', -400_00n),
      transaction('b', '2026-08-05', -600_00n),
      transaction('c', '2026-07-05', -100_00n, null),
    ])

    expect(result.rows).toEqual([
      { categoryId: 'living', name: 'Groceries', annualCents: -1_000_00n },
      { categoryId: null, name: 'Uncategorized', annualCents: -100_00n },
    ])
  })

  it('drops anything outside the window', () => {
    // The window is the trailing 365 days, matching the server. A charge from two years ago is not
    // evidence about next year.
    const result = review([
      transaction('old', '2024-01-01', -5_000_00n),
      transaction('recent', '2026-09-05', -400_00n),
    ])

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]?.annualCents).toBe(-400_00n)
  })

  it('drops a future-dated row rather than counting it', () => {
    const result = review([
      transaction('future', '2027-01-01', -900_00n),
      transaction('now', '2026-09-05', -400_00n),
    ])

    expect(result.rows[0]?.annualCents).toBe(-400_00n)
  })

  it('excludes transfers and voided rows', () => {
    /*
     * Counting a transfer into savings as consumption would inflate the retirement baseline by
     * exactly the amount somebody is saving *because* they intend to retire.
     */
    const result = review(
      [
        transaction('groceries', '2026-09-05', -400_00n),
        transaction('to-savings', '2026-09-06', -2_000_00n, 'moving'),
        transaction('paired', '2026-09-07', -3_000_00n),
        transaction('reversed', '2026-09-08', -50_00n, 'living', 'void'),
      ],
      ['paired'],
    )

    expect(result.rows).toEqual([
      { categoryId: 'living', name: 'Groceries', annualCents: -400_00n },
    ])
  })

  it('counts income as neither spending nor a category row', () => {
    // A paycheck is not a cost that continues into retirement, and a breakdown mixing the two
    // would sum to net, which nobody breaks down by category.
    const result = review([
      transaction('pay', '2026-09-01', 5_000_00n, null),
      transaction('groceries', '2026-09-05', -400_00n),
    ])

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]?.categoryId).toBe('living')
  })

  describe('months observed', () => {
    it('counts distinct calendar months', () => {
      const result = review([
        transaction('a', '2026-09-05', -400_00n),
        transaction('b', '2026-09-20', -400_00n),
        transaction('c', '2026-08-05', -400_00n),
      ])

      expect(result.monthsObserved).toBe(2)
    })

    it('counts only months with real spending in them', () => {
      /*
       * Counting months before transfers come out would call a month "observed" on the strength of
       * one transfer, and scale the baseline down by a twelfth for nothing.
       */
      const result = review([
        transaction('groceries', '2026-09-05', -400_00n),
        transaction('transfer-only', '2026-08-05', -2_000_00n, 'moving'),
      ])

      expect(result.monthsObserved).toBe(1)
    })

    it('is zero when nothing was observed, without dividing by it', () => {
      expect(review([])).toEqual({ rows: [], monthsObserved: 0 })
    })
  })
})

describe('planAccounts', () => {
  const account = (over: Partial<PlanAccountInput> = {}): PlanAccountInput => ({
    id: 'a1',
    name: 'Workplace 401(k)',
    type: 'investment',
    taxTreatment: 'traditional',
    currentBalanceCents: 400_000_00n,
    isClosed: false,
    ...over,
  })

  const build = (accounts: ReturnType<typeof account>[]) =>
    planAccounts({ accounts, taxBuckets: [], routing: [], planFeatures: [] })

  it('lists cash and investments only', () => {
    /*
     * A mortgage has no tax treatment to correct and a house has no buckets to split. Listing them
     * would be a screen full of rows with nothing to do on them.
     */
    const rows = build([
      account({ id: 'brokerage', type: 'investment' }),
      account({ id: 'checking', type: 'depository' }),
      account({ id: 'house', type: 'other_asset' }),
      account({ id: 'mortgage', type: 'mortgage' }),
      account({ id: 'card', type: 'credit' }),
    ])

    expect(rows.map((row) => row.id)).toEqual(['brokerage', 'checking'])
  })

  it('leaves out a closed account', () => {
    // Its balance is zero or historical, so asking somebody to split its buckets is asking about
    // money that is not there.
    const rows = build([account({ id: 'open' }), account({ id: 'shut', isClosed: true })])

    expect(rows.map((row) => row.id)).toEqual(['open'])
  })

  it('offers the plan questions on investments but not on cash', () => {
    // Not an inference that this *is* an employer plan — Beans cannot know that, and the copy says
    // so. A current account is never one, which is the only part that can be stated.
    const rows = build([
      account({ id: 'brokerage', type: 'investment' }),
      account({ id: 'checking', type: 'depository' }),
    ])

    expect(rows.find((row) => row.id === 'brokerage')?.offersPlanQuestions).toBe(true)
    expect(rows.find((row) => row.id === 'checking')?.offersPlanQuestions).toBe(false)
  })

  it('attaches the overlay to the right account', () => {
    const rows = planAccounts({
      accounts: [account({ id: 'a1' }), account({ id: 'a2' })],
      taxBuckets: [
        {
          accountId: 'a2',
          anchors: [
            { asOfDate: '2026-06-30', buckets: [{ treatment: 'roth', balance: '100.00' }] },
          ],
        },
      ],
      routing: [
        { accountId: 'a2', treatment: 'roth', annualAmount: '7000.00', active: true },
      ],
      planFeatures: [
        {
          accountId: 'a1',
          isEmployerPlan: true,
          allowsAfterTaxContributions: true,
          allowsInPlanRothConversion: null,
          allowsInServiceWithdrawal: null,
          acceptsIraRollIns: null,
          employerMatchDescription: null,
          answeredAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    })

    const first = rows.find((row) => row.id === 'a1')
    const second = rows.find((row) => row.id === 'a2')

    expect(first?.anchors).toEqual([])
    expect(first?.features?.allowsAfterTaxContributions).toBe(true)
    expect(second?.anchors).toHaveLength(1)
    expect(second?.routing).toHaveLength(1)
    expect(second?.features).toBeNull()
  })
})
