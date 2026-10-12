import type { TaxTreatment } from '../accounts/classification.js'
import type { BucketBalance, ContributionRouting } from './buckets.js'
import { grossUpForTax, grow, scaleSigned } from './rates.js'
import { spendingInYear, type RetirementSpending } from './spending.js'

/**
 * The deterministic projection. Annual timestep, real dollars, three scenarios at once.
 *
 * **Real returns throughout — today's dollars, net of inflation.** Nominal projections produce
 * headline numbers that feel wonderful and mean nothing, and this is stated on screen rather than
 * buried here.
 *
 * **Three scenarios run together and render as a band, never a line.** A point estimate implies a
 * precision that does not exist. The single most misleading thing a retirement tool does is draw one
 * confident curve through thirty years of unknown returns.
 *
 * Monte Carlo is a later phase and it earns its place for one specific reason: **sequence-of-returns
 * risk**. A deterministic model averaging six percent and a real market averaging six percent
 * diverge badly when the poor years land in the first five years of retirement — the deterministic
 * path cannot express that, because it has no sequence. Historical bootstrapping is preferred to
 * random normal draws when it arrives.
 */

/**
 * Something this projection knowingly does not model, reported rather than ignored.
 *
 * A declared gap, not a bug. The alternative is the mistake this codebase has made before: shipping
 * a check that cannot fire and looks like it did. Anything in this list must be stated on screen
 * next to the figures, because a projection missing required distributions is optimistic by an
 * amount nobody can see.
 */
export type UnmodelledFactor =
  /**
   * Required minimum distributions. Blocked on two things, not one: the statutory start age and the
   * lifetime table must come from `contribution_limits` (phase B) rather than from code, **and**
   * buckets would have to be attributable to an individual member, which the schema only supports
   * through a thin account-owner chain. Guessing either would be worse than saying neither.
   */
  | 'required_minimum_distributions'
  /**
   * The taxable share of Social Security. The thresholds that decide it are statutory and belong in
   * the reference table with their source. Tax is applied to pre-tax withdrawals only until then,
   * which understates the bill.
   */
  | 'social_security_taxation'

export type ProjectionMember = {
  id: string
  birthYear: number
  /** The calendar year this person stops working. */
  retirementYear: number
  /** Null until somebody has said. No benefit is counted while it is null. */
  socialSecurityClaimAge: number | null
  /** Annual, real, read off an SSA statement. Never computed — see §19.5. */
  socialSecurityAnnualBenefitCents: bigint
}

export type ProjectionScenario = {
  id: string
  name: string
  preRetirementReturnBasisPoints: number
  postRetirementReturnBasisPoints: number
  /** Replaces the reviewed baseline entirely. Negative, like all spending. */
  annualSpendingOverrideCents?: bigint | undefined
  /** Shifts every member's retirement year. Negative retires earlier. */
  retirementYearsOffset?: number | undefined
}

export type ProjectionInput = {
  /** The first year modelled, normally the current one. */
  startYear: number
  /** The last year modelled — the planning horizon, from the longest life expectancy. */
  endYear: number

  /** Opening balances by treatment. Buckets absent from the list hold nothing. */
  openingBuckets: readonly BucketBalance[]

  /** Annual contributions while still working, by destination bucket. */
  contributions: readonly ContributionRouting[]

  spending: RetirementSpending
  members: readonly ProjectionMember[]

  /** The assumed effective rate on pre-tax withdrawals. An estimate, labelled as one everywhere. */
  retirementEffectiveRateBasisPoints: number

  /** Null or absent uses {@link DEFAULT_WITHDRAWAL_ORDER}. */
  withdrawalOrder?: readonly TaxTreatment[] | null | undefined

  /**
   * Out-of-pocket healthcare between retiring and turning 65, per year. **Negative**, like all
   * spending.
   *
   * Its own input rather than a line in the spending baseline, because it is the single largest
   * unknown for anybody stopping work before Medicare and averaging it into a category makes it
   * disappear — producing a cheerful, wrong projection for exactly the people who most need an
   * accurate one.
   *
   * Applied in any year where **someone who has retired is still under 65**. That is the
   * household-level reading: one figure, charged while anybody needs the bridge. Per-member costs,
   * real plan pricing and the subsidy cliff are phase D, and this is deliberately the cruder thing
   * that is visible rather than the finer thing that is absent.
   */
  pre65HealthcareAnnualCents?: bigint | undefined
}

