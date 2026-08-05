import { parseDecimalToCents, type WorkingSetResponse } from '@beans/shared'
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

/**
 * The client working set, in IndexedDB (ARCHITECTURE.md §7).
 *
 * **The only persistent cache.** TanStack Query is an in-memory view over this — no persister
 * plugin, no second TTL. Two caching layers with independent lifetimes is where staleness bugs live.
 *
 * ## The cost, stated plainly
 *
 * This is **plaintext at rest in the browser profile**. Envelope encryption protects a stolen
 * database dump, which is the stated goal, but a decrypted household working set now also sits on
 * every device the user has signed in from. {@link clearWorkingSet} exists for that reason and must
 * be called on sign-out and on session expiry (§7.4).
 */

/**
 * Money is stored as `bigint` cents, parsed once here.
 *
 * The wire carries decimal strings; parsing at the ingest edge rather than at every read means no
 * component ever sees a money string it might be tempted to `parseFloat`. IndexedDB stores bigint
 * natively through structured clone, so nothing is lost on the way in or out.
 */
export type StoredAccount = {
  id: string
  type: string
  name: string
  institutionName: string | null
  mask: string | null
  currentBalanceCents: bigint | null
  balanceAsOf: string | null
  isManual: boolean
  isClosed: boolean
  /** The day it stopped existing. Null while open. */
  closedOn: string | null
  taxTreatment: string
  coverageStartDate: string | null
  connectionStatus: 'healthy' | 'stale' | 'error' | null
  lastSuccessAt: string | null
  consecutiveFailures: number
}

export type StoredBalance = {
  accountId: string
  asOfDate: string
  balanceCents: bigint
  source: 'derived' | 'observed' | 'imported' | 'carried'
}

export type StoredTransaction = {
  id: string
  accountId: string
  postedDate: string
  amountCents: bigint
  description: string | null
  payee: string | null
  categoryId: string | null
  pending: boolean
  status: 'active' | 'void'
}

/*
 * An interface rather than a type alias, against the usual house preference: `DBSchema` is designed
 * to be extended, and idb's generics do not accept an intersection in its place.
 */
interface BeansDB extends DBSchema {
  accounts: { key: string; value: StoredAccount }
  balances: { key: [string, string]; value: StoredBalance; indexes: { byAccount: string } }
  transactions: {
    key: string
    value: StoredTransaction
    indexes: { byAccount: string; byDate: string }
  }
  meta: { key: string; value: unknown }
}

const DB_NAME = 'beans-working-set'
const DB_VERSION = 1

let handle: Promise<IDBPDatabase<BeansDB>> | null = null

export function workingSetDb(): Promise<IDBPDatabase<BeansDB>> {
  handle ??= openDB<BeansDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      db.createObjectStore('accounts', { keyPath: 'id' })

      // Composite key, matching the server's `(account_id, as_of_date)` uniqueness. Replaying a
      // rewritten snapshot then overwrites the right row instead of accumulating duplicates.
      const balances = db.createObjectStore('balances', { keyPath: ['accountId', 'asOfDate'] })
      balances.createIndex('byAccount', 'accountId')

      const transactions = db.createObjectStore('transactions', { keyPath: 'id' })
      transactions.createIndex('byAccount', 'accountId')
      transactions.createIndex('byDate', 'postedDate')

      db.createObjectStore('meta')
    },
  })

  return handle
}

export type SyncState = {
  cursor: string | null
  coverageFrom: string | null
  /** Whose data is cached. A mismatch means the store belongs to somebody else. */
  householdId: string | null
}

/**
 * Confirmed transfer pair members, replaced wholesale on every sync.
 *
 * Stored under `meta` rather than as its own store because it is a small set that is always sent in
 * full — a client holding a stale half of a pair would count one side of a card payment as income.
 */
export async function readConfirmedTransferIds(): Promise<string[]> {
  const db = await workingSetDb()
  return ((await db.get('meta', 'confirmedTransferIds')) as string[] | undefined) ?? []
}

export type StoredCategory = {
  id: string
  slug: string
  name: string
  kind: 'income' | 'expense' | 'transfer'
  parentId: string | null
}

/** Replaced wholesale each sync, for the same reason as the transfer ids: a partial set misleads. */
export async function readCategories(): Promise<StoredCategory[]> {
  const db = await workingSetDb()
  return ((await db.get('meta', 'categories')) as StoredCategory[] | undefined) ?? []
}

export async function readSyncState(): Promise<SyncState> {
  const db = await workingSetDb()
  const [cursor, coverageFrom, householdId] = await Promise.all([
    db.get('meta', 'cursor') as Promise<string | undefined>,
    db.get('meta', 'coverageFrom') as Promise<string | undefined>,
    db.get('meta', 'householdId') as Promise<string | undefined>,
  ])

  return {
    cursor: cursor ?? null,
    coverageFrom: coverageFrom ?? null,
    householdId: householdId ?? null,
  }
}

/**
 * Applies one delta.
 *
 * Everything lands in **a single transaction across all four stores**, cursor included. A partial
 * apply that still advanced the cursor would skip the rest of that batch forever — the client would
 * hold a permanently incomplete working set and have no way to detect it.
 */
