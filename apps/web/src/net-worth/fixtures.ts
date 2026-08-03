import type { AccountType, NetWorthSection } from '@beans/shared'
import { sectionForType } from '@beans/shared'
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
  /** `YYYY-MM-DD`, or a time for accounts synced today — matching how the reference reads. */
  updated: string
  syncStatus: 'healthy' | 'stale' | 'error'
  isManual?: boolean
}

const DAYS = 90

function wobble(seed: number, index: number): number {
  const value = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453
  return value - Math.floor(value) - 0.5
}

/** Builds a daily series ending at `endCents`, so the chart agrees with the listed balances. */
export function buildSeries(
  endCents: bigint,
  driftPerDay: number,
  volatility: number,
  seed: number,
): SeriesPoint[] {
  const points: SeriesPoint[] = []
  const end = Number(endCents)
  let value = end - driftPerDay * DAYS

  for (let index = 0; index < DAYS; index += 1) {
    value += driftPerDay + wobble(seed, index) * volatility
    points.push({
      date: new Date(Date.UTC(2026, 4, 5 + index)).toISOString().slice(0, 10),
      value: BigInt(Math.round(value)),
    })
  }

  // Pin the final point so the chart's last value matches the total shown above it exactly.
  points[points.length - 1] = { date: '2026-08-02', value: endCents }
  return points
}

export const FIXTURE_ACCOUNTS: readonly FixtureAccount[] = [
  {
    id: 'a1',
    institution: 'Bank of America',
    name: 'Adv Relationship Banking',
    mask: '2755',
    type: 'depository',
    balanceCents: 54_770n,
    updated: '8/1/2026',
    syncStatus: 'healthy',
  },
  {
    id: 'a2',
    institution: 'Bank of America',
    name: 'Adv Relationship Banking',
    mask: '4113',
    type: 'depository',
    balanceCents: 941_851n,
    updated: '8/1/2026',
    syncStatus: 'healthy',
  },
  {
    id: 'a3',
    institution: 'Bank of America',
    name: 'Adv Relationship Banking',
    mask: '9224',
    type: 'depository',
    balanceCents: 1_127_743n,
    updated: '8/1/2026',
    syncStatus: 'healthy',
  },
  {
    id: 'a4',
    institution: 'Bank of America',
    name: 'Advantage Savings',
    mask: '2510',
    type: 'depository',
    balanceCents: 358_822n,
    updated: '8/1/2026',
    syncStatus: 'healthy',
  },
  {
    id: 'a5',
    institution: 'Wealthfront',
    name: 'Cash Account',
    mask: '8821',
    type: 'depository',
    balanceCents: 24_892_612n,
    updated: '8/1/2026',
    syncStatus: 'healthy',
  },

  {
    id: 'i1',
    institution: 'Fidelity Investments',
    name: 'Apple Stock',
    mask: null,
    type: 'investment',
    balanceCents: 4_820_438n,
    updated: '4:08 PM',
    syncStatus: 'healthy',
  },
  {
    id: 'i2',
    institution: 'Fidelity Investments',
    name: "Cdw Coworkers' Profit Sharing Plan",
    mask: '5567',
    type: 'investment',
    balanceCents: 32_255_940n,
    updated: '4:08 PM',
    syncStatus: 'healthy',
  },
  {
    id: 'i3',
    institution: 'Fidelity Investments',
    name: 'Scott Roth IRA',
    mask: null,
    type: 'investment',
    balanceCents: 3_804_686n,
    updated: '4:08 PM',
    syncStatus: 'healthy',
  },
  {
    id: 'i4',
    institution: 'Merrill Lynch Merrill Edge',
    name: 'Cma Edge 3j',
    mask: '4471',
    type: 'investment',
    balanceCents: 2_342_720n,
    updated: '11/4/2025',
    // Nine months stale while every other account is current — the case sync health exists for.
    syncStatus: 'stale',
  },
  {
    id: 'i5',
    institution: 'Transamerica Retirement Solutions',
    name: 'Careforth 401(k) Plan',
    mask: '1180',
    type: 'investment',
    balanceCents: 19_538_448n,
    updated: '8/1/2026',
    syncStatus: 'healthy',
  },

  {
    id: 'c1',
    institution: 'American Express',
    name: 'Amex Everyday Card',
    mask: null,
    type: 'credit',
    balanceCents: 0n,
    updated: '12/18/2025',
    syncStatus: 'error',
  },
  {
    id: 'c2',
    institution: 'American Express',
    name: 'Bonvoy Business Amex Card',
    mask: '3007',
    type: 'credit',
    balanceCents: -19_822n,
    updated: '12/18/2025',
    syncStatus: 'error',
  },
  {
    id: 'c3',
    institution: 'Bank of America',
    name: 'Family Credit Card',
    mask: '7412',
    type: 'credit',
    balanceCents: -182_448n,
    updated: '7/30/2026',
    syncStatus: 'healthy',
  },
  {
    id: 'c4',
    institution: 'Chase',
    name: 'Amazon Card',
    mask: null,
    type: 'credit',
    balanceCents: -338_639n,
    updated: '4:08 PM',
    syncStatus: 'healthy',
  },

  {
    id: 'm1',
    institution: 'NewRez',
    name: 'Mortgage',
    mask: '5653',
    type: 'mortgage',
    balanceCents: -47_798_062n,
    updated: '2/9/2026',
    syncStatus: 'error',
  },
  {
    id: 'm2',
    institution: 'PennyMac Loan',
    name: 'Conventional W/o Pmi',
    mask: '9930',
    type: 'mortgage',
    balanceCents: -34_689_061n,
    updated: '7/6/2025',
    syncStatus: 'stale',
  },

  {
    id: 'o1',
    institution: 'Assets',
    name: 'Cash',
    mask: null,
    type: 'other_asset',
    balanceCents: 1_500_000n,
    updated: 'Manual entry',
    syncStatus: 'healthy',
    isManual: true,
  },
  {
    id: 'o2',
    institution: 'Car',
    name: '2022 Jeep Wrangler 4xe',
    mask: null,
    type: 'other_asset',
    balanceCents: 2_500_000n,
    updated: 'Manual entry',
    syncStatus: 'healthy',
    isManual: true,
  },
  {
    id: 'o3',
    institution: 'Home',
    name: '18 Atlantic Xing',
    mask: null,
    type: 'other_asset',
    balanceCents: 115_780_000n,
    updated: '7/26/2026',
    syncStatus: 'healthy',
  },
  {
    id: 'o4',
    institution: 'Home',
    name: '555 Lynn Street',
    mask: null,
    type: 'other_asset',
    balanceCents: 88_370_000n,
    updated: '7/26/2026',
    syncStatus: 'healthy',
  },
]

