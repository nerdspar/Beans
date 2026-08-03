import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { DataKeyCache } from '../crypto/data-key-cache.js'
import { DecryptionError } from '../crypto/envelope.js'
import { LocalMasterKeyProvider } from '../crypto/local-master-key-provider.js'
import {
  NoHouseholdError,
  createHousehold,
  withHouseholdContext,
  type ContextDependencies,
} from './household-context.js'

/**
 * The repository layer's half of tenant isolation.
 *
 * `tenant-isolation.integration.test.ts` proves Postgres enforces separation at the row level.
 * This proves the layer above it hands out correctly scoped contexts and cannot be talked into
 * handing out someone else's.
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL']
const MASTER_KEY = Buffer.alloc(32, 0x11).toString('base64')

const USER_A = 'user-a-fixed-id'
const USER_B = 'user-b-fixed-id'
const USER_ORPHAN = 'user-orphan-fixed-id'

const describeIntegration = TEST_DATABASE_URL === undefined ? describe.skip : describe

describeIntegration('household context', () => {
  let pool: Pool
  let deps: ContextDependencies

  beforeAll(() => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 10_000 })
    deps = {
      pool,
      keyProvider: LocalMasterKeyProvider.fromObject({
        currentVersion: 1,
        keys: { 1: MASTER_KEY },
      }),
      keyCache: new DataKeyCache({ now: () => 1_000_000 }),
    }
  })

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query('truncate households, accounts, auth_user restart identity cascade')
    deps.keyCache.clear()

    for (const [id, email] of [
      [USER_A, 'a@example.com'],
      [USER_B, 'b@example.com'],
      [USER_ORPHAN, 'orphan@example.com'],
    ]) {
      await pool.query(
        `insert into auth_user (id, name, email, email_verified) values ($1, $2, $3, false)`,
        [id, 'Test User', email],
      )
    }
  })

  it('creates a household and makes the creator its owner', async () => {
    const { householdId } = await createHousehold(deps, USER_A, 'The Goldbergs')

    const context = await withHouseholdContext(deps, USER_A, async (ctx) => ({
      householdId: ctx.householdId,
      role: ctx.role,
      userId: ctx.userId,
    }))

    expect(context.householdId).toBe(householdId)
    expect(context.role).toBe('owner')
    expect(context.userId).toBe(USER_A)
  })

  it('refuses to build a context for a user with no household', async () => {
    await expect(
      withHouseholdContext(deps, USER_ORPHAN, async () => 'unreachable'),
    ).rejects.toThrow(NoHouseholdError)
  })

  it('scopes reads to the caller household', async () => {
    const a = await createHousehold(deps, USER_A, 'Household A')
    const b = await createHousehold(deps, USER_B, 'Household B')
    expect(a.householdId).not.toBe(b.householdId)

    await withHouseholdContext(deps, USER_A, async (ctx) => {
      await ctx.client.query(
        `insert into accounts (household_id, type, display_name, current_balance, currency)
         values ($1, 'depository', $2, $3, 'USD')`,
        [ctx.householdId, ctx.cipher.encryptText('A Checking'), ctx.cipher.encryptMoney(100_00n)],
      )
    })

    await withHouseholdContext(deps, USER_B, async (ctx) => {
      await ctx.client.query(
        `insert into accounts (household_id, type, display_name, current_balance, currency)
         values ($1, 'depository', $2, $3, 'USD')`,
        [ctx.householdId, ctx.cipher.encryptText('B Savings'), ctx.cipher.encryptMoney(250_00n)],
      )
    })

    const seenByA = await withHouseholdContext(deps, USER_A, async (ctx) => {
      const rows = await ctx.client.query('select display_name from accounts')
      return rows.rows.map((r) => ctx.cipher.decryptText(r.display_name as Buffer))
    })

    expect(seenByA).toEqual(['A Checking'])

    const seenByB = await withHouseholdContext(deps, USER_B, async (ctx) => {
      const rows = await ctx.client.query('select display_name from accounts')
      return rows.rows.map((r) => ctx.cipher.decryptText(r.display_name as Buffer))
    })

    expect(seenByB).toEqual(['B Savings'])
  })

  it('gives each household a distinct key, so one cipher cannot read another data', async () => {
    await createHousehold(deps, USER_A, 'Household A')
    await createHousehold(deps, USER_B, 'Household B')

    const sealedByA = await withHouseholdContext(deps, USER_A, async (ctx) =>
      ctx.cipher.encryptMoney(-82487123n),
    )

    // Even handed the raw ciphertext directly — bypassing RLS entirely — household B's context
    // cannot read it. Two independent barriers, and this test crosses the second one.
    await withHouseholdContext(deps, USER_B, async (ctx) => {
      expect(() => ctx.cipher.decryptMoney(sealedByA)).toThrow(DecryptionError)
    })
  })

  it('rolls back the whole transaction when the callback throws', async () => {
    await createHousehold(deps, USER_A, 'Household A')

    await expect(
      withHouseholdContext(deps, USER_A, async (ctx) => {
        await ctx.client.query(
          `insert into accounts (household_id, type, currency) values ($1, 'depository', 'USD')`,
          [ctx.householdId],
        )
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    const remaining = await withHouseholdContext(deps, USER_A, async (ctx) =>
      ctx.client.query('select 1 from accounts'),
    )
    expect(remaining.rowCount).toBe(0)
  })

  it('does not leak the session variable onto a pooled connection', async () => {
    await createHousehold(deps, USER_A, 'Household A')

    await withHouseholdContext(deps, USER_A, async (ctx) => {
      await ctx.client.query(
        `insert into accounts (household_id, type, currency) values ($1, 'depository', 'USD')`,
        [ctx.householdId],
      )
    })

    // A raw connection from the same pool, with no context set. If `set_config(..., true)` were
    // not transaction-local, this could inherit household A's scope and see its rows.
    const leaked = await pool.query('select * from accounts')
    expect(leaked.rowCount).toBe(0)
  })

  it('caches the unwrapped key rather than unwrapping per request', async () => {
    const { householdId } = await createHousehold(deps, USER_A, 'Household A')

    // createHousehold populates the cache, so the key is already resident.
    expect(deps.keyCache.get(householdId)).toBeDefined()

    deps.keyCache.clear()
    await withHouseholdContext(deps, USER_A, async () => undefined)

    // ...and a context miss repopulates it from the wrapped DEK in the database.
    expect(deps.keyCache.get(householdId)).toBeDefined()
  })
})
