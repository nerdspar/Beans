import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { DataKeyCache } from '../crypto/data-key-cache.js'
import { LocalMasterKeyProvider } from '../crypto/local-master-key-provider.js'
import { resetAll, resetHouseholdsFor } from '../test-support/reset-database.js'
import {
  confirmAccounts,
  createConnection,
  discoverAccounts,
  loadAccessUrl,
  reconnect,
  type AccountConfirmation,
} from './connections.js'
import {
  createHousehold,
  withHouseholdContext,
  type ContextDependencies,
} from './household-context.js'

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL']
const MASTER_KEY = Buffer.alloc(32, 0x11).toString('base64')

const USER = 'connections-user-fixed-id'
const CLAIM_URL = 'https://beta-bridge.simplefin.org/simplefin/claim/TOKEN123'
const SETUP_TOKEN = Buffer.from(CLAIM_URL, 'utf8').toString('base64')
const ACCESS_URL = 'https://user123:pass456@beta-bridge.simplefin.org/simplefin'
const NOW = new Date('2026-08-03T12:00:00.000Z')

/** Two accounts, one of which reports its card balance as a positive amount owed. */
const BALANCES_RESPONSE = {
  errors: ['Connection to Chase may need attention'],
  accounts: [
    {
      org: { domain: 'www.bankofamerica.com', name: 'Bank of America' },
      id: 'ACT-checking',
      name: 'Adv Relationship Banking',
      currency: 'USD',
      balance: '547.70',
      'balance-date': 1_785_762_200,
    },
    {
      org: { domain: 'www.chase.com', name: 'Chase' },
      id: 'ACT-card',
      name: 'Amazon Card',
      currency: 'USD',
      // Positive magnitude owed. Taken at face value this would ADD the debt to net worth.
      balance: '3386.39',
      'balance-date': 1_785_762_300,
    },
  ],
}

const describeIntegration = TEST_DATABASE_URL === undefined ? describe.skip : describe

