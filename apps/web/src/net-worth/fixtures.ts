import type { AccountType, ConnectionStatus, NetWorthSection } from '@beans/shared'
import { addDays, daysBetween, sectionForType, toIsoDate, type IsoDate } from '@beans/shared'
import type { SeriesPoint } from '../charts/AreaChart.js'

/**
 * A stand-in household, until the net worth API and the client working set exist.
 *
 * Shaped after the reference screenshots rather than invented: a wall of near-identical Bank of
 * America rows with unreadable product names, several Fidelity accounts, two mortgages, cards with
 * failed syncs, and manual-entry assets. That shape is the point — a fixture of five tidy accounts
 * would make the layout look fine and hide every problem this screen actually has.
 *
 * Amounts are the redacted figures from the screenshots. Clearly fictional, and nobody's real
 * balances.
 */

export type FixtureAccount = {
  id: string
  institution: string
  name: string
  mask: string | null
  type: AccountType
  balanceCents: bigint
  syncStatus: ConnectionStatus
  /**
   * ISO instant of the last successful sync, as the API will return it.
   *
   * Deliberately not a pre-formatted display string. The account screen needs to know how *old* a
   * balance is to say anything useful about a broken connection, and a string like `4:08 PM` cannot
   * answer that.
   */
  lastSuccessAt: string | null
  consecutiveFailures: number
  /** No connection at all. Nothing to reconnect, and nothing that can go stale on its own. */
  isManual?: boolean
}

/** An account with the daily series behind it. */
export type FixtureAccountSeries = FixtureAccount & { series: SeriesPoint[] }

/*
 * Sync times are relative to today so the fixture cannot rot into looking uniformly stale, except
 * where being old is the point — the broken connections keep fixed dates.
 */
const now = new Date()
const at = (daysAgo: number, hour: number, minute: number): string => {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo))
  day.setUTCHours(hour, minute, 0, 0)
  return day.toISOString()
}

/**
 * Two years, so every range in the control has something to show.
 *
 * Ninety days was enough while ranges were trailing day counts that silently clamped to whatever
 * existed. Now that a range resolves to a real date window, a fixture shorter than the longest range
 * makes "last year" legitimately empty — correct behaviour, useless for looking at the screen.
 */
const DAYS = 730

function wobble(seed: number, index: number): number {
  const value = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453
  return value - Math.floor(value) - 0.5
}

/**
 * Builds a daily series ending at `endCents`, so the chart agrees with the listed balances.
 *
 * **Stops generating movement at `observedThrough` and holds the last balance flat after it.** This
 * is the `carried` snapshot source of ARCHITECTURE.md §4, and it is the difference between a chart
 * that is stale and a chart that lies. An account whose connection broke in December has no daily
 * balances for the months since; inventing a plausible wiggle for that period puts fabricated
 * numbers directly beneath a banner saying the balance is from December.
 */
export function buildSeries(
  endCents: bigint,
  driftPerDay: number,
  volatility: number,
  seed: number,
  observedThrough: IsoDate | null,
): SeriesPoint[] {
  // Ends today rather than on a fixed date, so the fixture cannot drift into looking stale — and so
  // the chart's right-hand axis label is genuinely today's date, as it will be with real data.
  const lastDay = toIsoDate(new Date())
  const firstDay = addDays(lastDay, -(DAYS - 1))

  // At least one observed day: a series with nothing in it has no last known balance to carry.
  const observedDays =
    observedThrough === null
      ? DAYS
      : Math.min(DAYS, Math.max(1, daysBetween(firstDay, observedThrough) + 1))

  const walk: number[] = []
  let value = 0
  for (let index = 0; index < observedDays; index += 1) {
    value += driftPerDay + wobble(seed, index) * volatility
    walk.push(value)
  }

  /*
   * Shift the whole walk so it lands exactly on the known balance, rather than overwriting the last
   * point with it. Overwriting leaves a visible vertical jump wherever the walk happened to end up,
   * which reads as a real one-day swing in the balance.
   */
  const offset = Number(endCents) - (walk[walk.length - 1] ?? 0)

  const points: SeriesPoint[] = walk.map((raw, index) => ({
    date: addDays(firstDay, index),
    value: BigInt(Math.round(raw + offset)),
  }))

  // Carried: last known balance held flat, because nothing newer is known.
  for (let index = observedDays; index < DAYS; index += 1) {
    points.push({ date: addDays(firstDay, index), value: endCents })
  }

  return points
}