export async function applyDelta(
  response: WorkingSetResponse,
  options: { keepCursor?: boolean } = {},
): Promise<void> {
  const db = await workingSetDb()
  const tx = db.transaction(['accounts', 'balances', 'transactions', 'meta'], 'readwrite')

  const accounts = tx.objectStore('accounts')
  const balances = tx.objectStore('balances')
  const transactions = tx.objectStore('transactions')

  for (const account of response.accounts) {
    await accounts.put({
      id: account.id,
      type: account.type,
      name: account.name,
      institutionName: account.institutionName,
      mask: account.mask,
      currentBalanceCents:
        account.currentBalance === null ? null : parseDecimalToCents(account.currentBalance),
      balanceAsOf: account.balanceAsOf,
      isManual: account.isManual,
      isClosed: account.isClosed,
      closedOn: account.closedOn ?? null,
      taxTreatment: account.taxTreatment,
      coverageStartDate: account.coverageStartDate,
      connectionStatus: account.connectionStatus,
      lastSuccessAt: account.lastSuccessAt,
      consecutiveFailures: account.consecutiveFailures,
    })
  }

  for (const balance of response.balances) {
    await balances.put({
      accountId: balance.accountId,
      asOfDate: balance.asOfDate,
      balanceCents: parseDecimalToCents(balance.balance),
      source: balance.source,
    })
  }

  for (const transaction of response.transactions) {
    await transactions.put({
      id: transaction.id,
      accountId: transaction.accountId,
      postedDate: transaction.postedDate,
      amountCents: parseDecimalToCents(transaction.amount),
      description: transaction.description,
      payee: transaction.payee,
      categoryId: transaction.categoryId,
      pending: transaction.pending,
      status: transaction.status,
    })
  }

  for (const deletion of response.deletions) {
    if (deletion.entityType === 'account') {
      /*
       * Cascade by hand. The server's foreign keys removed the balances and transactions when the
       * account went, and it logs one tombstone for the account rather than thousands for its rows —
       * so a client that only deleted the account row would keep every balance and transaction
       * beneath it forever, silently inflating net worth.
       */
      await accounts.delete(deletion.entityId)

      let balanceCursor = await balances.index('byAccount').openKeyCursor(deletion.entityId)
      while (balanceCursor !== null) {
        await balances.delete(balanceCursor.primaryKey)
        balanceCursor = await balanceCursor.continue()
      }

      let txCursor = await transactions.index('byAccount').openKeyCursor(deletion.entityId)
      while (txCursor !== null) {
        await transactions.delete(txCursor.primaryKey)
        txCursor = await txCursor.continue()
      }
    } else if (deletion.entityType === 'transaction') {
      await transactions.delete(deletion.entityId)
    }
  }

  await tx.objectStore('meta').put(response.confirmedTransferIds, 'confirmedTransferIds')
  await tx.objectStore('meta').put(response.categories, 'categories')
  await tx.objectStore('meta').put(response.householdId, 'householdId')

  /*
   * A backfill widens the window; it does not advance time.
   *
   * Writing its cursor would claim an ordinary sync had happened at that moment, so anything
   * committed between the last real sync and the backfill would fall before the new cursor and
   * never be sent again — a row silently missing from the client forever.
   */
  if (options.keepCursor !== true) {
    await tx.objectStore('meta').put(response.cursor, 'cursor')
  }

  /*
   * Only ever moves earlier. A backfill reaches further back than an ordinary sync, and letting the
   * next ordinary sync write its own later `coverageFrom` would make the cache claim to hold less
   * than it does — and then refuse to backfill again because it thinks it already has that range.
   */
  const knownFrom = (await tx.objectStore('meta').get('coverageFrom')) as string | undefined
  const widest =
    knownFrom === undefined || response.coverageFrom < knownFrom ? response.coverageFrom : knownFrom

  await tx.objectStore('meta').put(widest, 'coverageFrom')

  await tx.done
}

/**
 * Empties the store.
 *
 * Called on sign-out, on session expiry, and when the server says a full resync is required. The
 * last case matters: past tombstone retention the server cannot prove what was deleted, so keeping
 * anything would mean merging fresh data into a set that may contain rows which no longer exist.
 */
export async function clearWorkingSet(): Promise<void> {
  const db = await workingSetDb()
  const tx = db.transaction(['accounts', 'balances', 'transactions', 'meta'], 'readwrite')

  await Promise.all([
    tx.objectStore('accounts').clear(),
    tx.objectStore('balances').clear(),
    tx.objectStore('transactions').clear(),
    tx.objectStore('meta').clear(),
    tx.done,
  ])
}

export async function readAll(): Promise<{
  accounts: StoredAccount[]
  balances: StoredBalance[]
  transactions: StoredTransaction[]
  confirmedTransferIds: string[]
  categories: StoredCategory[]
}> {
  const db = await workingSetDb()
  const [accounts, balances, transactions, confirmedTransferIds, categories] = await Promise.all([
    db.getAll('accounts'),
    db.getAll('balances'),
    db.getAll('transactions'),
    readConfirmedTransferIds(),
    readCategories(),
  ])
  return { accounts, balances, transactions, confirmedTransferIds, categories }
}
