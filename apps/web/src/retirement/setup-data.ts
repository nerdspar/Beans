import {
  isExcludedFromCashFlow,
  spendingByCategory,
  type CashFlowTransaction,
} from '@beans/shared'
import type { AccountBuckets, AccountPlanFeatures, AccountRouting } from './api.js'

/**
 * Building the setup screens out of the working set.
 *
 * Computed in the browser rather than fetched, for the same reason the subscriptions screen is:
 * the server cannot group spending by category without decrypting every amount, and the client
 * already holds the whole working set. The server's own baseline (`runRetirementProjection`) uses
 * the identical shared helpers over the identical window, so the review and the projection cannot
 * disagree about what a year of spending was.
 *
 * **Signs stay negative.** Nothing here flips one; the screen negates at the point of display.
 */

/** Mirrors the server's window. Twelve months is what makes seasonality cancel. */
export const BASELINE_DAYS = 365

export type SpendingRow = {
  categoryId: string | null
  name: string
  /** Trailing spend for this category, negative. */
  annualCents: bigint
}

export type SpendingReview = {
  rows: SpendingRow[]
  /** Distinct calendar months observed. Fewer than twelve means the baseline is being scaled. */
  monthsObserved: number
}

export type SpendingReviewInput = {
  transactions: readonly {
    id: string
    postedDate: string
    amountCents: bigint
    categoryId: string | null
    status: 'active' | 'void'
  }[]
  /**
   * Iterable rather than an array, because the working set holds a `Map` and copying it to an
   * array on every render of a long review would be pure waste.
   */
  categories: Iterable<{ id: string; name: string; kind: 'income' | 'expense' | 'transfer' }>
  /** Already a `Set` in the working set, and `isExcludedFromCashFlow` wants one. */
  confirmedTransferIds: ReadonlySet<string>
  /** Today, passed in. Never read from a clock here — see CLAUDE.md. */
  today: string
  /** What an uncategorized row is called. From the copy module, not invented here. */
  uncategorizedLabel: string
}

function daysBefore(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`)
  at.setUTCDate(at.getUTCDate() - days)
  return at.toISOString().slice(0, 10)
}

/**
 * Every category with spending in the trailing year, largest first.
 *
 * Uncategorized is a row like any other rather than being dropped. A review that quietly omitted a
 * third of the spending would produce a baseline that is wrong by a third, and the reader would
 * have no way to see it — where a visible "Uncategorized" row is at worst a prompt to go and
 * categorize.
 */
export function spendingReview(input: SpendingReviewInput): SpendingReview {
  const from = daysBefore(input.today, BASELINE_DAYS)
  const kindById = new Map<string, 'income' | 'expense' | 'transfer'>()
  const nameById = new Map<string, string>()
  for (const category of input.categories) {
    kindById.set(category.id, category.kind)
    nameById.set(category.id, category.name)
  }
  const confirmed = input.confirmedTransferIds

  const inWindow: CashFlowTransaction[] = input.transactions
    .filter(
      (transaction) => transaction.postedDate >= from && transaction.postedDate <= input.today,
    )
    .map((transaction) => ({
      id: transaction.id,
      postedDate: transaction.postedDate as CashFlowTransaction['postedDate'],
      amountCents: transaction.amountCents,
      categoryId: transaction.categoryId,
      status: transaction.status,
      ...(transaction.categoryId === null
        ? {}
        : { categoryKind: kindById.get(transaction.categoryId) }),
    }))

  /*
   * Months are counted from the rows that actually count as spending, after transfers and voids
   * come out. Counting them before would call a month "observed" on the strength of a single
   * transfer, and scale the baseline down by a twelfth for nothing.
   */
  const spendable = inWindow.filter(
    (transaction) => !isExcludedFromCashFlow(transaction, confirmed),
  )
  const months = new Set(spendable.map((transaction) => transaction.postedDate.slice(0, 7)))

  const rows = spendingByCategory(spendable, confirmed).map((total) => ({
    categoryId: total.categoryId,
    name:
      total.categoryId === null
        ? input.uncategorizedLabel
        : (nameById.get(total.categoryId) ?? input.uncategorizedLabel),
    annualCents: total.cents,
  }))

  return { rows, monthsObserved: months.size }
}

/**
 * The accounts the planner has anything to say about, with their overlay attached.
 *
 * Cash and investments only, matching `DRAWABLE_TYPES` on the server. A mortgage has no tax
 * treatment to correct and a house has no buckets to split, so listing them would be a screen full
 * of rows with nothing to do.
 *
 * Closed accounts are excluded for the same reason the projection excludes them: their balance is
 * zero or historical, and asking somebody to split a closed account's buckets is asking about
 * money that is not there.
 */
export type PlanAccountRow = {
  id: string
  name: string
  type: string
  taxTreatment: string
  balanceCents: bigint | null
  anchors: AccountBuckets['anchors']
  routing: AccountRouting[]
  features: AccountPlanFeatures | null
  /**
   * Whether the plan-feature questions are worth offering.
   *
   * Investment accounts only, and **not** an inference that this *is* an employer plan — Beans
   * cannot know that, and the copy says so. The questions are offered rather than demanded, and an
   * unanswered one stays null.
   */
  offersPlanQuestions: boolean
}

/** The slice of an account this needs. Named, so callers and tests can refer to it. */
export type PlanAccountInput = {
  id: string
  name: string
  type: string
  taxTreatment: string
  currentBalanceCents: bigint | null
  isClosed: boolean
}

export type PlanAccountsInput = {
  accounts: Iterable<PlanAccountInput>
  taxBuckets: readonly AccountBuckets[]
  routing: readonly AccountRouting[]
  planFeatures: readonly AccountPlanFeatures[]
}

const PLANNABLE_TYPES = new Set(['depository', 'investment'])

export function planAccounts(input: PlanAccountsInput): PlanAccountRow[] {
  const anchorsById = new Map(input.taxBuckets.map((entry) => [entry.accountId, entry.anchors]))
  const featuresById = new Map(input.planFeatures.map((entry) => [entry.accountId, entry]))

  return [...input.accounts]
    .filter((account) => PLANNABLE_TYPES.has(account.type) && !account.isClosed)
    .map((account) => ({
      id: account.id,
      name: account.name,
      type: account.type,
      taxTreatment: account.taxTreatment,
      balanceCents: account.currentBalanceCents,
      anchors: anchorsById.get(account.id) ?? [],
      routing: input.routing.filter((route) => route.accountId === account.id),
      features: featuresById.get(account.id) ?? null,
      offersPlanQuestions: account.type === 'investment',
    }))
}