/** A healthy synced account. Most of them are, which is what makes the broken ones stand out. */
function bank(
  id: string,
  institution: string,
  name: string,
  mask: string | null,
  type: AccountType,
  balanceCents: bigint,
  daysAgo = 0,
): FixtureAccount {
  return {
    id,
    institution,
    name,
    mask,
    type,
    balanceCents,
    syncStatus: 'healthy',
    lastSuccessAt: at(daysAgo, 16, 8),
    consecutiveFailures: 0,
  }
}

/** No connection behind it, so none of the sync machinery applies. */
function manual(
  id: string,
  institution: string,
  name: string,
  type: AccountType,
  balanceCents: bigint,
): FixtureAccount {
  return {
    id,
    institution,
    name,
    mask: null,
    type,
    balanceCents,
    syncStatus: 'healthy',
    lastSuccessAt: null,
    consecutiveFailures: 0,
    isManual: true,
  }
}

export const FIXTURE_ACCOUNTS: readonly FixtureAccount[] = [
  bank('a1', 'Bank of America', 'Adv Relationship Banking', '2755', 'depository', 54_770n),
  bank('a2', 'Bank of America', 'Adv Relationship Banking', '4113', 'depository', 941_851n),
  bank('a3', 'Bank of America', 'Adv Relationship Banking', '9224', 'depository', 1_127_743n),
  bank('a4', 'Bank of America', 'Advantage Savings', '2510', 'depository', 358_822n),
  bank('a5', 'Wealthfront', 'Cash Account', '8821', 'depository', 24_892_612n),

  bank('i1', 'Fidelity Investments', 'Apple Stock', null, 'investment', 4_820_438n),
  bank('i2', 'Fidelity Investments', "Cdw Coworkers' Profit Sharing Plan", '5567', 'investment', 32_255_940n),
  bank('i3', 'Fidelity Investments', 'Scott Roth IRA', null, 'investment', 3_804_686n),
  {
    // Stale but recent, and nothing erroring: the case where asking for a sync is the whole fix.
    ...bank('i4', 'Merrill Lynch Merrill Edge', 'Cma Edge 3j', '4471', 'investment', 2_342_720n),
    syncStatus: 'stale',
    lastSuccessAt: at(5, 16, 8),
  },
  bank('i5', 'Transamerica Retirement Solutions', 'Careforth 401(k) Plan', '1180', 'investment', 19_538_448n),

  {
    // Failing for months: the credentials went bad, and only the user can fix that.
    ...bank('c1', 'American Express', 'Amex Everyday Card', null, 'credit', 0n),
    syncStatus: 'error',
    lastSuccessAt: '2025-12-18T21:14:00.000Z',
    consecutiveFailures: 14,
  },
  {
    ...bank('c2', 'American Express', 'Bonvoy Business Amex Card', '3007', 'credit', -19_822n),
    syncStatus: 'error',
    lastSuccessAt: '2025-12-18T21:14:00.000Z',
    consecutiveFailures: 14,
  },
  bank('c3', 'Bank of America', 'Family Credit Card', '7412', 'credit', -182_448n, 4),
  bank('c4', 'Chase', 'Amazon Card', null, 'credit', -338_639n),

  {
    // Two failures against a sync that worked yesterday: transient, and Beans retries on its own.
    // Telling the user to re-authorize their mortgage here would be wrong.
    ...bank('m1', 'NewRez', 'Mortgage', '5653', 'mortgage', -47_798_062n),
    syncStatus: 'error',
    lastSuccessAt: at(1, 3, 20),
    consecutiveFailures: 2,
  },
  {
    // Silent for over a year without ever erroring — stale long enough to have become broken.
    ...bank('m2', 'PennyMac Loan', 'Conventional W/o Pmi', '9930', 'mortgage', -34_689_061n),
    syncStatus: 'stale',
    lastSuccessAt: '2025-07-06T11:02:00.000Z',
  },

  manual('o1', 'Assets', 'Cash', 'other_asset', 1_500_000n),
  manual('o2', 'Car', '2022 Jeep Wrangler 4xe', 'other_asset', 2_500_000n),
  bank('o3', 'Home', '18 Atlantic Xing', null, 'other_asset', 115_780_000n, 8),
  bank('o4', 'Home', '555 Lynn Street', null, 'other_asset', 88_370_000n, 8),
]

export type SectionGroup = {
  section: NetWorthSection
  accounts: FixtureAccountSeries[]
  totalCents: bigint
  series: SeriesPoint[]
}