export type ProjectionYear = {
  year: number
  /** True once the first member has retired — when the portfolio starts being drawn on. */
  retired: boolean

  /** Closing balances, by treatment, in the withdrawal order followed by anything held back. */
  buckets: BucketBalance[]
  totalCents: bigint

  /** Negative. Zero while still working, when wages are assumed to cover it. */
  spendingCents: bigint
  socialSecurityCents: bigint

  /**
   * What the portfolio had to fund this year: spending the benefits did not cover.
   *
   * Recorded rather than recomputed, so the funded ratio is auditable against the path it came
   * from. A summary figure nobody can trace back to a year is a figure nobody can argue with.
   */
  portfolioNeedCents: bigint

  /** Gross, including the amount withdrawn to pay the tax on itself. */
  withdrawalsCents: bigint
  /** The estimated tax on pre-tax withdrawals. */
  taxCents: bigint

  contributionsCents: bigint
  growthCents: bigint

  /** Positive when the drawable buckets ran out before the year was funded. */
  shortfallCents: bigint
}

export type ScenarioProjection = {
  scenarioId: string
  name: string
  years: ProjectionYear[]

  /** The closing total in `endYear`. */
  terminalTotalCents: bigint
  /** The first year that could not be funded, or null if the money lasted. */
  depletionYear: number | null

  /**
   * How much of the plan's retirement spending is funded, in basis points. 10000 is fully funded.
   *
   * **Derived from the simulated path, not from a parallel present-value model.** The obvious
   * implementation — discount the spending, discount the benefits, divide — is a second model, and
   * a second model disagrees with the first: it cannot see the tax gross-up, the withdrawal order,
   * or the buckets the plan holds back. A headline ratio that says "fully funded" above a chart
   * that runs dry in 2051 is worse than no ratio at all.
   *
   * So this is the present value of the need the simulation *met*, over the present value of the
   * need it faced. A run with no shortfall is exactly 10000 by construction.
   *
   * Null when the horizon contains no retirement year. Reporting a plan with nothing to fund as
   * fully funded would be a lie with a reassuring shape.
   */
  fundedRatioBasisPoints: number | null

  /**
   * What the plan is short, in today's dollars. Zero when it holds.
   *
   * The present value of the spending the portfolio could not cover, discounted at the scenario's
   * own return assumptions — which makes it also, and usefully, the amount that would have to be
   * added today to close the gap.
   */
  gapCents: bigint

  /**
   * Money the plan never spends, because its treatment is not in the withdrawal order.
   *
   * An HSA and a 529 hold real money that this plan deliberately does not draw on — an HSA is for
   * medical costs and a 529 carries a penalty for anything else. Leaving them in the terminal
   * balance with no note would make the plan look better funded than it is for *retirement
   * spending*, so the amount is reported separately.
   */
  heldBackCents: bigint

  notModelled: UnmodelledFactor[]
}

/**
 * Taxable first, then after-tax non-Roth, then pre-tax, then Roth.
 *
 * The conventional order, and the reasoning is tax deferral: spend the money that is already taxed
 * while the sheltered money keeps compounding, and leave Roth until last because it is the only
 * bucket whose growth is never taxed.
 *
 * `hsa` and `education` are **deliberately absent**. They hold money this plan does not spend, and
 * adding them here would have the projection quietly fund a grocery bill out of a 529.
 */
export const DEFAULT_WITHDRAWAL_ORDER: readonly TaxTreatment[] = [
  'taxable',
  'after_tax',
  'traditional',
  'roth',
]

/** Treatments whose withdrawals the effective-rate estimate applies to. */
const TAXED_ON_WITHDRAWAL: ReadonlySet<TaxTreatment> = new Set<TaxTreatment>(['traditional'])

function ageIn(member: ProjectionMember, year: number): number {
  return year - member.birthYear
}

function retirementYearOf(member: ProjectionMember, scenario: ProjectionScenario): number {
  return member.retirementYear + (scenario.retirementYearsOffset ?? 0)
}

/**
 * One scenario, year by year.
 *
 * The per-year order deviates from the one the spec lists, and every difference moves the number
 * **down**:
 *
 * 1. Withdrawals come before growth, so a year's spending does not earn a year's return on its way
 *    out the door.
 * 2. Contributions come after growth, so a year's contributions do not earn a full year of growth
 *    in the year they are spread across. This also matches `carryBucketsForward`, and the two
 *    disagreeing would make the bucket split and the balance path tell different stories.
 *
 * For a retirement projection the safe direction is down. A model that flatters by a few percent a
 * year compounds into a plan that says somebody can stop working a year before they can.
 */
