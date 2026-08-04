import { loadConfig } from '../config.js'
import { DataKeyCache } from '../crypto/data-key-cache.js'
import { LocalMasterKeyProvider } from '../crypto/local-master-key-provider.js'
import { createPool } from '../db/client.js'
import { NoHouseholdError, withHouseholdContext } from '../repositories/household-context.js'

/**
 * Counts what is in the database, without reading any of it.
 *
 * Emails and counts only — no names, no balances, nothing encrypted is decrypted. Exists because
 * development and production share one database, so "which of these households is real and which is
 * leftover test data" is a question that comes up.
 *
 * **Goes through `withHouseholdContext` per user rather than querying across households.** A single
 * query as `beans_app` returns nothing at all: every policy is keyed to session variables that are
 * unset, so RLS filters the lot. That is the isolation layer working, and it means there is no
 * unscoped way to take inventory — which is the point of the design.
 *
 *   pnpm --filter @beans/api dev:inventory
 */
const config = loadConfig()
const pool = createPool(config.databaseUrl)
const deps = {
  pool,
  keyProvider: await LocalMasterKeyProvider.fromFile(config.masterKeyFile),
  keyCache: new DataKeyCache(),
}

const users = await pool.query<{ id: string; email: string }>(
  'select id, email from auth_user order by email',
)

const homeless: string[] = []

for (const user of users.rows) {
  try {
    const summary = await withHouseholdContext(deps, user.id, async (context) => {
      const counts = await context.client.query<{
        accounts: string
        transactions: string
        connections: string
        snapshots: string
      }>(
        `select (select count(*) from accounts)::text as accounts,
                (select count(*) from transactions)::text as transactions,
                (select count(*) from connections)::text as connections,
                (select count(*) from balance_snapshots)::text as snapshots`,
      )
      return { householdId: context.householdId, ...counts.rows[0] }
    })

    console.log(
      `${summary.householdId.slice(0, 8)}  accounts=${(summary.accounts ?? '0').padStart(3)}` +
        `  txns=${(summary.transactions ?? '0').padStart(6)}` +
        `  snapshots=${(summary.snapshots ?? '0').padStart(6)}` +
        `  connections=${summary.connections ?? '0'}  ${user.email}`,
    )
  } catch (error) {
    if (error instanceof NoHouseholdError) {
      homeless.push(user.email)
      continue
    }
    throw error
  }
}

if (homeless.length > 0) {
  console.log(`\nNo household: ${homeless.join(', ')}`)
}

await pool.end()