export type SectionGroup = {
  section: NetWorthSection
  accounts: FixtureAccount[]
  totalCents: bigint
  series: SeriesPoint[]
}

/** Volatility per section, so each chart has a plausible personality rather than the same shape. */
const SHAPE: Record<NetWorthSection, { drift: number; volatility: number; seed: number }> = {
  cash: { drift: -18_000, volatility: 700_000, seed: 2 },
  investment: { drift: 55_000, volatility: 1_400_000, seed: 3 },
  credit_card: { drift: -3_000, volatility: 90_000, seed: 4 },
  loan: { drift: 8_000, volatility: 0, seed: 6 },
  mortgage: { drift: 11_000, volatility: 0, seed: 5 },
  other_assets: { drift: 31_000, volatility: 120_000, seed: 7 },
  other_liabilities: { drift: 2_000, volatility: 40_000, seed: 8 },
}

/** Groups the fixture into sections, dropping any that are empty — as the real screen must. */
export function buildSections(): SectionGroup[] {
  const bySection = new Map<NetWorthSection, FixtureAccount[]>()

  for (const account of FIXTURE_ACCOUNTS) {
    const section = sectionForType(account.type)
    bySection.set(section, [...(bySection.get(section) ?? []), account])
  }

  return [...bySection.entries()].map(([section, accounts]) => {
    const totalCents = accounts.reduce((sum, account) => sum + account.balanceCents, 0n)
    const shape = SHAPE[section]
    return {
      section,
      accounts,
      totalCents,
      series: buildSeries(totalCents, shape.drift, shape.volatility, shape.seed),
    }
  })
}

export function householdSeries(sections: readonly SectionGroup[]): SeriesPoint[] {
  const first = sections[0]?.series ?? []

  return first.map((point, index) => ({
    date: point.date,
    // Net worth is a plain sum, because every amount is already signed to add directly to it.
    value: sections.reduce((sum, group) => sum + (group.series[index]?.value ?? 0n), 0n),
  }))
}
