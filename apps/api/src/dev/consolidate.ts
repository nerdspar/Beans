import { loadConfig } from '../config.js'
import { DataKeyCache } from '../crypto/data-key-cache.js'
import { LocalMasterKeyProvider } from '../crypto/local-master-key-provider.js'
import { createPool } from '../db/client.js'
import { withHouseholdContext } from '../repositories/household-context.js'

/**
 * Dev-only repair: collapse a household's per-institution connections into one.
 *
 * The original seed created a connection per institution, which is not how SimpleFIN works — one
 * access URL exposes every institution inside a Bridge account. Existing dev data still has the old
 * shape, and the accounts screen renders per-connection controls once per connection.
 *
 *   pnpm --filter @beans/api dev:consolidate <user-email>
 */
async function main(): Promise<void> {
  const email = process.argv[2]
  if (email === undefined) throw new Error('Usage: dev:consolidate <user-email>')

  const config = loadConfig()
  const pool = createPool(config.databaseUrl)
  const deps = {
    pool,
    keyProvider: await LocalMasterKeyProvider.fromFile(config.masterKeyFile),
    keyCache: new DataKeyCache(),
  }

  const user = await pool.query<{ id: string }>('select id from auth_user where email = $1', [email])
  const userId = user.rows[0]?.id
  if (userId === undefined) throw new Error(`No user with email ${email}`)

  await withHouseholdContext(deps, userId, async (context) => {
    const keep = await context.client.query<{ id: string }>(
      'select id from connections order by created_at limit 1',
    )
    const keepId = keep.rows[0]?.id
    if (keepId === undefined) {
      console.log('No connections to consolidate.')
      return
    }

    const moved = await context.client.query(
      'update accounts set connection_id = $1 where connection_id is not null and connection_id <> $1',
      [keepId],
    )
    const removed = await context.client.query('delete from connections where id <> $1', [keepId])

    console.log(`Moved ${moved.rowCount ?? 0} accounts, removed ${removed.rowCount ?? 0} connections.`)
  })

  await pool.end()
}

await main()
