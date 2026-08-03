import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { authUser } from './auth.js'
import {
  bytea,
  createdAt,
  householdId,
  householdIsolationPolicy,
  primaryId,
  updatedAt,
} from './columns.js'
import { importKind, importStatus } from './enums.js'
import { households } from './tenancy.js'

/**
 * A staged CSV import.
 *
 * Imports are staged in `import_rows` first, so the user sees exactly what will happen before
 * anything touches the real tables, and an import can be reversed **as a unit**.
 *
 * The mapper is generic, not Empower-specific: delimiter and header row are auto-detected, columns
 * are mapped with a best-guess prefill, and Empower ships as a preset so Monarch, Mint and YNAB are
 * just configuration.
 *
 * (Defined without a reference to `import_rows` so the foreign-key graph stays acyclic —
 * `import_rows` points here, and at accounts and transactions.)
 */
export const imports = pgTable(
  'imports',
  {
    id: primaryId(),
    householdId: householdId().references(() => households.id, { onDelete: 'cascade' }),
    createdByUserId: text('created_by_user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),

    /** `empower` | `monarch` | `mint` | `ynab` | `custom`. Plain text so presets can be added freely. */
    sourcePreset: text('source_preset').notNull().default('custom'),

    kind: importKind('kind').notNull(),
    status: importStatus('status').notNull().default('staged'),

    /** Encrypted: a filename routinely contains a real name or an account number. */
    originalFilename: bytea('original_filename'),

    delimiter: text('delimiter'),

    /** Column mapping. Structure, not account data, so plaintext. */
    mapping: jsonb('mapping'),

    rowCount: integer('row_count').notNull().default(0),
    committedRowCount: integer('committed_row_count').notNull().default(0),

    committedAt: timestamp('committed_at', { withTimezone: true }),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),

    /**
     * Retention boundary, set to `committed_at + 30 days`.
     *
     * Once it passes, a scheduled job **deletes the `import_rows`** and keeps this header row with
     * its counts for audit. Reversal becomes impossible after that, which is the point: a five-year
     * Empower import is tens of thousands of staged rows carrying two encrypted JSONB blobs each,
     * and they would otherwise persist forever (ARCHITECTURE.md §11).
     */
    reversibleUntil: timestamp('reversible_until', { withTimezone: true }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('imports_household_idx').on(table.householdId),
    householdIsolationPolicy('imports'),
  ],
).enableRLS()
