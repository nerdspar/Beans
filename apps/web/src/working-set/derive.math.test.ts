import { describe, expect, it } from 'vitest'
import { deriveWorkingSet } from './derive.js'
import type { StoredAccount, StoredBalance } from './db.js'

/**
 * Aggregating the working set into net worth.
 *
 * The rule under test is the coverage boundary. Accounts do not share a start date — backward
 * reconstruction gives cash and credit a year of history immediately, while an investment account
 * gets one day, because its value moves with the market rather than with postings and reconstructing
 * it backwards would be invented (ARCHITECTURE.md §4). Summing across that boundary produces a total
 * silently missing whichever accounts do not reach back that far, which renders as net worth leaping
 * by the value of an account on the day it was connected.
 */

const TODAY = '2026-08-03'

function account(overrides: Partial<StoredAccount> & { id: string }): StoredAccount {
  return {
    type: 'depository',
    name: 'Account',
    institutionName: 'Bank',
    mask: null,
    currentBalanceCents: null,
    balanceAsOf: null,
    isManual: false,
    isClosed: false,
  closedOn: null,
    taxTreatment: 'none',
    coverageStartDate: null,
    connectionStatus: 'healthy',
    lastSuccessAt: null,
    consecutiveFailures: 0,
    ...overrides,
  }
}

function balances(
  accountId: string,
  entries: ReadonlyArray<[string, bigint]>,
): StoredBalance[] {
  return entries.map(([asOfDate, balanceCents]) => ({
    accountId,
    asOfDate,
    balanceCents,
    source: 'derived' as const,
  }))
}

