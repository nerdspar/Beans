import { PLACEHOLDER_VALUE, REFERENCE_DEFINITIONS, referenceReadiness } from '@beans/shared'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DataKeyCache } from '../crypto/data-key-cache.js'
import { LocalMasterKeyProvider } from '../crypto/local-master-key-provider.js'
import { resetAll, resetHouseholdsFor } from '../test-support/reset-database.js'
import {
  createHousehold,
  withHouseholdContext,
  type ContextDependencies,
} from './household-context.js'
import { acceptInvite, createInvite } from './invites.js'
import {
  approveReference,
  ensureReferenceYear,
  readReferenceYear,
  revokeReference,
} from './reference.js'
import { RetirementError } from './retirement.js'

/**
 * The statutory reference table and its approval gate (ARCHITECTURE.md §19.5).
 *
 * The gate is the point. Everything else in the retirement feature produces a number that is wrong
 * by an assumption somebody can see and argue with; an unapproved contribution limit produces a
 * number that is wrong by law.
 *
 * This table is also the one with **no `household_id` and no RLS**, so the tests below check the
 * consequence directly: both households see the same figures, and approval is an owner's action
 * because it changes what every household in the install is told.
 *
 * Fixed dates throughout (CLAUDE.md).
 */

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL']
const MASTER_KEY = Buffer.alloc(32, 0x11).toString('base64')

const OWNER = 'ref-owner-fixed-id'
const MEMBER = 'ref-member-fixed-id'
const OTHER = 'ref-other-fixed-id'

const YEAR = 2_099
const NOW = new Date('2026-10-12T12:00:00.000Z')

const describeIntegration = TEST_DATABASE_URL === undefined ? describe.skip : describe

