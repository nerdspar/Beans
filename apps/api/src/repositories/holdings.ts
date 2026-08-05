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
    return { asOfDate: null, holdings: [], previousAsOfDate: null, previousMarketValues: {} }
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

  return { asOfDate: latest, holdings, previousAsOfDate: previous, previousMarketValues }
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
