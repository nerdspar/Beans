import {
  centsToDecimalString,
  CURSOR_OVERLAP_SECONDS,
  DEFAULT_WINDOW_DAYS,
  TOMBSTONE_RETENTION_DAYS,
  type Deletion,
  type WorkingSetAccount,
  type WorkingSetBalance,
  type WorkingSetResponse,
  type WorkingSetTransaction,
} from '@beans/shared'
import { listCategories } from './categories.js'
import { confirmedPairMembers } from './transfers.js'
import type { HouseholdContext } from './household-context.js'

/**
 * The one read path for financial data.
 *
 * Answers "everything that changed since cursor X", never "page N" (ARCHITECTURE.md §7.2). The
 * client keeps this in IndexedDB and derives net worth, sections, series, search and filtering
 * locally — it has to, because the amounts and descriptions here are ciphertext in Postgres and
 * cannot be summed, sorted or searched by it.
 *
 * Every function takes a {@link HouseholdContext}. There is no unscoped path, and RLS runs
 * underneath regardless.
 */

export type WorkingSetQuery = {
  /** ISO instant from the client's last sync. Null or absent means a first, full load. */
  cursor: string | null
  /** Earliest date to include. Defaults to the two-year window. */
  from?: string | null
  /** Injected so tests are not at the mercy of the wall clock. */
  now?: Date
}

/**
 * Decrypts a nullable encrypted column, tolerating a null.
 *
 * `bytea` columns come back as `Buffer | null`; every optional encrypted field needs the same
 * three lines and getting one of them wrong means either a crash on a null or a `"null"` string
 * reaching the client.
 */
function textOrNull(context: HouseholdContext, value: Buffer | null): string | null {
  return value === null ? null : context.cipher.decryptText(value)
}

function moneyOrNull(context: HouseholdContext, value: Buffer | null): string | null {
  return value === null ? null : centsToDecimalString(context.cipher.decryptMoney(value))
}

export async function readWorkingSet(
  context: HouseholdContext,
  query: WorkingSetQuery,
): Promise<WorkingSetResponse> {
  const now = query.now ?? new Date()

  /*
   * Read the cursor for the *next* sync before doing any of the reads, not after.
   *
   * Taken afterwards, anything committed while these queries run would fall before the new cursor
   * and never be sent again — a row silently missing from the client forever. Taken first, the worst
   * case is re-sending a row the client already has, which its upsert absorbs.
   */
  const nextCursor = new Date(now.getTime() - CURSOR_OVERLAP_SECONDS * 1000).toISOString()

  const coverageFrom =
    query.from ?? isoDateOf(new Date(now.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000))

  /*
   * A cursor older than tombstone retention cannot be served: the rows proving what was deleted have
   * been reaped, so any delta built from it would be silently incomplete — the client would keep
   * showing accounts and transactions that no longer exist, with no way to ever learn otherwise.
   * Saying "resync" is the only honest answer (§7.3).
   */
  if (query.cursor !== null && isBeyondRetention(query.cursor, now)) {
    return {
      cursor: nextCursor,
      fullResyncRequired: true,
      coverageFrom,
      householdId: context.householdId,
      confirmedTransferIds: [],
      categories: [],
      accounts: [],
      balances: [],
      transactions: [],
      deletions: [],
    }
  }

  /*
   * Sequential, deliberately. These four share one `PoolClient` — the transaction's — and a single
   * connection cannot run queries concurrently: node-postgres serializes them anyway and warns that
   * it will stop doing so in pg@9. `Promise.all` here buys nothing and breaks later.
   */
  const since = query.cursor
  const accounts = await readAccounts(context, since)
  const balances = await readBalances(context, since, coverageFrom)
  const transactions = await readTransactions(context, since, coverageFrom)
  const deletions = await readDeletions(context, since)
  // Always sent in full, never filtered by cursor: a client holding half of a pair would exclude one
  // side of a card payment and count the other as income.
  const confirmedTransferIds = await confirmedPairMembers(context)
  // Also sent in full: a partial set would render categorized transactions as uncategorized.
  const categories = (await listCategories(context)).map((category) => ({
    id: category.id,
    slug: category.slug,
    name: category.name,
    kind: category.kind,
    parentId: category.parentId,
  }))

  return {
    cursor: nextCursor,
    fullResyncRequired: false,
    coverageFrom,
    householdId: context.householdId,
    confirmedTransferIds,
    categories,
    accounts,
    balances,
    transactions,
    deletions,
  }
}

function isoDateOf(value: Date): string {
  return value.toISOString().slice(0, 10)
}

function isBeyondRetention(cursor: string, now: Date): boolean {
  const age = now.getTime() - Date.parse(cursor)
  return age > TOMBSTONE_RETENTION_DAYS * 86_400_000
}

type AccountRow = {
  id: string
  type: WorkingSetAccount['type']
  display_name: Buffer | null
  provider_name: Buffer | null
  institution_name: Buffer | null
  mask: Buffer | null
  currency: string
  current_balance: Buffer | null
  available_balance: Buffer | null
  balance_as_of: Date | null
  is_manual: boolean
  is_closed: boolean
  closed_on: string | null
  tax_treatment: string
  coverage_start_date: string | null
  connection_status: WorkingSetAccount['connectionStatus']
  last_success_at: Date | null
  consecutive_failures: number | null
}

