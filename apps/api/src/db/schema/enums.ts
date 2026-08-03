import { pgEnum } from 'drizzle-orm/pg-core'

/**
 * Every enum in the schema. Enum values are plaintext — they are needed for indexing and filtering
 * and leak very little (ARCHITECTURE.md §5).
 */

/**
 * Account type drives almost everything: which balance-history method applies, which net worth
 * section a row appears in, and whether a balance counts as an asset or a liability.
 *
 * **Assets and liabilities are classified by this, never by the sign of a balance.** An overdrawn
 * checking account has a negative balance and is still a cash asset (ARCHITECTURE.md §3.2).
 */
export const accountType = pgEnum('account_type', [
  'depository',
  'credit',
  'loan',
  'mortgage',
  'investment',
  'other_asset',
  'other_liability',
])

/**
 * Nothing in phase 1 reads this, but retirement projection (phase 5) depends on it entirely, and
 * backfilling it across years of accounts is miserable. Asked for at account creation, defaulted
 * by account type, and editable.
 */
export const taxTreatment = pgEnum('tax_treatment', [
  'taxable',
  'traditional',
  'roth',
  'hsa',
  'education',
  'none',
])

export const householdRole = pgEnum('household_role', ['owner', 'member'])

/** Sync health is a first-class feature — silent staleness is this app's worst failure mode. */
export const connectionStatus = pgEnum('connection_status', ['healthy', 'stale', 'error'])

export const syncOutcome = pgEnum('sync_outcome', ['success', 'partial', 'error'])

/**
 * How a daily balance snapshot was arrived at (ARCHITECTURE.md §4).
 *
 * - `derived`   backward reconstruction: current balance minus transactions posted after the date.
 *               Correct for cash, credit, loan and mortgage, whose balances only move on postings.
 * - `observed`  a real daily observation. Required for investment accounts, where the value moves
 *               with the market and backward reconstruction is mathematically wrong.
 * - `imported`  filled in from a CSV, covering the period before either method reaches.
 * - `carried`   last known balance held flat because the sync is broken. Kept distinct so the UI
 *               can say so rather than presenting a guess as an observation.
 */
export const snapshotSource = pgEnum('snapshot_source', [
  'derived',
  'observed',
  'imported',
  'carried',
])

export const transactionSource = pgEnum('transaction_source', ['synced', 'manual', 'imported'])

/**
 * `void` covers a pending transaction that vanished — some institutions drop a pending row or
 * repost it under a different id. Voiding rather than deleting keeps the row visible to delta sync,
 * so clients learn it disappeared instead of holding it forever.
 */
export const transactionStatus = pgEnum('transaction_status', ['active', 'void'])

export const categoryKind = pgEnum('category_kind', ['income', 'expense', 'transfer'])

export const ruleMatchType = pgEnum('rule_match_type', ['contains', 'regex'])

/**
 * `rejected` is a stored state, not an absence. A dismissed pair must stay dismissed, or the
 * matcher re-proposes it after every sync and the user learns to ignore the prompt.
 */
export const transferStatus = pgEnum('transfer_status', ['proposed', 'confirmed', 'rejected'])

export const importKind = pgEnum('import_kind', ['transactions', 'balances'])

export const importStatus = pgEnum('import_status', ['staged', 'committed', 'reversed'])

export const importRowStatus = pgEnum('import_row_status', [
  'pending',
  'imported',
  'skipped',
  'failed',
])

/** Entity types recorded in the deletion log, so delta sync can report hard deletes. */
export const deletionEntity = pgEnum('deletion_entity', [
  'account',
  'transaction',
  'balance_snapshot',
  'category',
  'category_rule',
  'transfer_match',
  'connection',
])
