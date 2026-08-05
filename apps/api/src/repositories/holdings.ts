import { centsToDecimalString, type IsoDate } from '@beans/shared'
import type { SimplefinHolding } from '../simplefin/protocol.js'
import type { HouseholdContext } from './household-context.js'

/**
 * Positions inside an investment account.
 *
 * Read and written only through a household context, like everything else here — isolation layer 1,
 * with RLS behind it as layer 2.
 *
 * **What this deliberately does not do is reconstruct.** A balance can be walked backwards through
 * transactions; a position cannot, because a share price moving is not an event anybody posts. So
 * holdings exist for exactly the dates they were observed, and a date with no rows means the
 * provider said nothing that day rather than that the account was empty.
 */

export type Holding = {
  providerHoldingId: string
  symbol: string | null
  description: string | null
  /** Verbatim from the provider. A quantity, not an amount — see the schema note. */
  shares: string | null
  /** Decimal string, like every other amount crossing the API boundary. */
  marketValue: string
  costBasis: string | null
  purchasePrice: string | null
  currency: string | null
}

export type HoldingsReading = {
  /** The date these positions were observed. Null when the account has never reported any. */
  asOfDate: IsoDate | null
  /**
   * When a sync last inspected this account for positions, whether or not it found any.
   *
   * The whole reason an empty list is readable. Null means nothing has synced since holdings
   * existed, which is a different thing from an institution that reports none — and without this
   * the screen would have to present both as the same shrug.
   */
  checkedAt: string | null
  holdings: Holding[]
  /**
   * The previous date with positions, and what they were worth then.
   *
   * Carried so a day's move can be shown per position without a second round trip. Null when there
   * is only one observation, in which case there is no move to report and none should be invented.
   */
  previousAsOfDate: IsoDate | null
  previousMarketValues: Record<string, string>
}

type HoldingRow = {
  as_of_date: IsoDate
  provider_holding_id: string
  symbol: Buffer | null
  description: Buffer | null
  shares: Buffer | null
  market_value: Buffer
  cost_basis: Buffer | null
  purchase_price: Buffer | null
  currency: string | null
}

/**
 * The latest observed positions for one account, plus the one before it.
 *
 * Two queries rather than a window function over the whole table: the set is small, and decryption
 * happens here in TypeScript regardless — `market_value` is `bytea` and cannot be ordered, filtered
 * or aggregated in SQL, so pushing cleverness into the query buys nothing.
 */
export async function readHoldings(
  context: HouseholdContext,
  accountId: string,
): Promise<HoldingsReading> {
  const checked = await context.client.query<{ holdings_checked_at: Date | null }>(
    'select holdings_checked_at from accounts where id = $1',
    [accountId],
  )
  const checkedAt = checked.rows[0]?.holdings_checked_at?.toISOString() ?? null

  const dates = await context.client.query<{ as_of_date: IsoDate }>(
    `select distinct as_of_date
       from holdings
      where account_id = $1
      order by as_of_date desc
      limit 2`,
    [accountId],
  )

  const latest = dates.rows[0]?.as_of_date ?? null
  const previous = dates.rows[1]?.as_of_date ?? null

  if (latest === null) {
    return {
      asOfDate: null,
      checkedAt,
      holdings: [],
      previousAsOfDate: null,
      previousMarketValues: {},
    }
  }

  const current = await context.client.query<HoldingRow>(
    `select as_of_date, provider_holding_id, symbol, description, shares,
            market_value, cost_basis, purchase_price, currency
       from holdings
      where account_id = $1 and as_of_date = $2`,
    [accountId, latest],
  )

  /*
   * Sorted by value, largest first — and in TypeScript, necessarily. `market_value` is encrypted, so
   * the database cannot order by it; an `order by` in the query above would sort ciphertext, which
   * is a convincing-looking arbitrary order.
   *
   * Sorted on the cents, before they become decimal strings. Comparing the strings would be sorting
   * money lexicographically, which puts $9 above $10.
   */
  const holdings = current.rows
    .map((row) => ({ cents: context.cipher.decryptMoney(row.market_value), row }))
    .sort((left, right) => (right.cents > left.cents ? 1 : right.cents < left.cents ? -1 : 0))
    .map(({ cents, row }) => toHolding(context, row, cents))

  const previousMarketValues: Record<string, string> = {}

  if (previous !== null) {
    const before = await context.client.query<{
      provider_holding_id: string
      market_value: Buffer
    }>(
      `select provider_holding_id, market_value
         from holdings
        where account_id = $1 and as_of_date = $2`,
      [accountId, previous],
    )

    for (const row of before.rows) {
      previousMarketValues[row.provider_holding_id] = centsToDecimalString(
        context.cipher.decryptMoney(row.market_value),
      )
    }
  }

  return { asOfDate: latest, checkedAt, holdings, previousAsOfDate: previous, previousMarketValues }
}

