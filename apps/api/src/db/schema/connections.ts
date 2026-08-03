import { date, index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { authUser } from './auth.js'
import {
  bytea,
  createdAt,
  householdId,
  householdIsolationPolicy,
  primaryId,
  updatedAt,
} from './columns.js'
import { connectionStatus, syncOutcome } from './enums.js'
import { households } from './tenancy.js'

/**
 * SimpleFIN connections and the audit trail of every sync attempt.
 */

/**
 * A SimpleFIN organization.
 *
 * **Household-scoped, not global.** Institution names are encrypted, and encryption is per-household
 * (DEK plus AAD), so a shared global table could not hold them. The scoping also leaks strictly
 * less: there is no global foreign key revealing which institutions a household banks with.
 *
 * If logos or other display metadata are wanted later, they belong in a **separate global public
 * table keyed by domain with no household reference**, while this row keeps its encrypted name.
 * Do not add a global FK from here (ARCHITECTURE.md §17).
 */
export const institutions = pgTable(
  'institutions',
  {
    id: primaryId(),
    householdId: householdId().references(() => households.id, { onDelete: 'cascade' }),

    /** Stable identifier from SimpleFIN, plaintext so it can key the upsert. */
    simplefinOrgDomain: text('simplefin_org_domain').notNull(),

    name: bytea('name').notNull(),
    url: text('url'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('institutions_household_domain_uq').on(table.householdId, table.simplefinOrgDomain),
    householdIsolationPolicy('institutions'),
  ],
).enableRLS()

/**
 * One row per SimpleFIN access URL.
 *
 * **Every user brings their own connection.** Beans never shares one across households — a Bridge
 * account exposes every institution linked inside it, so sharing would put other people's bank data
 * under one person's login and defeat the encryption entirely (ARCHITECTURE.md §10).
 *
 * Reconnecting **replaces `access_url` on this existing row** and re-matches accounts to their
 * existing records. It must never create a duplicate connection or orphan balance history.
 */
export const connections = pgTable(
  'connections',
  {
    id: primaryId(),
    householdId: householdId().references(() => households.id, { onDelete: 'cascade' }),

    /** The member who authorized this connection. */
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),

    institutionId: uuid('institution_id').references(() => institutions.id, {
      onDelete: 'set null',
    }),

    /**
     * The long-lived SimpleFIN access URL, with basic-auth credentials embedded.
     *
     * This is a credential. It is encrypted at rest and **never returned to the client, not even
     * partially**.
     */
    accessUrl: bytea('access_url').notNull(),

    /**
     * Sync health is a first-class feature. Silent sync failure is the worst possible bug in this
     * app, because the numbers quietly go stale and everything still looks fine.
     */
    status: connectionStatus('status').notNull().default('healthy'),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),

    /** Encrypted: provider errors quote account names and other identifying detail. */
    lastError: bytea('last_error'),

    /**
     * Consecutive failures, driving exponential backoff. The Bridge allows 24 or fewer requests
     * per day per token, so a retry loop must never be free-running.
     */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('connections_household_idx').on(table.householdId),
    householdIsolationPolicy('connections'),
  ],
).enableRLS()

/**
 * An audit log of every sync attempt, its outcome, and its error if any.
 *
 * Exists so that "why is this balance stale?" is answerable after the fact rather than a guess.
 * Also where the per-type sign normalization records which rule fired, since a flipped credit-card
 * sign is the highest-consequence silent bug in the app (ARCHITECTURE.md §3.3).
 */
export const syncRuns = pgTable(
  'sync_runs',
  {
    id: primaryId(),
    householdId: householdId().references(() => households.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    outcome: syncOutcome('outcome'),

    /** The requested window. Subsequent syncs overlap by ~2 weeks to catch late and amended rows. */
    windowStartDate: date('window_start_date'),
    windowEndDate: date('window_end_date'),

    accountsSeen: integer('accounts_seen').notNull().default(0),
    transactionsUpserted: integer('transactions_upserted').notNull().default(0),

    /**
     * SimpleFIN's structured `errlist`, encrypted. These are **surfaced to the user**, never
     * swallowed.
     */
    errors: bytea('errors'),

    /** Sign-check and other anomalies raised during normalization, encrypted. */
    warnings: bytea('warnings'),

    createdAt: createdAt(),
  },
  (table) => [
    index('sync_runs_connection_started_idx').on(table.connectionId, table.startedAt),
    householdIsolationPolicy('sync_runs'),
  ],
).enableRLS()
