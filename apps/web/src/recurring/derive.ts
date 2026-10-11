import {
  detectRecurring,
  type IsoDate,
  type RecurringDecision,
  type RecurringSeries,
} from '@beans/shared'
import type {
  StoredCategory,
  StoredRecurringDecision,
  StoredTransaction,
} from '../working-set/db.js'

/**
 * The working set, turned into what the subscriptions screen draws.
 *
 * Detection itself lives in `@beans/shared`; this only feeds it — category kinds and slugs joined
 * on, decisions keyed — and splits the result into the screen's sections. Kept out of the component
 * so it can be tested without rendering anything.
 */

export type RecurringView = {
  subscriptions: RecurringSeries[]
  bills: RecurringSeries[]
  hidden: RecurringSeries[]
  /** Active subscriptions only, over a year. Negative, like any spending. */
  subscriptionsAnnualCents: bigint
  billsAnnualCents: bigint
  activeSubscriptions: number
  /** Decision ids by series key, so a decision can be undone. */
  decisionIds: ReadonlyMap<string, string>
}

export function buildRecurringView(input: {
  transactions: readonly StoredTransaction[]
  categories: ReadonlyMap<string, StoredCategory>
  confirmedTransferIds: ReadonlySet<string>
  decisions: readonly StoredRecurringDecision[]
  today: IsoDate
}): RecurringView {
  // Later wins. The server sends them oldest first, so a duplicate left by a race resolves to the
  // most recent thing somebody said.
  const decisions = new Map<string, RecurringDecision>()
  const decisionIds = new Map<string, string>()
  for (const entry of input.decisions) {
    decisions.set(entry.merchantKey, entry.decision)
    decisionIds.set(entry.merchantKey, entry.id)
  }

  const series = detectRecurring(
    input.transactions.map((transaction) => {
      const category =
        transaction.categoryId === null ? undefined : input.categories.get(transaction.categoryId)
      return {
        ...transaction,
        categoryKind: category?.kind,
        categorySlug: category?.slug,
      }
    }),
    { today: input.today, confirmedTransferIds: input.confirmedTransferIds, decisions },
  )

  const visible = series.filter((entry) => entry.decision !== 'ignored')
  // Active before lapsed within each section; detection already ordered each by yearly cost.
  const activeFirst = (list: RecurringSeries[]): RecurringSeries[] => [
    ...list.filter((entry) => entry.status === 'active'),
    ...list.filter((entry) => entry.status === 'lapsed'),
  ]
  const subscriptions = activeFirst(visible.filter((entry) => entry.kind === 'subscription'))
  const bills = activeFirst(visible.filter((entry) => entry.kind === 'bill'))

  const activeTotal = (list: RecurringSeries[]): bigint =>
    list
      .filter((entry) => entry.status === 'active')
      .reduce((sum, entry) => sum + entry.annualCents, 0n)

  return {
    subscriptions,
    bills,
    hidden: series.filter((entry) => entry.decision === 'ignored'),
    subscriptionsAnnualCents: activeTotal(subscriptions),
    billsAnnualCents: activeTotal(bills),
    activeSubscriptions: subscriptions.filter((entry) => entry.status === 'active').length,
    decisionIds,
  }
}
