import { SEED_SCENARIOS } from '@beans/shared'
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
import { createManualAccount } from './accounts.js'
import {
  RetirementError,
  addRetirementMember,
  deleteRetirementMember,
  ensureRetirementPlan,
  readLoanPayoffYears,
  readRetirementPlan,
  readSpendingAssumptions,
  setSpendingAssumption,
  setDefaultScenario,
  updateRetirementMember,
  updateRetirementProfile,
  updateRetirementScenario,
} from './retirement.js'

/**
 * The retirement plan against a real Postgres.
 *
 * Three things here can only be tested against the real database, and each has already bitten this
 * codebase once: a `jsonb` column rejecting a JavaScript array handed to it by node-pg, encrypted
 * columns round-tripping through the household cipher, and RLS deciding what one household can see
 * of another's. A mock would accept all three happily.
 *
 * The cross-tenant cases are the most important tests in the file. They are not to be weakened to
 * make an unrelated refactor pass (CLAUDE.md).
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL']
const MASTER_KEY = Buffer.alloc(32, 0x11).toString('base64')

const OWNER = 'retire-owner-fixed-id'
const OUTSIDER = 'retire-outsider-fixed-id'

// Fixed, never the wall clock (CLAUDE.md).
const REVIEWED = new Date('2026-10-01T12:00:00.000Z')

const describeIntegration = TEST_DATABASE_URL === undefined ? describe.skip : describe

describeIntegration('retirement plan', () => {
  let pool: Pool
  let deps: ContextDependencies

  const users = [OWNER, OUTSIDER] as const

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
      [OWNER, 'retire-owner@example.com'],
      [OUTSIDER, 'retire-outsider@example.com'],
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

  describe('creating the plan', () => {
    it('returns null before anyone has opened the planner', () => {
      /*
       * Null rather than a profile full of defaults. "No plan yet" is the state the wizard exists
       * to resolve, and defaults are indistinguishable from answers somebody reviewed and left —
       * the same mistake the unreviewed-spending flag avoids.
       */
      return (async () => {
        await createHousehold(deps, OWNER, 'The Goldbergs')

        const plan = await withHouseholdContext(deps, OWNER, readRetirementPlan)
        expect(plan).toBeNull()
      })()
    })

    it('creates the profile and seeds the three scenarios', async () => {
      await createHousehold(deps, OWNER, 'The Goldbergs')

      const plan = await withHouseholdContext(deps, OWNER, ensureRetirementPlan)

      expect(plan.members).toEqual([])
      expect(plan.scenarios.map((scenario) => scenario.name)).toEqual(
        SEED_SCENARIOS.map((seed) => seed.name),
      )
      // Exactly one default, and it is the middle scenario rather than the flattering one.
      expect(plan.scenarios.filter((scenario) => scenario.isDefault)).toHaveLength(1)
      expect(plan.scenarios.find((scenario) => scenario.isDefault)?.name).toBe(
        SEED_SCENARIOS.find((seed) => seed.isDefault)?.name,
      )
    })

    it('is idempotent, because the wizard is revisitable', async () => {
      // The first screen should not have to care whether it is being opened for the first time.
      await createHousehold(deps, OWNER, 'The Goldbergs')

      const first = await withHouseholdContext(deps, OWNER, ensureRetirementPlan)
      const second = await withHouseholdContext(deps, OWNER, ensureRetirementPlan)

      expect(second.profile.id).toBe(first.profile.id)
      expect(second.scenarios).toHaveLength(SEED_SCENARIOS.length)
    })

    it('defaults the tax rate to an assumption rather than leaving it null', async () => {
      // The after-tax equivalent needs a rate to exist at all. It is shown beside every figure it
      // produces, so a stated default is better than a blank that silently means zero.
      await createHousehold(deps, OWNER, 'The Goldbergs')

      const plan = await withHouseholdContext(deps, OWNER, ensureRetirementPlan)
      expect(plan.profile.retirementEffectiveRateBasisPoints).toBe(2_200)
      expect(plan.profile.withdrawalOrder).toBeNull()
      expect(plan.profile.pre65HealthcareAnnualCents).toBeNull()
    })
  })

  describe('the withdrawal order', () => {
    it('round-trips through the jsonb column', async () => {
      /*
       * The bug this exists for: node-pg serializes a JavaScript array as a Postgres array literal
       * — `{a,b,c}` — and `jsonb` rejects it outright. Every save of `user_preferences.tab_order`
       * failed that way from the day it shipped, and the visible symptom was a dead button.
       */
      await createHousehold(deps, OWNER, 'The Goldbergs')
      await withHouseholdContext(deps, OWNER, ensureRetirementPlan)

      await withHouseholdContext(deps, OWNER, (ctx) =>
        updateRetirementProfile(ctx, { withdrawalOrder: ['roth', 'taxable', 'traditional'] }),
      )

      const plan = await withHouseholdContext(deps, OWNER, readRetirementPlan)
      expect(plan?.profile.withdrawalOrder).toEqual(['roth', 'taxable', 'traditional'])
    })

    it('can be cleared back to the engine default', async () => {
      // Clearing is a real operation, distinct from leaving it alone, and must not store a JSON
      // null that reads back as a value where an absence is meant.
      await createHousehold(deps, OWNER, 'The Goldbergs')
      await withHouseholdContext(deps, OWNER, ensureRetirementPlan)

      await withHouseholdContext(deps, OWNER, (ctx) =>
        updateRetirementProfile(ctx, { withdrawalOrder: ['roth'] }),
      )
      await withHouseholdContext(deps, OWNER, (ctx) =>
        updateRetirementProfile(ctx, { withdrawalOrder: null }),
      )

      const plan = await withHouseholdContext(deps, OWNER, readRetirementPlan)
      expect(plan?.profile.withdrawalOrder).toBeNull()
    })

    it('leaves it alone when the patch does not mention it', async () => {
      await createHousehold(deps, OWNER, 'The Goldbergs')
      await withHouseholdContext(deps, OWNER, ensureRetirementPlan)

      await withHouseholdContext(deps, OWNER, (ctx) =>
        updateRetirementProfile(ctx, { withdrawalOrder: ['roth'] }),
      )
      await withHouseholdContext(deps, OWNER, (ctx) =>
        updateRetirementProfile(ctx, { retirementEffectiveRateBasisPoints: 1_800 }),
      )

      const plan = await withHouseholdContext(deps, OWNER, readRetirementPlan)
      expect(plan?.profile.withdrawalOrder).toEqual(['roth'])
      expect(plan?.profile.retirementEffectiveRateBasisPoints).toBe(1_800)
    })
  })

  describe('members', () => {
    it('round-trips an encrypted name and benefit', async () => {
      await createHousehold(deps, OWNER, 'The Goldbergs')
      const plan = await withHouseholdContext(deps, OWNER, ensureRetirementPlan)

      await withHouseholdContext(deps, OWNER, (ctx) =>
        addRetirementMember(ctx, plan.profile.id, {
          displayName: 'Scott',
          birthYear: 1_975,
          targetRetirementDate: '2040-06-01',
          socialSecurityClaimAge: 67,
          socialSecurityAnnualBenefitCents: 34_000_00n,
          lifeExpectancy: 92,
        }),
      )

      const after = await withHouseholdContext(deps, OWNER, readRetirementPlan)
      expect(after?.members).toHaveLength(1)
      expect(after?.members[0]).toMatchObject({
        displayName: 'Scott',
        birthYear: 1_975,
        targetRetirementDate: '2040-06-01',
        socialSecurityClaimAge: 67,
        socialSecurityAnnualBenefitCents: 34_000_00n,
        lifeExpectancy: 92,
      })
    })

    it('stores the name and benefit as ciphertext, not as readable columns', async () => {
      /*
       * Reading the raw bytes, because the point of an encrypted column is that a database dump is
       * useless. A test that only round-trips through the cipher would pass just as happily if the
       * column held plaintext.
       */
      await createHousehold(deps, OWNER, 'The Goldbergs')
      const plan = await withHouseholdContext(deps, OWNER, ensureRetirementPlan)

      await withHouseholdContext(deps, OWNER, (ctx) =>
        addRetirementMember(ctx, plan.profile.id, {
          displayName: 'Scott',
          birthYear: 1_975,
          socialSecurityAnnualBenefitCents: 34_000_00n,
        }),
      )

      const raw = await withHouseholdContext(deps, OWNER, async (ctx) => {
        const rows = await ctx.client.query<{
          display_name: Buffer
          social_security_annual_benefit: Buffer
        }>('select display_name, social_security_annual_benefit from retirement_members')
        return rows.rows[0]
      })

      expect(raw?.display_name.toString('utf8')).not.toContain('Scott')
      expect(raw?.social_security_annual_benefit.toString('utf8')).not.toContain('3400000')
    })

    it('accepts a member who is not a Beans user', async () => {
      // A spouse who never signs in still retires on a date and claims on a schedule. A plan that
      // cannot represent them is wrong for most households.
      await createHousehold(deps, OWNER, 'The Goldbergs')
      const plan = await withHouseholdContext(deps, OWNER, ensureRetirementPlan)

      await withHouseholdContext(deps, OWNER, (ctx) =>
        addRetirementMember(ctx, plan.profile.id, { displayName: 'Spouse', birthYear: 1_977 }),
      )

      const after = await withHouseholdContext(deps, OWNER, readRetirementPlan)
      expect(after?.members[0]?.userId).toBeNull()
    })

    it('keeps an unanswered field null rather than defaulting it', async () => {
      // Null claim age means unasked, and the projection counts no benefit for it. Defaulting to a
      // plausible age would put income in the plan that nobody stated.
      await createHousehold(deps, OWNER, 'The Goldbergs')
      const plan = await withHouseholdContext(deps, OWNER, ensureRetirementPlan)

      await withHouseholdContext(deps, OWNER, (ctx) =>
        addRetirementMember(ctx, plan.profile.id, { displayName: 'Scott', birthYear: 1_975 }),
      )

      const after = await withHouseholdContext(deps, OWNER, readRetirementPlan)
      expect(after?.members[0]).toMatchObject({
        socialSecurityClaimAge: null,
        socialSecurityAnnualBenefitCents: null,
        targetRetirementDate: null,
        lifeExpectancy: null,
      })
    })

    it('updates and deletes', async () => {
      await createHousehold(deps, OWNER, 'The Goldbergs')
      const plan = await withHouseholdContext(deps, OWNER, ensureRetirementPlan)

      const memberId = await withHouseholdContext(deps, OWNER, (ctx) =>
        addRetirementMember(ctx, plan.profile.id, { displayName: 'Scott', birthYear: 1_975 }),
      )

      await withHouseholdContext(deps, OWNER, (ctx) =>
        updateRetirementMember(ctx, memberId, {
          displayName: 'Scott G',
          birthYear: 1_975,
          socialSecurityClaimAge: 70,
        }),
      )

      let after = await withHouseholdContext(deps, OWNER, readRetirementPlan)
      expect(after?.members[0]).toMatchObject({ displayName: 'Scott G', socialSecurityClaimAge: 70 })

      await withHouseholdContext(deps, OWNER, (ctx) => deleteRetirementMember(ctx, memberId))

      after = await withHouseholdContext(deps, OWNER, readRetirementPlan)
      expect(after?.members).toEqual([])
    })
  })

  describe('scenarios', () => {
    it('moves the default without ever leaving two, or none', async () => {
      /*
       * The partial unique index allows exactly one default per profile, so setting before clearing
       * would collide with the row already holding it. Both statements are in the caller's
       * transaction, so there is no window where a profile has no default — which would make the
       * headline figure a coin toss.
       */
      await createHousehold(deps, OWNER, 'The Goldbergs')
      const plan = await withHouseholdContext(deps, OWNER, ensureRetirementPlan)

      const optimistic = plan.scenarios.find((scenario) => !scenario.isDefault)
      expect(optimistic).toBeDefined()

      await withHouseholdContext(deps, OWNER, (ctx) => setDefaultScenario(ctx, optimistic!.id))

      const after = await withHouseholdContext(deps, OWNER, readRetirementPlan)
      const defaults = after?.scenarios.filter((scenario) => scenario.isDefault) ?? []
      expect(defaults).toHaveLength(1)
      expect(defaults[0]?.id).toBe(optimistic!.id)
    })

    it('edits the rates and the spending override', async () => {
      await createHousehold(deps, OWNER, 'The Goldbergs')
      const plan = await withHouseholdContext(deps, OWNER, ensureRetirementPlan)
      const scenario = plan.scenarios[0]!

      await withHouseholdContext(deps, OWNER, (ctx) =>
        updateRetirementScenario(ctx, scenario.id, {
          name: 'My own',
          preRetirementReturnBasisPoints: 450,
          postRetirementReturnBasisPoints: 300,
          annualSpendingOverrideCents: -72_000_00n,
          retirementYearsOffset: -2,
        }),
      )

      const after = await withHouseholdContext(deps, OWNER, readRetirementPlan)
      expect(after?.scenarios.find((s) => s.id === scenario.id)).toMatchObject({
        name: 'My own',
        preRetirementReturnBasisPoints: 450,
        postRetirementReturnBasisPoints: 300,
        annualSpendingOverrideCents: -72_000_00n,
        retirementYearsOffset: -2,
      })
    })

    it('clears a spending override back to the reviewed baseline', async () => {
      await createHousehold(deps, OWNER, 'The Goldbergs')
      const plan = await withHouseholdContext(deps, OWNER, ensureRetirementPlan)
      const scenario = plan.scenarios[0]!

      await withHouseholdContext(deps, OWNER, (ctx) =>
        updateRetirementScenario(ctx, scenario.id, { annualSpendingOverrideCents: -72_000_00n }),
      )
      await withHouseholdContext(deps, OWNER, (ctx) =>
        updateRetirementScenario(ctx, scenario.id, { annualSpendingOverrideCents: null }),
      )

      const after = await withHouseholdContext(deps, OWNER, readRetirementPlan)
      expect(after?.scenarios.find((s) => s.id === scenario.id)?.annualSpendingOverrideCents).toBeNull()
    })
  })

  describe('spending assumptions', () => {
    async function categoryId(context: HouseholdContext, slug: string): Promise<string> {
      const rows = await context.client.query<{ id: string }>(
        'select id from categories where slug = $1',
        [slug],
      )
      const existing = rows.rows[0]
      if (existing !== undefined) return existing.id

      const created = await context.client.query<{ id: string }>(
        `insert into categories (household_id, slug, name, kind) values ($1, $2, $3, 'expense')
         returning id`,
        [context.householdId, slug, slug],
      )
      return created.rows[0]!.id
    }

    it('round-trips a treatment and its percentage', async () => {
      await createHousehold(deps, OWNER, 'The Goldbergs')

      await withHouseholdContext(deps, OWNER, async (ctx) => {
        const plan = await ensureRetirementPlan(ctx)
        await setSpendingAssumption(ctx, plan.profile.id, {
          categoryId: await categoryId(ctx, 'commuting'),
          treatment: 'adjusted',
          adjustmentBasisPoints: 2_500,
          reviewedAt: REVIEWED,
        })

        const stored = await readSpendingAssumptions(ctx, plan.profile.id)
        expect(stored).toHaveLength(1)
        expect(stored[0]).toMatchObject({
          treatment: 'adjusted',
          adjustmentBasisPoints: 2_500,
          lastYear: null,
        })
      })
    })

    it('refuses an adjusted category with no percentage', async () => {
      /*
       * Enforced here rather than by a CHECK so the error can say something useful. An `adjusted`
       * row with no percentage is a bug, and the math module falls back to `continues` if one ever
       * reaches it — overstating the cost, which is the safe direction but not a licence to write
       * one.
       */
      await createHousehold(deps, OWNER, 'The Goldbergs')

      await withHouseholdContext(deps, OWNER, async (ctx) => {
        const plan = await ensureRetirementPlan(ctx)
        await expect(
          setSpendingAssumption(ctx, plan.profile.id, {
            categoryId: await categoryId(ctx, 'commuting'),
            treatment: 'adjusted',
            reviewedAt: REVIEWED,
          }),
        ).rejects.toThrow(RetirementError)
      })
    })

    it('clears a stale percentage when the treatment stops being adjusted', async () => {
      // Otherwise switching back to `adjusted` later would silently pick up an old number nobody
      // re-entered.
      await createHousehold(deps, OWNER, 'The Goldbergs')

      await withHouseholdContext(deps, OWNER, async (ctx) => {
        const plan = await ensureRetirementPlan(ctx)
        const category = await categoryId(ctx, 'commuting')

        await setSpendingAssumption(ctx, plan.profile.id, {
          categoryId: category,
          treatment: 'adjusted',
          adjustmentBasisPoints: 2_500,
          reviewedAt: REVIEWED,
        })
        await setSpendingAssumption(ctx, plan.profile.id, {
          categoryId: category,
          treatment: 'continues',
          reviewedAt: REVIEWED,
        })

        const stored = await readSpendingAssumptions(ctx, plan.profile.id)
        expect(stored[0]).toMatchObject({ treatment: 'continues', adjustmentBasisPoints: null })
      })
    })

    it('stores a payoff year per category rather than applying one to all of them', async () => {
      /*
       * The bug this exists for. The first version of the reader resolved `lastYear` with a
       * subquery over `accounts.payoff_date` that was not correlated to the category — so every row
       * got the mortgage's year, and the projection would have stopped buying groceries the month
       * the house was paid off.
       */
      await createHousehold(deps, OWNER, 'The Goldbergs')

      await withHouseholdContext(deps, OWNER, async (ctx) => {
        const plan = await ensureRetirementPlan(ctx)

        await setSpendingAssumption(ctx, plan.profile.id, {
          categoryId: await categoryId(ctx, 'mortgage'),
          treatment: 'continues',
          lastYear: 2_034,
          reviewedAt: REVIEWED,
        })
        await setSpendingAssumption(ctx, plan.profile.id, {
          categoryId: await categoryId(ctx, 'groceries'),
          treatment: 'continues',
          reviewedAt: REVIEWED,
        })

        const stored = await readSpendingAssumptions(ctx, plan.profile.id)
        const byCategory = new Map(stored.map((row) => [row.categoryId, row.lastYear]))
        const mortgage = await categoryId(ctx, 'mortgage')
        const groceries = await categoryId(ctx, 'groceries')

        expect(byCategory.get(mortgage)).toBe(2_034)
        // The one that matters: groceries did not inherit the mortgage's payoff year.
        expect(byCategory.get(groceries)).toBeNull()
      })
    })

    it('offers a loan’s payoff year for the wizard to pre-fill, without applying it', async () => {
      // Which category pays which loan is something only the household knows, so this is an offer
      // rather than a derivation.
      await createHousehold(deps, OWNER, 'The Goldbergs')

      await withHouseholdContext(deps, OWNER, async (ctx) => {
        const { accountId } = await createManualAccount(ctx, {
          name: 'Mortgage',
          institutionName: 'Local Bank',
          type: 'mortgage',
          balanceCents: -300_000_00n,
          effectiveDate: '2026-01-01',
        })
        await ctx.client.query('update accounts set payoff_date = $2 where id = $1', [
          accountId,
          '2034-09-01',
        ])

        expect(await readLoanPayoffYears(ctx)).toEqual([{ accountId, payoffYear: 2_034 }])
      })
    })
  })

  describe('cross-tenant isolation', () => {
    it('does not show one household another household’s plan', async () => {
      await createHousehold(deps, OWNER, 'The Goldbergs')
      await withHouseholdContext(deps, OWNER, ensureRetirementPlan)

      await createHousehold(deps, OUTSIDER, 'Somebody Else')

      const theirs = await withHouseholdContext(deps, OUTSIDER, readRetirementPlan)
      expect(theirs).toBeNull()
    })

    it('gives each household its own profile rather than sharing one', async () => {
      await createHousehold(deps, OWNER, 'The Goldbergs')
      await createHousehold(deps, OUTSIDER, 'Somebody Else')

      const mine = await withHouseholdContext(deps, OWNER, ensureRetirementPlan)
      const theirs = await withHouseholdContext(deps, OUTSIDER, ensureRetirementPlan)

      expect(theirs.profile.id).not.toBe(mine.profile.id)
      // And the unique constraint is per household, so both got their own seeded scenarios.
      expect(theirs.scenarios).toHaveLength(SEED_SCENARIOS.length)
    })

    it('refuses to update a member belonging to another household', async () => {
      /*
       * RLS turns "belongs to someone else" into "no such row", so the update matches nothing. The
       * repository has to notice that and say so rather than reporting a silent success — a write
       * that reports success and changes nothing is the worst of the three outcomes.
       */
      await createHousehold(deps, OWNER, 'The Goldbergs')
      const plan = await withHouseholdContext(deps, OWNER, ensureRetirementPlan)
      const memberId = await withHouseholdContext(deps, OWNER, (ctx) =>
        addRetirementMember(ctx, plan.profile.id, { displayName: 'Scott', birthYear: 1_975 }),
      )

      await createHousehold(deps, OUTSIDER, 'Somebody Else')
      await withHouseholdContext(deps, OUTSIDER, ensureRetirementPlan)

      await expect(
        withHouseholdContext(deps, OUTSIDER, (ctx) =>
          updateRetirementMember(ctx, memberId, { displayName: 'Stolen', birthYear: 1_900 }),
        ),
      ).rejects.toThrow(RetirementError)

      // And the original is untouched.
      const after = await withHouseholdContext(deps, OWNER, readRetirementPlan)
      expect(after?.members[0]?.displayName).toBe('Scott')
    })

    it('refuses to delete a member belonging to another household', async () => {
      await createHousehold(deps, OWNER, 'The Goldbergs')
      const plan = await withHouseholdContext(deps, OWNER, ensureRetirementPlan)
      const memberId = await withHouseholdContext(deps, OWNER, (ctx) =>
        addRetirementMember(ctx, plan.profile.id, { displayName: 'Scott', birthYear: 1_975 }),
      )

      await createHousehold(deps, OUTSIDER, 'Somebody Else')

      await expect(
        withHouseholdContext(deps, OUTSIDER, (ctx) => deleteRetirementMember(ctx, memberId)),
      ).rejects.toThrow(RetirementError)

      const after = await withHouseholdContext(deps, OWNER, readRetirementPlan)
      expect(after?.members).toHaveLength(1)
    })

    it('refuses to retarget another household’s default scenario', async () => {
      await createHousehold(deps, OWNER, 'The Goldbergs')
      const mine = await withHouseholdContext(deps, OWNER, ensureRetirementPlan)
      const notDefault = mine.scenarios.find((scenario) => !scenario.isDefault)!

      await createHousehold(deps, OUTSIDER, 'Somebody Else')
      await withHouseholdContext(deps, OUTSIDER, ensureRetirementPlan)

      await expect(
        withHouseholdContext(deps, OUTSIDER, (ctx) => setDefaultScenario(ctx, notDefault.id)),
      ).rejects.toThrow(RetirementError)

      const after = await withHouseholdContext(deps, OWNER, readRetirementPlan)
      expect(after?.scenarios.find((s) => s.isDefault)?.id).not.toBe(notDefault.id)
    })
  })
})
