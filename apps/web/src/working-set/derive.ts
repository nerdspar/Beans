import {
  NET_WORTH_SECTIONS,
  carryForward,
  carryStale,
  maxDate,
  sectionForType,
  toIsoDate,
  type AccountType,
  type IsoDate,
  type NetWorthSection,
} from '@beans/shared'
import type { SeriesPoint } from '../charts/AreaChart.js'
import type { StoredAccount, StoredBalance } from './db.js'

/**
 * Turning the working set into what the screens draw.
 *
 * All of this happens on the client, which is the whole point of §7: the amounts are ciphertext in
 * Postgres and cannot be summed or ordered there, so the aggregation has to happen wherever the
 * plaintext is. Here, that means one pass over a couple of thousand rows — cheap enough that
 * changing the range is a re-slice with no request behind it.
 */

export type DerivedAccount = StoredAccount & {
  section: NetWorthSection
  series: SeriesPoint[]
  /** Last date with real data. Everything after it is carried, and the UI says so. */
  observedThrough: IsoDate | null
}

export type DerivedSection = {
  section: NetWorthSection
  accounts: DerivedAccount[]
  totalCents: bigint
  series: SeriesPoint[]
}

export type DerivedWorkingSet = {
  sections: DerivedSection[]
  household: SeriesPoint[]
  /** Every account, for the detail route, without re-walking the sections. */
  byId: Map<string, DerivedAccount>
}

/**
 * Builds a dense daily series for one account.
 *
 * Snapshots are carried forward rather than plotted as-is. The server stores a row per account per
 * day, but a gap is always possible — a sync that missed a day, an account added mid-window — and
 * plotting sparse points would draw a straight line across the gap that reads as a real trend.
 * Carry-forward states the truth instead: the balance was what it last was.
 *
 * **Never starts before `coverageStartDate`** (ARCHITECTURE.md §4.3). Drawing to the left of it
 * presents an absence of history as a flat balance, which is a claim about the account rather than
 * about what is known.
 */
function accountSeries(
  account: StoredAccount,
  snapshots: readonly StoredBalance[],
  from: IsoDate,
  to: IsoDate,
): { series: SeriesPoint[]; observedThrough: IsoDate | null } {
  if (snapshots.length === 0) {
    return { series: [], observedThrough: null }
  }

  const start = account.coverageStartDate === null ? from : maxDate(from, account.coverageStartDate)

  const observations = snapshots.map((snapshot) => ({
    date: snapshot.asOfDate,
    balanceCents: snapshot.balanceCents,
  }))

  const dense = carryForward(observations, start, to)

  /*
   * The last date with a real observation, which is not the same as the last date in the series —
   * a broken connection means the tail is carried. The screens use this to caption the flat stretch
   * rather than letting it read as a balance that genuinely stopped moving.
   */
  const lastObserved = snapshots.reduce<IsoDate | null>(
    (latest, snapshot) =>
      latest === null || snapshot.asOfDate > latest ? snapshot.asOfDate : latest,
    null,
  )

  // Held flat to the end of the window when the account stopped reporting. Omitting it instead would
  // put a hole in household net worth, and a total that quietly drops because one account went
  // silent is worse than one that is explicitly stale.
  const carried = carryStale(dense, to)

  return {
    series: carried.map((point) => ({ date: point.date, value: point.balanceCents })),
    observedThrough:
      lastObserved !== null && lastObserved < to && account.connectionStatus !== 'healthy'
        ? lastObserved
        : null,
  }
}

/** Adds series sharing a date axis. Every series here is built over the same `from`..`to`. */
function sumSeries(parts: ReadonlyArray<{ series: SeriesPoint[] }>): SeriesPoint[] {
  const byDate = new Map<string, bigint>()

  for (const part of parts) {
    for (const point of part.series) {
      byDate.set(point.date, (byDate.get(point.date) ?? 0n) + point.value)
    }
  }

  return [...byDate.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([date, value]) => ({ date, value }))
}

export function deriveWorkingSet(
  accounts: readonly StoredAccount[],
  balances: readonly StoredBalance[],
  options: { to?: IsoDate } = {},
): DerivedWorkingSet {
  const to = options.to ?? toIsoDate(new Date())

  const byAccount = new Map<string, StoredBalance[]>()
  for (const balance of balances) {
    const existing = byAccount.get(balance.accountId)
    if (existing === undefined) {
      byAccount.set(balance.accountId, [balance])
    } else {
      existing.push(balance)
    }
  }

  // The window is whatever history actually arrived, not a fixed span — the server decides how far
  // back it sent, and deriving a wider axis than that would draw emptiness as zero.
  const earliest = balances.reduce<IsoDate | null>(
    (min, balance) => (min === null || balance.asOfDate < min ? balance.asOfDate : min),
    null,
  )

  const bySection = new Map<NetWorthSection, DerivedAccount[]>()
  const byId = new Map<string, DerivedAccount>()

  // Closed accounts are excluded from the rollup. Their history is real, but a closed account is not
  // part of what the household currently has, and leaving them in makes net worth wrong.
  for (const account of accounts.filter((candidate) => !candidate.isClosed)) {
    const section = sectionForType(account.type as AccountType)
    const { series, observedThrough } = accountSeries(
      account,
      byAccount.get(account.id) ?? [],
      earliest ?? to,
      to,
    )

    const derived: DerivedAccount = { ...account, section, series, observedThrough }
    bySection.set(section, [...(bySection.get(section) ?? []), derived])
    byId.set(account.id, derived)
  }

  /*
   * Canonical order, not insertion order.
   *
   * Grouping in account order made the section order depend on which account happened to come back
   * first — which is data, and changed between requests. Cash above Mortgage is a property of the
   * screen, not of the household.
   */
  const sections = NET_WORTH_SECTIONS.filter((section) => bySection.has(section)).map((section) => {
    const sectionAccounts = bySection.get(section) ?? []

    return {
      section,
      accounts: sectionAccounts,
      /*
       * The total sums each account's *latest series point*, not `currentBalanceCents`. The two
       * agree when everything is healthy; when they disagree the series is what the chart above is
       * drawing, and a header contradicting its own chart is the worse failure.
       */
      totalCents: sectionAccounts.reduce(
        (sum, account) => sum + (account.series.at(-1)?.value ?? 0n),
        0n,
      ),
      series: sumSeries(sectionAccounts),
    }
  })

  return {
    sections,
    // Net worth is a plain sum, because every amount is already signed to add directly to it.
    household: sumSeries(sections),
    byId,
  }
}