describe('deriveWorkingSet', () => {
  it('sums signed amounts straight into net worth', () => {
    const result = deriveWorkingSet(
      [
        account({ id: 'cash', type: 'depository' }),
        account({ id: 'card', type: 'credit' }),
      ],
      [
        ...balances('cash', [[TODAY, 482_155n]]),
        // Liabilities are already negative at rest, so no subtraction happens here.
        ...balances('card', [[TODAY, -338_639n]]),
      ],
      { to: TODAY },
    )

    expect(result.household.at(-1)?.value).toBe(143_516n)
  })

  it('classifies by account type, never by the sign of a balance', () => {
    // An overdrawn checking account is still cash, not a liability.
    const result = deriveWorkingSet(
      [account({ id: 'overdrawn', type: 'depository' })],
      balances('overdrawn', [[TODAY, -12_300n]]),
      { to: TODAY },
    )

    expect(result.sections.map((group) => group.section)).toEqual(['cash'])
  })

  describe('the coverage boundary', () => {
    const accounts = [
      account({ id: 'cash', type: 'depository', coverageStartDate: '2026-08-01' }),
      // One day only — the shape a freshly connected brokerage actually has.
      account({ id: 'brokerage', type: 'investment', coverageStartDate: TODAY }),
    ]

    const snapshots = [
      ...balances('cash', [
        ['2026-08-01', 100_000n],
        ['2026-08-02', 100_000n],
        [TODAY, 100_000n],
      ]),
      ...balances('brokerage', [[TODAY, 5_000_000n]]),
    ]

    /**
     * The series used to start at the *latest* first-date, discarding everything before it. That
     * costs nothing on a first connection and everything afterwards: each account added later
     * re-truncated the whole chart, so the household series could never be longer than its newest
     * account. Adding one asset wiped out a year of net worth.
     */
    it('keeps history back to the earliest account, not the newest one', () => {
      const result = deriveWorkingSet(accounts, snapshots, { to: TODAY })

      expect(result.household.map((point) => point.date)).toEqual([
        '2026-08-01',
        '2026-08-02',
        TODAY,
      ])
      expect(result.coverageStart).toBe('2026-08-01')
    })

    it('sums the accounts that existed on each day', () => {
      const byDate = new Map(
        deriveWorkingSet(accounts, snapshots, { to: TODAY }).household.map((point) => [
          point.date,
          point.value,
        ]),
      )

      // Cash alone before the brokerage reaches back, both once it does.
      expect(byDate.get('2026-08-01')).toBe(100_000n)
      expect(byDate.get(TODAY)).toBe(5_100_000n)
    })

    /**
     * What the old truncation was protecting against, now answered by saying so instead.
     *
     * The total steps from $1,000 to $51,000 on the day the brokerage appears, and that step is not
     * a gain. Reporting the boundary is what lets the screen and the chart mark the earlier region
     * as incomplete rather than letting it be read as history.
     */
    it('reports where the total becomes complete, so the step can be explained', () => {
      const result = deriveWorkingSet(accounts, snapshots, { to: TODAY })

      expect(result.completeFrom).toBe(TODAY)
      expect(result.coverageIsLimited).toBe(true)
    })

    /**
     * The setting, for someone who prefers the old trade: less history, all of it complete.
     *
     * Off by default, because it discards real history to avoid one explicable step and nobody
     * should get that without asking — but it is a legitimate preference and this is where it lands.
     */
    it('trims to the common start when incomplete history is switched off', () => {
      const result = deriveWorkingSet(accounts, snapshots, {
        to: TODAY,
        showIncompleteHistory: false,
      })

      expect(result.household.map((point) => point.date)).toEqual([TODAY])
      expect(result.coverageStart).toBe(TODAY)
      // Nothing partial is left, so there is no region for the chart to mark.
      expect(result.completeFrom).toBeNull()
    })

    it('trims each section the same way, so the parts still add up to the total', () => {
      const result = deriveWorkingSet(accounts, snapshots, {
        to: TODAY,
        showIncompleteHistory: false,
      })

      for (const group of result.sections) {
        expect(group.series.map((point) => point.date)).toEqual([TODAY])
      }
    })

    it('claims no boundary when every account reaches equally far back', () => {
      const aligned = [
        account({ id: 'a', coverageStartDate: '2026-08-01' }),
        account({ id: 'b', coverageStartDate: '2026-08-01' }),
      ]
      const both = [
        ...balances('a', [['2026-08-01', 1n], [TODAY, 1n]]),
        ...balances('b', [['2026-08-01', 2n], [TODAY, 2n]]),
      ]

      const result = deriveWorkingSet(aligned, both, { to: TODAY })
      expect(result.coverageIsLimited).toBe(false)
      // Nothing to mark, so the chart draws no band and the screen shows no notice.
      expect(result.completeFrom).toBeNull()
    })
  })

  /**
   * Closed accounts stay in the rollup, and the server ends their series at the close date.
   *
   * They used to be filtered out here, which was right about today and wrong about every day before
   * it — an account closed in 2023 still held its money in 2022, so dropping it lowered every
   * historical point and put a cliff in the chart on the day it was marked closed.
   */
  describe('closed accounts', () => {
    // Held $500 until it closed on the 2nd, and nothing after. This is what the server writes.
    const closedSeries = balances('shut', [
      ['2026-08-01', 500n],
      ['2026-08-02', 500n],
      ['2026-08-03', 0n],
    ])

    const open = balances('open', [
      ['2026-08-01', 100n],
      ['2026-08-02', 100n],
      ['2026-08-03', 100n],
    ])

    it('keeps the money it held in the days before it closed', () => {
      const result = deriveWorkingSet(
        [
          account({ id: 'open', coverageStartDate: '2026-08-01' }),
          account({ id: 'shut', isClosed: true, closedOn: '2026-08-02', coverageStartDate: '2026-08-01' }),
        ],
        [...open, ...closedSeries],
        { to: '2026-08-03' },
      )

      const byDate = new Map(result.household.map((point) => [point.date, point.value]))
      expect(byDate.get('2026-08-01')).toBe(600n)
      expect(byDate.get('2026-08-02')).toBe(600n)
    })

    it('contributes nothing once it is closed', () => {
      const result = deriveWorkingSet(
        [
          account({ id: 'open', coverageStartDate: '2026-08-01' }),
          account({ id: 'shut', isClosed: true, closedOn: '2026-08-02', coverageStartDate: '2026-08-01' }),
        ],
        [...open, ...closedSeries],
        { to: '2026-08-03' },
      )

      expect(result.household.at(-1)?.value).toBe(100n)
    })

    /** The screens need it to label the row and to decide whether to list it at all. */
    it('is still reachable by id', () => {
      const result = deriveWorkingSet(
        [account({ id: 'shut', isClosed: true, closedOn: '2026-08-02' })],
        closedSeries,
        { to: '2026-08-03' },
      )

      expect(result.byId.get('shut')?.isClosed).toBe(true)
    })
  })

  it('carries a stale account forward rather than leaving a hole in net worth', () => {
    // A total that silently drops because one account stopped reporting is worse than one that is
    // explicitly stale.
    const result = deriveWorkingSet(
      [account({ id: 'stale', connectionStatus: 'error', coverageStartDate: '2026-08-01' })],
      balances('stale', [['2026-08-01', 250_000n]]),
      { to: TODAY },
    )

    expect(result.household.map((point) => point.value)).toEqual([250_000n, 250_000n, 250_000n])
    expect(result.byId.get('stale')?.observedThrough).toBe('2026-08-01')
  })

  it('reports no carried boundary for a healthy account that is simply current', () => {
    const result = deriveWorkingSet(
      [account({ id: 'fine', coverageStartDate: TODAY })],
      balances('fine', [[TODAY, 1n]]),
      { to: TODAY },
    )

    expect(result.byId.get('fine')?.observedThrough).toBeNull()
  })

  it('returns nothing rather than zero when there are no accounts', () => {
    // Zero is a claim about net worth; empty is the absence of one.
    const result = deriveWorkingSet([], [], { to: TODAY })
    expect(result.household).toEqual([])
    expect(result.coverageStart).toBeNull()
  })
})

