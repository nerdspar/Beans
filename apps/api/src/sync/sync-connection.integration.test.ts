import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { DataKeyCache } from '../crypto/data-key-cache.js'
import { LocalMasterKeyProvider } from '../crypto/local-master-key-provider.js'
import { confirmAccounts, createConnection, discoverAccounts } from '../repositories/connections.js'
import {
  createHousehold,
  withHouseholdContext,
  type ContextDependencies,
} from '../repositories/household-context.js'
import { resetAll, resetHouseholdsFor } from '../test-support/reset-database.js'
import { connectionStatusFor, syncConnection } from './sync-connection.js'

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL']
const MASTER_KEY = Buffer.alloc(32, 0x11).toString('base64')

const USER = 'sync-user-fixed-id'
const CLAIM_URL = 'https://beta-bridge.simplefin.org/simplefin/claim/TOKEN'
const SETUP_TOKEN = Buffer.from(CLAIM_URL, 'utf8').toString('base64')
const ACCESS_URL = 'https://u:p@beta-bridge.simplefin.org/simplefin'

const NOW = new Date('2026-08-03T12:00:00.000Z')
const LAST_SUCCESS = new Date('2026-07-30T12:00:00.000Z')

const epoch = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000)

/** A card whose provider reports the balance as a positive amount owed. */
const cardAccount = (
  balance: string,
  transactions: Array<Record<string, unknown>>,
): Record<string, unknown> => ({
  org: { domain: 'www.chase.com', name: 'Chase' },
  id: 'ACT-card',
  name: 'Amazon Card',
  currency: 'USD',
  balance,
  'balance-date': epoch('2026-08-03T11:00:00Z'),
  transactions,
})

const describeIntegration = TEST_DATABASE_URL === undefined ? describe.skip : describe

