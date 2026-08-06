import { toIsoDate } from '@beans/shared'
import { createAuth } from '../auth/auth.js'
import { loadConfig } from '../config.js'
import { createDatabase, createPool } from '../db/client.js'
import { DataKeyCache } from '../crypto/data-key-cache.js'
import { LocalMasterKeyProvider } from '../crypto/local-master-key-provider.js'
import {
  NoHouseholdError,
  createHousehold,
  withHouseholdContext,
  type ContextDependencies,
} from '../repositories/household-context.js'
import { seedDemoHousehold } from './seed.js'

/**
 * Creates the demo account and fills it, idempotently.
 *
 *     pnpm demo:seed                          # in a checkout
 *     node apps/api/dist/demo-seed.js         # inside the container, where the NAS needs it
 *
 * Safe to re-run, and meant to be: it clears the demo household's financial data first, so a
 * scheduled run undoes whatever visitors have done to it without touching anything else.
 *
 * Refuses without `DEMO_EMAIL` and `DEMO_PASSWORD`. There is no default account and no default
 * password — a demo login is a session handed to anyone who can reach the host, so it exists only
 * where somebody deliberately configured it.
 */
async function main(): Promise<void> {
  const config = loadConfig()

  if (config.demo === null) {
    throw new Error(
      'DEMO_EMAIL and DEMO_PASSWORD must both be set before the demo account can be created.',
    )
  }

  const pool = createPool(config.databaseUrl)

  try {
    const auth = createAuth(config, createDatabase(pool))

    /*
     * Created through the ordinary sign-up path rather than by inserting rows.
     *
     * The password has to be hashed the way Better Auth hashes it, and the household bootstrap has
     * to run the way it runs for anybody else — writing the rows by hand would produce an account
     * that works until the day one of those details changes.
     */
    await auth.api
      .signUpEmail({
        body: {
          email: config.demo.email,
          password: config.demo.password,
          name: 'Demo Household',
        },
      })
      .catch(() => {
        // Already exists, which is the normal case on every run after the first.
      })

    const signedIn = await auth.api.signInEmail({
      body: { email: config.demo.email, password: config.demo.password },
    })

    const userId = signedIn.user.id

    const deps: ContextDependencies = {
      pool,
      keyProvider: await LocalMasterKeyProvider.fromFile(config.masterKeyFile),
      keyCache: new DataKeyCache(),
    }

    /*
     * A household, if this user has none yet.
     *
     * Signing up does not create one — the app does it explicitly on first load, and the seeder
     * never goes near that path. Without this the first run creates the account and then fails on
     * `NoHouseholdError`, leaving a demo user who exists and cannot be signed into usefully.
     *
     * Checked rather than attempted-and-caught, so a re-seed does not depend on an error to know
     * that the household is already there.
     */
    const belongs = await withHouseholdContext(deps, userId, async (context) => context.householdId)
      .then(() => true)
      .catch((error: unknown) => {
        if (error instanceof NoHouseholdError) return false
        throw error
      })

    if (!belongs) {
      await createHousehold(deps, userId, 'Demo Household')
    }

    const result = await withHouseholdContext(deps, userId, async (context) =>
      seedDemoHousehold(context, toIsoDate(new Date())),
    )

    console.log(
      `Demo household ready: ${result.accounts} accounts, ${result.transactions} transactions, ${result.holdings} holdings.`,
    )
  } finally {
    await pool.end()
  }
}

await main()