export function projectScenario(
  input: ProjectionInput,
  scenario: ProjectionScenario,
): ScenarioProjection {
  /*
   * A real return of -100% or worse is not a pessimistic scenario, it is a broken input: it wipes
   * the portfolio every year and makes the discount factor used by the funded ratio divide by zero
   * or flip sign. Refusing is better than producing a confident figure out of nonsense.
   */
  for (const rate of [
    scenario.preRetirementReturnBasisPoints,
    scenario.postRetirementReturnBasisPoints,
  ]) {
    if (rate <= -10_000) {
      throw new RangeError('projectScenario: a real return of -100% or worse cannot be projected')
    }
  }

  const order = input.withdrawalOrder ?? DEFAULT_WITHDRAWAL_ORDER
  const drawable = new Set(order)

  const balances = new Map<TaxTreatment, bigint>()
  for (const bucket of input.openingBuckets) {
    balances.set(bucket.treatment, (balances.get(bucket.treatment) ?? 0n) + bucket.balanceCents)
  }

  /*
   * The household retires when its **first** member does, which is when contributions stop and
   * withdrawals start.
   *
   * A deliberate simplification, and a conservative one. Where one person keeps working, their
   * wages really do fund part of the household — but Beans has no salary figure (§19.4), so
   * modelling the gap years as still-accumulating would require inventing one. Starting the
   * drawdown early understates the plan instead, which is the direction that does not tell somebody
   * they can afford to stop. Modelling the gap properly is phase D.
   */
  const householdRetirementYear = input.members.reduce(
    (earliest, member) => Math.min(earliest, retirementYearOf(member, scenario)),
    Number.POSITIVE_INFINITY,
  )

  const years: ProjectionYear[] = []
  let depletionYear: number | null = null

  for (let year = input.startYear; year <= input.endYear; year += 1) {
    const retired = year >= householdRetirementYear

    const baselineCents = retired
      ? (scenario.annualSpendingOverrideCents ?? spendingInYear(input.spending, year))
      : 0n

    /*
     * The bridge is charged while anybody who has stopped working is still under 65. Checking the
     * retirement year per member rather than the household's — somebody who retires at 67 never
     * needs it, and charging the household for them would overstate every plan with an age gap.
     */
    const needsBridge = input.members.some(
      (member) => year >= retirementYearOf(member, scenario) && ageIn(member, year) < 65,
    )
    const spendingCents =
      baselineCents + (retired && needsBridge ? (input.pre65HealthcareAnnualCents ?? 0n) : 0n)

    /*
     * Benefits start at each member's own claim age, independently. Two people claim on different
     * schedules, and averaging them would smear a step change — the years between one claim and the
     * other are exactly the years a plan is most likely to come up short.
     */
    let socialSecurityCents = 0n
    for (const member of input.members) {
      if (member.socialSecurityClaimAge === null) continue
      if (ageIn(member, year) < member.socialSecurityClaimAge) continue
      socialSecurityCents += member.socialSecurityAnnualBenefitCents
    }

    // Spending is negative; benefits are positive. What remains is what the portfolio must fund.
    let needCents = -(spendingCents + socialSecurityCents)
    if (needCents < 0n) needCents = 0n
    const portfolioNeedCents = needCents

    let withdrawalsCents = 0n
    let taxCents = 0n

    for (const treatment of order) {
      if (needCents === 0n) break

      const available = balances.get(treatment) ?? 0n
      if (available <= 0n) continue

      const taxed = TAXED_ON_WITHDRAWAL.has(treatment)
      const rate = taxed ? input.retirementEffectiveRateBasisPoints : 0

      /*
       * Grossed up, so the tax on the withdrawal is funded by the withdrawal. Taking exactly what
       * is needed and paying tax out of it leaves the year short by the tax, and the plan looks
       * like it held when it did not.
       */
      const wanted = grossUpForTax(needCents, rate)
      const gross = wanted <= available ? wanted : available
      const tax = taxed ? scaleSigned(gross, BigInt(rate), 10_000n) : 0n

      balances.set(treatment, available - gross)
      withdrawalsCents += gross
      taxCents += tax

      // What the year actually received. When the bucket covered the gross-up, this is the whole
      // need; when the bucket ran dry it is whatever the balance netted, and the rest falls through
      // to the next treatment in the order.
      needCents -= gross - tax
      if (needCents < 0n) needCents = 0n
    }

    const shortfallCents = needCents
    if (shortfallCents > 0n && depletionYear === null) depletionYear = year

    const returnRate = retired
      ? scenario.postRetirementReturnBasisPoints
      : scenario.preRetirementReturnBasisPoints

    let growthCents = 0n
    for (const [treatment, balance] of balances) {
      const grown = grow(balance, returnRate)
      growthCents += grown - balance
      balances.set(treatment, grown)
    }

    let contributionsCents = 0n
    if (!retired) {
      for (const route of input.contributions) {
        if (route.annualCents === 0n) continue
        contributionsCents += route.annualCents
        balances.set(route.treatment, (balances.get(route.treatment) ?? 0n) + route.annualCents)
      }
    }

    years.push({
      year,
      retired,
      buckets: snapshot(balances, order),
      totalCents: [...balances.values()].reduce((sum, value) => sum + value, 0n),
      spendingCents,
      socialSecurityCents,
      portfolioNeedCents,
      withdrawalsCents,
      taxCents,
      contributionsCents,
      growthCents,
      shortfallCents,
    })
  }

  let heldBackCents = 0n
  for (const [treatment, balance] of balances) {
    if (!drawable.has(treatment)) heldBackCents += balance
  }

  const funding = summarizeFunding(years, scenario)

  return {
    scenarioId: scenario.id,
    name: scenario.name,
    years,
    terminalTotalCents: years.at(-1)?.totalCents ?? 0n,
    depletionYear,
    heldBackCents,
    fundedRatioBasisPoints: funding.fundedRatioBasisPoints,
    gapCents: funding.gapCents,
    notModelled: ['required_minimum_distributions', 'social_security_taxation'],
  }
}

