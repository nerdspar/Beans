import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { accounts, transactions } from './accounts.js'
import { authUser } from './auth.js'
import { categories } from './categories.js'
import {
  bytea,
  createdAt,
  householdId,
  householdIsolationPolicy,
  primaryId,
  updatedAt,
} from './columns.js'
import { keywordMode, ruleMatchType, transferStatus } from './enums.js'
import { households } from './tenancy.js'

/**
 * Auto-categorization rules and confirmed transfer pairs.
 */

/**
 * Rules that assign a category to matching transactions.
 *
 * **The match text and amounts are encrypted.** They look like configuration, but a rule set is
 * literally merchant and payee names lifted from the household's transactions — it reads as a list
 * of where they shop, bank, and send their kids to school. Rules are loaded wholesale per household
 * and evaluated in Node anyway, so plaintext would buy no SQL-side benefit.
 */
export const categoryRules = pgTable(
  'category_rules',
  {
    id: primaryId(),
    householdId: householdId().references(() => households.id, { onDelete: 'cascade' }),

    /** Lower runs first. Ties broken by creation order. */
    priority: integer('priority').notNull().default(0),
    enabled: boolean('enabled').notNull().default(true),

    /**
     * The original single-term field, kept for rules written before keywords existed.
     *
     * Not migrated into `match_keywords` by SQL, because it is **encrypted** — the database cannot
     * read it to transform it (ARCHITECTURE.md §3.1). The repository folds it into the keyword list
     * on read instead, and nothing writes it any more.
     */
    matchDescription: bytea('match_description'),

    /** Encrypted JSON array of terms. Combined per `keyword_mode`. */
    matchKeywords: bytea('match_keywords'),
    keywordMode: keywordMode('keyword_mode').notNull().default('any'),

    matchType: ruleMatchType('match_type').notNull().default('contains'),

    /** Signed integer cents, encrypted like any other amount. */
    matchAmountMin: bytea('match_amount_min'),
    matchAmountMax: bytea('match_amount_max'),

    /** Optional narrowing to one account. */
    matchAccountId: uuid('match_account_id').references(() => accounts.id, { onDelete: 'cascade' }),

    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('category_rules_household_priority_idx').on(table.householdId, table.priority),
    index('category_rules_household_updated_at_idx').on(table.householdId, table.updatedAt),
    householdIsolationPolicy('category_rules'),
  ],
).enableRLS()

/**
 * A proposed or confirmed transfer between two household accounts.
 *
 * Transfers must be detectable and excludable or cash flow is nonsense. A transfer to an account
 * Beans doesn't track stays an ordinary transaction with the built-in Transfers category and forms
 * no pair.
 *
 * **Mortgage payments are not transfers.** A payment leaves checking as one amount but reduces the
 * mortgage by only the principal portion; the rest is interest, a real expense. The amounts
 * therefore don't match and the matcher correctly declines to pair them — that is load-bearing, not
 * accidental. Do not fuzzy-match amounts across a liability boundary (ARCHITECTURE.md §9.1).
 */
export const transferMatches = pgTable(
  'transfer_matches',
  {
    id: primaryId(),
    householdId: householdId().references(() => households.id, { onDelete: 'cascade' }),

    /** Always the outflow (negative amount). */
    fromTransactionId: uuid('from_transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),

    /** Always the inflow (positive amount). */
    toTransactionId: uuid('to_transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),

    /**
     * Canonical key over the ordered pair.
     *
     * This is what makes `rejected` **sticky**: a dismissed pair remains a row, so the matcher
     * cannot re-propose it after every sync. Without it the user learns to ignore the prompt.
     */
    pairKey: text('pair_key').notNull(),

    status: transferStatus('status').notNull().default('proposed'),

    /** Matcher score, 0–100. An integer because it is a ranking, not money. */
    confidence: integer('confidence').notNull().default(0),

    confirmedByUserId: text('confirmed_by_user_id').references(() => authUser.id, {
      onDelete: 'set null',
    }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('transfer_matches_household_pair_uq').on(table.householdId, table.pairKey),

    /**
     * A transaction belongs to at most one confirmed pair.
     *
     * These two partial indexes are *sufficient*, not merely convenient: `from` is always the
     * outflow and `to` always the inflow, enforced at insert. A transaction has one sign, so it can
     * never be `from` in one pair and `to` in another. The cross case is impossible by construction.
     */
    uniqueIndex('transfer_matches_from_confirmed_uq')
      .on(table.fromTransactionId)
      .where(sql`${table.status} = 'confirmed'`),
    uniqueIndex('transfer_matches_to_confirmed_uq')
      .on(table.toTransactionId)
      .where(sql`${table.status} = 'confirmed'`),

    index('transfer_matches_household_updated_at_idx').on(table.householdId, table.updatedAt),
    householdIsolationPolicy('transfer_matches'),
  ],
).enableRLS()
