import { addDays, compareDates, eachDay, maxDate, type IsoDate } from './dates.js'

/**
 * Reconstructing a daily balance series.
 *
 * SimpleFIN returns a **current** balance plus a window of transactions. It never returns
 * historical daily balances, so they are constructed here.
 *
 * **Backward reconstruction**, for cash, credit, loan and mortgage:
 *
 *     balance(T) = current balance − sum of transactions posted after T
 *
 * which works precisely because those balances only move when transactions post. It gives real
 * history from the first sync, as far back as the institution's transaction window reaches.
 *
 * It is **mathematically wrong for investment accounts**, whose value moves with the market rather
 * than with transactions — those get forward observations instead, and their history starts the day
 * they were connected.
 */

export type SnapshotSource = 'derived' | 'observed' | 'imported' | 'carried'

export type DailyBalance = {
  date: IsoDate
  balanceCents: bigint
  source: SnapshotSource
}

export type PostedTransaction = {
  date: IsoDate
  amountCents: bigint
}

export type ReconstructOptions = {
  /** The authoritative observed balance. Snapshots are derived from this, never the reverse. */
  currentBalanceCents: bigint
  /** The calendar date `currentBalanceCents` was observed on. */
  balanceAsOf: IsoDate
  /**
   * Transactions in the reconstruction window. Order does not matter — they are summed per day, so
   * out-of-order postings and same-day ties produce the same result.
   */
  transactions: readonly PostedTransaction[]
  /**
   * The earliest date this account's history can be trusted, normally the start of the transaction
   * window ever fetched. Nothing is produced before it.
   *
   * **Never draw a chart line to the left of this.** Reconstruction can happily keep subtracting
   * into a period where we simply have no transactions, producing a smooth, confident, wrong line.
   */
  coverageStart: IsoDate
}

/**
 * Reconstructs the daily series backward from the observed balance.
 *
 * Returns one entry per calendar day from `coverageStart` through `balanceAsOf`, oldest first.
 *
 * Invariant, relied on elsewhere: **the last entry always equals `currentBalanceCents` exactly.**
 * The observed balance is the input, and the series is derived from it — if they ever disagree, the
 * reconstruction is wrong, not the balance.
 */
export function reconstructBackward(options: ReconstructOptions): DailyBalance[] {
  const { currentBalanceCents, balanceAsOf, transactions, coverageStart } = options

  if (compareDates(coverageStart, balanceAsOf) > 0) {
    // Coverage has not started yet. An empty series is the honest answer.
    return []
  }

  /**
   * Transactions dated after the observed balance are **ignored**, not folded in.
   *
   * `currentBalanceCents` reflects what the institution had posted as of `balanceAsOf`, so anything
   * dated later — a pending row, or clock skew at the institution — is by definition not in it.
   * Subtracting such a row would offset the entire series and break the invariant that the last
   * entry equals the observed balance exactly.
   */
  const byDate = sumByDate(
    transactions.filter((transaction) => compareDates(transaction.date, balanceAsOf) <= 0),
  )

  let running = currentBalanceCents
  const dates = eachDay(coverageStart, balanceAsOf)
  const series: DailyBalance[] = new Array<DailyBalance>(dates.length)

  // Walk backward: balance(T−1) = balance(T) − (transactions posted on T).
  for (let index = dates.length - 1; index >= 0; index -= 1) {
    const date = dates[index] as IsoDate
    series[index] = { date, balanceCents: running, source: 'derived' }
    running -= byDate.get(date) ?? 0n
  }

  return series
}

/**
 * Builds a series from point-in-time observations, carrying each forward until the next.
 *
 * Used for investment accounts, whose value moves with the market, and for manual accounts, where
 * the user enters a balance now and again. Both are step functions: the value is what was last
 * observed until something says otherwise.
 *
 * Observations before `from` are not discarded — the most recent one still sets the opening value,
 * which is what makes a manual account entered once a year chart correctly.
 */