describeIntegration('statutory reference data', () => {
  let pool: Pool
  let deps: ContextDependencies

  const users = [OWNER, MEMBER, OTHER] as const

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
      [OWNER, 'ref-owner@example.com'],
      [MEMBER, 'ref-member@example.com'],
      [OTHER, 'ref-other@example.com'],
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
    /*
     * Cleared by hand, because this table has no household to cascade from. That is the cost of
     * being global, and forgetting it would leak one test's approvals into the next.
     */
    await pool.query('delete from contribution_limits where tax_year = $1', [YEAR])
  })

  describe('seeding the checklist', () => {
    it('creates every figure unverified, with an absurd placeholder', async () => {
      /*
       * Shipping placeholders is only safe because of the gate. The value is deliberately not
       * plausible — one cent is self-evidently not a contribution limit — so that if one ever
       * escaped it would read as broken rather than as an answer.
       */
      await createHousehold(deps, OWNER, 'The Goldbergs')

      const rows = await withHouseholdContext(deps, OWNER, (ctx) =>
        ensureReferenceYear(ctx, YEAR),
      )

      expect(rows).toHaveLength(REFERENCE_DEFINITIONS.length)
      expect(rows.every((row) => row.verifiedAt === null)).toBe(true)
      expect(rows.every((row) => row.value === PLACEHOLDER_VALUE)).toBe(true)
      expect(referenceReadiness(rows, YEAR).ready).toBe(false)
    })

    it('is idempotent and does not reset an approval', async () => {
      // The screen seeds on every read. Re-seeding must not undo a figure somebody checked.
      await createHousehold(deps, OWNER, 'The Goldbergs')

      await withHouseholdContext(deps, OWNER, async (ctx) => {
        await ensureReferenceYear(ctx, YEAR)
        await approveReference(
          ctx,
          { taxYear: YEAR, key: 'rmd_start_age', value: 73n, sourceUrl: 'https://irs.test/rmd' },
          NOW,
        )
      })

      const rows = await withHouseholdContext(deps, OWNER, (ctx) =>
        ensureReferenceYear(ctx, YEAR),
      )

      expect(rows).toHaveLength(REFERENCE_DEFINITIONS.length)
      const rmd = rows.find((row) => row.key === 'rmd_start_age')
      expect(rmd?.value).toBe(73n)
      expect(rmd?.verifiedAt).not.toBeNull()
    })

    it('keeps years apart, so approving one never carries into the next', async () => {
      /*
       * The spec names this one: a missing year must produce a visible "not yet updated" state,
       * never a silent fallback to last year's number.
       */
      await createHousehold(deps, OWNER, 'The Goldbergs')

      await withHouseholdContext(deps, OWNER, async (ctx) => {
        await ensureReferenceYear(ctx, YEAR)
        await approveReference(
          ctx,
          { taxYear: YEAR, key: 'rmd_start_age', value: 73n, sourceUrl: 'https://irs.test/rmd' },
          NOW,
        )
      })

      const nextYear = await withHouseholdContext(deps, OWNER, (ctx) =>
        readReferenceYear(ctx, YEAR + 1),
      )

      expect(nextYear).toEqual([])

      await pool.query('delete from contribution_limits where tax_year = $1', [YEAR + 1])
    })
  })

  describe('approval', () => {
    it('records the figure, its source and who approved it', async () => {
      await createHousehold(deps, OWNER, 'The Goldbergs')

      await withHouseholdContext(deps, OWNER, async (ctx) => {
        await ensureReferenceYear(ctx, YEAR)
        await approveReference(
          ctx,
          {
            taxYear: YEAR,
            key: 'employee_deferral_limit',
            value: 2_350_000n,
            sourceUrl: 'https://irs.test/401k',
          },
          NOW,
        )
      })

      const rows = await withHouseholdContext(deps, OWNER, (ctx) => readReferenceYear(ctx, YEAR))
      const figure = rows.find((row) => row.key === 'employee_deferral_limit')

      expect(figure?.value).toBe(2_350_000n)
      expect(figure?.sourceUrl).toBe('https://irs.test/401k')
      expect(figure?.verifiedAt).toEqual(NOW)

      const audit = await pool.query<{ verified_by: string }>(
        'select verified_by from contribution_limits where tax_year = $1 and key = $2',
        [YEAR, 'employee_deferral_limit'],
      )
      expect(audit.rows[0]?.verified_by).toBe(OWNER)
    })

    it('survives a value too large for a JS number', async () => {
      /*
       * `bigint` all the way through. node-pg returns the column as a string, and reading it with
       * `Number` rather than `BigInt` would silently round — which in a table of money limits is
       * the same class of bug the whole codebase avoids by never putting money in a float.
       */
      await createHousehold(deps, OWNER, 'The Goldbergs')

      const huge = 9_007_199_254_740_993n // 2^53 + 1, the first integer a double cannot hold.

      await withHouseholdContext(deps, OWNER, async (ctx) => {
        await ensureReferenceYear(ctx, YEAR)
        await approveReference(
          ctx,
          { taxYear: YEAR, key: 'ira_contribution_limit', value: huge, sourceUrl: 'https://a.test' },
          NOW,
        )
      })

      const rows = await withHouseholdContext(deps, OWNER, (ctx) => readReferenceYear(ctx, YEAR))
      expect(rows.find((row) => row.key === 'ira_contribution_limit')?.value).toBe(huge)
    })

    it('becomes ready only once every figure is approved', async () => {
      // One unapproved row is enough to hold the banner up. A projection resting on thirteen
      // checked figures and one invented one is not thirteen-fourteenths right.
      await createHousehold(deps, OWNER, 'The Goldbergs')

      await withHouseholdContext(deps, OWNER, async (ctx) => {
        await ensureReferenceYear(ctx, YEAR)

        for (const definition of REFERENCE_DEFINITIONS.slice(0, -1)) {
          await approveReference(
            ctx,
            {
              taxYear: YEAR,
              key: definition.key,
              value: 5n,
              sourceUrl: definition.sourceUrl,
            },
            NOW,
          )
        }
      })

      let rows = await withHouseholdContext(deps, OWNER, (ctx) => readReferenceYear(ctx, YEAR))
      expect(referenceReadiness(rows, YEAR).ready).toBe(false)

      const last = REFERENCE_DEFINITIONS.at(-1)!
      await withHouseholdContext(deps, OWNER, (ctx) =>
        approveReference(
          ctx,
          { taxYear: YEAR, key: last.key, value: 5n, sourceUrl: last.sourceUrl },
          NOW,
        ),
      )

      rows = await withHouseholdContext(deps, OWNER, (ctx) => readReferenceYear(ctx, YEAR))
      expect(referenceReadiness(rows, YEAR).ready).toBe(true)
    })

    it('refuses an unknown figure rather than inserting one', async () => {
      await createHousehold(deps, OWNER, 'The Goldbergs')

      await expect(
        withHouseholdContext(deps, OWNER, async (ctx) => {
          await ensureReferenceYear(ctx, YEAR)
          await approveReference(
            ctx,
            { taxYear: YEAR, key: 'not_a_real_key', value: 1n, sourceUrl: 'https://a.test' },
            NOW,
          )
        }),
      ).rejects.toThrow(RetirementError)
    })
  })

  describe('withdrawing approval', () => {
    it('puts the figure back behind the gate but keeps the value', async () => {
      /*
       * Somebody un-approving a row is usually saying "this looks wrong, I need to check it".
       * Wiping the value would destroy the thing they were about to compare against.
       */
      await createHousehold(deps, OWNER, 'The Goldbergs')

      await withHouseholdContext(deps, OWNER, async (ctx) => {
        await ensureReferenceYear(ctx, YEAR)
        await approveReference(
          ctx,
          { taxYear: YEAR, key: 'rmd_start_age', value: 73n, sourceUrl: 'https://irs.test/rmd' },
          NOW,
        )
        await revokeReference(ctx, YEAR, 'rmd_start_age')
      })

      const rows = await withHouseholdContext(deps, OWNER, (ctx) => readReferenceYear(ctx, YEAR))
      const figure = rows.find((row) => row.key === 'rmd_start_age')

      expect(figure?.verifiedAt).toBeNull()
      expect(figure?.value).toBe(73n)
    })
  })

  describe('who may approve', () => {
    it('refuses a household member who is not the owner', async () => {
      /*
       * Approving changes what *every* household in the install is told about tax law, so it is an
       * owner's action. The table being global is exactly why this matters.
       */
      await createHousehold(deps, OWNER, 'The Goldbergs')
      await withHouseholdContext(deps, OWNER, (ctx) => ensureReferenceYear(ctx, YEAR))

      const token = await withHouseholdContext(deps, OWNER, async (ctx) => {
        const invite = await createInvite(ctx, { now: NOW })
        return invite.token
      })
      await acceptInvite(deps, MEMBER, token, NOW)

      await expect(
        withHouseholdContext(deps, MEMBER, (ctx) =>
          approveReference(
            ctx,
            { taxYear: YEAR, key: 'rmd_start_age', value: 1n, sourceUrl: 'https://a.test' },
            NOW,
          ),
        ),
      ).rejects.toThrow(/owner/)

      const rows = await withHouseholdContext(deps, OWNER, (ctx) => readReferenceYear(ctx, YEAR))
      expect(rows.find((row) => row.key === 'rmd_start_age')?.verifiedAt).toBeNull()
    })

    it('refuses a non-owner withdrawing an approval too', async () => {
      await createHousehold(deps, OWNER, 'The Goldbergs')
      await withHouseholdContext(deps, OWNER, async (ctx) => {
        await ensureReferenceYear(ctx, YEAR)
        await approveReference(
          ctx,
          { taxYear: YEAR, key: 'rmd_start_age', value: 73n, sourceUrl: 'https://irs.test/rmd' },
          NOW,
        )
      })

      const token = await withHouseholdContext(deps, OWNER, async (ctx) => {
        const invite = await createInvite(ctx, { now: NOW })
        return invite.token
      })
      await acceptInvite(deps, MEMBER, token, NOW)

      await expect(
        withHouseholdContext(deps, MEMBER, (ctx) => revokeReference(ctx, YEAR, 'rmd_start_age')),
      ).rejects.toThrow(/owner/)
    })
  })

  describe('being global', () => {
    it('shows the same approved figure to a different household', async () => {
      /*
       * The deliberate consequence of no `household_id`: these are figures the IRS publishes, the
       * same for everybody. One copy per household would mean a guarantee they drift apart.
       */
      await createHousehold(deps, OWNER, 'The Goldbergs')
      await withHouseholdContext(deps, OWNER, async (ctx) => {
        await ensureReferenceYear(ctx, YEAR)
        await approveReference(
          ctx,
          { taxYear: YEAR, key: 'rmd_start_age', value: 73n, sourceUrl: 'https://irs.test/rmd' },
          NOW,
        )
      })

      await createHousehold(deps, OTHER, 'Somebody Else')
      const theirs = await withHouseholdContext(deps, OTHER, (ctx) =>
        readReferenceYear(ctx, YEAR),
      )

      const figure = theirs.find((row) => row.key === 'rmd_start_age')
      expect(figure?.value).toBe(73n)
      expect(figure?.verifiedAt).not.toBeNull()
    })
  })
})
