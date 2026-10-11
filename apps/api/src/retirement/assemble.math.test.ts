import { retirementSpending, type RetirementSpending } from '@beans/shared'
import { describe, expect, it } from 'vitest'
import type { RetirementPlan } from '../repositories/retirement.js'
import {
  assembleProjection,
  type AssembleOptions,
  type RetirementAccount,
} from './assemble.js'

/**
 * Assembling a projection out of what the household actually has.
 *
 * The cases worth pinning are the ones where including the wrong thing produces a plan that looks
 * funded when it is not: a house counted as drawable, a mortgage netted against the portfolio, or a
 * missing life expectancy silently defaulted to a comfortable age.
 *
 * Fixed dates throughout (CLAUDE.md). No database — everything this needs is passed in.
 */

const TODAY = '2026-10-10' as AssembleOptions['today']

const spendingOf = (annualCents: bigint): RetirementSpending =>
  retirementSpending({
    trailingByCategory: [{ categoryId: 'living', cents: annualCents }],
    monthsObserved: 12,
    assumptions: [{ categoryId: 'living', treatment: 'continues' }],
  })

const plan = (over: Partial<RetirementPlan> = {}): RetirementPlan => ({
  profile: {
    id: 'profile-1',
    retirementEffectiveRateBasisPoints: 2_200,
    withdrawalOrder: null,
    pre65HealthcareAnnualCents: null,
  },
  members: [
    {
      id: 'member-1',
      displayName: 'Scott',
      userId: null,
      birthYear: 1_975,
      targetRetirementDate: '2040-06-01' as never,
      socialSecurityClaimAge: 67,
      socialSecurityAnnualBenefitCents: 34_000_00n,
      lifeExpectancy: 92,
    },
  ],
  scenarios: [
    {
      id: 'expected',
      name: 'Markets behave',
      preRetirementReturnBasisPoints: 500,
      postRetirementReturnBasisPoints: 350,
      annualSpendingOverrideCents: null,
      retirementYearsOffset: null,
      isDefault: true,
      sortOrder: 1,
    },
  ],
  ...over,
})

const account = (over: Partial<RetirementAccount> = {}): RetirementAccount => ({
  id: 'account-1',
  type: 'investment',
  taxTreatment: 'traditional',
  balanceCents: 400_000_00n,
  ...over,
})

const assemble = (over: Partial<AssembleOptions> = {}) =>
  assembleProjection({
    today: TODAY,
    plan: plan(),
    accounts: [account()],
    bucketAnchors: [],
    routing: [],
    spending: spendingOf(-72_000_00n),
    ...over,
  })