export function carryForward(
  observations: ReadonlyArray<{ date: IsoDate; balanceCents: bigint }>,
  from: IsoDate,
  to: IsoDate,
  source: SnapshotSource = 'observed',
): DailyBalance[] {
  if (observations.length === 0) {
    return []
  }

  const sorted = [...observations].sort((a, b) => compareDates(a.date, b.date))

  // The opening value: the most recent observation at or before `from`.
  let current: bigint | null = null
  let next = 0
  while (next < sorted.length && compareDates(sorted[next]!.date, from) <= 0) {
    current = sorted[next]!.balanceCents
    next += 1
  }

  // Nothing observed yet at `from`, so the series starts at the first observation instead of
  // inventing a value for the gap before it.
  const start = current === null ? maxDate(from, sorted[0]!.date) : from
  const series: DailyBalance[] = []

  for (const date of eachDay(start, to)) {
    while (next < sorted.length && compareDates(sorted[next]!.date, date) <= 0) {
      current = sorted[next]!.balanceCents
      next += 1
    }
    if (current !== null) {
      series.push({ date, balanceCents: current, source })
    }
  }

  return series
}

/**
 * Extends a series to `through` by holding the last known value flat.
 *
 * Used when a sync is broken: the account's real balance is unknown, but omitting it entirely would
 * put a hole in household net worth, and a total that silently drops because one account stopped
 * reporting is worse than one that is explicitly stale.
 *
 * Marked `carried` so the UI can say "2 accounts stale, carried forward since 7/28" rather than
 * presenting a guess as an observation.
 */
export function carryStale(series: readonly DailyBalance[], through: IsoDate): DailyBalance[] {
  const last = series.at(-1)
  if (last === undefined || compareDates(last.date, through) >= 0) {
    return [...series]
  }

  const carried = eachDay(addDays(last.date, 1), through).map((date): DailyBalance => ({
    date,
    balanceCents: last.balanceCents,
    source: 'carried',
  }))

  return [...series, ...carried]
}

/**
 * Merges series by date, with later sources winning.
 *
 * Used at the import seam: imported history owns everything before the cutover, synced data
 * everything after. Passing `[imported, derived]` yields exactly that, with no gap and no double
 * counting on the day they meet.
 */
export function mergeSeries(...series: ReadonlyArray<readonly DailyBalance[]>): DailyBalance[] {
  const byDate = new Map<IsoDate, DailyBalance>()

  for (const entries of series) {
    for (const entry of entries) {
      byDate.set(entry.date, entry)
    }
  }

  return [...byDate.values()].sort((a, b) => compareDates(a.date, b.date))
}

/**
 * Checks that a derived series is consistent with the balance it was derived from.
 *
 * The reason this exists: if an institution reports its balance and its transactions in **opposite
 * sign conventions**, reconstruction still produces a perfectly smooth line — one that drifts
 * steadily away from reality instead of failing. There is no error to catch, and the chart looks
 * entirely plausible.
 *
 * Comparing the series endpoint against the observed balance is the cheapest thing that would
 * notice. A mismatch means either that, or a bug here.
 */
export function checkReconstruction(
  series: readonly DailyBalance[],
  currentBalanceCents: bigint,
): { consistent: boolean; difference: bigint } {
  const last = series.at(-1)
  if (last === undefined) {
    return { consistent: true, difference: 0n }
  }

  const difference = last.balanceCents - currentBalanceCents
  return { consistent: difference === 0n, difference }
}

/** Sums transactions per calendar date, so ordering and same-day ties cannot affect the result. */
function sumByDate(transactions: readonly PostedTransaction[]): Map<IsoDate, bigint> {
  const byDate = new Map<IsoDate, bigint>()

  for (const transaction of transactions) {
    byDate.set(transaction.date, (byDate.get(transaction.date) ?? 0n) + transaction.amountCents)
  }

  return byDate
}