describeIntegration('connection sync', () => {
  let pool: Pool
  let deps: ContextDependencies

  /** A fetcher whose /accounts response can be swapped per test. */
  const makeFetcher = (accountsBody: unknown) =>
    vi.fn().mockImplementation(async (url: unknown) => {
      if (String(url).includes('/claim/')) {
        return new Response(ACCESS_URL, { status: 200 })
      }
      return new Response(JSON.stringify(accountsBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

  /** Creates a connection with the card account confirmed and sign-inverted. */
  async function setUpConnection(): Promise<string> {
    return withHouseholdContext(deps, USER, async (ctx) => {
      const fetcher = makeFetcher({ errors: [], accounts: [cardAccount('3386.39', [])] })
      const { connectionId } = await createConnection(ctx, SETUP_TOKEN, fetcher)
      const discovery = await discoverAccounts(ctx, connectionId, fetcher)

      await confirmAccounts(
        ctx,
        connectionId,
        discovery.accounts.map((a) => ({
          simplefinAccountId: a.simplefinAccountId,
          type: 'credit' as const,
          signInverted: true,
          include: true,
        })),
        discovery.accounts,
        NOW,
      )

      return connectionId
    })
  }

  const readTransactions = async () =>
    withHouseholdContext(deps, USER, async (ctx) => {
      const rows = await ctx.client.query<{
        simplefin_id: string
        amount: Buffer
        description: Buffer
        pending: boolean
        status: string
        posted_date: string
      }>('select simplefin_id, amount, description, pending, status, posted_date from transactions')
      return rows.rows.map((r) => ({
        id: r.simplefin_id,
        amount: ctx.cipher.decryptMoney(r.amount),
        description: ctx.cipher.decryptText(r.description),
        pending: r.pending,
        status: r.status,
        postedDate: r.posted_date,
      }))
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
      [USER, 'Test User', 'sync@example.com'],
    )
  })

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await resetHouseholdsFor(deps, [USER])
    await createHousehold(deps, USER, 'The Goldbergs')
  })

  it('applies the sign convention to the balance', async () => {
    const connectionId = await setUpConnection()

    await withHouseholdContext(deps, USER, async (ctx) =>
      syncConnection(
        ctx,
        connectionId,
        makeFetcher({ errors: [], accounts: [cardAccount('3386.39', [])] }),
        {
          lastSuccessAt: LAST_SUCCESS,
          now: NOW,
        },
      ),
    )

    const balance = await withHouseholdContext(deps, USER, async (ctx) => {
      const rows = await ctx.client.query<{ current_balance: Buffer }>(
        'select current_balance from accounts',
      )
      return ctx.cipher.decryptMoney(rows.rows[0]!.current_balance)
    })

    // Provider said +3386.39; stored as a liability.
    expect(balance).toBe(-338639n)
  })

  /**
   * Deliberate and load-bearing. The protocol *does* specify a transaction sign, and only the
   * balance sign is unspecified — so inverting both would corrupt the half that is consistent.
   * See the note at the top of sync-connection.ts.
   */
  it('does not apply the sign convention to transaction amounts', async () => {
    const connectionId = await setUpConnection()

    await withHouseholdContext(deps, USER, async (ctx) =>
      syncConnection(
        ctx,
        connectionId,
        makeFetcher({
          errors: [],
          accounts: [
            cardAccount('3386.39', [
              {
                id: 'TRN-1',
                posted: epoch('2026-08-01T00:00:00Z'),
                amount: '-52.40',
                description: "TRADER JOE'S",
              },
            ]),
          ],
        }),
        { lastSuccessAt: LAST_SUCCESS, now: NOW },
      ),
    )

    const [transaction] = await readTransactions()
    // Spending stays negative, even though the account's balance was inverted.
    expect(transaction?.amount).toBe(-5240n)
  })

  it('stores the posted date as a date, not a timestamp', async () => {
    const connectionId = await setUpConnection()

    await withHouseholdContext(deps, USER, async (ctx) =>
      syncConnection(
        ctx,
        connectionId,
        makeFetcher({
          errors: [],
          accounts: [
            cardAccount('3386.39', [
              {
                id: 'TRN-1',
                posted: epoch('2026-08-01T23:30:00Z'),
                amount: '-52.40',
                description: 'Late night',
              },
            ]),
          ],
        }),
        { lastSuccessAt: LAST_SUCCESS, now: NOW },
      ),
    )

    const [transaction] = await readTransactions()
    expect(transaction?.postedDate).toBe('2026-08-01')
  })

  describe('idempotency', () => {
    it('running the same payload twice changes nothing', async () => {
      const connectionId = await setUpConnection()
      const body = {
        errors: [],
        accounts: [
          cardAccount('3386.39', [
            {
              id: 'TRN-1',
              posted: epoch('2026-08-01T00:00:00Z'),
              amount: '-52.40',
              description: "TRADER JOE'S",
            },
          ]),
        ],
      }

      for (let run = 0; run < 2; run += 1) {
        await withHouseholdContext(deps, USER, async (ctx) =>
          syncConnection(ctx, connectionId, makeFetcher(body), {
            lastSuccessAt: LAST_SUCCESS,
            now: NOW,
          }),
        )
      }

      const transactions = await readTransactions()
      expect(transactions).toHaveLength(1)
      expect(transactions[0]?.amount).toBe(-5240n)
    })

    it('updates an amended transaction in place rather than duplicating', async () => {
      const connectionId = await setUpConnection()

      const withAmount = (amount: string, description: string) => ({
        errors: [],
        accounts: [
          cardAccount('3386.39', [
            { id: 'TRN-1', posted: epoch('2026-08-01T00:00:00Z'), amount, description },
          ]),
        ],
      })

      await withHouseholdContext(deps, USER, async (ctx) =>
        syncConnection(ctx, connectionId, makeFetcher(withAmount('-52.40', 'PENDING AUTH')), {
          lastSuccessAt: LAST_SUCCESS,
          now: NOW,
        }),
      )

      // The institution later amends both amount and description.
      await withHouseholdContext(deps, USER, async (ctx) =>
        syncConnection(ctx, connectionId, makeFetcher(withAmount('-58.10', "TRADER JOE'S #452")), {
          lastSuccessAt: LAST_SUCCESS,
          now: NOW,
        }),
      )

      const transactions = await readTransactions()
      expect(transactions).toHaveLength(1)
      expect(transactions[0]?.amount).toBe(-5810n)
      expect(transactions[0]?.description).toBe("TRADER JOE'S #452")
    })

    it('keeps the row identity when a pending transaction posts', async () => {
      const connectionId = await setUpConnection()

      const build = (pending: boolean, posted: number) => ({
        errors: [],
        accounts: [
          cardAccount('3386.39', [
            {
              id: 'TRN-1',
              posted,
              amount: '-52.40',
              description: "TRADER JOE'S",
              transacted_at: epoch('2026-08-01T00:00:00Z'),
              ...(pending ? { pending: true } : {}),
            },
          ]),
        ],
      })

      await withHouseholdContext(deps, USER, async (ctx) =>
        syncConnection(ctx, connectionId, makeFetcher(build(true, 0)), {
          lastSuccessAt: LAST_SUCCESS,
          now: NOW,
        }),
      )
      expect((await readTransactions())[0]?.pending).toBe(true)

      await withHouseholdContext(deps, USER, async (ctx) =>
        syncConnection(
          ctx,
          connectionId,
          makeFetcher(build(false, epoch('2026-08-02T00:00:00Z'))),
          { lastSuccessAt: LAST_SUCCESS, now: NOW },
        ),
      )

      const transactions = await readTransactions()
      expect(transactions).toHaveLength(1)
      expect(transactions[0]?.pending).toBe(false)
      expect(transactions[0]?.postedDate).toBe('2026-08-02')
    })
  })

  describe('vanished pending transactions', () => {
    /**
     * A documented SimpleFIN failure mode: a pending transaction that never posts simply disappears
     * from the response with no tombstone. Left alone it strands in the ledger forever.
     */
    it('voids a pending transaction that disappears', async () => {
      const connectionId = await setUpConnection()

      await withHouseholdContext(deps, USER, async (ctx) =>
        syncConnection(
          ctx,
          connectionId,
          makeFetcher({
            errors: [],
            accounts: [
              cardAccount('3386.39', [
                {
                  id: 'TRN-vanishing',
                  posted: 0,
                  transacted_at: epoch('2026-08-01T00:00:00Z'),
                  amount: '-52.40',
                  description: 'HOLD',
                  pending: true,
                },
              ]),
            ],
          }),
          { lastSuccessAt: LAST_SUCCESS, now: NOW },
        ),
      )

      expect((await readTransactions())[0]?.status).toBe('active')

      // Next sync: it is simply gone.
      const outcome = await withHouseholdContext(deps, USER, async (ctx) =>
        syncConnection(
          ctx,
          connectionId,
          makeFetcher({ errors: [], accounts: [cardAccount('3386.39', [])] }),
          {
            lastSuccessAt: LAST_SUCCESS,
            now: NOW,
          },
        ),
      )

      expect(outcome.transactionsVoided).toBe(1)

      const transactions = await readTransactions()
      // Voided, not deleted — delta sync has to be able to carry the change to clients.
      expect(transactions).toHaveLength(1)
      expect(transactions[0]?.status).toBe('void')
    })

    it('does not void a posted transaction that falls out of the window', async () => {
      const connectionId = await setUpConnection()

      await withHouseholdContext(deps, USER, async (ctx) =>
        syncConnection(
          ctx,
          connectionId,
          makeFetcher({
            errors: [],
            accounts: [
              cardAccount('3386.39', [
                {
                  id: 'TRN-posted',
                  posted: epoch('2026-08-01T00:00:00Z'),
                  amount: '-52.40',
                  description: 'REAL',
                },
              ]),
            ],
          }),
          { lastSuccessAt: LAST_SUCCESS, now: NOW },
        ),
      )

      await withHouseholdContext(deps, USER, async (ctx) =>
        syncConnection(
          ctx,
          connectionId,
          makeFetcher({ errors: [], accounts: [cardAccount('3386.39', [])] }),
          {
            lastSuccessAt: LAST_SUCCESS,
            now: NOW,
          },
        ),
      )

      // Only pending rows are reaped. A posted transaction absent from a response is normal.
      expect((await readTransactions())[0]?.status).toBe('active')
    })

    it('does not reap when the run was cut short by rate limiting', async () => {
      const connectionId = await setUpConnection()

      await withHouseholdContext(deps, USER, async (ctx) =>
        syncConnection(
          ctx,
          connectionId,
          makeFetcher({
            errors: [],
            accounts: [
              cardAccount('3386.39', [
                {
                  id: 'TRN-pending',
                  posted: 0,
                  transacted_at: epoch('2026-08-01T00:00:00Z'),
                  amount: '-52.40',
                  description: 'HOLD',
                  pending: true,
                },
              ]),
            ],
          }),
          { lastSuccessAt: LAST_SUCCESS, now: NOW },
        ),
      )

      const outcome = await withHouseholdContext(deps, USER, async (ctx) =>
        syncConnection(
          ctx,
          connectionId,
          makeFetcher({
            errors: ['Too many requests. SimpleFIN data is only refreshed once every 24 hours.'],
            accounts: [],
          }),
          { lastSuccessAt: LAST_SUCCESS, now: NOW },
        ),
      )

      expect(outcome.rateLimited).toBe(true)
      // An incomplete picture must not be used to delete real data.
      expect(outcome.transactionsVoided).toBe(0)
      expect((await readTransactions())[0]?.status).toBe('active')
    })
  })

  describe('provider errors', () => {
    it('surfaces them without discarding the accounts that did work', async () => {
      const connectionId = await setUpConnection()

      const outcome = await withHouseholdContext(deps, USER, async (ctx) =>
        syncConnection(
          ctx,
          connectionId,
          makeFetcher({
            errors: ['Connection to Chase may need attention'],
            accounts: [cardAccount('3386.39', [])],
          }),
          { lastSuccessAt: LAST_SUCCESS, now: NOW },
        ),
      )

      expect(outcome.errors).toEqual(['Connection to Chase may need attention'])
      expect(outcome.accountsUpdated).toBeGreaterThan(0)
      // A 200 carrying a connection complaint means stale balances, so it is not healthy.
      expect(connectionStatusFor(outcome)).toBe('error')
    })

    it('reports stale rather than healthy when rate limited', () => {
      expect(
        connectionStatusFor({
          accountsUpdated: 0,
          transactionsUpserted: 0,
          transactionsVoided: 0,
          requestsSpent: 1,
          errors: [],
          rateLimited: true,
          accountIds: new Set<string>(),
          holdingsRecorded: 0,
        }),
      ).toBe('stale')
    })
  })

  it('ignores provider accounts that were never confirmed', async () => {
    const connectionId = await setUpConnection()

    await withHouseholdContext(deps, USER, async (ctx) =>
      syncConnection(
        ctx,
        connectionId,
        makeFetcher({
          errors: [],
          accounts: [
            cardAccount('3386.39', []),
            {
              org: { domain: 'www.newbank.com', name: 'New Bank' },
              id: 'ACT-unconfirmed',
              name: 'Surprise Account',
              currency: 'USD',
              balance: '999.00',
              'balance-date': epoch('2026-08-03T11:00:00Z'),
              transactions: [],
            },
          ],
        }),
        { lastSuccessAt: LAST_SUCCESS, now: NOW },
      ),
    )

    // Adopting it silently would bypass type and sign confirmation entirely.
    const count = await withHouseholdContext(deps, USER, async (ctx) =>
      ctx.client.query('select 1 from accounts'),
    )
    expect(count.rowCount).toBe(1)
  })

  it('spends no requests when nothing has been confirmed yet', async () => {
    const fetcher = makeFetcher({ errors: [], accounts: [] })

    const outcome = await withHouseholdContext(deps, USER, async (ctx) => {
      const { connectionId } = await createConnection(ctx, SETUP_TOKEN, fetcher)
      return syncConnection(ctx, connectionId, fetcher, {
        lastSuccessAt: null,
        now: NOW,
      })
    })

    expect(outcome.requestsSpent).toBe(0)
  })
})
