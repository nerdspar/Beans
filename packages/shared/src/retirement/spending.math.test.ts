import { describe, expect, it } from 'vitest'
import { spendingByCategory, type CashFlowTransaction } from '../cash-flow/transfers.js'
import {
  retirementSpending,
  spendingInYear,
  type SpendingAssumption,
} from './spending.js'

/**
 * The retirement spending baseline.
 *
 * The cases that matter are the ones where a plausible shortcut produces a cheerful, wrong answer:
 * counting a transfer into savings as consumption, dropping the mortgage at retirement rather than
 * at its payoff date, or letting an untouched review look like a completed one.
 *
 * Fixed dates throughout, per CLAUDE.md. Nothing here reads a clock.
 */

const assume = (
  categoryId: string | null,
  treatment: 'continues' | 'stops',
  lastYear?: number,
): SpendingAssumption => ({ categoryId, treatment, ...(lastYear === undefined ? {} : { lastYear }) })

const adjust = (
  categoryId: string,
  adjustmentBasisPoints: number,
): SpendingAssumption => ({ categoryId, treatment: 'adjusted', adjustmentBasisPoints })

/** A full year of observations, so nothing is annualized unless a test asks for it. */
const full = (
  trailingByCategory: { categoryId: string | null; cents: bigint }[],
  assumptions: SpendingAssumption[],
) => retirementSpending({ trailingByCategory, monthsObserved: 12, assumptions })

describe('retirementSpending', () => {
  it('keeps what continues, zeroes what stops, and scales what is adjusted', () => {
    const result = full(
      [
        { categoryId: 'mortgage', cents: -24_000_00n },
        { categoryId: 'groceries', cents: -12_000_00n },
        { categoryId: 'commuting', cents: -3_000_00n },
      ],
      [
        assume('mortgage', 'stops'),
        assume('groceries', 'continues'),
        adjust('commuting', 2_500),
      ],
    )

    const by = (id: string) =>
      result.components.find((component) => component.categoryId === id)?.annualCents

    expect(by('groceries')).toBe(-12_000_00n)
    expect(by('mortgage')).toBe(0n)
    // A quarter of $3,000.
    expect(by('commuting')).toBe(-750_00n)
    expect(result.annualCents).toBe(-12_750_00n)
  })

  it('keeps a stopped category as a zero row rather than dropping it', () => {
    // "Mortgage: stops" is an answer worth showing. A missing row reads as a category nobody
    // considered, which is the one thing the review exists to rule out.
    const result = full([{ categoryId: 'mortgage', cents: -24_000_00n }], [assume('mortgage', 'stops')])

    expect(result.components).toHaveLength(1)
    expect(result.components[0]).toMatchObject({ categoryId: 'mortgage', annualCents: 0n })
  })

  it('flags categories nobody has reviewed, and still counts them', () => {
    /*
     * `continues` is the expensive default, so carrying it is the safe direction — but a default
     * that cannot be told apart from an answer makes an untouched plan look reviewed.
     */
    const result = full(
      [
        { categoryId: 'groceries', cents: -12_000_00n },
        { categoryId: 'hobbies', cents: -2_000_00n },
      ],
      [assume('groceries', 'continues')],
    )

    expect(result.unreviewedCategoryIds).toEqual(['hobbies'])
    expect(result.components.find((c) => c.categoryId === 'hobbies')).toMatchObject({
      annualCents: -2_000_00n,
      unreviewed: true,
    })
    // Counted, not deferred. An unreviewed cost is still a cost.
    expect(result.annualCents).toBe(-14_000_00n)
  })

  it('reports a complete review as complete', () => {
    const result = full(
      [{ categoryId: 'groceries', cents: -12_000_00n }],
      [assume('groceries', 'continues')],
    )
    expect(result.unreviewedCategoryIds).toEqual([])
  })

  it('treats uncategorized spending as a category rather than dropping it', () => {
    // Matching `spendingByCategory`: a baseline that quietly omitted the unsorted third would be a
    // wrong answer, where one that includes it is a prompt to categorize.
    const result = full([{ categoryId: null, cents: -5_000_00n }], [])

    expect(result.annualCents).toBe(-5_000_00n)
    expect(result.unreviewedCategoryIds).toEqual([null])
  })

  it('rounds an adjustment away from zero, so the cost is never quietly shaved', () => {
    /*
     * BigInt division truncates toward zero, which on a negative cost rounds *down* in magnitude —
     * a cent per category, always in the flattering direction. Half of $100.01 is exactly 50.005,
     * which lands on 50.01; plain truncation would give 50.00.
     */
    const result = full([{ categoryId: 'misc', cents: -100_01n }], [adjust('misc', 5_000)])

    expect(result.components[0]?.annualCents).toBe(-50_01n)
  })

  it('leaves an adjustment alone when it divides exactly', () => {
    // The control for the case above: rounding half away from zero must not nudge a figure that
    // needed no rounding at all.
    const result = full([{ categoryId: 'misc', cents: -100_00n }], [adjust('misc', 5_000)])

    expect(result.components[0]?.annualCents).toBe(-50_00n)
  })

  it('sorts by cost, largest first, after treatments are applied', () => {
    // Order follows what retirement costs, not what today costs. A stopped mortgage belongs at the
    // bottom of the review even though it is the biggest line in the trailing year.
    const result = full(
      [
        { categoryId: 'mortgage', cents: -24_000_00n },
        { categoryId: 'groceries', cents: -12_000_00n },
        { categoryId: 'travel', cents: -15_000_00n },
      ],
      [assume('mortgage', 'stops'), assume('groceries', 'continues'), assume('travel', 'continues')],
    )

    expect(result.components.map((component) => component.categoryId)).toEqual([
      'travel',
      'groceries',
      'mortgage',
    ])
  })

  describe('transfers and savings', () => {
    it('excludes a confirmed transfer, so moving money into savings is not spending', () => {
      /*
       * The failure this rules out is expensive and silent: a monthly contribution to a brokerage
       * counted as consumption inflates the retirement baseline by exactly the amount somebody is
       * saving *because* they intend to retire.
       */
      const transactions: CashFlowTransaction[] = [
        { id: 'groceries-1', postedDate: '2026-03-04', amountCents: -400_00n, categoryId: 'groceries' },
        { id: 'to-brokerage', postedDate: '2026-03-05', amountCents: -2_000_00n, categoryId: 'savings' },
        { id: 'into-brokerage', postedDate: '2026-03-05', amountCents: 2_000_00n, categoryId: 'savings' },
      ]

      const confirmedPair = new Set(['to-brokerage', 'into-brokerage'])
      const result = full([...spendingByCategory(transactions, confirmedPair)], [])

      expect(result.annualCents).toBe(-400_00n)
    })

    it('excludes a transfer to an account Beans cannot see, by its category kind', () => {
      // No counterpart to pair with, so without the category kind it would read as spending forever.
      const transactions: CashFlowTransaction[] = [
        { id: 'rent', postedDate: '2026-03-04', amountCents: -1_800_00n, categoryId: 'housing' },
        {
          id: 'to-outside-ira',
          postedDate: '2026-03-06',
          amountCents: -583_00n,
          categoryId: 'transfers',
          categoryKind: 'transfer',
        },
      ]

      const result = full([...spendingByCategory(transactions)], [])

      expect(result.annualCents).toBe(-1_800_00n)
    })
  })

  describe('a partial year', () => {
    it('scales up to a year and says that it did', () => {
      // Not scaling understates the cost of retirement, which is the direction that tells somebody
      // they can afford to stop working when they cannot.
      const result = retirementSpending({
        trailingByCategory: [{ categoryId: 'groceries', cents: -3_000_00n }],
        monthsObserved: 3,
        assumptions: [assume('groceries', 'continues')],
      })

      expect(result.annualCents).toBe(-12_000_00n)
      expect(result.annualizedFromPartialYear).toBe(true)
      expect(result.monthsObserved).toBe(3)
    })

    it('leaves a full year alone and does not claim to have scaled it', () => {
      const result = full([{ categoryId: 'groceries', cents: -12_000_00n }], [])

      expect(result.annualCents).toBe(-12_000_00n)
      expect(result.annualizedFromPartialYear).toBe(false)
    })

    it('does not divide by zero when there is nothing observed at all', () => {
      const result = retirementSpending({
        trailingByCategory: [],
        monthsObserved: 0,
        assumptions: [],
      })

      expect(result.annualCents).toBe(0n)
      expect(result.annualizedFromPartialYear).toBe(false)
      expect(result.components).toEqual([])
    })

    it('scales before applying an adjustment, not after', () => {
      // Two roundings compound. Six months of $1,000.01 at 50% is one rounding of 12,000.12, not a
      // rounding of a rounding.
      const result = retirementSpending({
        trailingByCategory: [{ categoryId: 'misc', cents: -1_000_01n }],
        monthsObserved: 6,
        assumptions: [adjust('misc', 5_000)],
      })

      expect(result.components[0]?.annualCents).toBe(-1_000_01n)
    })
  })
})

