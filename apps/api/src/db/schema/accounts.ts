import { sql } from 'drizzle-orm'
import {
  pgPolicy,
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
import { authUser } from './auth.js'
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

    /**
     * Last few digits of the account number. **Nothing populates this today.**
     *
     * SimpleFIN v1 has no such field, and neither manual creation nor the account editor asks for
     * one — so it is null on every real account, and the detail screen no longer offers a row that
     * would read "Not provided" forever. Kept because institutions that do publish the last four
     * would land here, and because the account picker already searches it.
     */
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

    /**
     * Whose account this is, for the private case.
     *
     * `is_shared` shipped without this and could not have worked: "invisible to other members" has
     * no meaning until something says which member it belongs to. Null on everything that predates
     * it, which is correct — those are all shared, and a null owner on a shared account is simply
     * unused.
     *
     * The pairing is enforced in the policy rather than by a constraint: private with no owner
     * would be an account nobody can see, and the policy resolves that to *nobody* rather than to
     * everybody. Failing closed is the only safe direction for a visibility rule.
     */
    ownerUserId: text('owner_user_id').references(() => authUser.id, { onDelete: 'set null' }),

    isClosed: boolean('is_closed').notNull().default(false),

    /**
     * When the account stopped existing. Null while it is open.
     *
     * `is_closed` alone could not answer the question the charts actually ask, which is not *is it
     * closed* but *from when*. Without a date there are only two possible behaviours, and both are
     * wrong: carry the final balance forward and a dead account sits in net worth forever, or drop
     * the account entirely and every historical point loses money the household really had at the
     * time. With a date the account holds its real balances up to it and contributes zero after —
     * correct in the past and correct today.
     */
    closedOn: date('closed_on'),

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
     * When a sync last looked at this account's response for positions.
     *
     * Set on every sync regardless of whether any arrived, which is the entire point: without it,
     * an account with no holdings rows is ambiguous between *the provider reports none* and *we
     * have not asked since the feature existed*, and those want opposite reactions from the reader.
     * The holdings themselves cannot record the second case, because the deliberate behaviour when
     * a response carries no positions is to write nothing at all.
     */
    holdingsCheckedAt: timestamp('holdings_checked_at', { withTimezone: true }),

    /**
     * Whether this provider reports the balance with the opposite sign to our convention.
     *
     * **The SimpleFIN protocol never specifies balance signs.** The only sign rule it states is for
     * transactions. Whether a credit card arrives as `-3386.39` or `3386.39` varies by institution,
     * and SimpleFIN's own author has had an open issue titled "Let me flip the sign of a single
     * account" since April 2022 — the Bridge does not normalize, and knows it.
     *
     * So this cannot be a per-type rule: the correct answer varies per institution, and SimpleFIN
     * sends no account type to key a rule on either. It is established once by a human at
     * connection confirmation and then applied to every subsequent sync.
     */
    providerSignInverted: boolean('provider_sign_inverted').notNull().default(false),

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
    /*
     * Household isolation **and** within-household visibility, in that order.
     *
     * The household clause is untouched and ANDed, which is the property that matters: nothing here
     * can widen cross-tenant access, only narrow within a tenant. A private account is visible to
     * its owner alone.
     *
     * `is_shared or owner = me` fails closed. An account marked private with no owner is visible to
     * nobody rather than to everybody — the wrong direction on a visibility rule is the one that
     * shows somebody's separate finances to the person they hid them from.
     */
    pgPolicy('accounts_household_isolation', {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: sql`household_id = nullif(current_setting('app.current_household', true), '')::uuid
                 and (is_shared or owner_user_id = nullif(current_setting('app.current_user_id', true), ''))`,
      withCheck: sql`household_id = nullif(current_setting('app.current_household', true), '')::uuid`,
    }),
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

    /**
     * The import that wrote this reading, for rows whose source is `imported`.
     *
     * Without it a balances import cannot be undone. Reversal deletes `where import_id = $1`, and a
     * snapshot with no such column would simply be missed — the undo would report success, delete
     * nothing, and leave the imported history in place. Transactions have carried this since the
     * import feature existed; balances only became importable later.
     *
     * `set null` rather than cascade: purging an old import record must not take a household's
     * balance history with it. What is lost then is the ability to undo, which the reversal window
     * had already closed on.
     */
    importId: uuid('import_id').references(() => imports.id, { onDelete: 'set null' }),

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

/**
 * Positions inside an investment account, as the provider last reported them.
 *
 * **Dated snapshots, exactly like `balance_snapshots`, and for the same reason.** A holding's value
 * is a point-in-time observation, not an event that can be replayed — so the only way to say what a
 * position did over a day is to have recorded it on both days. One row per position per date makes
 * that a lookup rather than a reconstruction, and reuses the mental model already in the codebase.
 *
 * A date with no rows for an account means the provider reported no positions that day. That is not
 * the same as the account holding nothing, and nothing downstream may render it as such — plenty of
 * institutions report a balance and no holdings at all.
 *
 * `provider_holding_id` is the provider's opaque key and stays plaintext, like
 * `accounts.simplefin_account_id`. Everything describing what is actually held — the symbol, the
 * description, the quantity, the money — is encrypted. A ticker is a statement about someone's
 * finances even without an amount beside it.
 */
export const holdings = pgTable(
  'holdings',
  {
    id: primaryId(),
    householdId: householdId().references(() => households.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),

    asOfDate: date('as_of_date').notNull(),
    providerHoldingId: text('provider_holding_id').notNull(),

    symbol: bytea('symbol'),
    description: bytea('description'),

    /**
     * A share count, encrypted as its decimal string.
     *
     * Not money and not cents: quantities are routinely fractional, there is no smallest unit to
     * normalize to, and they are never summed across positions. Carried verbatim so nothing has to
     * invent a precision the provider did not state.
     */
    shares: bytea('shares'),

    marketValue: bytea('market_value').notNull(),
    costBasis: bytea('cost_basis'),
    purchasePrice: bytea('purchase_price'),

    currency: text('currency'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('holdings_account_holding_date_uq').on(
      table.accountId,
      table.providerHoldingId,
      table.asOfDate,
    ),
    index('holdings_account_date_idx').on(table.accountId, table.asOfDate),
    index('holdings_household_updated_at_idx').on(table.householdId, table.updatedAt),

    householdIsolationPolicy('holdings'),
  ],
).enableRLS()
