import { index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { accounts, transactions } from './accounts.js'
import {
  bytea,
  createdAt,
  householdId,
  householdIsolationPolicy,
  primaryId,
  updatedAt,
} from './columns.js'
import { importRowStatus } from './enums.js'
import { imports } from './imports.js'
import { households } from './tenancy.js'

/**
 * A single staged row from a CSV import.
 *
 * Nothing touches the real tables until the user has previewed what will happen. Both the raw and
 * parsed payloads are encrypted — they are transaction data in every respect except that they
 * haven't been committed yet.
 *
 * Purged 30 days after commit (see `imports.reversible_until`), which is why the header row keeps
 * its own counts.
 */
export const importRows = pgTable(
  'import_rows',
  {
    id: primaryId(),
    householdId: householdId().references(() => households.id, { onDelete: 'cascade' }),
    importId: uuid('import_id')
      .notNull()
      .references(() => imports.id, { onDelete: 'cascade' }),

    rowNumber: integer('row_number').notNull(),

    /** The original cells, encrypted. Kept so a mapping mistake can be diagnosed after the fact. */
    raw: bytea('raw'),

    /** The interpreted row under the current mapping, encrypted. */
    parsed: bytea('parsed'),

    targetAccountId: uuid('target_account_id').references(() => accounts.id, {
      onDelete: 'set null',
    }),

    status: importRowStatus('status').notNull().default('pending'),

    /** Why a row was skipped or failed. Plaintext: it describes the mapping, not the data. */
    statusReason: text('status_reason'),

    /** Set on commit, so a reversal knows exactly what it created. */
    resultTransactionId: uuid('result_transaction_id').references(() => transactions.id, {
      onDelete: 'set null',
    }),

    /**
     * A pre-existing synced transaction this row appears to duplicate.
     *
     * Imported history and the SimpleFIN window overlap, and the same transaction shows up in both
     * with different descriptions. Overlap is detected by date proximity and amount, then presented
     * for **manual confirmation** — never silently merged, never silently duplicated.
     */
    matchTransactionId: uuid('match_transaction_id').references(() => transactions.id, {
      onDelete: 'set null',
    }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('import_rows_import_idx').on(table.importId, table.rowNumber),
    index('import_rows_household_idx').on(table.householdId),
    householdIsolationPolicy('import_rows'),
  ],
).enableRLS()
