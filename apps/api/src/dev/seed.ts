import { parseDecimalToCents } from '@beans/shared'
import { DataKeyCache } from '../crypto/data-key-cache.js'
import { LocalMasterKeyProvider } from '../crypto/local-master-key-provider.js'
import { loadConfig } from '../config.js'
import { createPool } from '../db/client.js'
import { withHouseholdContext, type HouseholdContext } from '../repositories/household-context.js'

/**
 * Development seed.
 *
 * Puts a plausible household behind an existing signed-up user so the frontend can be looked at
 * against the real read path rather than a fixture. **Never run against real data** — it inserts,
 * it does not migrate, and the amounts are invented.
 *
 * Goes through `withHouseholdContext` rather than raw SQL because every money and name column here
 * is encrypted with the household's own key. There is no way to seed these from psql.
 *
 *   pnpm --filter @beans/api dev:seed <user-email>
 */

type SeedAccount = {
  type: 'depository' | 'credit' | 'investment' | 'mortgage' | 'other_asset'
  institution: string
  name: string
  mask: string | null
  balance: string
  isManual?: boolean
  /** Days since the last successful sync, or null for a manual account. */
  syncedDaysAgo: number | null
  status: 'healthy' | 'stale' | 'error'
  failures?: number
  /** Cents per day of drift, applied backwards from today to build the history. */
  driftPerDay: number
}

const ACCOUNTS: SeedAccount[] = [
  { type: 'depository', institution: 'Bank of America', name: 'Adv Relationship Banking', mask: '2755', balance: '547.70', syncedDaysAgo: 0, status: 'healthy', driftPerDay: -12 },
  { type: 'depository', institution: 'Bank of America', name: 'Advantage Savings', mask: '2510', balance: '3588.22', syncedDaysAgo: 0, status: 'healthy', driftPerDay: 40 },
  { type: 'depository', institution: 'Wealthfront', name: 'Cash Account', mask: '8821', balance: '248926.12', syncedDaysAgo: 0, status: 'healthy', driftPerDay: -180 },
  { type: 'investment', institution: 'Fidelity Investments', name: 'Scott Roth IRA', mask: null, balance: '38046.86', syncedDaysAgo: 0, status: 'healthy', driftPerDay: 900 },
  { type: 'investment', institution: 'Merrill Lynch', name: 'Cma Edge 3j', mask: '4471', balance: '23427.20', syncedDaysAgo: 5, status: 'stale', driftPerDay: 220 },
  { type: 'credit', institution: 'Chase', name: 'Amazon Card', mask: null, balance: '-3386.39', syncedDaysAgo: 0, status: 'healthy', driftPerDay: 30 },
  { type: 'credit', institution: 'American Express', name: 'Bonvoy Business Amex Card', mask: '3007', balance: '-198.22', syncedDaysAgo: 228, status: 'error', failures: 14, driftPerDay: 12 },
  { type: 'mortgage', institution: 'NewRez', name: 'Mortgage', mask: '5653', balance: '-477980.62', syncedDaysAgo: 1, status: 'error', failures: 2, driftPerDay: 6200 },
  { type: 'other_asset', institution: 'Home', name: '18 Atlantic Xing', mask: null, balance: '1157800.00', syncedDaysAgo: 8, status: 'healthy', driftPerDay: 3100 },
  { type: 'other_asset', institution: 'Car', name: '2022 Jeep Wrangler 4xe', mask: null, balance: '25000.00', syncedDaysAgo: null, status: 'healthy', isManual: true, driftPerDay: 0 },
]

const HISTORY_DAYS = 730

function isoDate(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10)
}

/**
 * One connection for every synced account, as a real Bridge account is.
 *
 * The first version created one per institution, which is not how SimpleFIN works — a single access
 * URL exposes every institution linked inside it. The difference is not cosmetic: it made the
 * accounts screen render per-connection controls nine times, which read as if syncing were a
 * per-account action.
 */
async function seedConnection(context: HouseholdContext): Promise<string> {
  const existing = await context.client.query<{ id: string }>('select id from connections limit 1')
  const found = existing.rows[0]
  if (found !== undefined) return found.id

  const created = await context.client.query<{ id: string }>(
    `insert into connections
       (household_id, owner_user_id, access_url, status, last_success_at, consecutive_failures)
     values ($1, (select user_id from household_members where household_id = $1 limit 1), $2,
             'healthy', now(), 0)
     returning id`,
    [
      context.householdId,
      context.cipher.encryptText('https://seed:seed@example.invalid/simplefin'),
    ],
  )

  const id = created.rows[0]?.id
  if (id === undefined) throw new Error('seed failed')
  return id
}