/**
 * Snapshots reaching further back than the declared coverage.
 *
 * A household that turns on trust for its imported history gets a rebuild that writes snapshots
 * earlier than `coverage_start_date` on purpose — the column keeps meaning "what the provider
 * vouches for" so the setting stays reversible (ARCHITECTURE.md §4.2a).
 *
 * Clipping to the declared date discarded exactly those days, *after* the server had written them
 * and sent them over the wire. The symptom was the setting appearing to do nothing at all for every
 * synced account, while working for accounts whose declared coverage happened to be old already.
 */
describe('snapshots older than the declared coverage', () => {
  it('draws them rather than discarding them', () => {
    const derived = deriveWorkingSet(
      [account({ id: 'cash', type: 'depository', coverageStartDate: '2025-08-03' })],
      balances('cash', [
        ['2019-01-02', 100_000n],
        ['2025-08-03', 120_000n],
      ]),
      { showIncompleteHistory: true },
    )

    expect(derived.byId.get('cash')?.series[0]?.date).toBe('2019-01-02')
  })

  /**
   * Widening the boundary cannot invent history, only stop discarding it.
   *
   * A declared coverage earlier than every snapshot does not stretch the series backwards —
   * `carryForward` starts at the first observation rather than inventing a balance for the gap
   * before it. So the change here can only ever *keep* days that exist.
   */
  it('does not invent days before the first snapshot, however early coverage is declared', () => {
    const derived = deriveWorkingSet(
      [account({ id: 'cash', type: 'depository', coverageStartDate: '2019-01-01' })],
      balances('cash', [['2019-06-01', 100_000n]]),
      { showIncompleteHistory: true },
    )

    expect(derived.byId.get('cash')?.series[0]?.date).toBe('2019-06-01')
  })

  /**
   * The guard that made the old clip worth having: a series must not begin before there is anything
   * to draw. Held to by the snapshots themselves, which exist only where a rebuild wrote one.
   */
  it('never begins before the oldest snapshot it holds', () => {
    const derived = deriveWorkingSet(
      [account({ id: 'cash', type: 'depository', coverageStartDate: null })],
      balances('cash', [['2024-05-05', 100_000n]]),
      { showIncompleteHistory: true },
    )

    expect(derived.byId.get('cash')?.series[0]?.date).toBe('2024-05-05')
  })

  /** One account reaching back must not drag the others' starts with it. */
  it('leaves an account with recent coverage where it is', () => {
    const derived = deriveWorkingSet(
      [
        account({ id: 'old', type: 'depository', coverageStartDate: '2025-08-03' }),
        account({ id: 'new', type: 'credit', coverageStartDate: '2026-01-01' }),
      ],
      [
        ...balances('old', [['2019-01-02', 100_000n]]),
        ...balances('new', [['2026-01-01', -5_000n]]),
      ],
      { showIncompleteHistory: true },
    )

    expect(derived.byId.get('old')?.series[0]?.date).toBe('2019-01-02')
    expect(derived.byId.get('new')?.series[0]?.date).toBe('2026-01-01')
  })
})
