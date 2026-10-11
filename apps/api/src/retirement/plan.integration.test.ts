import { pairKeyFor } from '@beans/shared'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DataKeyCache } from '../crypto/data-key-cache.js'
import { LocalMasterKeyProvider } from '../crypto/local-master-key-provider.js'
import { createManualAccount } from '../repositories/accounts.js'
import {
  createHousehold,
  withHouseholdContext,
  type ContextDependencies,
  type HouseholdContext,
} from '../repositories/household-context.js'
import { acceptInvite, createInvite } from '../repositories/invites.js'
import {
  addRetirementMember,
  ensureRetirementPlan,
  setSpendingAssumption,
} from '../repositories/retirement.js'
import { setContributionRoute } from '../repositories/retirement-accounts.js'
import { resetAll, resetHouseholdsFor } from '../test-support/reset-database.js'
import { runRetirementProjection } from './plan.js'

/**
 * The plan end to end, against a real household.
 *
 * The assembly and the engine are covered without a database elsewhere. What only this can prove is
 * that the reads line up with them: that spending comes back signed and categorized, that the
 * baseline excludes transfers the same way the cash flow screens do, and — the one that settles a
 * product decision rather than a technical one — that a private account's spending stays out of the
 * household baseline.
 *
 * Fixed dates throughout (CLAUDE.md).
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL']
const MASTER_KEY = Buffer.alloc(32, 0x11).toString('base64')

const OWNER = 'plan-owner-fixed-id'
const PARTNER = 'plan-partner-fixed-id'

const TODAY = '2026-10-01' as never
const NOW = new Date('2026-10-01T12:00:00.000Z')

const describeIntegration = TEST_DATABASE_URL === undefined ? describe.skip : describe

describeIntegration('retirement projection', () => {
  let pool: Pool
  let deps: ContextDependencies

  const users = [OWNER, PARTNER] as const

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
      [OWNER, 'plan-owner@example.com'],
      [PARTNER, 'plan-partner@example.com'],
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

  /** One spending transaction a month for twelve months, so the baseline is a full year. */
  async function spendMonthly(
    context: HouseholdContext,
    accountId: string,
    category: string,
    monthlyCents: bigint,
  ): Promise<void> {
    const category_id = await categoryId(context, category)

    for (let month = 10; month <= 21; month += 1) {
      const year = month <= 12 ? 2_025 : 2_026
      const inYear = month <= 12 ? month : month - 12
      const date = `${year}-${String(inYear).padStart(2, '0')}-05`

      await context.client.query(
        `insert into transactions
           (household_id, account_id, posted_date, amount, category_id, pending, status, source)
         values ($1, $2, $3, $4, $5, false, 'active', 'synced')`,
        [context.householdId, accountId, date, context.cipher.encryptMoney(monthlyCents), category_id],
      )
    }
  }

  /** A household with a portfolio, a year of spending, and one member ready to retire. */
  async function completeHousehold(): Promise<void> {
    await createHousehold(deps, OWNER, 'The Goldbergs')

    await withHouseholdContext(deps, OWNER, async (ctx) => {
      const plan = await ensureRetirementPlan(ctx)

      const { accountId } = await createManualAccount(ctx, {
        name: 'Workplace 401(k)',
        institutionName: 'Fidelity',
        type: 'investment',
        balanceCents: 600_000_00n,
        effectiveDate: '2026-01-01',
        taxTreatment: 'traditional',
      })

      const { accountId: checking } = await createManualAccount(ctx, {
        name: 'Checking',
        institutionName: 'Local Bank',
        type: 'depository',
        balanceCents: 30_000_00n,
        effectiveDate: '2026-01-01',
      })

      await spendMonthly(ctx, checking, 'living', -5_000_00n)

      await addRetirementMember(ctx, plan.profile.id, {
        displayName: 'Scott',
        birthYear: 1_975,
        targetRetirementDate: '2040-06-01' as never,
        socialSecurityClaimAge: 67,
        socialSecurityAnnualBenefitCents: 34_000_00n,
        lifeExpectancy: 90,
      })

      await setSpendingAssumption(ctx, plan.profile.id, {
        categoryId: await categoryId(ctx, 'living'),
        treatment: 'continues',
        reviewedAt: NOW,
      })

      await setContributionRoute(ctx, accountId, 'traditional', 23_000_00n)
    })
  }

  describe('a complete plan', () => {
    it('runs all three scenarios as a band', async () => {
      await completeHousehold()

      const result = await withHouseholdContext(deps, OWNER, (ctx) =>
        runRetirementProjection(ctx, { today: TODAY }),
      )

      expect(result.ready).toBe(true)
      if (!result.ready) return

      expect(result.projections).toHaveLength(3)
      expect(result.startYear).toBe(2_026)
      // 1975 + 90.
      expect(result.endYear).toBe(2_065)

      // The band must not cross over itself at any point.
      const [low, mid, high] = result.projections
      for (let index = 0; index < low!.years.length; index += 1) {
        expect(low!.years[index]!.totalCents).toBeLessThanOrEqual(mid!.years[index]!.totalCents)
        expect(mid!.years[index]!.totalCents).toBeLessThanOrEqual(high!.years[index]!.totalCents)
      }
    })

    it('builds the baseline from a real year of transactions', async () => {
      await completeHousehold()

      const result = await withHouseholdContext(deps, OWNER, (ctx) =>
        runRetirementProjection(ctx, { today: TODAY }),
      )

      expect(result.ready).toBe(true)
      if (!result.ready) return

      expect(result.monthsObserved).toBe(12)
      expect(result.annualizedFromPartialYear).toBe(false)
      expect(result.unreviewedCategoryIds).toEqual([])

      // $5,000 a month for twelve months, continuing.
      const firstRetired = result.projections[0]!.years.find((year) => year.retired)
      expect(firstRetired?.spendingCents).toBe(-60_000_00n)
    })

    it('opens with the real portfolio total, not a modelled one', async () => {
      await completeHousehold()

      const result = await withHouseholdContext(deps, OWNER, (ctx) =>
        runRetirementProjection(ctx, { today: TODAY }),
      )

      expect(result.ready).toBe(true)
      if (!result.ready) return

      const opening = result.projections[0]!.years[0]!
      // $600,000 of 401(k) plus $30,000 of cash, grown one year and contributed to.
      expect(opening.totalCents).toBeGreaterThan(630_000_00n)
      expect(opening.contributionsCents).toBe(23_000_00n)
    })

    it('declares what it does not model', async () => {
      await completeHousehold()

      const result = await withHouseholdContext(deps, OWNER, (ctx) =>
        runRetirementProjection(ctx, { today: TODAY }),
      )

      expect(result.ready).toBe(true)
      if (!result.ready) return
      expect(result.projections[0]?.notModelled).toContain('required_minimum_distributions')
    })
  })

  describe('what the baseline leaves out', () => {
    it('excludes a confirmed transfer, so saving is not spending', async () => {
      /*
       * Filtered with the same predicate the cash flow screens use. Two implementations of "what
       * counts as spending" would eventually disagree, and the one in the retirement baseline is
       * the one nobody would notice.
       */
      await completeHousehold()

      await withHouseholdContext(deps, OWNER, async (ctx) => {
        const rows = await ctx.client.query<{ id: string }>(
          `select id from accounts where type = 'depository'`,
        )
        const checking = rows.rows[0]!.id
        const transfers = await categoryId(ctx, 'to-savings')

        const inserted = await ctx.client.query<{ id: string }>(
          `insert into transactions
             (household_id, account_id, posted_date, amount, category_id, pending, status, source)
           values ($1, $2, '2026-05-05', $3, $4, false, 'active', 'synced')
           returning id`,
          [ctx.householdId, checking, ctx.cipher.encryptMoney(-50_000_00n), transfers],
        )

        /*
         * Paired with itself, which is enough: `isExcludedFromCashFlow` only asks whether the id is
         * in the confirmed set. `pair_key` comes from the shared helper rather than being
         * hand-rolled, because the column is not null and the real matcher derives it the same way.
         */
        const id = inserted.rows[0]!.id
        await ctx.client.query(
          `insert into transfer_matches
             (household_id, from_transaction_id, to_transaction_id, pair_key, status, confirmed_at)
           values ($1, $2, $2, $3, 'confirmed', now())`,
          [ctx.householdId, id, pairKeyFor(id, id)],
        )
      })

      const result = await withHouseholdContext(deps, OWNER, (ctx) =>
        runRetirementProjection(ctx, { today: TODAY }),
      )

      expect(result.ready).toBe(true)
      if (!result.ready) return

      // Still only the $60,000 of living costs. The $50,000 moved to savings is not consumption.
      const firstRetired = result.projections[0]!.years.find((year) => year.retired)
      expect(firstRetired?.spendingCents).toBe(-60_000_00n)
    })

    it('excludes another member’s private account', async () => {
      /*
       * The decision this encodes: a private account's spending is outside the household baseline,
       * exactly as it is outside every other rollup (§6.4). The consequence is deliberate — two
       * members of one household see different projections, because the owner's baseline includes
       * spending the other member cannot see.
       *
       * The alternative was summing everything into the total and hiding the breakdown, which
       * leaks: subtract the visible categories from the total and you have inferred the rest.
       */
      await completeHousehold()

      const token = await withHouseholdContext(deps, OWNER, async (ctx) => {
        const invite = await createInvite(ctx, { now: NOW })
        return invite.token
      })
      await acceptInvite(deps, PARTNER, token, NOW)

      await withHouseholdContext(deps, OWNER, async (ctx) => {
        const { accountId } = await createManualAccount(ctx, {
          name: 'My own card',
          institutionName: 'Another Bank',
          type: 'depository',
          balanceCents: 1_000_00n,
          effectiveDate: '2026-01-01',
        })
        await ctx.client.query(
          'update accounts set is_shared = false, owner_user_id = $2 where id = $1',
          [accountId, OWNER],
        )
        await spendMonthly(ctx, accountId, 'private-habit', -1_000_00n)
      })

      const mine = await withHouseholdContext(deps, OWNER, (ctx) =>
        runRetirementProjection(ctx, { today: TODAY }),
      )
      const theirs = await withHouseholdContext(deps, PARTNER, (ctx) =>
        runRetirementProjection(ctx, { today: TODAY }),
      )

      expect(mine.ready && theirs.ready).toBe(true)
      if (!mine.ready || !theirs.ready) return

      const spendingOf = (result: typeof mine) =>
        result.projections[0]!.years.find((year) => year.retired)?.spendingCents

      // The owner sees both; the partner sees only the shared living costs.
      expect(spendingOf(mine)).toBe(-72_000_00n)
      expect(spendingOf(theirs)).toBe(-60_000_00n)
    })
  })

  describe('an incomplete plan', () => {
    it('reports every missing input before anyone has started', async () => {
      await createHousehold(deps, OWNER, 'The Goldbergs')

      const result = await withHouseholdContext(deps, OWNER, (ctx) =>
        runRetirementProjection(ctx, { today: TODAY }),
      )

      expect(result.ready).toBe(false)
      if (result.ready) return
      expect(result.missing).toContain('members')
      expect(result.missing).toContain('balances')
    })

    it('reports a missing life expectancy rather than projecting without one', async () => {
      await createHousehold(deps, OWNER, 'The Goldbergs')

      await withHouseholdContext(deps, OWNER, async (ctx) => {
        const plan = await ensureRetirementPlan(ctx)
        const { accountId } = await createManualAccount(ctx, {
          name: 'Workplace 401(k)',
          institutionName: 'Fidelity',
          type: 'investment',
          balanceCents: 600_000_00n,
          effectiveDate: '2026-01-01',
          taxTreatment: 'traditional',
        })
        await spendMonthly(ctx, accountId, 'living', -5_000_00n)

        await addRetirementMember(ctx, plan.profile.id, {
          displayName: 'Scott',
          birthYear: 1_975,
          targetRetirementDate: '2040-06-01' as never,
        })
      })

      const result = await withHouseholdContext(deps, OWNER, (ctx) =>
        runRetirementProjection(ctx, { today: TODAY }),
      )

      expect(result.ready).toBe(false)
      if (result.ready) return
      expect(result.missing).toEqual(['life_expectancy'])
    })
  })

  describe('a partial year of history', () => {
    it('scales to a year and says that it did', async () => {
      await createHousehold(deps, OWNER, 'The Goldbergs')

      await withHouseholdContext(deps, OWNER, async (ctx) => {
        const plan = await ensureRetirementPlan(ctx)
        const { accountId } = await createManualAccount(ctx, {
          name: 'Workplace 401(k)',
          institutionName: 'Fidelity',
          type: 'investment',
          balanceCents: 600_000_00n,
          effectiveDate: '2026-01-01',
          taxTreatment: 'traditional',
        })

        const living = await categoryId(ctx, 'living')
        // Three months only.
        for (const date of ['2026-07-05', '2026-08-05', '2026-09-05']) {
          await ctx.client.query(
            `insert into transactions
               (household_id, account_id, posted_date, amount, category_id, pending, status, source)
             values ($1, $2, $3, $4, $5, false, 'active', 'synced')`,
            [ctx.householdId, accountId, date, ctx.cipher.encryptMoney(-5_000_00n), living],
          )
        }

        await addRetirementMember(ctx, plan.profile.id, {
          displayName: 'Scott',
          birthYear: 1_975,
          targetRetirementDate: '2040-06-01' as never,
          lifeExpectancy: 90,
        })
        await setSpendingAssumption(ctx, plan.profile.id, {
          categoryId: living,
          treatment: 'continues',
          reviewedAt: NOW,
        })
      })

      const result = await withHouseholdContext(deps, OWNER, (ctx) =>
        runRetirementProjection(ctx, { today: TODAY }),
      )

      expect(result.ready).toBe(true)
      if (!result.ready) return

      expect(result.monthsObserved).toBe(3)
      expect(result.annualizedFromPartialYear).toBe(true)
      // $15,000 over three months scaled to $60,000, and flagged as scaled.
      const firstRetired = result.projections[0]!.years.find((year) => year.retired)
      expect(firstRetired?.spendingCents).toBe(-60_000_00n)
    })
  })
})
