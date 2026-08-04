import { loadConfig } from '../config.js'
import { DataKeyCache } from '../crypto/data-key-cache.js'
import { LocalMasterKeyProvider } from '../crypto/local-master-key-provider.js'
import { createPool } from '../db/client.js'
import { ensureDefaultCategories } from '../repositories/categories.js'
import { NoHouseholdError, withHouseholdContext } from '../repositories/household-context.js'

/**
 * Installs the default categories into households created before they existed.
 *
 * `ensureDefaultCategories` is idempotent on slug, so this adds only what is missing and is safe to
 * re-run. New households get them at creation and never need this.
 *
 *   pnpm --filter @beans/api dev:backfill-categories
 */
const config = loadConfig()
const pool = createPool(config.databaseUrl)
const deps = {
  pool,
  keyProvider: await LocalMasterKeyProvider.fromFile(config.masterKeyFile),
  keyCache: new DataKeyCache(),
}

const users = await pool.query<{ id: string; email: string }>('select id, email from auth_user')

for (const user of users.rows) {
  try {
    const result = await withHouseholdContext(deps, user.id, ensureDefaultCategories)
    console.log(`${user.email}: added ${result.added} categories`)
  } catch (error) {
    if (!(error instanceof NoHouseholdError)) throw error
  }
}

await pool.end()
