import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import type { Pool } from 'pg'
import { createDatabase, createPool } from './client.js'

/**
 * Applies pending migrations, idempotently, under an advisory lock.
 *
 * Runs on startup. Drizzle already tracks applied migrations by hash in `__drizzle_migrations`, so
 * re-running is a no-op — but that check is **not** concurrency-safe: two instances booting at the
 * same moment can both read "nothing applied" and both try to create the same tables. The advisory
 * lock serializes them. The loser waits, then finds nothing to do.
 */

/**
 * Arbitrary but fixed. Any constant works as long as nothing else in this database uses the same
 * one — advisory locks share a single global namespace per database.
 */
const MIGRATION_LOCK_ID = 8_263_771_004_918_223n

const MIGRATIONS_FOLDER = fileURLToPath(new URL('./migrations', import.meta.url))

export async function runMigrations(pool: Pool): Promise<void> {
  // A dedicated connection, because advisory locks are session-scoped: the lock lives as long as
  // the connection holding it, and must be released on that same connection.
  const lockConnection = await pool.connect()

  try {
    await lockConnection.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID.toString()])

    try {
      await migrate(createDatabase(pool), { migrationsFolder: MIGRATIONS_FOLDER })
    } finally {
      await lockConnection.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID.toString()])
    }
  } finally {
    lockConnection.release()
  }
}

/**
 * Standalone entry point, so migrations can be applied without booting the API:
 *     pnpm db:migrate
 */
async function main(): Promise<void> {
  // `--test` targets the integration-test database. It is a separate database on purpose:
  // integration tests truncate tables, and must never be able to reach development data.
  const useTestDatabase = process.argv.includes('--test')
  const variable = useTestDatabase ? 'TEST_DATABASE_URL' : 'DATABASE_URL'
  const connectionString = process.env[variable]

  if (connectionString === undefined || connectionString === '') {
    throw new Error(`${variable} is not set. Copy .env.example to .env and fill it in.`)
  }

  const pool = createPool(connectionString)

  try {
    await runMigrations(pool)
    // Deliberately says nothing about which migrations ran — drizzle logs that itself, and the
    // connection string must never reach the output.
    console.log('Migrations are up to date.')
  } finally {
    await pool.end()
  }
}

// Only run when invoked directly, not when imported by the server's startup path.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
