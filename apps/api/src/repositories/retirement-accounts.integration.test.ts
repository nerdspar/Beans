import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DataKeyCache } from '../crypto/data-key-cache.js'
import { LocalMasterKeyProvider } from '../crypto/local-master-key-provider.js'
import { resetAll, resetHouseholdsFor } from '../test-support/reset-database.js'
import { createManualAccount } from './accounts.js'
import {
  createHousehold,
  withHouseholdContext,
  type ContextDependencies,
  type HouseholdContext,
} from './household-context.js'
import { acceptInvite, createInvite } from './invites.js'
import { RetirementError } from './retirement.js'
import {
  deleteContributionRoute,
  readAccountTaxBuckets,
  readContributionRouting,
  readPlanFeatures,
  setAccountTaxBuckets,
  setContributionRoute,
  setPlanFeatures,
} from './retirement-accounts.js'

/**
 * The per-account retirement overlay.
 *
 * The tests that earn their keep here are the private-account ones. These three tables carry only
 * the household RLS check; the rule that one member's private account is invisible to another lives
 * on the `accounts` policy, and it only reaches these rows because every read joins `accounts` and
 * every write checks it. An `account_id` index makes the unsafe query the obvious one to write, so
 * these exist to make writing it fail.
 *
 * Fixed dates throughout (CLAUDE.md).
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL']
const MASTER_KEY = Buffer.alloc(32, 0x11).toString('base64')

const OWNER = 'ra-owner-fixed-id'
const PARTNER = 'ra-partner-fixed-id'
const OUTSIDER = 'ra-outsider-fixed-id'

const NOW = new Date('2026-07-01T12:00:00.000Z')

const describeIntegration = TEST_DATABASE_URL === undefined ? describe.skip : describe

describeIntegration('retirement account overlay', () => {
  let pool: Pool
  let deps: ContextDependencies

  const users = [OWNER, PARTNER, OUTSIDER] as const

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
      [OWNER, 'ra-owner@example.com'],
      [PARTNER, 'ra-partner@example.com'],
      [OUTSIDER, 'ra-outsider@example.com'],
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
    await resetHouseholdsFor(deps, users)
  })

  /** A 401(k)-shaped account, shared with the household by default. */
  async function makeAccount(context: HouseholdContext, name = 'Workplace 401(k)') {
    const { accountId } = await createManualAccount(context, {
      name,
      institutionName: 'Fidelity',
      type: 'investment',
      balanceCents: 400_000_00n,
      effectiveDate: '2026-01-01',
      taxTreatment: 'traditional',
    })
    return accountId
  }

  /** Puts PARTNER in OWNER's household, the way the app actually does it. */
  async function addPartnerToHousehold(): Promise<void> {
    const token = await withHouseholdContext(deps, OWNER, async (ctx) => {
      const invite = await createInvite(ctx, { now: NOW })
      return invite.token
    })
    await acceptInvite(deps, PARTNER, token, NOW)
  }

  describe('tax bucket anchors', () => {
    it('stores a whole breakdown for a date and reads it back as an anchor', async () => {
      await createHousehold(deps, OWNER, 'The Goldbergs')

      await withHouseholdContext(deps, OWNER, async (ctx) => {
        const accountId = await makeAccount(ctx)
        await setAccountTaxBuckets(ctx, accountId, '2026-06-30', [
          { treatment: 'traditional', balanceCents: 240_000_00n },
          { treatment: 'roth', balanceCents: 160_000_00n },
        ])
      })

      const overlay = await withHouseholdContext(deps, OWNER, readAccountTaxBuckets)

      expect(overlay).toHaveLength(1)
      expect(overlay[0]?.anchors).toHaveLength(1)
      expect(overlay[0]?.anchors[0]?.asOfDate).toBe('2026-06-30')
      /*
       * Enum order, not alphabetical. `order by treatment` on a Postgres enum column sorts by the
       * type's declared order — taxable, traditional, roth, after_tax, … — which is the domain's
       * own ordering and a more useful one to render than an alphabetical accident.
       */
      expect(overlay[0]?.anchors[0]?.buckets).toEqual([
        { treatment: 'traditional', balanceCents: 240_000_00n },
        { treatment: 'roth', balanceCents: 160_000_00n },
      ])
    })

    it('replaces a date as a unit rather than merging into it', async () => {
      /*
       * A partial anchor is a wrong anchor: the carry-forward reads proportions across every bucket
       * at a date, so a breakdown left half-replaced would model a split nobody entered.
       */
      await createHousehold(deps, OWNER, 'The Goldbergs')

      await withHouseholdContext(deps, OWNER, async (ctx) => {
        const accountId = await makeAccount(ctx)
        await setAccountTaxBuckets(ctx, accountId, '2026-06-30', [
          { treatment: 'traditional', balanceCents: 240_000_00n },
          { treatment: 'roth', balanceCents: 160_000_00n },
        ])
        await setAccountTaxBuckets(ctx, accountId, '2026-06-30', [
          { treatment: 'traditional', balanceCents: 300_000_00n },
        ])
      })

      const overlay = await withHouseholdContext(deps, OWNER, readAccountTaxBuckets)
      expect(overlay[0]?.anchors[0]?.buckets).toEqual([
        { treatment: 'traditional', balanceCents: 300_000_00n },
      ])
    })

    it('keeps several dates, because a newer reading re-bases rather than overwrites', async () => {
      await createHousehold(deps, OWNER, 'The Goldbergs')

      await withHouseholdContext(deps, OWNER, async (ctx) => {
        const accountId = await makeAccount(ctx)
        await setAccountTaxBuckets(ctx, accountId, '2024-01-01', [
          { treatment: 'traditional', balanceCents: 100_000_00n },
        ])
        await setAccountTaxBuckets(ctx, accountId, '2026-06-30', [
          { treatment: 'traditional', balanceCents: 240_000_00n },
          { treatment: 'roth', balanceCents: 160_000_00n },
        ])
      })

      const overlay = await withHouseholdContext(deps, OWNER, readAccountTaxBuckets)
      expect(overlay[0]?.anchors.map((anchor) => anchor.asOfDate)).toEqual([
        '2024-01-01',
        '2026-06-30',
      ])
    })

    it('removes the anchor when given an empty breakdown', async () => {
      // How a user undoes a split and falls back to the account-level tax treatment.
      await createHousehold(deps, OWNER, 'The Goldbergs')

      await withHouseholdContext(deps, OWNER, async (ctx) => {
        const accountId = await makeAccount(ctx)
        await setAccountTaxBuckets(ctx, accountId, '2026-06-30', [
          { treatment: 'traditional', balanceCents: 240_000_00n },
        ])
        await setAccountTaxBuckets(ctx, accountId, '2026-06-30', [])
      })

      expect(await withHouseholdContext(deps, OWNER, readAccountTaxBuckets)).toEqual([])
    })

    it('stores the balance as ciphertext', async () => {
      await createHousehold(deps, OWNER, 'The Goldbergs')

      await withHouseholdContext(deps, OWNER, async (ctx) => {
        const accountId = await makeAccount(ctx)
        await setAccountTaxBuckets(ctx, accountId, '2026-06-30', [
          { treatment: 'traditional', balanceCents: 240_000_00n },
        ])
      })

      const raw = await withHouseholdContext(deps, OWNER, async (ctx) => {
        const rows = await ctx.client.query<{ balance: Buffer }>(
          'select balance from account_tax_buckets',
        )
        return rows.rows[0]
      })

      expect(raw?.balance.toString('utf8')).not.toContain('24000000')
    })
  })

  describe('contribution routing', () => {
    it('round-trips an annual amount and can be switched off without losing it', async () => {
      await createHousehold(deps, OWNER, 'The Goldbergs')

      const accountId = await withHouseholdContext(deps, OWNER, async (ctx) => {
        const id = await makeAccount(ctx)
        await setContributionRoute(ctx, id, 'roth', 23_000_00n)
        return id
      })

      let routes = await withHouseholdContext(deps, OWNER, readContributionRouting)
      expect(routes).toEqual([
        { accountId, treatment: 'roth', annualCents: 23_000_00n, active: true },
      ])

      await withHouseholdContext(deps, OWNER, (ctx) =>
        setContributionRoute(ctx, accountId, 'roth', 23_000_00n, false),
      )

      routes = await withHouseholdContext(deps, OWNER, readContributionRouting)
      // Kept rather than deleted, so stopping and restarting does not lose the amount.
      expect(routes[0]).toMatchObject({ annualCents: 23_000_00n, active: false })
    })

    it('holds one route per treatment per account', async () => {
      await createHousehold(deps, OWNER, 'The Goldbergs')

      await withHouseholdContext(deps, OWNER, async (ctx) => {
        const id = await makeAccount(ctx)
        await setContributionRoute(ctx, id, 'roth', 23_000_00n)
        await setContributionRoute(ctx, id, 'roth', 24_000_00n)
        await setContributionRoute(ctx, id, 'traditional', 5_000_00n)
      })

      const routes = await withHouseholdContext(deps, OWNER, readContributionRouting)
      expect(routes).toHaveLength(2)
      expect(routes.find((r) => r.treatment === 'roth')?.annualCents).toBe(24_000_00n)
    })

    it('deletes a route', async () => {
      await createHousehold(deps, OWNER, 'The Goldbergs')

      await withHouseholdContext(deps, OWNER, async (ctx) => {
        const id = await makeAccount(ctx)
        await setContributionRoute(ctx, id, 'roth', 23_000_00n)
        await deleteContributionRoute(ctx, id, 'roth')
      })

      expect(await withHouseholdContext(deps, OWNER, readContributionRouting)).toEqual([])
    })
  })

  describe('plan features', () => {
    it('keeps unasked questions null rather than defaulting them to no', async () => {
      /*
       * The load-bearing distinction. `null` is "not asked", `false` is "asked, and no" — and
       * defaulting to false would make an unanswered plan look restrictive and silently suppress a
       * rule that might apply to it.
       */
      await createHousehold(deps, OWNER, 'The Goldbergs')

      await withHouseholdContext(deps, OWNER, async (ctx) => {
        const id = await makeAccount(ctx)
        await setPlanFeatures(ctx, id, { allowsAfterTaxContributions: true, answeredAt: NOW })
      })

      const features = await withHouseholdContext(deps, OWNER, readPlanFeatures)
      expect(features[0]).toMatchObject({
        allowsAfterTaxContributions: true,
        allowsInPlanRothConversion: null,
        allowsInServiceWithdrawal: null,
        acceptsIraRollIns: null,
      })
    })

    it('can answer no to a question previously answered yes', async () => {
      /*
       * This is why each field carries an explicit "was it mentioned" flag rather than using
       * `coalesce`. Under coalesce, false is indistinguishable from absent, so the answer would
       * silently fail to save and the screen would show the old one.
       */
      await createHousehold(deps, OWNER, 'The Goldbergs')

      const accountId = await withHouseholdContext(deps, OWNER, async (ctx) => {
        const id = await makeAccount(ctx)
        await setPlanFeatures(ctx, id, { allowsInServiceWithdrawal: true, answeredAt: NOW })
        return id
      })

      await withHouseholdContext(deps, OWNER, (ctx) =>
        setPlanFeatures(ctx, accountId, { allowsInServiceWithdrawal: false, answeredAt: NOW }),
      )

      const features = await withHouseholdContext(deps, OWNER, readPlanFeatures)
      expect(features[0]?.allowsInServiceWithdrawal).toBe(false)
    })

    it('leaves a field alone when the patch does not mention it', async () => {
      await createHousehold(deps, OWNER, 'The Goldbergs')

      const accountId = await withHouseholdContext(deps, OWNER, async (ctx) => {
        const id = await makeAccount(ctx)
        await setPlanFeatures(ctx, id, { acceptsIraRollIns: true, answeredAt: NOW })
        return id
      })

      await withHouseholdContext(deps, OWNER, (ctx) =>
        setPlanFeatures(ctx, accountId, { allowsAfterTaxContributions: true, answeredAt: NOW }),
      )

      const features = await withHouseholdContext(deps, OWNER, readPlanFeatures)
      expect(features[0]).toMatchObject({
        acceptsIraRollIns: true,
        allowsAfterTaxContributions: true,
      })
    })

    it('encrypts the match formula, because it describes someone’s compensation', async () => {
      await createHousehold(deps, OWNER, 'The Goldbergs')

      await withHouseholdContext(deps, OWNER, async (ctx) => {
        const id = await makeAccount(ctx)
        await setPlanFeatures(ctx, id, {
          employerMatchDescription: '100% of the first 4%, then 50% of the next 2%',
          answeredAt: NOW,
        })
      })

      const raw = await withHouseholdContext(deps, OWNER, async (ctx) => {
        const rows = await ctx.client.query<{ employer_match_description: Buffer }>(
          'select employer_match_description from plan_features',
        )
        return rows.rows[0]
      })

      expect(raw?.employer_match_description.toString('utf8')).not.toContain('100%')

      const features = await withHouseholdContext(deps, OWNER, readPlanFeatures)
      expect(features[0]?.employerMatchDescription).toBe(
        '100% of the first 4%, then 50% of the next 2%',
      )
    })
  })

  describe('another member’s private account', () => {
    /**
     * Creates a private account owned by OWNER, with PARTNER in the same household.
     *
     * Private accounts are the case these tables are most exposed to: the household check passes,
     * and only the `accounts` policy knows the account is somebody else's.
     */
    async function privateAccountOf(): Promise<string> {
      await createHousehold(deps, OWNER, 'The Goldbergs')
      await addPartnerToHousehold()

      return withHouseholdContext(deps, OWNER, async (ctx) => {
        const accountId = await makeAccount(ctx, 'My own IRA')
        await ctx.client.query(
          'update accounts set is_shared = false, owner_user_id = $2 where id = $1',
          [accountId, OWNER],
        )
        await setAccountTaxBuckets(ctx, accountId, '2026-06-30', [
          { treatment: 'traditional', balanceCents: 240_000_00n },
          { treatment: 'roth', balanceCents: 160_000_00n },
        ])
        await setContributionRoute(ctx, accountId, 'roth', 7_000_00n)
        await setPlanFeatures(ctx, accountId, { acceptsIraRollIns: true, answeredAt: NOW })
        return accountId
      })
    }

    it('does not leak its tax breakdown to the other member', async () => {
      // Knowing an account is 60% pre-tax is a statement about somebody's finances even without a
      // balance beside it, and this is an account the other member cannot see at all.
      await privateAccountOf()

      expect(await withHouseholdContext(deps, PARTNER, readAccountTaxBuckets)).toEqual([])
      // And the owner still sees their own.
      expect(await withHouseholdContext(deps, OWNER, readAccountTaxBuckets)).toHaveLength(1)
    })

    it('does not leak its contribution routing', async () => {
      await privateAccountOf()

      expect(await withHouseholdContext(deps, PARTNER, readContributionRouting)).toEqual([])
      expect(await withHouseholdContext(deps, OWNER, readContributionRouting)).toHaveLength(1)
    })

    it('does not leak its plan features', async () => {
      await privateAccountOf()

      expect(await withHouseholdContext(deps, PARTNER, readPlanFeatures)).toEqual([])
      expect(await withHouseholdContext(deps, OWNER, readPlanFeatures)).toHaveLength(1)
    })

    it('refuses a write against it from the other member', async () => {
      /*
       * The household `with check` would happily accept this row — the household id matches. Only
       * the pre-flight select through `accounts` catches it, which is why the write path checks
       * rather than relying on the constraint.
       */
      const accountId = await privateAccountOf()

      await expect(
        withHouseholdContext(deps, PARTNER, (ctx) =>
          setAccountTaxBuckets(ctx, accountId, '2026-06-30', [
            { treatment: 'roth', balanceCents: 1n },
          ]),
        ),
      ).rejects.toThrow(RetirementError)

      // And the owner's anchor is untouched.
      const overlay = await withHouseholdContext(deps, OWNER, readAccountTaxBuckets)
      expect(overlay[0]?.anchors[0]?.buckets).toHaveLength(2)
    })

    it('still lets both members see a shared account', async () => {
      // The control. If every one of these came back empty the tests above would pass for the
      // wrong reason — a join that matched nothing at all.
      await createHousehold(deps, OWNER, 'The Goldbergs')
      await addPartnerToHousehold()

      await withHouseholdContext(deps, OWNER, async (ctx) => {
        const accountId = await makeAccount(ctx, 'Joint brokerage')
        await setAccountTaxBuckets(ctx, accountId, '2026-06-30', [
          { treatment: 'taxable', balanceCents: 50_000_00n },
        ])
      })

      expect(await withHouseholdContext(deps, PARTNER, readAccountTaxBuckets)).toHaveLength(1)
    })
  })

  describe('another household', () => {
    it('cannot read or write the overlay', async () => {
      await createHousehold(deps, OWNER, 'The Goldbergs')
      const accountId = await withHouseholdContext(deps, OWNER, async (ctx) => {
        const id = await makeAccount(ctx)
        await setAccountTaxBuckets(ctx, id, '2026-06-30', [
          { treatment: 'traditional', balanceCents: 240_000_00n },
        ])
        return id
      })

      await createHousehold(deps, OUTSIDER, 'Somebody Else')

      expect(await withHouseholdContext(deps, OUTSIDER, readAccountTaxBuckets)).toEqual([])
      await expect(
        withHouseholdContext(deps, OUTSIDER, (ctx) =>
          setContributionRoute(ctx, accountId, 'roth', 1n),
        ),
      ).rejects.toThrow(RetirementError)
    })
  })
})
