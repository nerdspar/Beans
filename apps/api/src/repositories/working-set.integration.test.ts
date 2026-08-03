import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DataKeyCache } from '../crypto/data-key-cache.js'
import { LocalMasterKeyProvider } from '../crypto/local-master-key-provider.js'
import { resetAll, resetHouseholdsFor } from '../test-support/reset-database.js'
import {
  createHousehold,
  withHouseholdContext,
  type ContextDependencies,
  type HouseholdContext,
} from './household-context.js'
import { readWorkingSet } from './working-set.js'

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL']
const MASTER_KEY = Buffer.alloc(32, 0x22).toString('base64')

const USER = 'working-set-user-fixed-id'
const OTHER_USER = 'working-set-other-user-fixed-id'
const NOW = new Date('2026-08-03T12:00:00.000Z')

const describeIntegration = TEST_DATABASE_URL === undefined ? describe.skip : describe

describeIntegration('working set', () => {
  let pool: Pool
  let deps: ContextDependencies

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 10_000 })
    deps = {
      pool,
      keyProvider: LocalMasterKeyProvider.fromObject({ currentVersion: 1, keys: { 1: MASTER_KEY } }),
      keyCache: new DataKeyCache({ now: () => 1_000_000 }),
    }
    await resetAll(pool)
    for (const [id, email] of [
      [USER, 'working-set@example.com'],
      [OTHER_USER, 'working-set-other@example.com'],
    ]) {
      await pool.query(
        'insert into auth_user (id, name, email, email_verified) values ($1, $2, $3, false)',
        [id, 'Test User', email],
      )
    }
  })

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await resetHouseholdsFor(deps, [USER, OTHER_USER])
    await createHousehold(deps, USER, 'The Goldbergs')
    await createHousehold(deps, OTHER_USER, 'Someone Else')
  })

  /**
   * The database's clock, not the test's.
   *
   * `updated_at` is stamped by a trigger using Postgres' `now()`, so a delta test comparing against
   * a fixed date in the test file is comparing two unrelated clocks. Fixed dates stay right for the
   * *data* — every posted date and balance date here is fixed — but the cursor has to be anchored to
   * whatever actually stamped the rows.
   */
  async function dbNow(context: HouseholdContext): Promise<Date> {
    const result = await context.client.query<{ now: Date }>('select now() as now')
    const value = result.rows[0]?.now
    if (value === undefined) throw new Error('no clock')
    return value
  }

  /** A confirmed checking account with one snapshot and one transaction. */
  async function seedAccount(
    context: HouseholdContext,
    options: { confirmed?: boolean; balanceCents?: bigint; name?: string } = {},
  ): Promise<string> {
    const { confirmed = true, balanceCents = 54_770n, name = 'Adv Relationship Banking' } = options

    const account = await context.client.query<{ id: string }>(
      `insert into accounts
         (household_id, type, provider_name, current_balance, is_manual, confirmed_at, coverage_start_date)
       values ($1, 'depository', $2, $3, false, $4, '2026-01-01')
       returning id`,
      [
        context.householdId,
        context.cipher.encryptText(name),
        context.cipher.encryptMoney(balanceCents),
        confirmed ? NOW : null,
      ],
    )

    const accountId = account.rows[0]?.id
    if (accountId === undefined) throw new Error('seed failed')

    await context.client.query(
      `insert into balance_snapshots (household_id, account_id, as_of_date, balance, source)
       values ($1, $2, '2026-08-01', $3, 'derived')`,
      [context.householdId, accountId, context.cipher.encryptMoney(balanceCents)],
    )

    await context.client.query(
      `insert into transactions (household_id, account_id, posted_date, amount, description)
       values ($1, $2, '2026-08-01', $3, $4)`,
      [
        context.householdId,
        accountId,
        context.cipher.encryptMoney(-4_523n),
        context.cipher.encryptText('Coffee'),
      ],
    )

    return accountId
  }

  it('returns decrypted accounts, balances and transactions on a first sync', async () => {
    await withHouseholdContext(deps, USER, seedAccount)

    const result = await withHouseholdContext(deps, USER, (ctx) =>
      readWorkingSet(ctx, { cursor: null, now: NOW }),
    )

    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]?.name).toBe('Adv Relationship Banking')
    expect(result.balances).toHaveLength(1)
    expect(result.transactions).toHaveLength(1)
    expect(result.transactions[0]?.description).toBe('Coffee')
    expect(result.fullResyncRequired).toBe(false)
  })

  /**
   * Money must not become a JSON number anywhere on this path. A double loses cents above 2^53, and
   * the failure is silent — the number simply comes back slightly wrong.
   */
  it('sends money as decimal strings, never numbers', async () => {
    await withHouseholdContext(deps, USER, (ctx) =>
      seedAccount(ctx, { balanceCents: 90_071_992_547_409_93n }),
    )

    const result = await withHouseholdContext(deps, USER, (ctx) =>
      readWorkingSet(ctx, { cursor: null, now: NOW }),
    )

    // 9007199254740993 cents — one above 2^53, so a double cannot represent it and would come back
    // as ...992. The string survives.
    expect(result.accounts[0]?.currentBalance).toBe('90071992547409.93')
    expect(typeof result.accounts[0]?.currentBalance).toBe('string')

    const roundTripped = JSON.parse(JSON.stringify(result)) as typeof result
    expect(roundTripped.accounts[0]?.currentBalance).toBe('90071992547409.93')
    expect(Number('90071992547409.93') * 100).not.toBe(9_007_199_254_740_993)
  })

  it('signs transaction amounts so they add directly to net worth', async () => {
    await withHouseholdContext(deps, USER, seedAccount)

    const result = await withHouseholdContext(deps, USER, (ctx) =>
      readWorkingSet(ctx, { cursor: null, now: NOW }),
    )
    expect(result.transactions[0]?.amount).toBe('-45.23')
  })

  /**
   * The safety net for sign normalization. An unconfirmed account has not had its balance sign
   * checked by a human, and an inverted credit card moves net worth by twice its balance in a
   * direction that looks plausible (ARCHITECTURE.md §3.3).
   */
  it('excludes unconfirmed accounts, and their balances and transactions with them', async () => {
    await withHouseholdContext(deps, USER, (ctx) => seedAccount(ctx, { confirmed: false }))

    const result = await withHouseholdContext(deps, USER, (ctx) =>
      readWorkingSet(ctx, { cursor: null, now: NOW }),
    )

    expect(result.accounts).toEqual([])
    expect(result.balances).toEqual([])
    expect(result.transactions).toEqual([])
  })

  it('never returns another household’s data', async () => {
    await withHouseholdContext(deps, USER, seedAccount)
    await withHouseholdContext(deps, OTHER_USER, (ctx) =>
      seedAccount(ctx, { name: 'Not Yours', balanceCents: 999_999n }),
    )

    const mine = await withHouseholdContext(deps, USER, (ctx) =>
      readWorkingSet(ctx, { cursor: null, now: NOW }),
    )

    expect(mine.accounts).toHaveLength(1)
    expect(mine.accounts.map((account) => account.name)).not.toContain('Not Yours')
    expect(mine.balances).toHaveLength(1)
    expect(mine.transactions).toHaveLength(1)
  })

  it('never includes an access URL in any form', async () => {
    await withHouseholdContext(deps, USER, seedAccount)

    const result = await withHouseholdContext(deps, USER, (ctx) =>
      readWorkingSet(ctx, { cursor: null, now: NOW }),
    )

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('simplefin.org')
    expect(serialized).not.toMatch(/accessUrl|access_url/i)
  })

  describe('delta', () => {
    it('returns nothing new when nothing has changed', async () => {
      await withHouseholdContext(deps, USER, seedAccount)

      // A cursor taken after the seed, from the clock that stamped it.
      const cursor = await withHouseholdContext(deps, USER, async (ctx) =>
        (await dbNow(ctx)).toISOString(),
      )

      const second = await withHouseholdContext(deps, USER, async (ctx) =>
        readWorkingSet(ctx, { cursor, now: await dbNow(ctx) }),
      )

      expect(second.accounts).toEqual([])
      expect(second.transactions).toEqual([])
      expect(second.balances).toEqual([])
    })

    /**
     * The overlap doing its job (§7.3). A row written moments before the cursor comes back again
     * rather than being assumed delivered — the client upserts by id, so a duplicate costs nothing,
     * while a row that falls into the gap between `updated_at` and commit is lost permanently.
     */
    it('re-sends rows written just inside the overlap, rather than risking a gap', async () => {
      await withHouseholdContext(deps, USER, seedAccount)

      const first = await withHouseholdContext(deps, USER, async (ctx) =>
        readWorkingSet(ctx, { cursor: null, now: await dbNow(ctx) }),
      )

      const second = await withHouseholdContext(deps, USER, async (ctx) =>
        readWorkingSet(ctx, { cursor: first.cursor, now: await dbNow(ctx) }),
      )

      expect(second.accounts).toHaveLength(1)
    })

    /**
     * The case §7.3 calls out specifically: reconstruction rewrites history when a late transaction
     * posts, so snapshot rows change without anything being inserted. A cursor keyed off
     * `created_at` would never carry this to the client.
     */
    it('picks up a snapshot that was rewritten in place', async () => {
      const accountId = await withHouseholdContext(deps, USER, seedAccount)

      const cursor = await withHouseholdContext(deps, USER, async (ctx) =>
        (await dbNow(ctx)).toISOString(),
      )

      await withHouseholdContext(deps, USER, async (ctx) => {
        await ctx.client.query(
          `update balance_snapshots set balance = $1 where account_id = $2 and as_of_date = '2026-08-01'`,
          [ctx.cipher.encryptMoney(11_111n), accountId],
        )
      })

      const second = await withHouseholdContext(deps, USER, async (ctx) =>
        readWorkingSet(ctx, { cursor, now: await dbNow(ctx) }),
      )

      // Nothing was inserted — the row's own `updated_at` moved, which is the only signal there is.
      expect(second.balances).toHaveLength(1)
      expect(second.balances[0]?.balance).toBe('111.11')
      expect(second.accounts).toEqual([])
    })

    it('reports deletions so the client can drop rows the server no longer has', async () => {
      const accountId = await withHouseholdContext(deps, USER, seedAccount)

      const cursor = await withHouseholdContext(deps, USER, async (ctx) =>
        (await dbNow(ctx)).toISOString(),
      )

      await withHouseholdContext(deps, USER, async (ctx) => {
        await ctx.client.query(
          `insert into deletions (household_id, entity_type, entity_id) values ($1, 'account', $2)`,
          [ctx.householdId, accountId],
        )
      })

      const second = await withHouseholdContext(deps, USER, async (ctx) =>
        readWorkingSet(ctx, { cursor, now: await dbNow(ctx) }),
      )

      expect(second.deletions).toEqual([{ entityType: 'account', entityId: accountId }])
    })

    it('sends no deletions on a first sync, since nothing is cached to delete', async () => {
      const accountId = await withHouseholdContext(deps, USER, seedAccount)
      await withHouseholdContext(deps, USER, async (ctx) => {
        await ctx.client.query(
          `insert into deletions (household_id, entity_type, entity_id) values ($1, 'account', $2)`,
          [ctx.householdId, accountId],
        )
      })

      const result = await withHouseholdContext(deps, USER, (ctx) =>
        readWorkingSet(ctx, { cursor: null, now: NOW }),
      )
      expect(result.deletions).toEqual([])
    })

    /**
     * Beyond tombstone retention the server cannot prove what was deleted, so a delta would be
     * silently incomplete — the client would keep showing rows that no longer exist forever.
     */
    it('demands a full resync for a cursor older than tombstone retention', async () => {
      await withHouseholdContext(deps, USER, seedAccount)

      const result = await withHouseholdContext(deps, USER, async (ctx) => {
        const clock = await dbNow(ctx)
        const ancient = new Date(clock.getTime() - 91 * 86_400_000).toISOString()
        return readWorkingSet(ctx, { cursor: ancient, now: clock })
      })

      expect(result.fullResyncRequired).toBe(true)
      expect(result.accounts).toEqual([])
    })

    it('serves a cursor just inside retention normally', async () => {
      await withHouseholdContext(deps, USER, seedAccount)

      const result = await withHouseholdContext(deps, USER, async (ctx) => {
        const clock = await dbNow(ctx)
        const recent = new Date(clock.getTime() - 89 * 86_400_000).toISOString()
        return readWorkingSet(ctx, { cursor: recent, now: clock })
      })

      expect(result.fullResyncRequired).toBe(false)
      expect(result.accounts).toHaveLength(1)
    })

    /**
     * The cursor is taken before the reads and rewound, so a row committed while the reads run gets
     * re-sent rather than skipped. Re-sending is free — the client upserts by id — and skipping is
     * permanent.
     */
    it('returns a cursor behind the clock, so a concurrent write cannot be skipped', async () => {
      await withHouseholdContext(deps, USER, seedAccount)

      const result = await withHouseholdContext(deps, USER, (ctx) =>
        readWorkingSet(ctx, { cursor: null, now: NOW }),
      )

      expect(Date.parse(result.cursor)).toBeLessThan(NOW.getTime())
    })
  })

  describe('window', () => {
    it('excludes history older than the requested window', async () => {
      await withHouseholdContext(deps, USER, async (ctx) => {
        const accountId = await seedAccount(ctx)
        await ctx.client.query(
          `insert into balance_snapshots (household_id, account_id, as_of_date, balance, source)
           values ($1, $2, '2020-01-01', $3, 'imported')`,
          [ctx.householdId, accountId, ctx.cipher.encryptMoney(1n)],
        )
      })

      const result = await withHouseholdContext(deps, USER, (ctx) =>
        readWorkingSet(ctx, { cursor: null, from: '2026-01-01', now: NOW }),
      )

      expect(result.balances.map((balance) => balance.asOfDate)).toEqual(['2026-08-01'])
      expect(result.coverageFrom).toBe('2026-01-01')
    })

    it('reaches back far enough by default to cover the longest range', async () => {
      const result = await withHouseholdContext(deps, USER, (ctx) =>
        readWorkingSet(ctx, { cursor: null, now: NOW }),
      )

      // Two years, so the 1-year and last-year ranges both have data behind them.
      expect(result.coverageFrom <= '2024-08-05').toBe(true)
    })
  })
})