export type HouseholdHolding = Holding & {
  accountId: string
  /** What this position was worth at the previous observation. Null when it did not exist then. */
  previousMarketValue: string | null
}

export type HouseholdHoldingsReading = {
  holdings: HouseholdHolding[]
  /** The newest observation date across accounts, for dating the list once. */
  asOfDate: IsoDate | null
  /** Whether any investment account has ever been inspected for positions. */
  everChecked: boolean
}

type RankedRow = HoldingRow & { account_id: string; rnk: string }

/**
 * Every account's latest positions at once, for the portfolio-wide view.
 *
 * One query rather than a request per account: a household here has dozens of investment accounts,
 * and fanning out would make the screen's cost scale with how many institutions somebody uses.
 *
 * `dense_rank` over `as_of_date` picks each account's two newest observations independently, which
 * matters because accounts do not sync together — one may be a day behind another, and forcing a
 * single date across all of them would silently drop the laggard's positions.
 */
export async function readHouseholdHoldings(
  context: HouseholdContext,
): Promise<HouseholdHoldingsReading> {
  const checked = await context.client.query<{ any_checked: boolean }>(
    `select exists (
       select 1 from accounts
        where type = 'investment' and confirmed_at is not null and holdings_checked_at is not null
     ) as any_checked`,
  )

  const result = await context.client.query<RankedRow>(
    `with ranked as (
       select h.account_id, h.as_of_date, h.provider_holding_id, h.symbol, h.description,
              h.shares, h.market_value, h.cost_basis, h.purchase_price, h.currency,
              dense_rank() over (partition by h.account_id order by h.as_of_date desc) as rnk
         from holdings h
         join accounts a on a.id = h.account_id
        where a.confirmed_at is not null
     )
     select * from ranked where rnk <= 2`,
  )

  /*
   * Split into the newest observation and the one before it, per account.
   *
   * Done here rather than in SQL because the join back onto the previous value has to happen on
   * decrypted amounts anyway — `market_value` is `bytea`, so nothing about it can be compared or
   * carried in the query.
   */
  const previousByKey = new Map<string, bigint>()
  const currentRows: RankedRow[] = []

  for (const row of result.rows) {
    if (row.rnk === '1') {
      currentRows.push(row)
    } else {
      previousByKey.set(
        `${row.account_id}:${row.provider_holding_id}`,
        context.cipher.decryptMoney(row.market_value),
      )
    }
  }

  const holdings = currentRows
    .map((row) => ({ cents: context.cipher.decryptMoney(row.market_value), row }))
    .sort((left, right) => (right.cents > left.cents ? 1 : right.cents < left.cents ? -1 : 0))
    .map(({ cents, row }) => {
      const previous = previousByKey.get(`${row.account_id}:${row.provider_holding_id}`)
      return {
        ...toHolding(context, row, cents),
        accountId: row.account_id,
        previousMarketValue: previous === undefined ? null : centsToDecimalString(previous),
      }
    })

  const asOfDate = currentRows.reduce<IsoDate | null>(
    (latest, row) => (latest === null || row.as_of_date > latest ? row.as_of_date : latest),
    null,
  )

  return { holdings, asOfDate, everChecked: checked.rows[0]?.any_checked ?? false }
}