describe('assembleProjection', () => {
  it('builds a runnable projection from a complete plan', () => {
    const result = assemble()

    expect(result.ready).toBe(true)
    if (!result.ready) return

    expect(result.input.startYear).toBe(2_026)
    // 1975 + 92.
    expect(result.input.endYear).toBe(2_067)
    expect(result.input.members[0]).toMatchObject({
      birthYear: 1_975,
      retirementYear: 2_040,
      socialSecurityClaimAge: 67,
      socialSecurityAnnualBenefitCents: 34_000_00n,
    })
    expect(result.input.openingBuckets).toEqual([
      { treatment: 'traditional', balanceCents: 400_000_00n },
    ])
    expect(result.scenarios).toHaveLength(1)
  })

  describe('which accounts count', () => {
    it('counts cash and investments', () => {
      const result = assemble({
        accounts: [
          account({ id: 'brokerage', type: 'investment', taxTreatment: 'taxable', balanceCents: 200_000_00n }),
          account({ id: 'checking', type: 'depository', taxTreatment: 'none', balanceCents: 20_000_00n }),
        ],
      })

      expect(result.ready).toBe(true)
      if (!result.ready) return

      // Cash lands under `taxable`: it has already been taxed and is spendable at face value.
      expect(result.input.openingBuckets).toEqual([
        { treatment: 'taxable', balanceCents: 220_000_00n },
      ])
    })

    it('does not count a house as money to retire on', () => {
      /*
       * A house is not a retirement portfolio, and selling it is a decision with somewhere to live
       * attached that Beans cannot model. Counting it would make almost every plan look funded.
       */
      const result = assemble({
        accounts: [
          account({ id: 'investments', balanceCents: 400_000_00n }),
          account({ id: 'house', type: 'other_asset', taxTreatment: 'none', balanceCents: 750_000_00n }),
        ],
      })

      expect(result.ready).toBe(true)
      if (!result.ready) return

      const total = result.input.openingBuckets.reduce((sum, b) => sum + b.balanceCents, 0n)
      expect(total).toBe(400_000_00n)
    })

    it('does not net a mortgage against the portfolio', () => {
      /*
       * A mortgage is a monthly cost, not a negative pot. It reaches the projection through the
       * spending baseline and leaves on its payoff date; netting it here would both understate the
       * drawdown and drop the payment at the wrong moment.
       */
      const result = assemble({
        accounts: [
          account({ id: 'investments', balanceCents: 400_000_00n }),
          account({ id: 'mortgage', type: 'mortgage', taxTreatment: 'none', balanceCents: -300_000_00n }),
        ],
      })

      expect(result.ready).toBe(true)
      if (!result.ready) return

      const total = result.input.openingBuckets.reduce((sum, b) => sum + b.balanceCents, 0n)
      expect(total).toBe(400_000_00n)
    })

    it('ignores an account with no observed balance', () => {
      const result = assemble({
        accounts: [
          account({ id: 'real', balanceCents: 400_000_00n }),
          account({ id: 'never-synced', balanceCents: null }),
        ],
      })

      expect(result.ready).toBe(true)
      if (!result.ready) return
      expect(result.input.openingBuckets).toEqual([
        { treatment: 'traditional', balanceCents: 400_000_00n },
      ])
    })
  })

  describe('bucket splits', () => {
    it('uses the carried-forward split when the account has an anchor', () => {
      const result = assemble({
        accounts: [account({ balanceCents: 400_000_00n })],
        bucketAnchors: [
          {
            accountId: 'account-1',
            anchors: [
              {
                asOfDate: '2026-01-01' as never,
                buckets: [
                  { treatment: 'traditional', balanceCents: 150_000_00n },
                  { treatment: 'roth', balanceCents: 50_000_00n },
                ],
              },
            ],
          },
        ],
      })

      expect(result.ready).toBe(true)
      if (!result.ready) return

      // Three quarters and one quarter of the real balance, not of the anchor's total.
      expect(result.input.openingBuckets).toEqual([
        { treatment: 'traditional', balanceCents: 300_000_00n },
        { treatment: 'roth', balanceCents: 100_000_00n },
      ])
    })

    it('keeps the portfolio total equal to the sum of the accounts', () => {
      /*
       * The property that matters more than the split: the proportions are modelled, but the total
       * is observed. A split that lost or invented a cent would make the projection start from a
       * number the account screen disagrees with.
       */
      const result = assemble({
        accounts: [account({ balanceCents: 1_234_567_89n })],
        bucketAnchors: [
          {
            accountId: 'account-1',
            anchors: [
              {
                asOfDate: '2020-03-15' as never,
                buckets: [
                  { treatment: 'traditional', balanceCents: 33_333_33n },
                  { treatment: 'roth', balanceCents: 66_666_67n },
                ],
              },
            ],
          },
        ],
        routing: [
          { accountId: 'account-1', treatment: 'roth', annualCents: 7_000_00n, active: true },
        ],
      })

      expect(result.ready).toBe(true)
      if (!result.ready) return

      const total = result.input.openingBuckets.reduce((sum, b) => sum + b.balanceCents, 0n)
      expect(total).toBe(1_234_567_89n)
    })

    it('falls back to the account treatment when the anchor is in the future', () => {
      // `carryBucketsForward` returns nothing for an anchor dated after the date asked about, and
      // dropping the balance instead of falling back would quietly shrink the portfolio.
      const result = assemble({
        accounts: [account({ taxTreatment: 'roth', balanceCents: 400_000_00n })],
        bucketAnchors: [
          {
            accountId: 'account-1',
            anchors: [
              {
                asOfDate: '2030-01-01' as never,
                buckets: [{ treatment: 'traditional', balanceCents: 1n }],
              },
            ],
          },
        ],
      })

      expect(result.ready).toBe(true)
      if (!result.ready) return
      expect(result.input.openingBuckets).toEqual([
        { treatment: 'roth', balanceCents: 400_000_00n },
      ])
    })
  })

  describe('contributions', () => {
    it('sums active routes by destination treatment', () => {
      const result = assemble({
        routing: [
          { accountId: 'account-1', treatment: 'roth', annualCents: 7_000_00n, active: true },
          { accountId: 'other', treatment: 'roth', annualCents: 23_000_00n, active: true },
          { accountId: 'other', treatment: 'traditional', annualCents: 5_000_00n, active: true },
        ],
      })

      expect(result.ready).toBe(true)
      if (!result.ready) return
      expect(result.input.contributions).toEqual([
        { treatment: 'roth', annualCents: 30_000_00n },
        { treatment: 'traditional', annualCents: 5_000_00n },
      ])
    })

    it('ignores an inactive route', () => {
      // Kept in the table so stopping and restarting does not lose the amount, but it is not money
      // going in.
      const result = assemble({
        routing: [
          { accountId: 'account-1', treatment: 'roth', annualCents: 7_000_00n, active: false },
        ],
      })

      expect(result.ready).toBe(true)
      if (!result.ready) return
      expect(result.input.contributions).toEqual([])
    })
  })

  describe('a plan too incomplete to run', () => {
    it('reports a missing retirement date rather than inventing one', () => {
      const result = assemble({
        plan: plan({
          members: [{ ...plan().members[0]!, targetRetirementDate: null }],
        }),
      })

      expect(result.ready).toBe(false)
      if (result.ready) return
      expect(result.missing).toContain('retirement_date')
    })

    it('reports a missing life expectancy rather than defaulting to a comfortable age', () => {
      /*
       * "How long will the money last" is the question being asked. Quietly answering 95 on the
       * user's behalf bakes an invented assumption into the answer, and the horizon moves the
       * result more than almost anything else.
       */
      const result = assemble({
        plan: plan({ members: [{ ...plan().members[0]!, lifeExpectancy: null }] }),
      })

      expect(result.ready).toBe(false)
      if (result.ready) return
      expect(result.missing).toContain('life_expectancy')
    })

    it('reports no members', () => {
      const result = assemble({ plan: plan({ members: [] }) })

      expect(result.ready).toBe(false)
      if (result.ready) return
      expect(result.missing).toContain('members')
    })

    it('reports no spending baseline', () => {
      const result = assemble({
        spending: retirementSpending({
          trailingByCategory: [],
          monthsObserved: 0,
          assumptions: [],
        }),
      })

      expect(result.ready).toBe(false)
      if (result.ready) return
      expect(result.missing).toContain('spending_baseline')
    })

    it('reports nothing to draw down', () => {
      const result = assemble({
        accounts: [account({ type: 'other_asset', balanceCents: 750_000_00n })],
      })

      expect(result.ready).toBe(false)
      if (result.ready) return
      expect(result.missing).toContain('balances')
    })

    it('lists every missing thing, not only the first', () => {
      // The wizard's job is to say what is still needed, and the first gap is rarely the only one.
      const result = assemble({
        plan: plan({ members: [] }),
        accounts: [],
        spending: retirementSpending({
          trailingByCategory: [],
          monthsObserved: 0,
          assumptions: [],
        }),
      })

      expect(result.ready).toBe(false)
      if (result.ready) return
      expect(result.missing).toEqual(['members', 'spending_baseline', 'balances'])
    })
  })

  describe('the horizon', () => {
    it('runs to the longest-lived member', () => {
      // Stopping while somebody is still alive would report that the money lasted.
      const first = plan().members[0]!
      const result = assemble({
        plan: plan({
          members: [
            first,
            { ...first, id: 'member-2', birthYear: 1_980, lifeExpectancy: 95 },
          ],
        }),
      })

      expect(result.ready).toBe(true)
      if (!result.ready) return
      // 1980 + 95 beats 1975 + 92.
      expect(result.input.endYear).toBe(2_075)
    })
  })

  describe('the profile', () => {
    it('passes the tax rate and withdrawal order through', () => {
      const result = assemble({
        plan: plan({
          profile: {
            id: 'profile-1',
            retirementEffectiveRateBasisPoints: 1_800,
            withdrawalOrder: ['roth', 'taxable'],
            pre65HealthcareAnnualCents: null,
          },
        }),
      })

      expect(result.ready).toBe(true)
      if (!result.ready) return
      expect(result.input.retirementEffectiveRateBasisPoints).toBe(1_800)
      expect(result.input.withdrawalOrder).toEqual(['roth', 'taxable'])
    })

    it('carries a scenario’s overrides through only when they are set', () => {
      const base = plan().scenarios[0]!
      const result = assemble({
        plan: plan({
          scenarios: [
            base,
            {
              ...base,
              id: 'early',
              name: 'Retire early',
              isDefault: false,
              annualSpendingOverrideCents: -60_000_00n,
              retirementYearsOffset: -3,
            },
          ],
        }),
      })

      expect(result.ready).toBe(true)
      if (!result.ready) return

      expect(result.scenarios[0]).not.toHaveProperty('annualSpendingOverrideCents')
      expect(result.scenarios[1]).toMatchObject({
        annualSpendingOverrideCents: -60_000_00n,
        retirementYearsOffset: -3,
      })
    })
  })
})