async function readAccounts(
  context: HouseholdContext,
  since: string | null,
): Promise<WorkingSetAccount[]> {
  /*
   * `confirmed_at is not null` is load-bearing, not hygiene. An unconfirmed account has not had its
   * balance sign checked by a human, and a credit card whose sign is inverted moves net worth by
   * twice its balance in a plausible-looking direction (ARCHITECTURE.md §3.3). Excluding them here
   * means the client cannot render one by accident.
   *
   * The connection is joined rather than sent as its own collection: the client needs status per row
   * to draw the dot, and nothing else about a connection is its business. `access_url` is not
   * selected — not here, not anywhere that reaches a response.
   */
  const result = await context.client.query<AccountRow>(
    `select a.id,
            a.type,
            a.display_name,
            a.provider_name,
            i.name as institution_name,
            a.mask,
            a.currency,
            a.current_balance,
            a.available_balance,
            a.balance_as_of,
            a.is_manual,
            a.is_closed,
            a.closed_on,
            a.tax_treatment,
            a.coverage_start_date,
            c.status as connection_status,
            c.last_success_at,
            c.consecutive_failures
       from accounts a
       left join connections c on c.id = a.connection_id
       left join institutions i on i.id = a.institution_id
      where a.confirmed_at is not null
        and ($1::timestamptz is null or a.updated_at >= $1::timestamptz)
      -- Ordered by id as well as created_at. Accounts imported in one transaction share a
      -- created_at to the microsecond, and without a tiebreaker Postgres may return them in a
      -- different order every time, which reaches the user as rows that shuffle between refreshes.
      order by a.created_at, a.id`,
    [since],
  )

  return result.rows.map((row) => ({
    id: row.id,
    type: row.type,
    // The user's name wins whenever they set one. Sync never overwrites `display_name`, so falling
    // back to the provider's only ever happens for an account nobody has renamed.
    name:
      textOrNull(context, row.display_name) ?? textOrNull(context, row.provider_name) ?? 'Account',
    institutionName: textOrNull(context, row.institution_name),
    mask: textOrNull(context, row.mask),
    currency: row.currency,
    currentBalance: moneyOrNull(context, row.current_balance),
    availableBalance: moneyOrNull(context, row.available_balance),
    balanceAsOf: row.balance_as_of?.toISOString() ?? null,
    isManual: row.is_manual,
    isClosed: row.is_closed,
    closedOn: row.closed_on,
    taxTreatment: row.tax_treatment,
    coverageStartDate: row.coverage_start_date,
    connectionStatus: row.connection_status,
    lastSuccessAt: row.last_success_at?.toISOString() ?? null,
    consecutiveFailures: row.consecutive_failures ?? 0,
  }))
}

async function readBalances(
  context: HouseholdContext,
  since: string | null,
  from: string,
): Promise<WorkingSetBalance[]> {
  const result = await context.client.query<{
    account_id: string
    as_of_date: string
    balance: Buffer
    source: WorkingSetBalance['source']
  }>(
    `select s.account_id, s.as_of_date, s.balance, s.source
       from balance_snapshots s
       join accounts a on a.id = s.account_id
      where a.confirmed_at is not null
        and s.as_of_date >= $2::date
        and ($1::timestamptz is null or s.updated_at >= $1::timestamptz)
      order by s.as_of_date`,
    [since, from],
  )

  return result.rows.map((row) => ({
    accountId: row.account_id,
    asOfDate: row.as_of_date,
    balance: centsToDecimalString(context.cipher.decryptMoney(row.balance)),
    source: row.source,
  }))
}

async function readTransactions(
  context: HouseholdContext,
  since: string | null,
  from: string,
): Promise<WorkingSetTransaction[]> {
  /*
   * Voided rows are included on purpose. A pending transaction that vanished is exactly the change
   * the client most needs to hear about — filtering it out here would leave the row cached forever
   * with no event that could ever remove it.
   */
  const result = await context.client.query<{
    id: string
    account_id: string
    posted_date: string
    amount: Buffer
    description: Buffer | null
    payee: Buffer | null
    category_id: string | null
    pending: boolean
    status: WorkingSetTransaction['status']
  }>(
    `select t.id, t.account_id, t.posted_date, t.amount, t.description, t.payee,
            t.category_id, t.pending, t.status
       from transactions t
       join accounts a on a.id = t.account_id
      where a.confirmed_at is not null
        and t.posted_date >= $2::date
        and ($1::timestamptz is null or t.updated_at >= $1::timestamptz)
      order by t.posted_date desc`,
    [since, from],
  )

  return result.rows.map((row) => ({
    id: row.id,
    accountId: row.account_id,
    postedDate: row.posted_date,
    amount: centsToDecimalString(context.cipher.decryptMoney(row.amount)),
    description: textOrNull(context, row.description),
    payee: textOrNull(context, row.payee),
    categoryId: row.category_id,
    pending: row.pending,
    status: row.status,
  }))
}

async function readDeletions(
  context: HouseholdContext,
  since: string | null,
): Promise<Deletion[]> {
  // A first sync has nothing cached, so there is nothing for a tombstone to remove.
  if (since === null) return []

  const result = await context.client.query<{
    entity_type: Deletion['entityType']
    entity_id: string
  }>(
    `select entity_type, entity_id
       from deletions
      where deleted_at >= $1::timestamptz
      order by deleted_at`,
    [since],
  )

  return result.rows.map((row) => ({ entityType: row.entity_type, entityId: row.entity_id }))
}
