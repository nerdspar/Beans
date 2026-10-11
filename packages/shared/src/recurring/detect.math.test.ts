import { describe, expect, it } from 'vitest'
import { addDays } from '../balance-history/dates.js'
import { addMonths, detectRecurring, type RecurringTransaction } from './detect.js'

/**
 * Recurring charges, found from history alone.
 *
 * Fixtures are fixed dates and shaped after what banks actually send: a phone number that rotates,
 * a weekend that moves a charge a day, a price rise, a merchant that bills three things under one
 * name. `TODAY` is passed in, never read.
 */

const TODAY = '2026-10-10'
const NONE = new Set<string>()

let sequence = 0
function charge(
  postedDate: string,
  amountCents: bigint,
  description: string,
  extra: Partial<RecurringTransaction> = {},
): RecurringTransaction {
  sequence += 1
  return {
    id: `t${String(sequence).padStart(4, '0')}`,
    accountId: 'card',
    postedDate,
    amountCents,
    description,
    payee: null,
    pending: false,
    status: 'active',
    ...extra,
  }
}

/** One charge a month on `day`, for `count` months ending in September 2026. */
function monthly(
  count: number,
  day: number,
  amountCents: bigint | ((index: number) => bigint),
  description: string | ((index: number) => string),
  extra: Partial<RecurringTransaction> = {},
): RecurringTransaction[] {
  return Array.from({ length: count }, (_, index) => {
    const date = addMonths(`2026-09-${String(day).padStart(2, '0')}`, index - (count - 1))
    return charge(
      date,
      typeof amountCents === 'function' ? amountCents(index) : amountCents,
      typeof description === 'function' ? description(index) : description,
      extra,
    )
  })
}

const detect = (transactions: RecurringTransaction[], decisions?: Map<string, never>) =>
  detectRecurring(transactions, {
    today: TODAY,
    confirmedTransferIds: NONE,
    ...(decisions === undefined ? {} : { decisions }),
  })

