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

    it('starts net worth where every account has data, not where the first one does', () => {
      const result = deriveWorkingSet(accounts, snapshots, { to: TODAY })

      expect(result.household.map((point) => point.date)).toEqual([TODAY])
      expect(result.coverageStart).toBe(TODAY)
    })

    /**
     * The failure this prevents. Starting on 8/1 would report net worth as $1,000 for two days and
     * then $51,000 — a $50,000 gain that never happened, on the day an account was connected.
     */
    it('never reports a total that is missing an account', () => {
      const result = deriveWorkingSet(accounts, snapshots, { to: TODAY })

      for (const point of result.household) {
        expect(point.value).toBe(5_100_000n)
      }
    })

    it('says when the boundary is hiding history that exists', () => {
      expect(deriveWorkingSet(accounts, snapshots, { to: TODAY }).coverageIsLimited).toBe(true)
    })

    it('does not claim a limit when every account agrees', () => {
      const aligned = [
        account({ id: 'a', coverageStartDate: '2026-08-01' }),
        account({ id: 'b', coverageStartDate: '2026-08-01' }),
      ]
      const both = [
        ...balances('a', [['2026-08-01', 1n], [TODAY, 1n]]),
        ...balances('b', [['2026-08-01', 2n], [TODAY, 2n]]),
      ]

      expect(deriveWorkingSet(aligned, both, { to: TODAY }).coverageIsLimited).toBe(false)
    })
  })

  it('excludes closed accounts from the rollup', () => {
    const result = deriveWorkingSet(
      [account({ id: 'open' }), account({ id: 'shut', isClosed: true })],
      [...balances('open', [[TODAY, 100n]]), ...balances('shut', [[TODAY, 999_999n]])],
      { to: TODAY },
    )

    expect(result.household.at(-1)?.value).toBe(100n)
    expect(result.byId.has('shut')).toBe(false)
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