export type HoldingAccountSlice = {
  accountId: string
  accountName: string
  institutionName: string | null
  shares: string | null
  marketValue: string
  previousMarketValue: string | null
}

export type HoldingDetail = {
  key: string
  symbol: string | null
  description: string | null
  /** The security's total value across accounts, one point per observed date. */
  series: { date: IsoDate; value: string }[]
  accounts: HoldingAccountSlice[]
  asOfDate: IsoDate | null
  previousAsOfDate: IsoDate | null
}

type DetailRow = HoldingRow & {
  account_id: string
  display_name: Buffer | null
  provider_name: Buffer | null
  institution_name: Buffer | null
}

/**
 * One security, everywhere it is held and everything we have recorded about it.
 *
 * **Filtered in TypeScript, not in SQL, and that is forced rather than lazy.** `symbol` is
 * encrypted, so `where symbol = $1` cannot exist — there is no ciphertext to compare against that
 * would not require deterministic encryption, which leaks which rows share a symbol across the
 * whole table. So every row in the window is decrypted and matched here (ARCHITECTURE.md §3.1).
 *
 * That cost is bounded by `from`. It grows with days × positions rather than with history, which is
 * why the window exists at all — the caller passes the chart's range and nothing older is read.
 */
export async function readHoldingDetail(
  context: HouseholdContext,
  key: string,
  from: IsoDate,
): Promise<HoldingDetail> {
  const result = await context.client.query<DetailRow>(
    `select h.account_id, h.as_of_date, h.provider_holding_id, h.symbol, h.description,
            h.shares, h.market_value, h.cost_basis, h.purchase_price, h.currency,
            a.display_name, a.provider_name, i.name as institution_name
       from holdings h
       join accounts a on a.id = h.account_id
       left join institutions i on i.id = a.institution_id
      where a.confirmed_at is not null and h.as_of_date >= $1
      order by h.as_of_date`,
    [from],
  )

  const wanted = key.trim().toUpperCase()

  const matched = result.rows
    .map((row) => ({
      row,
      symbol: context.cipher.decryptTextOrNull(row.symbol),
      description: context.cipher.decryptTextOrNull(row.description),
      cents: context.cipher.decryptMoney(row.market_value),
    }))
    .filter(
      (entry) =>
        (entry.symbol ?? entry.description ?? '').trim().toUpperCase() === wanted,
    )

  if (matched.length === 0) {
    return {
      key: wanted,
      symbol: null,
      description: null,
      series: [],
      accounts: [],
      asOfDate: null,
      previousAsOfDate: null,
    }
  }

  // The security's total on each date it was observed.
  const byDate = new Map<IsoDate, bigint>()
  for (const entry of matched) {
    byDate.set(entry.row.as_of_date, (byDate.get(entry.row.as_of_date) ?? 0n) + entry.cents)
  }

  const dates = [...byDate.keys()].sort()
  const asOfDate = dates[dates.length - 1] ?? null
  const previousAsOfDate = dates[dates.length - 2] ?? null

  const previousByAccount = new Map<string, bigint>()
  if (previousAsOfDate !== null) {
    for (const entry of matched) {
      if (entry.row.as_of_date !== previousAsOfDate) continue
      previousByAccount.set(
        entry.row.account_id,
        (previousByAccount.get(entry.row.account_id) ?? 0n) + entry.cents,
      )
    }
  }

  // Largest first, sorted on the cents — comparing the decimal strings would order $9 above $10.
  const accounts = matched
    .filter((entry) => entry.row.as_of_date === asOfDate)
    .sort((left, right) => (right.cents > left.cents ? 1 : right.cents < left.cents ? -1 : 0))
    .map((entry) => {
      const previous = previousByAccount.get(entry.row.account_id)
      return {
        accountId: entry.row.account_id,
        // The user's name wins, exactly as it does everywhere else a name is shown.
        accountName:
          context.cipher.decryptTextOrNull(entry.row.display_name) ??
          context.cipher.decryptTextOrNull(entry.row.provider_name) ??
          'Account',
        institutionName: context.cipher.decryptTextOrNull(entry.row.institution_name),
        shares: context.cipher.decryptTextOrNull(entry.row.shares),
        marketValue: centsToDecimalString(entry.cents),
        previousMarketValue: previous === undefined ? null : centsToDecimalString(previous),
      }
    })

  const identity = matched[matched.length - 1]

  return {
    key: wanted,
    symbol: identity?.symbol ?? null,
    description: identity?.description ?? null,
    series: dates.map((date) => ({ date, value: centsToDecimalString(byDate.get(date) ?? 0n) })),
    accounts,
    asOfDate,
    previousAsOfDate,
  }
}

