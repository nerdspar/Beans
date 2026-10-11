import type { CategoryTotal } from '../cash-flow/transfers.js'
import { scaleSigned } from './rates.js'

/**
 * What retirement actually costs, built from what the household actually spends.
 *
 * This replaces "assume 80% of current spending", which is folklore. Beans has twelve months of
 * categorized transactions, so it can ask the only question that matters — *does this particular
 * cost continue* — one category at a time, with the real number beside it.
 *
 * **Signs follow the domain convention: spending is negative** (§3.2, CLAUDE.md). Nothing here
 * re-decides a sign, so the projection adds these figures to a balance as a plain sum rather than
 * subtracting a magnitude and hoping everyone remembers which way it points.
 */

/**
 * One category's answer.
 *
 * A discriminated union, so an `adjusted` row **cannot** exist without its percentage. That pairing
 * is the one invariant this type can enforce for free, and the alternative — a nullable percentage
 * checked at runtime — puts the failure in a chart rather than in the type system.
 */
export type SpendingAssumption = { categoryId: string | null; lastYear?: number | undefined } & (
  | { treatment: 'continues' | 'stops' }
  | {
      treatment: 'adjusted'
      /** What fraction of today's spending continues, in basis points. 7000 is 70%. */
      adjustmentBasisPoints: number
    }
)

export type SpendingComponent = {
  categoryId: string | null
  /** The annual cost in retirement, negative, with the treatment already applied. */
  annualCents: bigint
  /**
   * The last calendar year this cost is incurred, or null for "the whole projection".
   *
   * This is how a mortgage leaves the baseline: not at retirement, but on its own payoff date,
   * which Beans knows because it asked (`accounts.payoff_date`). Retiring at 62 with four years
   * left on the mortgage is a materially different plan from retiring with it clear, and a model
   * that drops it at either the wrong moment is wrong by a whole payment a month.
   */
  lastYear: number | null
  /**
   * True when nobody recorded an answer for this category and `continues` was assumed.
   *
   * Carried per component rather than only in aggregate, so the review screen can mark the
   * individual rows that are still guesses.
   */
  unreviewed: boolean
}

export type RetirementSpending = {
  /** Every category, largest cost first. `stops` rows are kept at zero rather than dropped. */
  components: SpendingComponent[]

  /** The annual total before anything expires, negative. */
  annualCents: bigint

  /**
   * How many months of real spending this was built from.
   *
   * Exposed rather than resolved here. Twelve months is a baseline; three months scaled up by four
   * is a number with a straight face and nothing behind it, and only the caller knows whether to
   * show a warning or refuse to project at all.
   */
  monthsObserved: number

  /**
   * True when fewer than twelve months were observed and the figures were scaled up to a year.
   *
   * **The scaling is linear, which is wrong for lumpy costs** — property tax, insurance and
   * tuition do not arrive in twelfths. It is still the better of the two available errors: not
   * scaling understates the cost of retirement, and understating it is the direction that tells
   * somebody they can afford to stop working when they cannot.
   */
  annualizedFromPartialYear: boolean

  /** Categories with no recorded assumption. Non-empty means the review is incomplete. */
  unreviewedCategoryIds: (string | null)[]
}

export type RetirementSpendingOptions = {
  /**
   * Trailing spending by category, negative, exactly as `spendingByCategory` returns it.
   *
   * Transfers and voided rows are already gone by then (§9), which also removes contributions to
   * any investment account Beans tracks — money moving into savings is not consumption, and
   * counting it as spending would inflate the retirement baseline by the entire amount somebody is
   * saving *because* they are retiring.
   *
   * Choosing the window is the caller's job. It depends on coverage, and this function has no way
   * to know whether a thin month is a quiet month or a gap in the data.
   */
  trailingByCategory: readonly CategoryTotal[]

  /** Months of spending the totals cover. Twelve for a full trailing year. */
  monthsObserved: number

  assumptions: readonly SpendingAssumption[]
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value
}

export function retirementSpending(options: RetirementSpendingOptions): RetirementSpending {
  const { trailingByCategory, monthsObserved, assumptions } = options

  const byCategory = new Map<string | null, SpendingAssumption>()
  for (const assumption of assumptions) byCategory.set(assumption.categoryId, assumption)

  /*
   * A partial window is scaled to a year before any treatment is applied. Doing it after would
   * work out the same for `continues` and `stops`, but would compound two roundings for
   * `adjusted` — and a cost is a cost whether or not somebody has decided what happens to it.
   */
  const annualize = monthsObserved > 0 && monthsObserved < 12

  const components: SpendingComponent[] = []
  const unreviewedCategoryIds: (string | null)[] = []

  for (const total of trailingByCategory) {
    const observed = annualize
      ? scaleSigned(total.cents, 12n, BigInt(monthsObserved))
      : total.cents

    const assumption = byCategory.get(total.categoryId)

    /*
     * No answer means `continues`, flagged. The spec asks for pre-filled defaults so the user is
     * reviewing rather than data-entering — but a default that cannot be told apart from an answer
     * makes an untouched plan look like a reviewed one, and `continues` is the expensive
     * assumption. Better to carry it and say it is a guess.
     */
    if (assumption === undefined) {
      unreviewedCategoryIds.push(total.categoryId)
      components.push({
        categoryId: total.categoryId,
        annualCents: observed,
        lastYear: null,
        unreviewed: true,
      })
      continue
    }

    const annualCents =
      assumption.treatment === 'stops'
        ? 0n
        : assumption.treatment === 'adjusted'
          ? scaleSigned(observed, BigInt(assumption.adjustmentBasisPoints), 10_000n)
          : observed

    components.push({
      categoryId: total.categoryId,
      annualCents,
      lastYear: assumption.lastYear ?? null,
      unreviewed: false,
    })
  }

  components.sort((left, right) => {
    const a = abs(left.annualCents)
    const b = abs(right.annualCents)
    return a > b ? -1 : a < b ? 1 : 0
  })

  return {
    components,
    annualCents: components.reduce((sum, component) => sum + component.annualCents, 0n),
    monthsObserved,
    annualizedFromPartialYear: annualize,
    unreviewedCategoryIds,
  }
}

/**
 * The annual cost in one calendar year, negative, with expired costs removed.
 *
 * Summed per year rather than decremented from a running total, because a cost that ends is not the
 * only thing that changes a baseline and a running total would make the order of operations matter.
 */
export function spendingInYear(spending: RetirementSpending, year: number): bigint {
  let total = 0n
  for (const component of spending.components) {
    if (component.lastYear !== null && year > component.lastYear) continue
    total += component.annualCents
  }
  return total
}