async function seedAccount(
  context: HouseholdContext,
  connectionId: string,
  spec: SeedAccount,
): Promise<void> {
  const institution = await context.client.query<{ id: string }>(
    `insert into institutions (household_id, simplefin_org_domain, name)
     values ($1, $2, $3)
     on conflict (household_id, simplefin_org_domain) do update set name = excluded.name
     returning id`,
    [
      context.householdId,
      spec.institution.toLowerCase().replaceAll(/[^a-z]/g, '') + '.com',
      context.cipher.encryptText(spec.institution),
    ],
  )

  const account = await context.client.query<{ id: string }>(
    `insert into accounts
       (household_id, connection_id, institution_id, type, provider_name, mask, current_balance,
        is_manual, tax_treatment, coverage_start_date, confirmed_at, balance_as_of)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'none', $9, now(), now())
     returning id`,
    [
      context.householdId,
      (spec.isManual ?? false) ? null : connectionId,
      institution.rows[0]?.id,
      spec.type,
      context.cipher.encryptText(spec.name),
      spec.mask === null ? null : context.cipher.encryptText(spec.mask),
      context.cipher.encryptMoney(parseDecimalToCents(spec.balance)),
      spec.isManual ?? false,
      isoDate(HISTORY_DAYS - 1),
    ],
  )

  const accountId = account.rows[0]?.id
  if (accountId === undefined) throw new Error('seed failed')

  /*
   * History is only written up to the last successful sync. Past that the account has no data, and
   * the client carries the last balance flat and says so — writing invented snapshots for a broken
   * connection is exactly the lie the carried source exists to avoid.
   */
  const stopAt = spec.syncedDaysAgo ?? 0
  const end = parseDecimalToCents(spec.balance)

  // A manual account is one number somebody entered: one observation, carried forward, not a series.
  const days = (spec.isManual ?? false) ? [HISTORY_DAYS - 1] : range(stopAt, HISTORY_DAYS)

  for (const daysAgo of days) {
    const value = end - BigInt(Math.round(spec.driftPerDay * (daysAgo - stopAt)))
    await context.client.query(
      `insert into balance_snapshots (household_id, account_id, as_of_date, balance, source)
       values ($1, $2, $3, $4, $5)
       on conflict (account_id, as_of_date) do update set balance = excluded.balance`,
      [
        context.householdId,
        accountId,
        isoDate(daysAgo),
        context.cipher.encryptMoney(value),
        (spec.isManual ?? false) ? 'observed' : 'derived',
      ],
    )
  }
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from }, (_, index) => from + index)
}

async function main(): Promise<void> {
  const email = process.argv[2]
  if (email === undefined) {
    throw new Error('Usage: dev:seed <user-email>')
  }

  const config = loadConfig()
  const pool = createPool(config.databaseUrl)
  const deps = {
    pool,
    keyProvider: await LocalMasterKeyProvider.fromFile(config.masterKeyFile),
    keyCache: new DataKeyCache(),
  }

  const user = await pool.query<{ id: string }>('select id from auth_user where email = $1', [email])
  const userId = user.rows[0]?.id
  if (userId === undefined) {
    throw new Error(`No user with email ${email}. Sign up in the app first.`)
  }

  await withHouseholdContext(deps, userId, async (context) => {
    /*
     * Refuses to write fake accounts into a household that already has some.
     *
     * Development and production currently share one database, deliberately — real data has found
     * bugs no fixture would have. The cost is that this command, whose entire job is to invent
     * plausible financial data, points at real money by default. "Remember not to run it" is not a
     * safety mechanism, so it checks.
     */
    const existing = await context.client.query<{ count: string }>(
      'select count(*) as count from accounts',
    )
    const count = Number(existing.rows[0]?.count ?? 0)

    if (count > 0 && !process.argv.includes('--force')) {
      throw new Error(
        `This household already has ${count} account${count === 1 ? '' : 's'}. ` +
          `Seeding would add ${ACCOUNTS.length} invented ones alongside them, which is almost ` +
          `certainly not what you want against real data. Re-run with --force if it is.`,
      )
    }

    const connectionId = await seedConnection(context)
    for (const spec of ACCOUNTS) {
      await seedAccount(context, connectionId, spec)
    }
  })

  console.log(`Seeded ${ACCOUNTS.length} accounts with ${HISTORY_DAYS} days of history.`)
  await pool.end()
}

await main()