/** Volatility per section, so each chart has a plausible personality rather than the same shape. */
const SHAPE: Record<NetWorthSection, { drift: number; volatility: number; seed: number }> = {
  cash: { drift: -6_000, volatility: 250_000, seed: 2 },
  investment: { drift: 20_000, volatility: 500_000, seed: 3 },
  // Positive: the card is being paid down. Negative drift over two years would have to start from a
  // positive balance to land on today's, which is not a thing a credit card does.
  credit_card: { drift: 1_200, volatility: 25_000, seed: 4 },
  loan: { drift: 3_000, volatility: 0, seed: 6 },
  mortgage: { drift: 11_000, volatility: 0, seed: 5 },
  other_assets: { drift: 31_000, volatility: 42_000, seed: 7 },
  other_liabilities: { drift: 800, volatility: 12_000, seed: 8 },
}

/**
 * Groups the fixture into sections, dropping any that are empty — as the real screen must.
 *
 * Series are generated **per account** and summed upwards, rather than each level being invented
 * independently. It costs nothing and it means an account's own chart actually reconciles with the
 * section total above it: open one account, add up its siblings, and the arithmetic works. Sections
 * generated on their own would drift away from the accounts they claim to summarize, and that is
 * exactly the kind of quiet inconsistency this app cannot afford to ship.
 */
export function buildSections(): SectionGroup[] {
  const bySection = new Map<NetWorthSection, FixtureAccount[]>()

  for (const account of FIXTURE_ACCOUNTS) {
    const section = sectionForType(account.type)
    bySection.set(section, [...(bySection.get(section) ?? []), account])
  }

  return [...bySection.entries()].map(([section, accounts]) => {
    const totalCents = accounts.reduce((sum, account) => sum + account.balanceCents, 0n)
    const shape = SHAPE[section]
    const total = Number(totalCents)

    const withSeries = accounts.map((account, index) => {
      /*
       * Each account carries its share of the section's drift, so the shapes add up to the
       * section's. A zero-balance section would divide by zero, so it splits evenly instead — and a
       * zero-balance *account* correctly gets a flat line at zero rather than a share of the trend.
       */
      const share = total === 0 ? 1 / accounts.length : Number(account.balanceCents) / total

      // A manual account is one number somebody typed. It has no daily history, and drawing a
      // plausible daily wiggle through it invents movement that never happened — the same lie as
      // charting a broken connection, just with a friendlier cause.
      if (account.isManual === true) {
        return { ...account, series: flatSeries(account.balanceCents) }
      }

      return {
        ...account,
        series: buildSeries(
          account.balanceCents,
          shape.drift * share,
          shape.volatility * share,
          shape.seed * 10 + index,
          observedThrough(account),
        ),
      }
    })

    return { section, accounts: withSeries, totalCents, series: sumSeries(withSeries) }
  })
}

/** A value held flat across the whole axis: known once, never observed changing. */
function flatSeries(valueCents: bigint): SeriesPoint[] {
  const lastDay = toIsoDate(new Date())
  return Array.from({ length: DAYS }, (_, index) => ({
    date: addDays(lastDay, index - (DAYS - 1)),
    value: valueCents,
  }))
}

/**
 * The last date this account has real data for.
 *
 * Null for a manual account and for anything healthy — both are current as of today. For a broken
 * or stale connection it is the day of the last successful sync, and everything after it is carried.
 */
export function observedThrough(account: FixtureAccount): IsoDate | null {
  if (account.isManual === true || account.syncStatus === 'healthy') return null
  return account.lastSuccessAt === null ? null : toIsoDate(new Date(account.lastSuccessAt))
}

/** Adds series that share a date axis. Every series here is generated over the same span. */
function sumSeries(parts: ReadonlyArray<{ series: SeriesPoint[] }>): SeriesPoint[] {
  const first = parts[0]?.series ?? []

  return first.map((point, index) => ({
    date: point.date,
    value: parts.reduce((sum, part) => sum + (part.series[index]?.value ?? 0n), 0n),
  }))
}

/** Finds one account across every section, for the account detail route. */
export function findAccount(
  sections: readonly SectionGroup[],
  id: string,
): { account: FixtureAccountSeries; section: NetWorthSection } | null {
  for (const group of sections) {
    const account = group.accounts.find((candidate) => candidate.id === id)
    if (account !== undefined) return { account, section: group.section }
  }
  return null
}

// Net worth is a plain sum, because every amount is already signed to add directly to it.
export function householdSeries(sections: readonly SectionGroup[]): SeriesPoint[] {
  return sumSeries(sections)
}
