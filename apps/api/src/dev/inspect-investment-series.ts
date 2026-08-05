import { Pool } from 'pg'
import { DataKeyCache } from '../crypto/data-key-cache.js'
import { LocalMasterKeyProvider } from '../crypto/local-master-key-provider.js'
import { loadConfig } from '../config.js'
import { withHouseholdContext } from '../repositories/household-context.js'

/** Prints the last few daily snapshots per investment account, to see whether they actually move. */
async function main(): Promise<void> {
  const config = loadConfig()
  const pool = new Pool({ connectionString: config.databaseUrl })
  const deps = {
    pool,
    keyProvider: await LocalMasterKeyProvider.fromFile(config.masterKeyFile),
    keyCache: new DataKeyCache(),
  }

  const user = await pool.query<{ user_id: string }>('select user_id from household_members limit 1')
  const userId = user.rows[0]?.user_id
  if (userId === undefined) {
    console.log('no household members')
    await pool.end()
    return
  }

  await withHouseholdContext(deps, userId, async (ctx) => {
    const accounts = await ctx.client.query<{ id: string; provider_name: Buffer | null }>(
      "select id, provider_name from accounts where type = 'investment' and is_closed = false",
    )

    for (const account of accounts.rows) {
      const rows = await ctx.client.query<{ as_of_date: string; balance: Buffer; source: string }>(
        `select as_of_date, balance, source from balance_snapshots
          where account_id = $1 order by as_of_date desc limit 4`,
        [account.id],
      )
      const name =
        account.provider_name === null ? '(unnamed)' : ctx.cipher.decryptText(account.provider_name)
      const points = rows.rows.map(
        (row) => `${row.as_of_date}=${ctx.cipher.decryptMoney(row.balance)}(${row.source})`,
      )
      console.log(name.slice(0, 28).padEnd(30), points.join('  '))
    }
  })

  await pool.end()
}

void main()