/**
 * The funded ratio and the gap, read off the path the simulation actually walked.
 *
 * Both are present values discounted at the scenario's own return assumptions — the pre-retirement
 * rate for the years before the drawdown starts and the post-retirement rate after, because that is
 * what the model assumes the money earns over each stretch. Discounting at one blended rate would
 * be a third assumption nobody stated.
 *
 * The discount factor is carried as an exact rational — a numerator of `10_000^k` over the product
 * of `(10_000 + rate)` — rather than as a float. Over a thirty-five year horizon the two differ by
 * enough to move a headline dollar figure, and this is the figure somebody would act on.
 */
function summarizeFunding(
  years: readonly ProjectionYear[],
  scenario: ProjectionScenario,
): { fundedRatioBasisPoints: number | null; gapCents: bigint } {
  // The first modelled year is today, so it is not discounted at all.
  let numerator = 1n
  let denominator = 1n

  let needPresentValue = 0n
  let shortfallPresentValue = 0n
  let hasRetirementYear = false

  for (const year of years) {
    if (year.retired) hasRetirementYear = true

    if (year.portfolioNeedCents > 0n) {
      needPresentValue += scaleSigned(year.portfolioNeedCents, numerator, denominator)
      shortfallPresentValue += scaleSigned(year.shortfallCents, numerator, denominator)
    }

    const rate = year.retired
      ? scenario.postRetirementReturnBasisPoints
      : scenario.preRetirementReturnBasisPoints

    numerator *= 10_000n
    denominator *= 10_000n + BigInt(rate)
  }

  /*
   * No retirement year in the horizon means there is nothing to be funded *for*, which is not the
   * same as being fully funded. Null makes the UI say so rather than print a reassuring 100%.
   */
  if (!hasRetirementYear) return { fundedRatioBasisPoints: null, gapCents: 0n }

  /*
   * A need of zero across every retirement year — benefits covering the whole baseline — is
   * genuinely fully funded, and dividing by it is not. Stated separately rather than left to
   * arithmetic.
   */
  if (needPresentValue === 0n) return { fundedRatioBasisPoints: 10_000, gapCents: 0n }

  const met = needPresentValue - shortfallPresentValue
  return {
    fundedRatioBasisPoints: Number((met * 10_000n) / needPresentValue),
    gapCents: shortfallPresentValue,
  }
}

/**
 * Every scenario over the same inputs, in the order given.
 *
 * Run together rather than one at a time because the band is the output — the reader is meant to
 * see the spread, and a UI that fetched one curve and then another would render a line first.
 */
export function projectScenarios(
  input: ProjectionInput,
  scenarios: readonly ProjectionScenario[],
): ScenarioProjection[] {
  return scenarios.map((scenario) => projectScenario(input, scenario))
}

/**
 * Balances as a list, withdrawal order first, then anything held back.
 *
 * Ordered rather than arbitrary so a stacked chart does not reshuffle its bands between years, and
 * so the buckets the plan actually spends read first.
 */
function snapshot(
  balances: ReadonlyMap<TaxTreatment, bigint>,
  order: readonly TaxTreatment[],
): BucketBalance[] {
  const seen = new Set<TaxTreatment>()
  const out: BucketBalance[] = []

  for (const treatment of order) {
    if (!balances.has(treatment) || seen.has(treatment)) continue
    seen.add(treatment)
    out.push({ treatment, balanceCents: balances.get(treatment) ?? 0n })
  }

  for (const [treatment, balanceCents] of balances) {
    if (seen.has(treatment)) continue
    out.push({ treatment, balanceCents })
  }

  return out
}
