import { describe, expect, it } from 'vitest'
import type { BucketBalance, ContributionRouting } from './buckets.js'
import {
  DEFAULT_WITHDRAWAL_ORDER,
  projectScenario,
  projectScenarios,
  type ProjectionInput,
  type ProjectionMember,
  type ProjectionScenario,
} from './projection.js'
import { retirementSpending, type RetirementSpending } from './spending.js'

/**
 * The deterministic projection.
 *
 * The first test is a full hand-computed year-by-year trace, which the spec asks for by name. The
 * rest pin the behaviours where a plausible implementation is quietly wrong: a bucket running dry
 * mid-year, tax funded out of the withdrawal rather than out of thin air, a 529 being spent on
 * groceries, and the band crossing over itself.
 *
 * Fixed years throughout. Nothing here reads a clock.
 */

const bucket = (treatment: string, balanceCents: bigint): BucketBalance => ({
  treatment: treatment as never,
  balanceCents,
})

const route = (treatment: string, annualCents: bigint): ContributionRouting => ({
  treatment: treatment as never,
  annualCents,
})

/** A single continuing cost, which is all most of these need. */
const costs = (annualCents: bigint): RetirementSpending =>
  retirementSpending({
    trailingByCategory: [{ categoryId: 'living', cents: annualCents }],
    monthsObserved: 12,
    assumptions: [{ categoryId: 'living', treatment: 'continues' }],
  })

const member = (over: Partial<ProjectionMember> = {}): ProjectionMember => ({
  id: 'one',
  birthYear: 1_961,
  retirementYear: 2_027,
  socialSecurityClaimAge: null,
  socialSecurityAnnualBenefitCents: 0n,
  ...over,
})

const scenario = (over: Partial<ProjectionScenario> = {}): ProjectionScenario => ({
  id: 'expected',
  name: 'Expected',
  preRetirementReturnBasisPoints: 0,
  postRetirementReturnBasisPoints: 0,
  ...over,
})

