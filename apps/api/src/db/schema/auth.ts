import { boolean, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Better Auth's tables.
 *
 * **Prefixed `auth_`** because Better Auth's `account` means "OAuth provider link", which would
 * collide with our financial `accounts` in both meaning and namespace (ARCHITECTURE.md §6.1). The
 * prefix comes from `modelName` in the Better Auth config; the adapter resolves tables by model
 * name, so the export names here must keep matching it.
 *
 * These are **not** household-scoped and carry **no RLS** — identity is cross-household by nature.
 *
 * This file mirrors the output of `npx auth@latest generate` exactly, including its
 * timestamp-without-timezone columns, so regenerating produces a clean diff instead of a spurious
 * migration. Do not hand-tune it; change the Better Auth config and regenerate.
 */

export const authUser = pgTable('auth_user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: text('image'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
})

export const authSession = pgTable(
  'auth_session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
  },
  (table) => [index('auth_session_user_id_idx').on(table.userId)],
)

/**
 * OAuth provider links, and the credential hash for email/password sign-in (`password`, with
 * `providerId = 'credential'`). Argon2id, configured on the Better Auth instance — Better Auth
 * defaults to scrypt, and switching after users exist strands their hashes.
 */
export const authAccount = pgTable(
  'auth_account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at'),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('auth_account_user_id_idx').on(table.userId)],
)

export const authVerification = pgTable(
  'auth_verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('auth_verification_identifier_idx').on(table.identifier)],
)