/**
 * Replaces one account's positions for a single date.
 *
 * Delete-then-insert rather than upsert, because a position that was *sold* has to disappear. An
 * upsert would leave the sold holding sitting at its last known value forever, and the account's
 * positions would slowly stop adding up to its balance.
 *
 * Scoped to the one date so history is untouched: yesterday's observation is a record of what was
 * true yesterday and is never revised by what arrives today.
 */
export async function replaceHoldings(
  context: HouseholdContext,
  accountId: string,
  asOfDate: IsoDate,
  holdings: readonly SimplefinHolding[],
): Promise<number> {
  await context.client.query('delete from holdings where account_id = $1 and as_of_date = $2', [
    accountId,
    asOfDate,
  ])

  for (const holding of holdings) {
    await context.client.query(
      `insert into holdings
         (household_id, account_id, as_of_date, provider_holding_id,
          symbol, description, shares, market_value, cost_basis, purchase_price, currency)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        context.householdId,
        accountId,
        asOfDate,
        holding.id,
        context.cipher.encryptTextOrNull(holding.symbol),
        context.cipher.encryptTextOrNull(holding.description),
        context.cipher.encryptTextOrNull(holding.shares),
        context.cipher.encryptMoney(holding.marketValueCents),
        context.cipher.encryptMoneyOrNull(holding.costBasisCents),
        context.cipher.encryptMoneyOrNull(holding.purchasePriceCents),
        holding.currency,
      ],
    )
  }

  return holdings.length
}

function toHolding(context: HouseholdContext, row: HoldingRow, marketValueCents: bigint): Holding {
  return {
    providerHoldingId: row.provider_holding_id,
    symbol: context.cipher.decryptTextOrNull(row.symbol),
    description: context.cipher.decryptTextOrNull(row.description),
    shares: context.cipher.decryptTextOrNull(row.shares),
    marketValue: centsToDecimalString(marketValueCents),
    costBasis: nullableMoney(context, row.cost_basis),
    purchasePrice: nullableMoney(context, row.purchase_price),
    currency: row.currency,
  }
}

function nullableMoney(context: HouseholdContext, sealed: Buffer | null): string | null {
  const cents = context.cipher.decryptMoneyOrNull(sealed)
  return cents === null ? null : centsToDecimalString(cents)
}

/**
 * Records that a sync looked, whatever it found.
 *
 * Separate from writing the positions themselves because the interesting case is the one where
 * there were none: an empty response writes no holdings by design, so nothing else in the data
 * would distinguish it from an account that has never been synced.
 */
export async function markHoldingsChecked(
  context: HouseholdContext,
  accountId: string,
  at: Date,
): Promise<void> {
  await context.client.query('update accounts set holdings_checked_at = $1 where id = $2', [
    at,
    accountId,
  ])
}
