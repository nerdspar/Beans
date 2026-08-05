import {
  NET_WORTH_SECTIONS,
  carryForward,
  carryStale,
  maxDate,
  sectionForType,
  type AccountType,
  type IsoDate,
  type NetWorthSection,
} from '@beans/shared'
import type { SeriesPoint } from '../charts/AreaChart.js'
import type { StoredAccount, StoredBalance } from './db.js'
import { localToday } from '../lib/today.js'

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
  /** The earliest date any account reaches, which is where the chart starts. */
  coverageStart: IsoDate | null
  /**
   * The first date every account contributes to. Null when they all reach equally far back.
   *
   * Before it, the total is real but incomplete — it leaves out accounts whose history does not
   * reach that far. The chart marks that region and the screen says so, because a total stepping up
   * on the day an account appears would otherwise read as a gain that never happened.
   */
  completeFrom: IsoDate | null
  /** True when part of the range is incomplete. Worth telling the user. */
  coverageIsLimited: boolean
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

/**
 * Adds series, starting only where **every** part has data.
 *
 * The subtlety that makes this necessary: accounts do not share a coverage start. Backward
 * reconstruction gives cash and credit a year of history immediately, while an investment account
 * gets one day — its value moves with the market rather than with postings, so reconstructing it
 * backwards would be arithmetically fine and factually invented (ARCHITECTURE.md §4).
 *
 * Summing across that boundary produces a total that is silently **missing** whichever accounts do
 * not reach that far back, and the result is not a subtle error: on a first connection it renders as
 * net worth sitting near zero for a year and then leaping by the value of the brokerage on the day
 * it was added. Nothing about that line is true.
 *
 * So the sum starts at the latest first-date among its parts. Less history, all of it real.
 */
/**
 * Sums parts that do not share a start date.
 *
 * The series runs from the **earliest** date any part reaches, and each part contributes from its
 * own start. Before every part has data the total is genuinely incomplete, and `completeFrom` says
 * where that stops being true so the screen and the chart can mark the difference.
 *
 * This used to start at the *latest* first-date and discard everything before it — less history,
 * all of it real (§15.2). That reasoning holds on a first connection, where there is no history to
 * lose, and fails completely afterwards: every account added later re-truncates the whole chart, so
 * the household series could never be longer than its newest account. Adding a house wiped out a
 * year of net worth.
 *
 * The thing truncation was protecting against is real — a total stepping up by the value of an
 * account on the day it appears reads as a gain that never happened. That is answered by saying so,
 * which is what `completeFrom` is for, rather than by hiding a year of history to avoid it.
 */
function sumSeries(parts: ReadonlyArray<{ series: SeriesPoint[] }>): {
  series: SeriesPoint[]
  coverageStart: IsoDate | null
  /** The first date every part contributes to. Null when they already all agree. */
  completeFrom: IsoDate | null
  isLimited: boolean
} {
  const withData = parts.filter((part) => part.series.length > 0)
  if (withData.length === 0) {
    return { series: [], coverageStart: null, completeFrom: null, isLimited: false }
  }

  const firstDates = withData.map((part) => part.series[0]?.date ?? '')
  const complete = firstDates.reduce((latest, date) => (date > latest ? date : latest))
  const earliest = firstDates.reduce((first, date) => (date < first ? date : first))

  const byDate = new Map<string, bigint>()
  for (const part of withData) {
    for (const point of part.series) {
      byDate.set(point.date, (byDate.get(point.date) ?? 0n) + point.value)
    }
  }

  const isLimited = complete > earliest

  return {
    series: [...byDate.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([date, value]) => ({ date, value })),
    coverageStart: earliest,
    completeFrom: isLimited ? complete : null,
    isLimited,
  }
}

export function deriveWorkingSet(
  accounts: readonly StoredAccount[],
  balances: readonly StoredBalance[],
  options: { to?: IsoDate; showIncompleteHistory?: boolean } = {},
): DerivedWorkingSet {
  const to = options.to ?? localToday()
  const showIncomplete = options.showIncompleteHistory ?? true

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

  /*
   * Closed accounts are included, deliberately.
   *
   * They used to be filtered out here, which was right about today and wrong about every day before
   * it: an account closed in 2023 still held its money in 2022, and dropping it lowered every
   * historical point and put a cliff in the chart on the day it was marked closed. History is not
   * revised by what has happened since.
   *
   * Nothing needs to be subtracted to keep *today* right, because the server ends a closed
   * account's series at its close date and it contributes zero from then on. What the household
   * currently has is unaffected; what it used to have is finally correct.
   */
  for (const account of accounts) {
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

    const summed = sumSeries(sectionAccounts)

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
      series: summed.series,
    }
  })

  // Net worth is a plain sum, because every amount is already signed to add directly to it.
  const household = sumSeries(sections)

  /*
   * The setting, applied at the last moment.
   *
   * Trimming here rather than inside `sumSeries` keeps one code path building the totals and one
   * decision about how much of them to show — and keeps `completeFrom` meaningful either way, since
   * the trimmed series then simply starts at it.
   */
  const trim = <T extends { date: string }>(series: T[], from: IsoDate | null): T[] =>
    showIncomplete || from === null ? series : series.filter((point) => point.date >= from)

  const shownHousehold = trim(household.series, household.completeFrom)

  return {
    sections: sections.map((group) => ({
      ...group,
      series: trim(group.series, household.completeFrom),
    })),
    household: shownHousehold,
    coverageStart: shownHousehold[0]?.date ?? household.coverageStart,
    // Null once the incomplete part has been trimmed away: there is no longer a region to mark.
    completeFrom: showIncomplete ? household.completeFrom : null,
    // Reported from the accounts rather than the sections: a section whose parts disagree would
    // otherwise hide that any part of its own total is incomplete.
    coverageIsLimited:
      household.isLimited || sections.some((group) => sumSeries(group.accounts).isLimited),
    byId,
  }
}
