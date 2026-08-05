import { addDays, daysBetween, eachDay, type IsoDate } from '../balance-history/dates.js'

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
  categoryId?: string | null | undefined
  status?: 'active' | 'void' | undefined
}

export type CategoryTotal = {
  /** Null for everything not categorized yet, which is reported rather than hidden. */
  categoryId: string | null
  cents: bigint
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

/**
 * Spending by category, largest first.
 *
 * Uncategorized is a bucket like any other rather than being dropped. A breakdown that quietly
 * omitted a third of the spending would be worse than one that says a third is unsorted — the second
 * is a prompt to categorize, the first is a wrong answer.
 */
export function spendingByCategory(
  transactions: readonly CashFlowTransaction[],
  confirmedPairMembers: ReadonlySet<string> = new Set(),
): CategoryTotal[] {
  return categoryTotals(transactions, 'out', confirmedPairMembers)
}

/**
 * The same breakdown for money coming in.
 *
 * A separate call rather than a sign-agnostic one, because a breakdown only means anything once a
 * direction is chosen. Categories cannot share an axis across the zero line — groceries and a
 * paycheck do not belong in one ranking, and the figure they would sum to is net, which is not
 * something anybody breaks down by category.
 */
export function incomeByCategory(
  transactions: readonly CashFlowTransaction[],
  confirmedPairMembers: ReadonlySet<string> = new Set(),
): CategoryTotal[] {
  return categoryTotals(transactions, 'in', confirmedPairMembers)
}

/**
 * Totals per category in one direction, largest first.
 *
 * Amounts keep the sign they are stored with — spending stays negative — because every amount in
 * this app is signed to add directly to net worth, and flipping one here would put a second sign
 * decision outside the ingest edge. The screen negates for display and nothing else does.
 */
function categoryTotals(
  transactions: readonly CashFlowTransaction[],
  direction: 'in' | 'out',
  confirmedPairMembers: ReadonlySet<string>,
): CategoryTotal[] {
  const totals = new Map<string | null, bigint>()

  for (const transaction of transactions) {
    if (isExcludedFromCashFlow(transaction, confirmedPairMembers)) continue

    /*
     * Zero belongs to neither direction. A reversed pending charge or a waived fee is not a
     * purchase, and filing it under spending because it is "not positive" would put a row in a
     * breakdown it has no business being in.
     */
    if (direction === 'out' && transaction.amountCents >= 0n) continue
    if (direction === 'in' && transaction.amountCents <= 0n) continue

    const key = transaction.categoryId ?? null
    totals.set(key, (totals.get(key) ?? 0n) + transaction.amountCents)
  }

  // Largest magnitude first, whichever way the amounts point.
  return [...totals.entries()]
    .map(([categoryId, cents]) => ({ categoryId, cents }))
    .sort((left, right) => {
      const a = left.cents < 0n ? -left.cents : left.cents
      const b = right.cents < 0n ? -right.cents : right.cents
      return a > b ? -1 : a < b ? 1 : 0
    })
}

/**
 * How much of a breakdown has not been categorized, as a magnitude.
 *
 * Reported so a screen can say "$4,200 of the spending below is uncategorized" rather than "some
 * transactions are uncategorized". The first is a number somebody can act on; the second is a
 * disclaimer people learn to scroll past.
 */
export function uncategorizedTotal(totals: readonly CategoryTotal[]): bigint {
  const found = totals.find((total) => total.categoryId === null)?.cents ?? 0n
  return found < 0n ? -found : found
}

export type DailyFlowPoint = {
  date: IsoDate
  /** Running total from the start of the window through this day, inclusive. */
  cumulativeCents: bigint
}

/**
 * A running total, one point per day across a window.
 *
 * The question this answers is not "what did I spend" — the header already says that — but "when
 * did it happen, and am I ahead or behind where I was last time". Neither is legible from a monthly
 * total, and both are obvious from the shape of a line that only moves on days something posted.
 *
 * **Every day gets a point, including days with nothing.** A line that skipped empty days would
 * compress a quiet fortnight into the same width as a busy one, so the slope would stop meaning
 * rate — which is the only thing a cumulative line is read for.
 *
 * Days are walked from `from` even when the first transaction is later, so two windows of the same
 * length are comparable by index: point 7 is the seventh day of each, not the seventh day that
 * happened to have activity.
 */
export function cumulativeDailyFlow(
  transactions: readonly CashFlowTransaction[],
  from: IsoDate,
  to: IsoDate,
  direction: 'net' | 'in' | 'out',
  confirmedPairMembers: ReadonlySet<string> = new Set(),
): DailyFlowPoint[] {
  const perDay = new Map<string, bigint>()

  for (const transaction of transactions) {
    if (isExcludedFromCashFlow(transaction, confirmedPairMembers)) continue
    if (transaction.postedDate < from || transaction.postedDate > to) continue

    if (direction === 'in' && transaction.amountCents <= 0n) continue
    if (direction === 'out' && transaction.amountCents >= 0n) continue

    perDay.set(
      transaction.postedDate,
      (perDay.get(transaction.postedDate) ?? 0n) + transaction.amountCents,
    )
  }

  let running = 0n
  return eachDay(from, to).map((date) => {
    running += perDay.get(date) ?? 0n
    return { date, cumulativeCents: running }
  })
}

/**
 * The window of equal length immediately before this one.
 *
 * Equal length rather than "the previous calendar month", so the comparison holds for any range the
 * user picked. Comparing 31 days against 28 would make February look thrifty every year.
 */
export function precedingWindow(
  from: IsoDate,
  to: IsoDate,
): { start: IsoDate; end: IsoDate } {
  const span = daysBetween(from, to)
  // `{ start, end }` to match DateWindow. Two shapes for one concept is a bug waiting for whoever
  // passes the wrong one to a function that reads the other.
  return { start: addDays(from, -(span + 1)), end: addDays(to, -(span + 1)) }
}

export type DayChange = {
  /** Value moved by the market, with money paid in or taken out removed. */
  marketCents: bigint
  /** As a fraction of where the account started the day. Null when it started at nothing. */
  fraction: number | null
  /** What was paid in or taken out, kept so a screen can say why a figure looks odd. */
  flowCents: bigint
}

/**
 * What an investment account did in a day, separating the market from the money.
 *
 * A balance moved by a deposit is not performance. Empower's one-day figure is the balance delta,
 * so paying $5,000 into a brokerage reads as a $5,000 gain — the most flattering possible day, and
 * entirely untrue. Subtracting the day's own transactions leaves what the market did.
 *
 * Where a provider sends no transactions for an account, `flowCents` is zero and this degrades to
 * the delta. That is the best available answer, not a claim that nothing was paid in.
 */
export function dayChange(
  openingCents: bigint,
  closingCents: bigint,
  flowCents: bigint,
): DayChange {
  const marketCents = closingCents - openingCents - flowCents

  return {
    marketCents,
    /*
     * Measured against the opening balance plus what was paid in, which is the money that was
     * actually exposed to the market that day. Against the opening alone, a large deposit would
     * shrink the percentage of a good day toward nothing.
     */
    fraction:
      openingCents + flowCents === 0n
        ? null
        : Number(marketCents) / Math.abs(Number(openingCents + flowCents)),
    flowCents,
  }
}