describe('projectScenario', () => {
  it('matches a hand-computed four-year trace', () => {
    /*
     * Worked by hand, so a refactor that changes the arithmetic fails here rather than quietly
     * producing a different retirement.
     *
     * Opening $100,000 taxable. Contributions $10,000/yr while working. Spending $30,000/yr once
     * retired in 2027. Social Security $20,000/yr from age 67, which is 2028. Pre-retirement return
     * 10%, post-retirement 0%, chosen so every step is checkable in your head.
     *
     *   2026  working: no spending. 100,000 grows 10% to 110,000, then +10,000 = 120,000
     *   2027  retired: need 30,000, no benefit yet. 120,000 - 30,000 = 90,000. No growth, no adds
     *   2028  retired: need 30,000 - 20,000 benefit = 10,000.  90,000 - 10,000 = 80,000
     *   2029  retired: same again.                             80,000 - 10,000 = 70,000
     */
    const input: ProjectionInput = {
      startYear: 2_026,
      endYear: 2_029,
      openingBuckets: [bucket('taxable', 100_000_00n)],
      contributions: [route('taxable', 10_000_00n)],
      spending: costs(-30_000_00n),
      members: [
        member({ socialSecurityClaimAge: 67, socialSecurityAnnualBenefitCents: 20_000_00n }),
      ],
      retirementEffectiveRateBasisPoints: 2_200,
    }

    const result = projectScenario(
      input,
      scenario({ preRetirementReturnBasisPoints: 1_000, postRetirementReturnBasisPoints: 0 }),
    )

    expect(result.years.map((y) => y.totalCents)).toEqual([
      120_000_00n,
      90_000_00n,
      80_000_00n,
      70_000_00n,
    ])

    const [working, firstRetired, claiming] = result.years

    expect(working).toMatchObject({
      year: 2_026,
      retired: false,
      spendingCents: 0n,
      socialSecurityCents: 0n,
      withdrawalsCents: 0n,
      growthCents: 10_000_00n,
      contributionsCents: 10_000_00n,
    })

    expect(firstRetired).toMatchObject({
      year: 2_027,
      retired: true,
      spendingCents: -30_000_00n,
      // Age 66 in 2027. The benefit has not started.
      socialSecurityCents: 0n,
      withdrawalsCents: 30_000_00n,
      contributionsCents: 0n,
      growthCents: 0n,
      shortfallCents: 0n,
    })

    expect(claiming).toMatchObject({
      year: 2_028,
      socialSecurityCents: 20_000_00n,
      withdrawalsCents: 10_000_00n,
    })

    expect(result.terminalTotalCents).toBe(70_000_00n)
    expect(result.depletionYear).toBeNull()
  })

  it('funds the tax on a pre-tax withdrawal out of the withdrawal', () => {
    /*
     * The failure this rules out is silent and expensive: withdraw exactly what is needed, pay tax
     * out of it, and the year is short by the tax while the plan reports that it held.
     *
     * To net $30,000 at a 25% effective rate takes a $40,000 gross withdrawal, of which $10,000 is
     * tax. The balance must fall by the full $40,000.
     */
    const result = projectScenario(
      {
        startYear: 2_030,
        endYear: 2_030,
        openingBuckets: [bucket('traditional', 100_000_00n)],
        contributions: [],
        spending: costs(-30_000_00n),
        members: [member({ retirementYear: 2_030 })],
        retirementEffectiveRateBasisPoints: 2_500,
      },
      scenario(),
    )

    const year = result.years[0]
    expect(year?.withdrawalsCents).toBe(40_000_00n)
    expect(year?.taxCents).toBe(10_000_00n)
    expect(year?.totalCents).toBe(60_000_00n)
    expect(year?.shortfallCents).toBe(0n)
  })

  it('does not tax a Roth or taxable withdrawal', () => {
    // Roth is tax-free; taxable is taken at face value because Beans has no cost basis (§19.3).
    const result = projectScenario(
      {
        startYear: 2_030,
        endYear: 2_030,
        openingBuckets: [bucket('taxable', 50_000_00n), bucket('roth', 50_000_00n)],
        contributions: [],
        spending: costs(-30_000_00n),
        members: [member({ retirementYear: 2_030 })],
        retirementEffectiveRateBasisPoints: 2_500,
      },
      scenario(),
    )

    expect(result.years[0]?.taxCents).toBe(0n)
    expect(result.years[0]?.withdrawalsCents).toBe(30_000_00n)
  })

  describe('withdrawal ordering', () => {
    const threeBuckets: ProjectionInput = {
      startYear: 2_030,
      endYear: 2_035,
      openingBuckets: [
        bucket('taxable', 20_000_00n),
        bucket('traditional', 100_000_00n),
        bucket('roth', 50_000_00n),
      ],
      contributions: [],
      spending: costs(-25_000_00n),
      members: [member({ retirementYear: 2_030 })],
      // Zero, so the ordering is visible without compounding in the way.
      retirementEffectiveRateBasisPoints: 0,
    }

    it('follows taxable, then after-tax, then pre-tax, then Roth', () => {
      expect(DEFAULT_WITHDRAWAL_ORDER).toEqual(['taxable', 'after_tax', 'traditional', 'roth'])
    })

    it('spills into the next bucket when one runs dry mid-year', () => {
      /*
       * The case the spec names. $25,000 is needed and taxable holds $20,000, so the year has to
       * finish out of the next treatment rather than reporting a shortfall with $150,000 still
       * sitting there.
       */
      const result = projectScenario(threeBuckets, scenario())
      const first = result.years[0]

      const balance = (treatment: string) =>
        first?.buckets.find((b) => b.treatment === treatment)?.balanceCents

      expect(balance('taxable')).toBe(0n)
      expect(balance('traditional')).toBe(95_000_00n)
      expect(balance('roth')).toBe(50_000_00n)
      expect(first?.shortfallCents).toBe(0n)
    })

    it('leaves Roth untouched until everything ahead of it is gone', () => {
      /*
       * 2030 takes the last 20,000 of taxable plus 5,000 of pre-tax, leaving 95,000. Pre-tax then
       * drains 70,000 → 45,000 → 20,000 across 2031–2033, so 2034 is the first year that cannot be
       * funded without reaching past it — 20,000 from pre-tax and the remaining 5,000 from Roth.
       */
      const result = projectScenario(threeBuckets, scenario())

      const roth = (year: number) =>
        result.years
          .find((y) => y.year === year)
          ?.buckets.find((b) => b.treatment === 'roth')?.balanceCents

      expect(roth(2_033)).toBe(50_000_00n)
      expect(roth(2_034)).toBe(45_000_00n)
      // And the year after draws Roth alone, with nothing ahead of it left.
      expect(roth(2_035)).toBe(20_000_00n)
    })

    it('honours a configured order over the default', () => {
      const result = projectScenario(
        { ...threeBuckets, withdrawalOrder: ['roth', 'taxable', 'traditional'] },
        scenario(),
      )

      const first = result.years[0]
      expect(first?.buckets.find((b) => b.treatment === 'roth')?.balanceCents).toBe(25_000_00n)
      expect(first?.buckets.find((b) => b.treatment === 'taxable')?.balanceCents).toBe(20_000_00n)
    })
  })

  describe('money the plan does not spend', () => {
    it('never draws an HSA or a 529, and reports what it held back', () => {
      /*
       * Both hold real money that this plan deliberately does not touch — an HSA is for medical
       * costs, and a 529 carries a penalty for anything else. Including them in the drawdown would
       * have the projection fund a grocery bill out of a child's tuition.
       */
      const result = projectScenario(
        {
          startYear: 2_030,
          endYear: 2_031,
          openingBuckets: [
            bucket('taxable', 50_000_00n),
            bucket('hsa', 30_000_00n),
            bucket('education', 20_000_00n),
          ],
          contributions: [],
          spending: costs(-10_000_00n),
          members: [member({ retirementYear: 2_030 })],
          retirementEffectiveRateBasisPoints: 0,
        },
        scenario(),
      )

      const last = result.years.at(-1)
      expect(last?.buckets.find((b) => b.treatment === 'hsa')?.balanceCents).toBe(30_000_00n)
      expect(last?.buckets.find((b) => b.treatment === 'education')?.balanceCents).toBe(20_000_00n)

      // Reported separately, so the terminal balance cannot read as money available for spending.
      expect(result.heldBackCents).toBe(50_000_00n)
    })
  })

  describe('shortfall', () => {
    it('records the first year the money ran out, and keeps going', () => {
      // The depletion year is the headline. Stopping the projection there would lose the shape of
      // what happens afterwards, which is what somebody asking "what if I retire at 60" wants.
      const result = projectScenario(
        {
          startYear: 2_030,
          endYear: 2_032,
          openingBuckets: [bucket('taxable', 10_000_00n)],
          contributions: [],
          spending: costs(-25_000_00n),
          members: [member({ retirementYear: 2_030 })],
          retirementEffectiveRateBasisPoints: 0,
        },
        scenario(),
      )

      expect(result.depletionYear).toBe(2_030)
      expect(result.years[0]?.shortfallCents).toBe(15_000_00n)
      expect(result.years[1]?.shortfallCents).toBe(25_000_00n)
      expect(result.years).toHaveLength(3)
    })

    it('reports no depletion when the plan holds', () => {
      const result = projectScenario(
        {
          startYear: 2_030,
          endYear: 2_032,
          openingBuckets: [bucket('taxable', 500_000_00n)],
          contributions: [],
          spending: costs(-25_000_00n),
          members: [member({ retirementYear: 2_030 })],
          retirementEffectiveRateBasisPoints: 0,
        },
        scenario(),
      )

      expect(result.depletionYear).toBeNull()
      expect(result.years.every((y) => y.shortfallCents === 0n)).toBe(true)
    })
  })

  describe('Social Security', () => {
    it('counts nothing until somebody has entered a claim age', () => {
      // Null means unasked. Assuming a claim age would put income in the plan that nobody stated,
      // and the benefit is large enough to change the answer on its own.
      const result = projectScenario(
        {
          startYear: 2_030,
          endYear: 2_030,
          openingBuckets: [bucket('taxable', 100_000_00n)],
          contributions: [],
          spending: costs(-25_000_00n),
          members: [
            member({
              retirementYear: 2_030,
              socialSecurityClaimAge: null,
              socialSecurityAnnualBenefitCents: 30_000_00n,
            }),
          ],
          retirementEffectiveRateBasisPoints: 0,
        },
        scenario(),
      )

      expect(result.years[0]?.socialSecurityCents).toBe(0n)
      expect(result.years[0]?.withdrawalsCents).toBe(25_000_00n)
    })

    it('starts each member at their own claim age rather than averaging them', () => {
      /*
       * Two people claim on different schedules, and the years between one claim and the other are
       * exactly the years a plan is most likely to come up short. Smearing them would hide that.
       */
      const result = projectScenario(
        {
          startYear: 2_030,
          endYear: 2_032,
          openingBuckets: [bucket('taxable', 500_000_00n)],
          contributions: [],
          spending: costs(-60_000_00n),
          members: [
            member({
              id: 'older',
              birthYear: 1_963,
              retirementYear: 2_030,
              socialSecurityClaimAge: 67,
              socialSecurityAnnualBenefitCents: 30_000_00n,
            }),
            member({
              id: 'younger',
              birthYear: 1_965,
              retirementYear: 2_030,
              socialSecurityClaimAge: 67,
              socialSecurityAnnualBenefitCents: 20_000_00n,
            }),
          ],
          retirementEffectiveRateBasisPoints: 0,
        },
        scenario(),
      )

      // Older turns 67 in 2030; younger not until 2032.
      expect(result.years.map((y) => y.socialSecurityCents)).toEqual([
        30_000_00n,
        30_000_00n,
        50_000_00n,
      ])
    })

    it('does not withdraw when the benefit covers the spending', () => {
      const result = projectScenario(
        {
          startYear: 2_030,
          endYear: 2_030,
          openingBuckets: [bucket('taxable', 100_000_00n)],
          contributions: [],
          spending: costs(-20_000_00n),
          members: [
            member({
              birthYear: 1_960,
              retirementYear: 2_030,
              socialSecurityClaimAge: 67,
              socialSecurityAnnualBenefitCents: 30_000_00n,
            }),
          ],
          retirementEffectiveRateBasisPoints: 0,
        },
        scenario(),
      )

      expect(result.years[0]?.withdrawalsCents).toBe(0n)
      expect(result.years[0]?.totalCents).toBe(100_000_00n)
    })
  })

  describe('the retirement transition', () => {
    it('starts the drawdown when the first member retires, not the last', () => {
      /*
       * Conservative and deliberate (§19.4). Where one person keeps working their wages really do
       * fund part of the household, but Beans has no salary figure — so the choice is between
       * starting early, which understates the plan, and inventing an income, which flatters it.
       */
      const result = projectScenario(
        {
          startYear: 2_030,
          endYear: 2_031,
          openingBuckets: [bucket('taxable', 200_000_00n)],
          contributions: [route('taxable', 10_000_00n)],
          spending: costs(-25_000_00n),
          members: [
            member({ id: 'early', retirementYear: 2_030 }),
            member({ id: 'late', retirementYear: 2_040 }),
          ],
          retirementEffectiveRateBasisPoints: 0,
        },
        scenario(),
      )

      expect(result.years[0]).toMatchObject({
        retired: true,
        spendingCents: -25_000_00n,
        // Contributions stop at the same moment, for the same reason.
        contributionsCents: 0n,
      })
    })

    it('shifts every member when a scenario moves the retirement year', () => {
      // "Retire two years earlier" is the question people ask, and it has to apply to both people
      // rather than collapsing two dates into one.
      const earlier = projectScenario(
        {
          startYear: 2_028,
          endYear: 2_028,
          openingBuckets: [bucket('taxable', 200_000_00n)],
          contributions: [],
          spending: costs(-25_000_00n),
          members: [member({ retirementYear: 2_030 })],
          retirementEffectiveRateBasisPoints: 0,
        },
        scenario({ retirementYearsOffset: -2 }),
      )

      expect(earlier.years[0]?.retired).toBe(true)
      expect(earlier.years[0]?.spendingCents).toBe(-25_000_00n)
    })

    it('uses the pre-retirement return while working and the post-retirement one after', () => {
      // Most people de-risk on approach, so a single rate across both eras quietly assumes they do
      // not.
      const result = projectScenario(
        {
          startYear: 2_029,
          endYear: 2_030,
          openingBuckets: [bucket('taxable', 100_000_00n)],
          contributions: [],
          spending: costs(0n),
          members: [member({ retirementYear: 2_030 })],
          retirementEffectiveRateBasisPoints: 0,
        },
        scenario({ preRetirementReturnBasisPoints: 1_000, postRetirementReturnBasisPoints: 400 }),
      )

      expect(result.years[0]?.growthCents).toBe(10_000_00n)
      // 4% of 110,000.
      expect(result.years[1]?.growthCents).toBe(4_400_00n)
    })
  })

  describe('spending overrides', () => {
    it('replaces the reviewed baseline entirely', () => {
      const result = projectScenario(
        {
          startYear: 2_030,
          endYear: 2_030,
          openingBuckets: [bucket('taxable', 100_000_00n)],
          contributions: [],
          spending: costs(-25_000_00n),
          members: [member({ retirementYear: 2_030 })],
          retirementEffectiveRateBasisPoints: 0,
        },
        scenario({ annualSpendingOverrideCents: -40_000_00n }),
      )

      expect(result.years[0]?.spendingCents).toBe(-40_000_00n)
      expect(result.years[0]?.withdrawalsCents).toBe(40_000_00n)
    })
  })

  describe('the funded ratio and the gap', () => {
    /** Two retirement years, $25,000 needed each, $10,000 to meet it with. */
    const underfunded: ProjectionInput = {
      startYear: 2_030,
      endYear: 2_031,
      openingBuckets: [bucket('taxable', 10_000_00n)],
      contributions: [],
      spending: costs(-25_000_00n),
      members: [member({ retirementYear: 2_030 })],
      retirementEffectiveRateBasisPoints: 0,
    }

    it('is exactly fully funded when no year came up short', () => {
      /*
       * A construction guarantee, not a coincidence. The ratio is the present value of the need the
       * simulation *met* over the need it faced, so a run with no shortfall cannot report anything
       * but 10000 — which is the whole reason it is derived from the path rather than from a second
       * present-value model that cannot see the tax gross-up or the withdrawal order.
       */
      const result = projectScenario(
        { ...underfunded, openingBuckets: [bucket('taxable', 500_000_00n)] },
        scenario(),
      )

      expect(result.depletionYear).toBeNull()
      expect(result.fundedRatioBasisPoints).toBe(10_000)
      expect(result.gapCents).toBe(0n)
    })

    it('matches a hand-computed ratio and gap when it falls short', () => {
      /*
       * Needs $25,000 twice and has $10,000. Returns are zero, so nothing discounts:
       *   need met    = 10,000           of 50,000  → 2000 basis points
       *   shortfalls  = 15,000 + 25,000  = 40,000   → the gap
       */
      const result = projectScenario(underfunded, scenario())

      expect(result.fundedRatioBasisPoints).toBe(2_000)
      expect(result.gapCents).toBe(40_000_00n)
      expect(result.depletionYear).toBe(2_030)
    })

    it('discounts a later shortfall, so the gap is in today’s dollars', () => {
      /*
       * The same two shortfalls, once at a 0% assumed return and once at 10%. The second year's
       * $25,000 is worth less today when money is assumed to grow, which is what makes the gap
       * answerable as "how much would I have to add today".
       *
       * The balance is already empty by then, so the shortfalls themselves are identical between
       * the two runs — only the discounting differs.
       */
      const undiscounted = projectScenario(underfunded, scenario())
      const discounted = projectScenario(
        underfunded,
        scenario({ postRetirementReturnBasisPoints: 1_000 }),
      )

      const shortfalls = (result: { years: { shortfallCents: bigint }[] }) =>
        result.years.map((year) => year.shortfallCents)

      expect(shortfalls(discounted)).toEqual(shortfalls(undiscounted))
      expect(discounted.gapCents).toBeLessThan(undiscounted.gapCents)
      // 25,000 / 1.1 is 22,727.27, so the gap is 15,000 + that.
      expect(discounted.gapCents).toBe(37_727_27n)
    })

    it('reports no ratio at all when the horizon contains no retirement year', () => {
      // "Nothing to fund" is not "fully funded". A reassuring 100% on a plan that models only
      // working years would be a lie with a comforting shape.
      const result = projectScenario(
        { ...underfunded, startYear: 2_026, endYear: 2_028, members: [member({ retirementYear: 2_040 })] },
        scenario(),
      )

      expect(result.years.every((year) => !year.retired)).toBe(true)
      expect(result.fundedRatioBasisPoints).toBeNull()
      expect(result.gapCents).toBe(0n)
    })

    it('is fully funded when the benefits cover the whole baseline', () => {
      // The portfolio is never drawn on, so there is no need to divide by. Stated rather than left
      // to arithmetic.
      const result = projectScenario(
        {
          ...underfunded,
          spending: costs(-20_000_00n),
          members: [
            member({
              birthYear: 1_960,
              retirementYear: 2_030,
              socialSecurityClaimAge: 67,
              socialSecurityAnnualBenefitCents: 30_000_00n,
            }),
          ],
        },
        scenario(),
      )

      expect(result.years.every((year) => year.portfolioNeedCents === 0n)).toBe(true)
      expect(result.fundedRatioBasisPoints).toBe(10_000)
      expect(result.gapCents).toBe(0n)
    })

    it('records what the portfolio had to fund, so the ratio is traceable', () => {
      // A summary figure nobody can trace back to a year is a figure nobody can argue with.
      const result = projectScenario(underfunded, scenario())

      expect(result.years.map((year) => year.portfolioNeedCents)).toEqual([
        25_000_00n,
        25_000_00n,
      ])
    })

    it('refuses a real return of -100% or worse rather than projecting nonsense', () => {
      // Not a pessimistic scenario — a broken input. It wipes the portfolio every year and makes
      // the discount factor divide by zero.
      expect(() =>
        projectScenario(underfunded, scenario({ postRetirementReturnBasisPoints: -10_000 })),
      ).toThrow(/cannot be projected/)
    })
  })

  describe('what it does not model', () => {
    it('says so, rather than leaving the omission invisible', () => {
      /*
       * Required distributions and the taxable share of Social Security both depend on statutory
       * figures that must come from the reference table, not from code (§19.5). A projection
       * missing them is optimistic by an amount nobody can see, so the omission is declared and
       * the UI is obliged to state it.
       */
      const result = projectScenario(
        {
          startYear: 2_030,
          endYear: 2_030,
          openingBuckets: [bucket('traditional', 100_000_00n)],
          contributions: [],
          spending: costs(-10_000_00n),
          members: [member({ birthYear: 1_950, retirementYear: 2_030 })],
          retirementEffectiveRateBasisPoints: 2_200,
        },
        scenario(),
      )

      expect(result.notModelled).toContain('required_minimum_distributions')
      expect(result.notModelled).toContain('social_security_taxation')
    })
  })
})

