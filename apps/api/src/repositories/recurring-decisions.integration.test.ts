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
import {
  RecurringAccountNotFoundError,
  clearRecurringDecision,
  listRecurringDecisions,
  setRecurringDecision,
} from './recurring-decisions.js'
import { readWorkingSet } from './working-set.js'

/**
 * Overrides for recurring series, against real Postgres.
 *
 * The isolation cases matter most. A decision's key is a merchant name, so a decision leaking is a
 * payee leaking — across households, and within one, from a private account to a member who cannot
 * see it (ARCHITECTURE.md §6.4).
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL']
const MASTER_KEY = Buffer.alloc(32, 0x33).toString('base64')

const USER = 'recurring-user-fixed-id'
const PARTNER = 'recurring-partner-fixed-id'
const OTHER_USER = 'recurring-other-user-fixed-id'
const NOW = new Date('2026-10-10T12:00:00.000Z')

const describeIntegration = TEST_DATABASE_URL === undefined ? describe.skip : describe

describeIntegration('recurring decisions', () => {
  let pool: Pool
  let deps: ContextDependencies

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
    for (const [id, email] of [
      [USER, 'recurring@example.com'],
      [PARTNER, 'recurring-partner@example.com'],
      [OTHER_USER, 'recurring-other@example.com'],
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
    // The partner joins USER's household, so the two differ only in who they are.
    await withHouseholdContext(deps, USER, (context) =>
      context.client.query(
        `insert into household_members (household_id, user_id, role) values ($1, $2, 'member')`,
        [context.householdId, PARTNER],
      ),
    )
  })

  async function seedAccount(
    context: HouseholdContext,
    options: { private?: boolean } = {},
  ): Promise<string> {
    const result = await context.client.query<{ id: string }>(
      `insert into accounts
         (household_id, type, provider_name, is_manual, confirmed_at, is_shared, owner_user_id)
       values ($1, 'credit', $2, false, $3, $4, $5)
       returning id`,
      [
        context.householdId,
        context.cipher.encryptText('Sapphire'),
        NOW,
        options.private !== true,
        context.userId,
      ],
    )
    const id = result.rows[0]?.id
    if (id === undefined) throw new Error('seed failed')
    return id
  }

  it('stores a decision and returns it with the key decrypted', async () => {
    await withHouseholdContext(deps, USER, async (context) => {
      const accountId = await seedAccount(context)
      await setRecurringDecision(context, {
        merchantKey: 'netflix.com',
        decision: 'bill',
        accountId,
      })

      expect(await listRecurringDecisions(context)).toEqual([
        { id: expect.any(String), merchantKey: 'netflix.com', decision: 'bill' },
      ])
    })
  })

  it('encrypts the key at rest', async () => {
    await withHouseholdContext(deps, USER, async (context) => {
      const accountId = await seedAccount(context)
      await setRecurringDecision(context, {
        merchantKey: 'netflix.com',
        decision: 'ignored',
        accountId,
      })

      const raw = await context.client.query<{ merchant_key: Buffer }>(
        'select merchant_key from recurring_decisions',
      )
      expect(raw.rows[0]?.merchant_key.toString('latin1')).not.toContain('netflix')
    })
  })

  it('replaces an earlier decision for the same series rather than adding a second', async () => {
    await withHouseholdContext(deps, USER, async (context) => {
      const accountId = await seedAccount(context)
      const first = await setRecurringDecision(context, {
        merchantKey: 'netflix.com',
        decision: 'bill',
        accountId,
      })
      const second = await setRecurringDecision(context, {
        merchantKey: 'netflix.com',
        decision: 'ignored',
        accountId,
      })

      expect(second.id).toBe(first.id)
      expect(await listRecurringDecisions(context)).toEqual([
        { id: first.id, merchantKey: 'netflix.com', decision: 'ignored' },
      ])
    })
  })

  it('clears a decision', async () => {
    await withHouseholdContext(deps, USER, async (context) => {
      const accountId = await seedAccount(context)
      const { id } = await setRecurringDecision(context, {
        merchantKey: 'hulu',
        decision: 'ignored',
        accountId,
      })

      expect(await clearRecurringDecision(context, id)).toBe(true)
      expect(await listRecurringDecisions(context)).toEqual([])
    })
  })

  it('sends decisions in the working set', async () => {
    await withHouseholdContext(deps, USER, async (context) => {
      const accountId = await seedAccount(context)
      await setRecurringDecision(context, { merchantKey: 'hulu', decision: 'ignored', accountId })
    })

    const result = await withHouseholdContext(deps, USER, (context) =>
      readWorkingSet(context, { cursor: null, now: NOW }),
    )
    expect(result.recurringDecisions).toEqual([
      { id: expect.any(String), merchantKey: 'hulu', decision: 'ignored' },
    ])
  })

  describe('isolation', () => {
    it('never shows one household’s decisions to another', async () => {
      const id = await withHouseholdContext(deps, USER, async (context) => {
        const accountId = await seedAccount(context)
        return (
          await setRecurringDecision(context, { merchantKey: 'hulu', decision: 'bill', accountId })
        ).id
      })

      await withHouseholdContext(deps, OTHER_USER, async (context) => {
        expect(await listRecurringDecisions(context)).toEqual([])
        expect(await clearRecurringDecision(context, id)).toBe(false)
      })
    })

    it('hides a decision on a private account from the rest of the household', async () => {
      await withHouseholdContext(deps, USER, async (context) => {
        const accountId = await seedAccount(context, { private: true })
        await setRecurringDecision(context, {
          merchantKey: 'a therapist',
          decision: 'bill',
          accountId,
        })
      })

      // The owner still sees it.
      await withHouseholdContext(deps, USER, async (context) => {
        expect(await listRecurringDecisions(context)).toHaveLength(1)
      })

      // The partner, in the same household, sees nothing — not in the list, not in the working set.
      await withHouseholdContext(deps, PARTNER, async (context) => {
        expect(await listRecurringDecisions(context)).toEqual([])
        const workingSet = await readWorkingSet(context, { cursor: null, now: NOW })
        expect(workingSet.recurringDecisions).toEqual([])
      })
    })

    it('refuses to attach a decision to an account the person cannot see', async () => {
      const privateAccount = await withHouseholdContext(deps, USER, (context) =>
        seedAccount(context, { private: true }),
      )

      await withHouseholdContext(deps, PARTNER, async (context) => {
        await expect(
          setRecurringDecision(context, {
            merchantKey: 'hulu',
            decision: 'ignored',
            accountId: privateAccount,
          }),
        ).rejects.toBeInstanceOf(RecurringAccountNotFoundError)
      })
    })

    it('does not let a member clear a decision they cannot see', async () => {
      const id = await withHouseholdContext(deps, USER, async (context) => {
        const accountId = await seedAccount(context, { private: true })
        return (
          await setRecurringDecision(context, { merchantKey: 'hulu', decision: 'bill', accountId })
        ).id
      })

      await withHouseholdContext(deps, PARTNER, async (context) => {
        expect(await clearRecurringDecision(context, id)).toBe(false)
      })
      await withHouseholdContext(deps, USER, async (context) => {
        expect(await listRecurringDecisions(context)).toHaveLength(1)
      })
    })
  })
})
