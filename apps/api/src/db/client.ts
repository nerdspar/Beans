import { drizzle } from 'drizzle-orm/node-postgres'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema/index.js'
import { registerPostgresTypeParsers } from './type-parsers.js'

/**
 * Database connections.
 *
 * node-postgres rather than postgres.js, so the `Pool` is ours to hand to Fastify's lifecycle and
 * to shut down explicitly.
 */

export type Database = NodePgDatabase<typeof schema>

/**
 * The application pool.
 *
 * Connections from here carry per-request session state — `app.current_household` and
 * `app.current_user_id`, set inside the request transaction to drive row-level security. That
 * makes this pool unsafe to share with anything that runs its own queries outside a request:
 * pg-boss in particular gets its own pool for exactly this reason (ARCHITECTURE.md §17).
 */
export function createPool(connectionString: string): Pool {
  registerPostgresTypeParsers()

  return new Pool({
    connectionString,
    // Session state (the RLS GUCs) is set per transaction and reset on release, so a modest pool
    // is fine. Raise only with evidence.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  })
}

export function createDatabase(pool: Pool): Database {
  return drizzle(pool, { schema })
}