describe('projectScenarios', () => {
  const band: ProjectionScenario[] = [
    {
      id: 'pessimistic',
      name: 'Pessimistic',
      preRetirementReturnBasisPoints: 300,
      postRetirementReturnBasisPoints: 200,
    },
    {
      id: 'expected',
      name: 'Expected',
      preRetirementReturnBasisPoints: 600,
      postRetirementReturnBasisPoints: 400,
    },
    {
      id: 'optimistic',
      name: 'Optimistic',
      preRetirementReturnBasisPoints: 900,
      postRetirementReturnBasisPoints: 600,
    },
  ]

  const input: ProjectionInput = {
    startYear: 2_026,
    endYear: 2_060,
    openingBuckets: [bucket('taxable', 200_000_00n), bucket('traditional', 400_000_00n)],
    contributions: [route('traditional', 23_000_00n)],
    spending: costs(-72_000_00n),
    members: [
      member({
        birthYear: 1_975,
        retirementYear: 2_040,
        socialSecurityClaimAge: 67,
        socialSecurityAnnualBenefitCents: 34_000_00n,
      }),
    ],
    retirementEffectiveRateBasisPoints: 2_200,
  }

  it('never lets the band cross over itself, at any timestep', () => {
    /*
     * The spec asks for this explicitly, and it is a real property rather than a tautology: the
     * engine has to be monotonic in the return rate. A withdrawal rule that drew a *fixed fraction*
     * of the balance, or a shortfall that clamped differently per scenario, would break it — and a
     * band whose edges cross is worse than no band, because the reader cannot tell which line is
     * which.
     */
    const [pessimistic, expected, optimistic] = projectScenarios(input, band)

    expect(pessimistic?.years).toHaveLength(35)

    /*
     * The band has to actually be a band. Three identical curves would satisfy every `<=` below
     * while testing nothing, so this pins that the scenarios genuinely separate before the ordering
     * assertions are allowed to mean anything.
     */
    expect(pessimistic!.terminalTotalCents).toBeLessThan(optimistic!.terminalTotalCents)

    for (let index = 0; index < (pessimistic?.years.length ?? 0); index += 1) {
      const low = pessimistic?.years[index]
      const mid = expected?.years[index]
      const high = optimistic?.years[index]

      expect(low?.year).toBe(mid?.year)
      expect(mid?.year).toBe(high?.year)
      expect(low!.totalCents).toBeLessThanOrEqual(mid!.totalCents)
      expect(mid!.totalCents).toBeLessThanOrEqual(high!.totalCents)
    }
  })

  it('never reports a funded ratio that contradicts its own chart', () => {
    /*
     * The failure this rules out is the one that destroys trust in a planner: a headline saying
     * "fully funded" above a balance path that visibly runs dry. Because the ratio is read off the
     * simulated path, a run with no depletion is exactly 10000 and a run with one cannot exceed it.
     *
     * Only asserted in that direction. A single stray cent of shortfall thirty years out discounts
     * to nothing, so a depleting run *may* round to 10000 — which is a rounding artefact, not a
     * contradiction.
     */
    for (const result of projectScenarios(input, band)) {
      if (result.depletionYear === null) {
        expect(result.fundedRatioBasisPoints).toBe(10_000)
        expect(result.gapCents).toBe(0n)
      } else {
        expect(result.fundedRatioBasisPoints).toBeLessThanOrEqual(10_000)
        expect(result.gapCents).toBeGreaterThanOrEqual(0n)
      }
    }
  })

  it('returns one projection per scenario, in the order given', () => {
    const results = projectScenarios(input, band)

    expect(results.map((result) => result.scenarioId)).toEqual([
      'pessimistic',
      'expected',
      'optimistic',
    ])
    expect(results.map((result) => result.name)).toEqual([
      'Pessimistic',
      'Expected',
      'Optimistic',
    ])
  })

  it('is empty for no scenarios rather than inventing one', () => {
    expect(projectScenarios(input, [])).toEqual([])
  })
})