describeIntegration('simplefin connections', () => {
  let pool: Pool
  let deps: ContextDependencies

  const claimFetcher = () =>
    vi.fn().mockImplementation(async (url: unknown) => {
      if (String(url).includes('/claim/')) {
        return new Response(ACCESS_URL, { status: 200 })
      }
      return new Response(JSON.stringify(BALANCES_RESPONSE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 10_000 })
    deps = {
      pool,
      keyProvider: LocalMasterKeyProvider.fromObject({
        currentVersion: 1,
        keys: { 1: MASTER_KEY },
      }),
      keyCache: new DataKeyCache({ now: () => 1_000_000 }),
    }
    await resetAll(pool)
    await pool.query(
      'insert into auth_user (id, name, email, email_verified) values ($1, $2, $3, false)',
      [USER, 'Test User', 'connections@example.com'],
    )
  })

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await resetHouseholdsFor(deps, [USER])
    await createHousehold(deps, USER, 'The Goldbergs')
  })

  it('claims a setup token and stores the access URL encrypted', async () => {
    const fetcher = claimFetcher()

    const { connectionId } = await withHouseholdContext(deps, USER, async (ctx) =>
      createConnection(ctx, SETUP_TOKEN, fetcher),
    )

    const stored = await withHouseholdContext(deps, USER, async (ctx) => {
      const rows = await ctx.client.query<{ access_url: Buffer }>(
        'select access_url from connections where id = $1',
        [connectionId],
      )
      return rows.rows[0]?.access_url
    })

    expect(stored?.toString('utf8')).not.toContain('pass456')

    const decrypted = await withHouseholdContext(deps, USER, async (ctx) =>
      loadAccessUrl(ctx, connectionId),
    )
    expect(decrypted).toBe(ACCESS_URL)
  })

  describe('discovery', () => {
    it('writes nothing to accounts', async () => {
      const fetcher = claimFetcher()

      await withHouseholdContext(deps, USER, async (ctx) => {
        const { connectionId } = await createConnection(ctx, SETUP_TOKEN, fetcher)
        await discoverAccounts(ctx, connectionId, fetcher)
      })

      const count = await withHouseholdContext(deps, USER, async (ctx) =>
        ctx.client.query('select 1 from accounts'),
      )
      expect(count.rowCount).toBe(0)
    })

    it('uses balances-only, since there is nowhere to put transactions yet', async () => {
      const fetcher = claimFetcher()

      await withHouseholdContext(deps, USER, async (ctx) => {
        const { connectionId } = await createConnection(ctx, SETUP_TOKEN, fetcher)
        await discoverAccounts(ctx, connectionId, fetcher)
      })

      const accountsCall = fetcher.mock.calls.find((call) => String(call[0]).includes('/accounts'))
      expect(new URL(String(accountsCall?.[0])).searchParams.get('balances-only')).toBe('1')
    })

    it('surfaces provider errors rather than swallowing them', async () => {
      const fetcher = claimFetcher()

      const result = await withHouseholdContext(deps, USER, async (ctx) => {
        const { connectionId } = await createConnection(ctx, SETUP_TOKEN, fetcher)
        return discoverAccounts(ctx, connectionId, fetcher)
      })

      expect(result.errors).toEqual(['Connection to Chase may need attention'])
    })

    it('admits when it cannot guess a type', async () => {
      const fetcher = claimFetcher()

      const result = await withHouseholdContext(deps, USER, async (ctx) => {
        const { connectionId } = await createConnection(ctx, SETUP_TOKEN, fetcher)
        return discoverAccounts(ctx, connectionId, fetcher)
      })

      const checking = result.accounts.find((a) => a.simplefinAccountId === 'ACT-checking')
      expect(checking?.typeGuess.confidence).toBe('low')
      // ...and therefore declines to suggest a sign flip off a shaky guess.
      expect(checking?.suggestedSignInverted).toBeNull()
    })

    /**
     * The core case. A card reported as a positive amount owed would, taken at face value, add the
     * debt to net worth — a doubled error in a plausible-looking direction.
     */
    it('suggests flipping a card reported as a positive amount owed', async () => {
      const fetcher = claimFetcher()

      const result = await withHouseholdContext(deps, USER, async (ctx) => {
        const { connectionId } = await createConnection(ctx, SETUP_TOKEN, fetcher)
        return discoverAccounts(ctx, connectionId, fetcher)
      })

      const card = result.accounts.find((a) => a.simplefinAccountId === 'ACT-card')
      expect(card?.typeGuess.type).toBe('credit')
      expect(card?.providerBalanceCents).toBe(338639n)
      expect(card?.suggestedSignInverted).toBe(true)
      // Our reading of it, shown beside the provider's raw value.
      expect(card?.interpretedBalanceCents).toBe(-338639n)
      // With the suggestion applied the sign is plausible, so nothing is flagged.
      expect(card?.anomaly).toBeNull()
    })
  })

  describe('confirmation', () => {
    const confirmAll = async (overrides: Record<string, Partial<AccountConfirmation>> = {}) =>
      withHouseholdContext(deps, USER, async (ctx) => {
        const fetcher = claimFetcher()
        const { connectionId } = await createConnection(ctx, SETUP_TOKEN, fetcher)
        const discovery = await discoverAccounts(ctx, connectionId, fetcher)

        const confirmations: AccountConfirmation[] = discovery.accounts.map((account) => ({
          simplefinAccountId: account.simplefinAccountId,
          type: account.typeGuess.type,
          signInverted: account.suggestedSignInverted ?? false,
          include: true,
          ...overrides[account.simplefinAccountId],
        }))

        const result = await confirmAccounts(
          ctx,
          connectionId,
          confirmations,
          discovery.accounts,
          NOW,
        )
        return { connectionId, result }
      })

    it('stores the confirmed balance with the corrected sign', async () => {
      await confirmAll()

      const balances = await withHouseholdContext(deps, USER, async (ctx) => {
        // Cast to text: Postgres orders an enum by its declaration order, not alphabetically.
        const rows = await ctx.client.query<{ type: string; current_balance: Buffer }>(
          'select type, current_balance from accounts order by type::text',
        )
        return rows.rows.map((r) => ({
          type: r.type,
          balance: ctx.cipher.decryptMoney(r.current_balance),
        }))
      })

      expect(balances).toEqual([
        { type: 'credit', balance: -338639n },
        { type: 'depository', balance: 54770n },
      ])
    })

    it('honors a user overriding our guess', async () => {
      await confirmAll({
        'ACT-checking': { displayName: 'Everyday Checking' },
        'ACT-card': { signInverted: false },
      })

      const stored = await withHouseholdContext(deps, USER, async (ctx) => {
        const rows = await ctx.client.query<{
          display_name: Buffer | null
          current_balance: Buffer
          type: string
          type_is_user_set: boolean
          provider_sign_inverted: boolean
        }>(
          'select display_name, current_balance, type, type_is_user_set, provider_sign_inverted from accounts',
        )
        return rows.rows.map((r) => ({
          displayName: ctx.cipher.decryptTextOrNull(r.display_name),
          balance: ctx.cipher.decryptMoney(r.current_balance),
          type: r.type,
          userSet: r.type_is_user_set,
          inverted: r.provider_sign_inverted,
        }))
      })

      const card = stored.find((a) => a.type === 'credit')
      expect(card?.inverted).toBe(false)
      // The user's choice is respected even though it produces an implausible sign.
      expect(card?.balance).toBe(338639n)

      const checking = stored.find((a) => a.type === 'depository')
      expect(checking?.displayName).toBe('Everyday Checking')
      // Always true — the user saw the guess and either accepted or changed it, so sync must never
      // overwrite the outcome.
      expect(stored.every((a) => a.userSet)).toBe(true)
    })

    it('skips accounts the user excluded', async () => {
      await confirmAll({ 'ACT-card': { include: false } })

      const types = await withHouseholdContext(deps, USER, async (ctx) => {
        const rows = await ctx.client.query<{ type: string }>('select type from accounts')
        return rows.rows.map((r) => r.type)
      })

      expect(types).toEqual(['depository'])
    })

    it('creates a household-scoped institution with an encrypted name', async () => {
      await confirmAll()

      const institutions = await withHouseholdContext(deps, USER, async (ctx) => {
        const rows = await ctx.client.query<{ simplefin_org_domain: string; name: Buffer }>(
          'select simplefin_org_domain, name from institutions order by simplefin_org_domain',
        )
        return rows.rows.map((r) => ({
          name: ctx.cipher.decryptText(r.name),
          ciphertext: r.name.toString('utf8'),
        }))
      })

      expect(institutions.map((i) => i.name)).toEqual(['Bank of America', 'Chase'])
      expect(institutions[0]?.ciphertext).not.toContain('Bank of America')
    })

    it('is idempotent, updating rather than duplicating on re-confirmation', async () => {
      const { connectionId } = await confirmAll()

      const again = await withHouseholdContext(deps, USER, async (ctx) => {
        const fetcher = claimFetcher()
        const discovery = await discoverAccounts(ctx, connectionId, fetcher)

        // Everything is already linked, so this is a reconnect rather than a discovery.
        expect(discovery.accounts.every((a) => a.alreadyLinked)).toBe(true)

        return confirmAccounts(
          ctx,
          connectionId,
          discovery.accounts.map((account) => ({
            simplefinAccountId: account.simplefinAccountId,
            type: account.typeGuess.type,
            signInverted: account.suggestedSignInverted ?? false,
            include: true,
          })),
          discovery.accounts,
          NOW,
        )
      })

      expect(again).toEqual({ created: 0, updated: 2 })

      const count = await withHouseholdContext(deps, USER, async (ctx) =>
        ctx.client.query('select 1 from accounts'),
      )
      expect(count.rowCount).toBe(2)
    })

    it('rejects a confirmation for an account that was never discovered', async () => {
      await expect(
        withHouseholdContext(deps, USER, async (ctx) => {
          const fetcher = claimFetcher()
          const { connectionId } = await createConnection(ctx, SETUP_TOKEN, fetcher)
          const discovery = await discoverAccounts(ctx, connectionId, fetcher)

          return confirmAccounts(
            ctx,
            connectionId,
            [
              {
                simplefinAccountId: 'ACT-invented',
                type: 'depository',
                signInverted: false,
                include: true,
              },
            ],
            discovery.accounts,
            NOW,
          )
        }),
      ).rejects.toThrow(/was not discovered/)
    })
  })

  describe('reconnect', () => {
    it('replaces the access URL on the existing connection, preserving accounts', async () => {
      const fetcher = claimFetcher()

      const connectionId = await withHouseholdContext(deps, USER, async (ctx) => {
        const created = await createConnection(ctx, SETUP_TOKEN, fetcher)
        const discovery = await discoverAccounts(ctx, created.connectionId, fetcher)
        await confirmAccounts(
          ctx,
          created.connectionId,
          discovery.accounts.map((a) => ({
            simplefinAccountId: a.simplefinAccountId,
            type: a.typeGuess.type,
            signInverted: a.suggestedSignInverted ?? false,
            include: true,
          })),
          discovery.accounts,
          NOW,
        )
        return created.connectionId
      })

      const accountIdsBefore = await withHouseholdContext(deps, USER, async (ctx) => {
        const rows = await ctx.client.query<{ id: string }>('select id from accounts order by id')
        return rows.rows.map((r) => r.id)
      })

      const newAccessUrl = 'https://newuser:newpass@beta-bridge.simplefin.org/simplefin'
      const reconnectFetcher = vi
        .fn()
        .mockImplementation(async () => new Response(newAccessUrl, { status: 200 }))

      await withHouseholdContext(deps, USER, async (ctx) =>
        reconnect(ctx, connectionId, SETUP_TOKEN, reconnectFetcher),
      )

      const stored = await withHouseholdContext(deps, USER, async (ctx) =>
        loadAccessUrl(ctx, connectionId),
      )
      expect(stored).toBe(newAccessUrl)

      // Under no circumstances may reconnecting move or duplicate accounts.
      const accountIdsAfter = await withHouseholdContext(deps, USER, async (ctx) => {
        const rows = await ctx.client.query<{ id: string }>('select id from accounts order by id')
        return rows.rows.map((r) => r.id)
      })
      expect(accountIdsAfter).toEqual(accountIdsBefore)

      const connectionCount = await withHouseholdContext(deps, USER, async (ctx) =>
        ctx.client.query('select 1 from connections'),
      )
      expect(connectionCount.rowCount).toBe(1)
    })

    it('clears the failure state', async () => {
      const fetcher = claimFetcher()
      const connectionId = await withHouseholdContext(deps, USER, async (ctx) => {
        const created = await createConnection(ctx, SETUP_TOKEN, fetcher)
        await ctx.client.query(
          `update connections set status = 'error', consecutive_failures = 5 where id = $1`,
          [created.connectionId],
        )
        return created.connectionId
      })

      await withHouseholdContext(deps, USER, async (ctx) =>
        reconnect(ctx, connectionId, SETUP_TOKEN, claimFetcher()),
      )

      const state = await withHouseholdContext(deps, USER, async (ctx) => {
        const rows = await ctx.client.query<{ status: string; consecutive_failures: number }>(
          'select status, consecutive_failures from connections where id = $1',
          [connectionId],
        )
        return rows.rows[0]
      })

      expect(state).toEqual({ status: 'healthy', consecutive_failures: 0 })
    })
  })
})