describe('spendingInYear', () => {
  it('drops a mortgage at its payoff year, not at retirement', () => {
    /*
     * The spec's case, and the reason `accounts.payoff_date` is asked for. Retiring in 2030 with
     * four years left on the mortgage is a materially different plan from retiring with it clear,
     * and dropping it at either the wrong moment is wrong by a whole payment a month.
     */
    const spending = full(
      [
        { categoryId: 'mortgage', cents: -24_000_00n },
        { categoryId: 'groceries', cents: -12_000_00n },
      ],
      [assume('mortgage', 'continues', 2_034), assume('groceries', 'continues')],
    )

    expect(spendingInYear(spending, 2_030)).toBe(-36_000_00n)
    // The payoff year still carries the cost; it is the last year the payments are made.
    expect(spendingInYear(spending, 2_034)).toBe(-36_000_00n)
    expect(spendingInYear(spending, 2_035)).toBe(-12_000_00n)
  })

  it('is the plain total when nothing expires', () => {
    const spending = full(
      [{ categoryId: 'groceries', cents: -12_000_00n }],
      [assume('groceries', 'continues')],
    )

    expect(spendingInYear(spending, 2_060)).toBe(spending.annualCents)
  })

  it('reaches zero once every cost has expired', () => {
    const spending = full(
      [{ categoryId: 'tuition', cents: -30_000_00n }],
      [assume('tuition', 'continues', 2_031)],
    )

    expect(spendingInYear(spending, 2_031)).toBe(-30_000_00n)
    expect(spendingInYear(spending, 2_032)).toBe(0n)
  })
})
