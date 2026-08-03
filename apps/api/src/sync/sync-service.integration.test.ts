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
import { DAILY_REQUEST_BUDGET, RESERVED_FOR_SCHEDULED } from './quota.js'
import { markStaleConnections, runSync } from './sync-service.js'

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL']
const MASTER_KEY = Buffer.alloc(32, 0x11).toString('base64')

const USER = 'syncsvc-user-fixed-id'
const CLAIM_URL = 'https://beta-bridge.simplefin.org/simplefin/claim/TOKEN'
const SETUP_TOKEN = Buffer.from(CLAIM_URL, 'utf8').toString('base64')
const ACCESS_URL = 'https://u:p@beta-bridge.simplefin.org/simplefin'

const NOW = new Date('2026-08-03T12:00:00.000Z')

const epoch = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000)

const account = (transactions: Array<Record<string, unknown>> = []) => ({
  org: { domain: 'www.chase.com', name: 'Chase' },
  id: 'ACT-card',
  name: 'Amazon Card',
  currency: 'USD',
  balance: '3386.39',
  'balance-date': epoch('2026-08-03T11:00:00Z'),
  transactions,
})

const describeIntegration = TEST_DATABASE_URL === undefined ? describe.skip : describe

describeIntegration('sync service', () => {
  let pool: Pool
  let deps: ContextDependencies

  const makeFetcher = (body: unknown, status = 200) =>
    vi.fn().mockImplementation(async (url: unknown) => {
      if (String(url).includes('/claim/')) {
        return new Response(ACCESS_URL, { status: 200 })
      }
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    })

  const okBody = { errors: [], accounts: [account()] }

  async function setUp(): Promise<string> {
    return withHouseholdContext(deps, USER, async (ctx) => {
      const fetcher = makeFetcher(okBody)
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

  const readConnection = async (connectionId: string) =>
    withHouseholdContext(deps, USER, async (ctx) => {
      const rows = await ctx.client.query<{
        status: string
        consecutive_failures: number
        last_success_at: Date | null
        last_error: Buffer | null
      }>(
        'select status, consecutive_failures, last_success_at, last_error from connections where id = $1',
        [connectionId],
      )
      const row = rows.rows[0]!
      return {
        status: row.status,
        failures: row.consecutive_failures,
        lastSuccessAt: row.last_success_at,
        errors: row.last_error === null ? null : ctx.cipher.decryptJson<string[]>(row.last_error),
      }
    })

  const readSyncRuns = async () =>
    withHouseholdContext(deps, USER, async (ctx) => {
      const rows = await ctx.client.query<{
        outcome: string | null
        requests_spent: number
        transactions_upserted: number
        errors: Buffer | null
      }>(
        'select outcome, requests_spent, transactions_upserted, errors from sync_runs order by started_at',
      )
      return rows.rows.map((r) => ({
        outcome: r.outcome,
        requestsSpent: r.requests_spent,
        transactionsUpserted: r.transactions_upserted,
        errors: r.errors === null ? null : ctx.cipher.decryptJson<string[]>(r.errors),
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
      [USER, 'Test User', 'syncsvc@example.com'],
    )
  })

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await resetHouseholdsFor(deps, [USER])
    await createHousehold(deps, USER, 'The Goldbergs')
  })

  it('records a successful run and marks the connection healthy', async () => {
    const connectionId = await setUp()

    const attempt = await withHouseholdContext(deps, USER, async (ctx) =>
      runSync(ctx, connectionId, makeFetcher(okBody), 'scheduled', NOW),
    )

    expect(attempt.ran).toBe(true)

    const runs = await readSyncRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0]?.outcome).toBe('success')
    expect(runs[0]?.requestsSpent).toBeGreaterThan(0)

    const connection = await readConnection(connectionId)
    expect(connection.status).toBe('healthy')
    expect(connection.lastSuccessAt).not.toBeNull()
  })

  /**
   * A 200 carrying a provider complaint is not a success. Calling it one is exactly how staleness
   * becomes invisible — the request worked, but an institution behind it did not.
   */
  it('records a partial run when the provider complains', async () => {
    const connectionId = await setUp()

    await withHouseholdContext(deps, USER, async (ctx) =>
      runSync(
        ctx,
        connectionId,
        makeFetcher({ errors: ['Connection to Chase may need attention'], accounts: [account()] }),
        'scheduled',
        NOW,
      ),
    )

    const runs = await readSyncRuns()
    expect(runs[0]?.outcome).toBe('partial')
    expect(runs[0]?.errors).toEqual(['Connection to Chase may need attention'])

    const connection = await readConnection(connectionId)
    expect(connection.status).toBe('error')
    expect(connection.errors).toEqual(['Connection to Chase may need attention'])
  })

  it('records a failure and increments the backoff counter', async () => {
    const connectionId = await setUp()

    const failing = vi.fn().mockImplementation(async (url: unknown) => {
      if (String(url).includes('/claim/')) return new Response(ACCESS_URL, { status: 200 })
      return new Response('<html>502</html>', { status: 502 })
    })

    const attempt = await withHouseholdContext(deps, USER, async (ctx) =>
      runSync(ctx, connectionId, failing, 'scheduled', NOW),
    )

    // Returned rather than thrown: rethrowing would roll back the transaction and take the audit
    // record of the failure with it, leaving no trace that anything went wrong.
    expect(attempt).toMatchObject({ ran: true, ok: false })

    const runs = await readSyncRuns()
    expect(runs[0]?.outcome).toBe('error')

    const connection = await readConnection(connectionId)
    expect(connection.status).toBe('error')
    expect(connection.failures).toBe(1)
  })

  describe('budget enforcement', () => {
    /**
     * The daily budget is computed by summing `requests_spent` over today's runs, so it survives a
     * restart and cannot drift from what actually happened.
     */
    it('refuses once the daily budget is exhausted', async () => {
      const connectionId = await setUp()

      await withHouseholdContext(deps, USER, async (ctx) => {
        await ctx.client.query(
          `insert into sync_runs (household_id, connection_id, started_at, finished_at, outcome, requests_spent)
           values ($1, $2, $3, $3, 'success', $4)`,
          [ctx.householdId, connectionId, NOW, DAILY_REQUEST_BUDGET],
        )
      })

      const attempt = await withHouseholdContext(deps, USER, async (ctx) =>
        runSync(ctx, connectionId, makeFetcher(okBody), 'scheduled', NOW),
      )

      expect(attempt.ran).toBe(false)
      if (!attempt.ran) {
        expect(attempt.reason).toMatch(/budget/)
        expect(attempt.retryAfter?.toISOString()).toBe('2026-08-04T00:00:00.000Z')
      }
    })

    it('reserves the tail of the budget so a manual refresh cannot starve the schedule', async () => {
      const connectionId = await setUp()

      await withHouseholdContext(deps, USER, async (ctx) => {
        await ctx.client.query(
          `insert into sync_runs (household_id, connection_id, started_at, finished_at, outcome, requests_spent)
           values ($1, $2, $3, $3, 'success', $4)`,
          [ctx.householdId, connectionId, NOW, DAILY_REQUEST_BUDGET - RESERVED_FOR_SCHEDULED],
        )
      })

      const manual = await withHouseholdContext(deps, USER, async (ctx) =>
        runSync(ctx, connectionId, makeFetcher(okBody), 'manual', NOW),
      )
      expect(manual.ran).toBe(false)

      // ...but the scheduled sync still runs, so the numbers keep updating on their own.
      const scheduled = await withHouseholdContext(deps, USER, async (ctx) =>
        runSync(ctx, connectionId, makeFetcher(okBody), 'scheduled', NOW),
      )
      expect(scheduled.ran).toBe(true)
    })

    it('does not count yesterday requests against today', async () => {
      const connectionId = await setUp()

      await withHouseholdContext(deps, USER, async (ctx) => {
        await ctx.client.query(
          `insert into sync_runs (household_id, connection_id, started_at, finished_at, outcome, requests_spent)
           values ($1, $2, $3, $3, 'success', $4)`,
          [
            ctx.householdId,
            connectionId,
            new Date('2026-08-02T23:00:00.000Z'),
            DAILY_REQUEST_BUDGET,
          ],
        )
      })

      const attempt = await withHouseholdContext(deps, USER, async (ctx) =>
        runSync(ctx, connectionId, makeFetcher(okBody), 'scheduled', NOW),
      )
      expect(attempt.ran).toBe(true)
    })

    it('backs off after a failure rather than retrying immediately', async () => {
      const connectionId = await setUp()

      await withHouseholdContext(deps, USER, async (ctx) => {
        await ctx.client.query(
          `update connections set consecutive_failures = 3, last_attempt_at = $1 where id = $2`,
          [NOW, connectionId],
        )
      })

      const tooSoon = await withHouseholdContext(deps, USER, async (ctx) =>
        runSync(
          ctx,
          connectionId,
          makeFetcher(okBody),
          'scheduled',
          new Date(NOW.getTime() + 60_000),
        ),
      )

      expect(tooSoon.ran).toBe(false)
      if (!tooSoon.ran) {
        expect(tooSoon.reason).toMatch(/backing off/)
      }
    })

    it('refusals spend nothing and leave no sync run', async () => {
      const connectionId = await setUp()
      const fetcher = makeFetcher(okBody)

      await withHouseholdContext(deps, USER, async (ctx) => {
        await ctx.client.query(
          `update connections set consecutive_failures = 5, last_attempt_at = $1 where id = $2`,
          [NOW, connectionId],
        )
      })

      await withHouseholdContext(deps, USER, async (ctx) =>
        runSync(ctx, connectionId, fetcher, 'scheduled', NOW),
      )

      // No request issued, and nothing written that would look like an attempt.
      expect(fetcher.mock.calls.filter((c) => String(c[0]).includes('/accounts'))).toHaveLength(0)
      expect(await readSyncRuns()).toHaveLength(0)
    })
  })

  describe('staleness', () => {
    it('marks a connection stale when it has not succeeded recently', async () => {
      const connectionId = await setUp()

      await withHouseholdContext(deps, USER, async (ctx) => {
        await ctx.client.query(`update connections set last_success_at = $1 where id = $2`, [
          new Date('2026-08-01T00:00:00.000Z'),
          connectionId,
        ])
      })

      const marked = await withHouseholdContext(deps, USER, async (ctx) =>
        markStaleConnections(ctx, NOW),
      )

      expect(marked).toBe(1)
      expect((await readConnection(connectionId)).status).toBe('stale')
    })

    it('leaves a recently synced connection healthy', async () => {
      const connectionId = await setUp()

      await withHouseholdContext(deps, USER, async (ctx) =>
        runSync(ctx, connectionId, makeFetcher(okBody), 'scheduled', NOW),
      )

      const marked = await withHouseholdContext(deps, USER, async (ctx) =>
        markStaleConnections(ctx, new Date(NOW.getTime() + 60 * 60 * 1000)),
      )

      expect(marked).toBe(0)
      expect((await readConnection(connectionId)).status).toBe('healthy')
    })

    it('does not overwrite an error status with stale', async () => {
      const connectionId = await setUp()

      await withHouseholdContext(deps, USER, async (ctx) => {
        await ctx.client.query(`update connections set status = 'error' where id = $1`, [
          connectionId,
        ])
      })

      await withHouseholdContext(deps, USER, async (ctx) => markStaleConnections(ctx, NOW))

      // An error is more actionable than staleness, so it wins.
      expect((await readConnection(connectionId)).status).toBe('error')
    })
  })
})