describe('detectRecurring', () => {
  it('finds a monthly subscription whose description changes every month', () => {
    const phones = ['866-579-7172', '866-716-0414', '844-505-2993']
    const [series, ...rest] = detect(
      monthly(6, 14, -1_549n, (index) => `NETFLIX.COM ${phones[index % 3]} CA`),
    )

    expect(rest).toHaveLength(0)
    expect(series).toMatchObject({
      key: 'netflix.com',
      kind: 'subscription',
      cadence: 'monthly',
      amountCents: -1_549n,
      annualCents: -18_588n,
      lastDate: '2026-09-14',
      nextDate: '2026-10-14',
      status: 'active',
      priceChange: null,
    })
  })

  it('tolerates a charge pushed a few days by a weekend', () => {
    const transactions = monthly(6, 1, -999n, 'SPOTIFY USA')
    transactions[2] = { ...transactions[2]!, postedDate: '2026-06-03' }
    expect(detect(transactions)).toHaveLength(1)
  })

  it('reports a price change and charges the new price', () => {
    const [series] = detect(
      monthly(8, 14, (index) => (index < 5 ? -1_549n : -1_799n), 'NETFLIX.COM'),
    )

    expect(series?.kind).toBe('subscription')
    expect(series?.amountCents).toBe(-1_799n)
    expect(series?.priceChange).toEqual({ fromCents: -1_549n, toCents: -1_799n, on: '2026-07-14' })
  })

  it('separates several subscriptions billed under one merchant name', () => {
    const transactions = [
      ...monthly(5, 3, -299n, 'APPLE.COM/BILL 866-712-7753 CA'),
      ...monthly(5, 9, -999n, 'APPLE.COM/BILL 866-712-7753 CA'),
      ...monthly(5, 21, -699n, 'APPLE.COM/BILL 866-712-7753 CA'),
    ]

    const found = detect(transactions)
    expect(found.map((series) => series.key).sort()).toEqual([
      'apple.com@-299',
      'apple.com@-699',
      'apple.com@-999',
    ])
    expect(found.every((series) => series.label === 'Apple.com')).toBe(true)
  })

  it('finds Prime among one-off orders from the same merchant', () => {
    const orders = [
      charge('2026-04-02', -2_317n, 'AMAZON MKTPL'),
      charge('2026-04-19', -4_588n, 'AMAZON MKTPL'),
      charge('2026-06-07', -1_204n, 'AMAZON MKTPL'),
      charge('2026-07-30', -8_999n, 'AMAZON MKTPL'),
    ]
    const prime = monthly(6, 11, -1_499n, 'AMAZON MKTPL')

    const found = detect([...orders, ...prime])
    expect(found).toHaveLength(1)
    expect(found[0]?.key).toBe('amazon mktpl@-1499')
  })

  it('reports an annual plan from two charges', () => {
    const [series] = detect([
      charge('2024-11-02', -9_900n, 'ADOBE *ACROPRO'),
      charge('2025-11-03', -9_900n, 'ADOBE *ACROPRO'),
    ])

    expect(series).toMatchObject({
      cadence: 'annual',
      annualCents: -9_900n,
      nextDate: '2026-11-03',
    })
  })

  it('calls a variable monthly amount a bill and reports its median', () => {
    const amounts = [-8_412n, -9_655n, -14_301n, -16_870n, -12_044n, -9_120n]
    const [series] = detect(monthly(6, 22, (index) => amounts[index]!, 'PG&E WEB ONLINE'))

    expect(series?.kind).toBe('bill')
    expect(series?.priceChange).toBeNull()
    // Median of 8412, 9120, 9655, 12044, 14301, 16870 → (9655 + 12044) / 2.
    expect(series?.amountCents).toBe(-10_849n)
  })

  it('calls a large fixed payment a bill, not a subscription', () => {
    const [series] = detect(monthly(6, 1, -240_000n, 'OAKWOOD PROPERTY MGMT'))
    expect(series?.kind).toBe('bill')
  })

  it('takes a bill category over the amount', () => {
    const [series] = detect(
      monthly(6, 5, -8_900n, 'STATE FARM INSURANCE', { categorySlug: 'insurance' }),
    )
    expect(series?.kind).toBe('bill')
  })

  it('does not call a weekly grocery run a bill', () => {
    const groceries = Array.from({ length: 12 }, (_, index) =>
      charge(
        addDays('2026-07-04', index * 7),
        -(8_000n + BigInt(index) * 731n),
        'TRADER JOE S #552',
        { categorySlug: 'food-groceries' },
      ),
    )
    expect(detect(groceries)).toEqual([])
  })

  it('ignores an irregular merchant', () => {
    expect(
      detect([
        charge('2026-02-11', -1_200n, 'BLUE BOTTLE'),
        charge('2026-02-19', -1_200n, 'BLUE BOTTLE'),
        charge('2026-04-30', -1_200n, 'BLUE BOTTLE'),
        charge('2026-05-02', -1_200n, 'BLUE BOTTLE'),
      ]),
    ).toEqual([])
  })

  it('needs three monthly charges, not two', () => {
    expect(detect(monthly(2, 14, -1_549n, 'NETFLIX.COM'))).toEqual([])
  })

  it('marks a series lapsed once a charge is well overdue', () => {
    // Last charge in June; July's was due a quarter of a year ago.
    const [series] = detect(
      monthly(6, 14, -1_099n, 'HULU').map((entry) => ({
        ...entry,
        postedDate: addMonths(entry.postedDate, -3),
      })),
    )
    expect(series?.status).toBe('lapsed')
    expect(series?.lastDate).toBe('2026-06-14')
  })

  it('stays active while the next charge is only a little late', () => {
    // Last was 14 September, so the next is due 14 October — not yet.
    expect(detect(monthly(6, 14, -1_099n, 'HULU'))[0]?.status).toBe('active')
    // Last was 25 August, due 25 September — fifteen days late is within half a month.
    const late = detect(
      monthly(6, 25, -1_099n, 'HULU').map((entry) => ({
        ...entry,
        postedDate: addMonths(entry.postedDate, -1),
      })),
    )
    expect(late[0]?.status).toBe('active')
  })

  it('leaves out refunds, pending charges and voided charges', () => {
    const transactions = [
      ...monthly(3, 14, -1_549n, 'NETFLIX.COM', { pending: true }),
      ...monthly(3, 15, -1_549n, 'NETFLIX.COM', { status: 'void' }),
      ...monthly(3, 16, 1_549n, 'NETFLIX.COM'),
    ]
    expect(detect(transactions)).toEqual([])
  })

  it('never reports a card payment, which recurs monthly but is a transfer', () => {
    const payments = monthly(6, 20, -150_000n, 'CHASE CREDIT CRD AUTOPAY')
    const confirmed = new Set(payments.map((entry) => entry.id))

    expect(detectRecurring(payments, { today: TODAY, confirmedTransferIds: confirmed })).toEqual([])
    expect(
      detect(payments.map((entry) => ({ ...entry, categoryKind: 'transfer' as const }))),
    ).toEqual([])
  })

  it('applies a decision to move a series or hide it', () => {
    const transactions = [
      ...monthly(6, 14, -1_549n, 'NETFLIX.COM'),
      ...monthly(6, 1, -240_000n, 'OAKWOOD PROPERTY MGMT'),
    ]
    const decisions = new Map([
      ['netflix.com', 'bill'],
      ['oakwood property mgmt', 'ignored'],
    ] as const)

    const found = detectRecurring(transactions, {
      today: TODAY,
      confirmedTransferIds: NONE,
      decisions,
    })
    const netflix = found.find((series) => series.key === 'netflix.com')
    const rent = found.find((series) => series.key === 'oakwood property mgmt')

    expect(netflix).toMatchObject({ detectedKind: 'subscription', kind: 'bill', decision: 'bill' })
    // Hidden series are still returned, so the screen can offer to bring one back.
    expect(rent?.decision).toBe('ignored')
  })

  it('keeps amounts negative and lists the largest yearly cost first', () => {
    const found = detect([
      ...monthly(6, 14, -1_549n, 'NETFLIX.COM'),
      ...monthly(6, 3, -299n, 'ICLOUD'),
      ...monthly(6, 7, -6_500n, 'EQUINOX'),
    ])
    expect(found.map((series) => series.label)).toEqual(['Equinox', 'Netflix.com', 'Icloud'])
    expect(found.every((series) => series.amountCents < 0n && series.annualCents < 0n)).toBe(true)
  })
})

describe('addMonths', () => {
  it('clamps to the end of a shorter month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29')
  })

  it('crosses a year in both directions', () => {
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15')
    expect(addMonths('2026-02-15', -3)).toBe('2025-11-15')
  })
})
