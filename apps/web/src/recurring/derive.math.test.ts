import { addMonths } from '@beans/shared'
import { describe, expect, it } from 'vitest'
import type { StoredCategory, StoredTransaction } from '../working-set/db.js'
import { buildRecurringView } from './derive.js'

/**
 * Feeding the working set to the detector and splitting what comes back.
 *
 * Detection has its own tests in `@beans/shared`. These cover what this layer adds: categories
 * joined on, decisions applied, hidden series set aside, and totals that count only what is active.
 */

const TODAY = '2026-10-10'

const CATEGORIES = new Map<string, StoredCategory>([
  [
    'cat-transfers',
    { id: 'cat-transfers', slug: 'transfers', name: 'Transfers', kind: 'transfer', parentId: null },
  ],
  [
    'cat-insurance',
    { id: 'cat-insurance', slug: 'insurance', name: 'Insurance', kind: 'expense', parentId: null },
  ],
])

let sequence = 0
function monthly(
  count: number,
  lastDate: string,
  amountCents: bigint,
  description: string,
  categoryId: string | null = null,
): StoredTransaction[] {
  return Array.from({ length: count }, (_, index) => {
    sequence += 1
    return {
      id: `t${sequence}`,
      accountId: 'card',
      postedDate: addMonths(lastDate, index - (count - 1)),
      amountCents,
      description,
      payee: null,
      categoryId,
      pending: false,
      status: 'active' as const,
    }
  })
}

const view = (
  transactions: StoredTransaction[],
  decisions: {
    id: string
    merchantKey: string
    decision: 'subscription' | 'bill' | 'ignored'
  }[] = [],
) =>
  buildRecurringView({
    transactions,
    categories: CATEGORIES,
    confirmedTransferIds: new Set(),
    decisions,
    today: TODAY,
  })

describe('buildRecurringView', () => {
  it('splits subscriptions from bills and totals each over a year', () => {
    const result = view([
      ...monthly(6, '2026-09-14', -1_549n, 'NETFLIX.COM'),
      ...monthly(6, '2026-09-05', -8_900n, 'STATE FARM', 'cat-insurance'),
    ])

    expect(result.subscriptions.map((series) => series.key)).toEqual(['netflix.com'])
    // The insurance category makes it a bill despite a fixed, modest amount.
    expect(result.bills.map((series) => series.key)).toEqual(['state farm'])
    expect(result.subscriptionsAnnualCents).toBe(-18_588n)
    expect(result.billsAnnualCents).toBe(-106_800n)
    expect(result.activeSubscriptions).toBe(1)
  })

  it('leaves a lapsed subscription out of the total and lists it after the active ones', () => {
    const result = view([
      ...monthly(6, '2026-09-14', -1_549n, 'NETFLIX.COM'),
      ...monthly(6, '2026-03-02', -6_500n, 'EQUINOX'),
    ])

    expect(result.subscriptions.map((series) => [series.key, series.status])).toEqual([
      ['netflix.com', 'active'],
      ['equinox', 'lapsed'],
    ])
    expect(result.subscriptionsAnnualCents).toBe(-18_588n)
    expect(result.activeSubscriptions).toBe(1)
  })

  it('never lists a payment categorized as a transfer', () => {
    expect(
      view(monthly(6, '2026-09-20', -150_000n, 'CHASE AUTOPAY', 'cat-transfers')),
    ).toMatchObject({
      subscriptions: [],
      bills: [],
    })
  })

  it('sets hidden series aside, out of every total', () => {
    const result = view(monthly(6, '2026-09-14', -1_549n, 'NETFLIX.COM'), [
      { id: 'd1', merchantKey: 'netflix.com', decision: 'ignored' },
    ])

    expect(result.subscriptions).toEqual([])
    expect(result.hidden.map((series) => series.key)).toEqual(['netflix.com'])
    expect(result.subscriptionsAnnualCents).toBe(0n)
    expect(result.decisionIds.get('netflix.com')).toBe('d1')
  })

  it('lets the latest of two decisions for one series win', () => {
    // Two rows can exist after a race between devices; the server sends them oldest first.
    const result = view(monthly(6, '2026-09-14', -1_549n, 'NETFLIX.COM'), [
      { id: 'old', merchantKey: 'netflix.com', decision: 'ignored' },
      { id: 'new', merchantKey: 'netflix.com', decision: 'bill' },
    ])

    expect(result.bills.map((series) => series.key)).toEqual(['netflix.com'])
    expect(result.decisionIds.get('netflix.com')).toBe('new')
  })
})
