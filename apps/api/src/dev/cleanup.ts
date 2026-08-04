import { loadConfig } from '../config.js'
import { DataKeyCache } from '../crypto/data-key-cache.js'
import { LocalMasterKeyProvider } from '../crypto/local-master-key-provider.js'
import { createPool } from '../db/client.js'
import { NoHouseholdError, withHouseholdContext } from '../repositories/household-context.js'

/**
 * Removes test users and everything their households contain.
 *
 *   pnpm --filter @beans/api dev:cleanup <email> [<email> ...]
 *
 * Development and production share one database, so this deletes real rows from real
 * infrastructure. Two guards, because the cost of getting it wrong is somebody's financial history:
 *
 *   - Only the emails named on the command line are touched. There is no pattern matching and no
 *     "delete everything except", because both fail open.
 *   - A household holding transactions is refused unless `--force`. Test households have none and
 *     real ones do, so the natural shape of the data is itself the check.
 */
const emails = process.argv.slice(2).filter((argument) => !argument.startsWith('--'))
const force = process.argv.includes('--force')

if (emails.length === 0) {
  throw new Error('Usage: dev:cleanup <email> [<email> ...]')
}

const config = loadConfig()
const pool = createPool(config.databaseUrl)
const deps = {
  pool,
  keyProvider: await LocalMasterKeyProvider.fromFile(config.masterKeyFile),
  keyCache: new DataKeyCache(),
}

for (const email of emails) {
  const found = await pool.query<{ id: string }>('select id from auth_user where email = $1', [
    email,
  ])
  const userId = found.rows[0]?.id

  if (userId === undefined) {
    console.log(`${email}: no such user, skipping`)
    continue
  }

  let removedHousehold = false

  try {
    await withHouseholdContext(deps, userId, async (context) => {
      const counts = await context.client.query<{ accounts: string; transactions: string }>(
        `select (select count(*) from accounts)::text as accounts,
                (select count(*) from transactions)::text as transactions`,
      )

      const accounts = Number(counts.rows[0]?.accounts ?? 0)
      const transactions = Number(counts.rows[0]?.transactions ?? 0)

      if (transactions > 0 && !force) {
        throw new Error(
          `${email} owns a household with ${transactions} transactions. That is the shape of real ` +
            `data, not a test fixture. Re-run with --force if you are certain.`,
        )
      }

      // Everything below the household cascades from this one row: accounts, connections,
      // transactions, snapshots, categories, invites.
      await context.client.query('delete from households where id = $1', [context.householdId])
      console.log(
        `${email}: removed household ${context.householdId.slice(0, 8)} ` +
          `(${accounts} accounts, ${transactions} transactions)`,
      )
      removedHousehold = true
    })
  } catch (error) {
    if (!(error instanceof NoHouseholdError)) throw error
    console.log(`${email}: no household`)
  }

  await pool.query('delete from auth_user where id = $1', [userId])
  console.log(`${email}: removed user${removedHousehold ? '' : ' (no household to remove)'}`)
}

await pool.end()
