import { sql } from 'drizzle-orm'
import {
  boolean,
  date,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { categories } from './categories.js'
import {
  bytea,
  createdAt,
  householdId,
  householdIsolationPolicy,
  primaryId,
  updatedAt,
} from './columns.js'
import { connections, institutions } from './connections.js'
import {
  accountType,
  snapshotSource,
  taxTreatment,
  transactionSource,
  transactionStatus,
} from './enums.js'
import { imports } from './imports.js'
import { households } from './tenancy.js'

/**
 * Accounts, transactions, and the daily balance series.
 */

export const accounts = pgTable(
  'accounts',
  {
    id: primaryId(),
    householdId: householdId().references(() => households.id, { onDelete: 'cascade' }),

    /** Null for manual accounts — SimpleFIN cannot see a house, a car, or a private investment. */
    connectionId: uuid('connection_id').references(() => connections.id, { onDelete: 'set null' }),
    institutionId: uuid('institution_id').references(() => institutions.id, {
      onDelete: 'set null',
    }),

    type: accountType('type').notNull(),

    /**
     * Set once the user corrects the type. Automatic classification gets some of these wrong, and
     * sync must never stomp a correction — the same guarantee `display_name` has, but it needs its
     * own flag because unlike a name, a type always has a plausible provider-supplied value.
     */
    typeIsUserSet: boolean('type_is_user_set').notNull().default(false),

    /**
     * User-editable name. **Sync must never overwrite this.** Institution names like
     * "Adv Relationship Banking" are unreadable and users rename nearly everything.
     */
    displayName: bytea('display_name'),

    /** What SimpleFIN calls it. Sync updates this freely. */
    providerName: bytea('provider_name'),

    mask: bytea('mask'),

    /** v1 assumes USD throughout and refuses to aggregate across currencies. */
    currency: text('currency').notNull().default('USD'),

    /**
     * The authoritative balance — the provider's (or user's) observation.
     *
     * `balance_snapshots` is derived *from* this, never the reverse. If the two disagree,
     * this wins and the series is recomputed (ARCHITECTURE.md §4.1).
     */
    currentBalance: bytea('current_balance'),

    /** Provided by SimpleFIN and shown on account detail. Deliberately has no snapshot equivalent. */
    availableBalance: bytea('available_balance'),

    /** When `current_balance` was observed. Explicit because manual accounts have no sync time. */
    balanceAsOf: timestamp('balance_as_of', { withTimezone: true }),

    isManual: boolean('is_manual').notNull().default(false),

    /**
     * Accounts default to shared with the household, but a member can mark one private. Private
     * accounts are excluded from household rollups and invisible to other members.
     */
    isShared: boolean('is_shared').notNull().default(true),

    isClosed: boolean('is_closed').notNull().default(false),

    taxTreatment: taxTreatment('tax_treatment').notNull().default('none'),

    /**
     * The earliest date for which this account's history is trustworthy. Returned with every
     * balance series. **Never draw a chart line to the left of it** (ARCHITECTURE.md §4.3).
     */
    coverageStartDate: date('coverage_start_date'),

    /** Once confirmed: imported data owns everything before this date, synced data everything after. */
    importCutoverDate: date('import_cutover_date'),

    /** Stable provider id. This is what re-matches accounts on reconnect instead of duplicating them. */
    simplefinAccountId: text('simplefin_account_id'),

    /**
     * Null until the user confirms this account at connection time.
     *
     * Unconfirmed accounts are excluded from every rollup. This is the safety net for sign
     * normalization: a flipped credit-card sign puts net worth off by twice the balance in a
     * plausible-looking direction, and this catches it in the one moment a human is already
     * reading the numbers (ARCHITECTURE.md §3.3).
     */
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /** Reconnect matching. Partial, because manual accounts have no provider id. */
    uniqueIndex('accounts_connection_simplefin_uq')
      .on(table.connectionId, table.simplefinAccountId)
      .where(sql`${table.simplefinAccountId} is not null`),

    index('accounts_household_idx').on(table.householdId),
    index('accounts_household_updated_at_idx').on(table.householdId, table.updatedAt),
    householdIsolationPolicy('accounts'),
  ],
).enableRLS()

export const transactions = pgTable(
  'transactions',
  {
    id: primaryId(),
    householdId: householdId().references(() => households.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),

    /**
     * The SimpleFIN transaction id, used for deduplication.
     *
     * Amounts, descriptions and pending status all change after first appearance, so sync
     * **upserts** on this rather than inserting, keeping row identity stable.
     */
    simplefinId: text('simplefin_id'),

    /**
     * `date`, not `timestamptz`. A transaction posted on the 3rd is on the 3rd regardless of
     * anyone's timezone.
     */
    postedDate: date('posted_date').notNull(),

    /** Signed so it adds directly to net worth: income positive, spending negative. */
    amount: bytea('amount').notNull(),

    description: bytea('description'),
    payee: bytea('payee'),
    memo: bytea('memo'),

    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),

    pending: boolean('pending').notNull().default(false),

    /**
     * `void` marks a pending transaction that vanished. Voided rather than deleted so delta sync
     * carries the change to clients instead of leaving them holding a row forever.
     */
    status: transactionStatus('status').notNull().default('active'),

    source: transactionSource('source').notNull().default('synced'),

    /** Set for imported rows, so an import can be reversed as a unit. */
    importId: uuid('import_id').references(() => imports.id, { onDelete: 'set null' }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /** Dedup key. Partial, because manual and imported transactions have no provider id. */
    uniqueIndex('transactions_account_simplefin_uq')
      .on(table.accountId, table.simplefinId)
      .where(sql`${table.simplefinId} is not null`),

    index('transactions_household_posted_idx').on(table.householdId, table.postedDate),
    index('transactions_account_posted_idx').on(table.accountId, table.postedDate),
    index('transactions_category_idx').on(table.categoryId),
    index('transactions_import_idx').on(table.importId),
    index('transactions_household_updated_at_idx').on(table.householdId, table.updatedAt),
    householdIsolationPolicy('transactions'),
  ],
).enableRLS()

/**
 * One row per account per day. The heart of the app.
 *
 * Derived, observed, imported and carried history all converge here into one uniform daily series,
 * so every chart reads from a single shape regardless of how the numbers were arrived at.
 *
 * This table is **derived output**, recomputable from scratch at any time. It is never edited
 * independently of the inputs that produce it (ARCHITECTURE.md §4.1).
 */
export const balanceSnapshots = pgTable(
  'balance_snapshots',
  {
    id: primaryId(),
    householdId: householdId().references(() => households.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),

    asOfDate: date('as_of_date').notNull(),
    balance: bytea('balance').notNull(),
    source: snapshotSource('source').notNull(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('balance_snapshots_account_date_uq').on(table.accountId, table.asOfDate),
    index('balance_snapshots_household_date_idx').on(table.householdId, table.asOfDate),

    /**
     * Delta sync depends on this one heavily: backward reconstruction rewrites history whenever a
     * late transaction posts, so rows change without anything being inserted.
     */
    index('balance_snapshots_household_updated_at_idx').on(table.householdId, table.updatedAt),

    householdIsolationPolicy('balance_snapshots'),
  ],
).enableRLS()

/**
 * User-entered balances for manual accounts — a house, a car, a private investment, a crypto wallet.
 *
 * Each entry becomes an `observed` snapshot at its effective date, held flat until the next entry
 * (step-function carry-forward). Manual accounts participate in net worth exactly like synced ones.
 */
export const manualBalanceUpdates = pgTable(
  'manual_balance_updates',
  {
    id: primaryId(),
    householdId: householdId().references(() => households.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),

    effectiveDate: date('effective_date').notNull(),
    balance: bytea('balance').notNull(),
    note: bytea('note'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('manual_balance_updates_account_date_uq').on(table.accountId, table.effectiveDate),
    index('manual_balance_updates_household_idx').on(table.householdId),
    householdIsolationPolicy('manual_balance_updates'),
  ],
).enableRLS()
