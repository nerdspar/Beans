import { daysBetween, type IsoDate } from '../balance-history/dates.js'

/**
 * Finding the movements that are not income or spending.
 *
 * Money moved between two accounts a household owns appears twice: as an outflow from one and an
 * inflow to the other. Counted naively, paying a credit card off adds the same amount to both sides
 * of cash flow — money that was neither earned nor spent. Card payments are the highest-volume case
 * in real data, so this is not an edge case, it is most of the error.
 *
 * **Exclusion is defined once, here** (ARCHITECTURE.md §9). Cash flow, budgeting and exports all call
 * it. A second implementation on a screen is how two numbers that describe the same thing start
 * disagreeing.
 */

export type PairableTransaction = {
  id: string
  accountId: string
  postedDate: IsoDate
  amountCents: bigint
}

/** A pair the matcher believes belongs together. `from` is the outflow, `to` the inflow. */
export type ProposedPair = {
  fromTransactionId: string
  toTransactionId: string
  /** Canonical, order-independent, so a rejection sticks no matter which side is seen first. */
  pairKey: string
}

/**
 * How far apart the two halves may post.
 *
 * Three days covers a weekend between the debit leaving one institution and the credit landing at
 * another. Wider starts pairing genuinely unrelated amounts that happen to match.
 */
const MAX_DAYS_APART = 3

/** Stable regardless of which transaction is seen first, so `rejected` cannot be circumvented. */
export function pairKeyFor(firstId: string, secondId: string): string {
  return firstId < secondId ? `${firstId}:${secondId}` : `${secondId}:${firstId}`
}

/**
 * Proposes transfer pairs from a set of transactions.
 *
 * **Amounts must match exactly.** Not approximately — see §9.1: a mortgage payment leaves checking
 * as one amount while the mortgage balance drops by only the principal, the rest being interest,
 * which is a real expense. The amounts therefore do not match and this correctly declines to pair
 * them. Loosening the tolerance to "improve" matching would silently erase interest expense from
 * cash flow, which is exactly the kind of quiet wrongness this app exists to avoid.
 *
 * Each transaction is used at most once, and candidates are considered nearest-in-time first so the
 * obvious pairing wins when several are available.
 */
export function proposeTransferPairs(
  transactions: readonly PairableTransaction[],
  alreadyPaired: ReadonlySet<string> = new Set(),
  rejectedKeys: ReadonlySet<string> = new Set(),
): ProposedPair[] {
  const outflows = transactions
    .filter((entry) => entry.amountCents < 0n && !alreadyPaired.has(entry.id))
    .sort((left, right) => (left.postedDate < right.postedDate ? -1 : 1))

  const inflows = transactions.filter(
    (entry) => entry.amountCents > 0n && !alreadyPaired.has(entry.id),
  )

  const used = new Set<string>()
  const pairs: ProposedPair[] = []

  for (const outflow of outflows) {
    if (used.has(outflow.id)) continue

    const candidates = inflows
      .filter(
        (inflow) =>
          !used.has(inflow.id) &&
          // A transfer moves money between two accounts. The same account cannot be both ends.
          inflow.accountId !== outflow.accountId &&
          inflow.amountCents === -outflow.amountCents &&
          Math.abs(daysBetween(outflow.postedDate, inflow.postedDate)) <= MAX_DAYS_APART &&
          !rejectedKeys.has(pairKeyFor(outflow.id, inflow.id)),
      )
      .sort(
        (left, right) =>
          Math.abs(daysBetween(outflow.postedDate, left.postedDate)) -
          Math.abs(daysBetween(outflow.postedDate, right.postedDate)),
      )

    const match = candidates[0]
    if (match === undefined) continue

    used.add(outflow.id)
    used.add(match.id)
    pairs.push({
      fromTransactionId: outflow.id,
      toTransactionId: match.id,
      pairKey: pairKeyFor(outflow.id, match.id),
    })
  }

  return pairs
}

export type CashFlowTransaction = {
  id: string
  postedDate: IsoDate
  amountCents: bigint
  /** The kind of the transaction's category, when it has one. */
  categoryKind?: 'income' | 'expense' | 'transfer' | undefined
  status?: 'active' | 'void' | undefined
}

/**
 * Whether a transaction counts as income or spending.
 *
 * Two ways out, per §9: it is half of a confirmed pair, or its category says it is a transfer. The
 * second covers money sent to an account Beans does not track, which has no counterpart to pair
 * with and would otherwise read as spending forever.
 *
 * Voided transactions are excluded too. A pending charge that vanished never happened, and leaving
 * it in would report spending the bank has already taken back.
 */
export function isExcludedFromCashFlow(
  transaction: CashFlowTransaction,
  confirmedPairMembers: ReadonlySet<string>,
): boolean {
  return (
    transaction.status === 'void' ||
    transaction.categoryKind === 'transfer' ||
    confirmedPairMembers.has(transaction.id)
  )
}

export type CashFlowPeriod = {
  /** `YYYY-MM`. */
  month: string
  incomeCents: bigint
  spendingCents: bigint
  /** Income plus spending. Spending is negative, so this is a plain sum. */
  netCents: bigint
}

export type CashFlowSummary = {
  periods: CashFlowPeriod[]
  incomeCents: bigint
  spendingCents: bigint
  netCents: bigint
  /** How many were left out, so the screen can say so rather than quietly shrinking the totals. */
  excludedCount: number
}

/**
 * Aggregates cash flow by calendar month.
 *
 * Spending stays **negative** throughout, because every amount in this app is signed to add directly
 * to net worth. Flipping it to a positive "spending" figure somewhere in the middle is how a sign
 * error gets introduced; the screen negates for display and nothing else does.
 */
export function summarizeCashFlow(
  transactions: readonly CashFlowTransaction[],
  confirmedPairMembers: ReadonlySet<string> = new Set(),
): CashFlowSummary {
  const byMonth = new Map<string, { income: bigint; spending: bigint }>()
  let excludedCount = 0

  for (const transaction of transactions) {
    if (isExcludedFromCashFlow(transaction, confirmedPairMembers)) {
      excludedCount += 1
      continue
    }

    const month = transaction.postedDate.slice(0, 7)
    const bucket = byMonth.get(month) ?? { income: 0n, spending: 0n }

    if (transaction.amountCents > 0n) {
      bucket.income += transaction.amountCents
    } else {
      bucket.spending += transaction.amountCents
    }

    byMonth.set(month, bucket)
  }

  const periods = [...byMonth.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([month, bucket]) => ({
      month,
      incomeCents: bucket.income,
      spendingCents: bucket.spending,
      netCents: bucket.income + bucket.spending,
    }))

  const incomeCents = periods.reduce((sum, period) => sum + period.incomeCents, 0n)
  const spendingCents = periods.reduce((sum, period) => sum + period.spendingCents, 0n)

  return { periods, incomeCents, spendingCents, netCents: incomeCents + spendingCents, excludedCount }
}
