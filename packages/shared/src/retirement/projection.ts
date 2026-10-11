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

    const spendingCents = retired
      ? (scenario.annualSpendingOverrideCents ?? spendingInYear(input.spending, year))
      : 0n

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

  return {
    scenarioId: scenario.id,
    name: scenario.name,
    years,
    terminalTotalCents: years.at(-1)?.totalCents ?? 0n,
    depletionYear,
    heldBackCents,
    notModelled: ['required_minimum_distributions', 'social_security_taxation'],
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
