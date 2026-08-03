import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { authUser } from './auth.js'
import {
  bytea,
  createdAt,
  householdId,
  householdIsolationPolicy,
  householdSelfIsolationPolicy,
  primaryId,
  updatedAt,
  userIsolationPolicy,
} from './columns.js'
import { householdRole } from './enums.js'

/**
 * The tenancy boundary and the keys that protect it.
 */

/**
 * A household. Every piece of financial data hangs off exactly one.
 *
 * Each household holds its own data encryption key, stored **wrapped** by the master key that
 * lives in a Docker secret. The master key never lives in Postgres — which is what makes a stolen
 * database dump useless, and also why the master key must be backed up separately from the
 * database (ARCHITECTURE.md §5).
 */
export const households = pgTable(
  'households',
  {
    id: primaryId(),
    name: text('name').notNull(),

    /** The household DEK, sealed under the master key with the household id bound as AAD. */
    wrappedDek: bytea('wrapped_dek').notNull(),

    /**
     * Which master key version sealed `wrapped_dek`. This is what lets the master key rotate
     * without downtime: old and new coexist while a background pass re-wraps.
     */
    keyVersion: integer('key_version').notNull(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  () => [householdSelfIsolationPolicy()],
).enableRLS()

/**
 * User-to-household membership.
 *
 * `unique(user_id)` enforces one household per user in v1. Dropping that single constraint is the
 * entire migration to many-to-many — the table is otherwise already a plain join table, so nothing
 * restructures (ARCHITECTURE.md §6.2).
 */
export const householdMembers = pgTable(
  'household_members',
  {
    id: primaryId(),
    householdId: householdId().references(() => households.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    role: householdRole('role').notNull().default('member'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('household_members_user_uq').on(table.userId),
    index('household_members_household_idx').on(table.householdId),
    householdIsolationPolicy('household_members'),

    /**
     * Lets a signed-in user read **their own** membership row without a household context.
     *
     * Resolves a genuine chicken-and-egg: every other table is gated on
     * `app.current_household`, but discovering *which* household to set it to means reading this
     * table first. Without this, a request could never bootstrap its own scope.
     *
     * Deliberately narrow. `for: 'select'` only, so it widens reads and never writes, and the
     * predicate matches a single row — the user's own. Postgres ORs permissive policies together,
     * so this adds exactly that row to what the household policy already allows, and nothing else.
     */
    pgPolicy('household_members_self_select', {
      as: 'permissive',
      for: 'select',
      to: 'public',
      using: sql`user_id = nullif(current_setting('app.current_user_id', true), '')`,
    }),
  ],
).enableRLS()

/**
 * Invites work as copy-paste links so mail is never required to onboard someone — a self-hosted
 * install may have no SMTP at all.
 *
 * Only the **hash** of the token is stored. A database dump therefore cannot be used to accept
 * outstanding invites.
 */
export const householdInvites = pgTable(
  'household_invites',
  {
    id: primaryId(),
    householdId: householdId().references(() => households.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    role: householdRole('role').notNull().default('member'),

    /** Optional, and encrypted: an invitee's address is personal data. */
    email: bytea('email'),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdByUserId: text('created_by_user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedByUserId: text('accepted_by_user_id').references(() => authUser.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('household_invites_household_idx').on(table.householdId),
    householdIsolationPolicy('household_invites'),
  ],
).enableRLS()

/**
 * Per-user interface preferences, notably the four configurable mobile bottom-tab slots (the fifth
 * is always More).
 *
 * Keyed to the **user**, not the household, and persisted server-side deliberately so the choice
 * follows the person across devices rather than living in one browser's storage.
 *
 * Isolated by `app.current_user_id` rather than `app.current_household` — the one table in the
 * schema whose RLS is user-scoped.
 */
export const userPreferences = pgTable(
  'user_preferences',
  {
    id: primaryId(),
    userId: text('user_id')
      .notNull()
      .unique()
      .references(() => authUser.id, { onDelete: 'cascade' }),

    /** Ordered destination keys for the first four tab slots. Null means "use the default order". */
    tabOrder: jsonb('tab_order').$type<string[] | null>(),

    theme: text('theme').notNull().default('system'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  () => [userIsolationPolicy('user_preferences')],
).enableRLS()

/**
 * Hard-deletion log, read by delta sync (ARCHITECTURE.md §7.3).
 *
 * `updated_at` plus a cursor tells a client what *changed*; nothing tells it what **disappeared**.
 * Without this table, a reversed import leaves every client holding transactions the server no
 * longer has, permanently and silently.
 *
 * Retention is 90 days. A client whose cursor predates the oldest tombstone must be told to resync
 * fully, because we can no longer prove what was deleted.
 */
export const deletions = pgTable(
  'deletions',
  {
    id: primaryId(),
    householdId: householdId().references(() => households.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('deletions_household_deleted_at_idx').on(table.householdId, table.deletedAt),
    householdIsolationPolicy('deletions'),
  ],
).enableRLS()
