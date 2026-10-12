import {
  carryBucketsForward,
  type AccountType,
  type BucketBalance,
  type ContributionRouting,
  type IsoDate,
  type ProjectionInput,
  type ProjectionMember,
  type ProjectionScenario,
  type RetirementSpending,
  type TaxTreatment,
} from '@beans/shared'
import type { AccountBucketAnchors, ContributionRoute } from '../repositories/retirement-accounts.js'
import type { RetirementPlan } from '../repositories/retirement.js'

/**
 * Turning what the household actually has into something the projection engine can run.
 *
 * A pure function on purpose. Everything it needs is read first and passed in, which makes the
 * interesting part — which accounts count, how a bucket split is resolved, what counts as a plan
 * too incomplete to project — testable without a database. The reads themselves are uninteresting
 * and already covered by the repository suites.
 */

/** The slice of an account this needs. Read through `accounts`, so RLS has already had its say. */
export type RetirementAccount = {
  id: string
  type: AccountType
  taxTreatment: TaxTreatment
  /** Null for an account whose balance has never been observed. Treated as nothing. */
  balanceCents: bigint | null
}

/**
 * Something the plan cannot be run without.
 *
 * Reported as a list rather than thrown, because the wizard's job is to tell somebody what is still
 * missing, and the first missing thing is rarely the only one. Guessing any of these would produce
 * a confident projection resting on a number nobody stated.
 */
export type MissingPlanInput =
  /** Nobody has been added, so there is nobody to retire. */
  | 'members'
  /** A member with no target retirement date. There is no non-arbitrary default for this. */
  | 'retirement_date'
  /**
   * A member with no life expectancy, which is what sets the horizon.
   *
   * No default, deliberately. "How long will the money last" is the question being asked, and
   * quietly answering 95 on the user's behalf bakes an invented assumption into the answer.
   */
  | 'life_expectancy'
  /** No spending observed at all, so there is no baseline to retire onto. */
  | 'spending_baseline'
  /** Nothing to draw down. A projection over an empty portfolio is a straight line to nowhere. */
  | 'balances'

export type AssembledProjection =
  | { ready: true; input: ProjectionInput; scenarios: ProjectionScenario[] }
  | { ready: false; missing: MissingPlanInput[] }

export type AssembleOptions = {
  /** Passed in, never read from a clock, so a projection is reproducible and testable. */
  today: IsoDate
  plan: RetirementPlan
  accounts: readonly RetirementAccount[]
  bucketAnchors: readonly AccountBucketAnchors[]
  routing: readonly ContributionRoute[]
  spending: RetirementSpending
}

/**
 * Account types whose balance is available to fund retirement spending.
 *
 * Cash and investments only. Deliberately **not** `other_asset`: a house is not a retirement
 * portfolio, and selling it is a decision with somewhere to live attached that Beans cannot model.
 * Including it would make almost every plan look funded.
 *
 * Liabilities are absent for a different reason. A mortgage is not a negative pot to draw from — it
 * is a monthly cost, and it reaches the projection through the spending baseline, leaving it on its
 * payoff date. Netting it against the portfolio instead would understate the drawdown and drop the
 * payment at the wrong moment.
 */
const DRAWABLE_TYPES: ReadonlySet<AccountType> = new Set<AccountType>(['depository', 'investment'])

function yearOf(date: IsoDate): number {
  return Number(date.slice(0, 4))
}

/**
 * The treatment a drawable account's balance lands under when nobody has split it into buckets.
 *
 * `none` becomes `taxable`, which is only ever reached by a cash account given the type filter
 * above: money in a current account has already been taxed and is spendable at face value.
 *
 * The one imprecision this introduces is that `taxable` sets `ignoresEmbeddedGains` on the
 * after-tax equivalent, and pure cash has no embedded gains — so a household holding only cash gets
 * a note about capital gains it does not have. A seventh treatment purely to sharpen a footnote is
 * not worth another enum value.
 */
function fallbackTreatment(account: RetirementAccount): TaxTreatment {
  return account.taxTreatment === 'none' ? 'taxable' : account.taxTreatment
}

export function assembleProjection(options: AssembleOptions): AssembledProjection {
  const { today, plan, accounts, bucketAnchors, routing, spending } = options

  const missing: MissingPlanInput[] = []

  if (plan.members.length === 0) missing.push('members')
  if (plan.members.some((member) => member.targetRetirementDate === null)) {
    missing.push('retirement_date')
  }
  if (plan.members.some((member) => member.lifeExpectancy === null)) {
    missing.push('life_expectancy')
  }
  if (spending.components.length === 0) missing.push('spending_baseline')

  const drawable = accounts.filter(
    (account) => DRAWABLE_TYPES.has(account.type) && (account.balanceCents ?? 0n) !== 0n,
  )
  if (drawable.length === 0) missing.push('balances')

  if (missing.length > 0) return { ready: false, missing }

  /*
   * The bucket split is carried forward at the **default scenario's** pre-retirement rate.
   *
   * One rate rather than one per scenario, because the opening balances feed all three bands and a
   * split that varied between them would make the after-tax equivalent scenario-dependent — and
   * that figure is shown beside net worth, where there is only one of it.
   */
  const defaultScenario = plan.scenarios.find((scenario) => scenario.isDefault)
  const carryRate = defaultScenario?.preRetirementReturnBasisPoints ?? 0

  const anchorsByAccount = new Map(
    bucketAnchors.map((entry) => [entry.accountId, entry.anchors] as const),
  )

  /** Only active routes contribute. An inactive one keeps its amount for the UI and nothing else. */
  const activeRoutes = routing.filter((route) => route.active)
  const routesByAccount = new Map<string, ContributionRouting[]>()
  for (const route of activeRoutes) {
    const existing = routesByAccount.get(route.accountId) ?? []
    existing.push({ treatment: route.treatment, annualCents: route.annualCents })
    routesByAccount.set(route.accountId, existing)
  }

  const openingByTreatment = new Map<TaxTreatment, bigint>()

  for (const account of drawable) {
    const balanceCents = account.balanceCents ?? 0n
    const anchors = anchorsByAccount.get(account.id)

    /*
     * Split accounts go through the carry-forward; unsplit ones land whole under their account-level
     * treatment. `carryBucketsForward` returns an empty array when it has no usable anchor — an
     * anchor dated after today, for instance — and falling back rather than dropping the balance is
     * what keeps the portfolio total equal to the sum of the accounts.
     */
    const buckets: BucketBalance[] =
      anchors === undefined || anchors.length === 0
        ? []
        : carryBucketsForward({
            anchors,
            routing: routesByAccount.get(account.id) ?? [],
            annualReturnBasisPoints: BigInt(carryRate),
            asOf: today,
            actualBalanceCents: balanceCents,
          })

    const resolved: readonly BucketBalance[] =
      buckets.length > 0
        ? buckets
        : [{ treatment: fallbackTreatment(account), balanceCents }]

    for (const bucket of resolved) {
      openingByTreatment.set(
        bucket.treatment,
        (openingByTreatment.get(bucket.treatment) ?? 0n) + bucket.balanceCents,
      )
    }
  }

  /** Contributions are summed by destination treatment — the engine has one portfolio, not many. */
  const contributionsByTreatment = new Map<TaxTreatment, bigint>()
  for (const route of activeRoutes) {
    contributionsByTreatment.set(
      route.treatment,
      (contributionsByTreatment.get(route.treatment) ?? 0n) + route.annualCents,
    )
  }

  const members: ProjectionMember[] = plan.members.map((member) => ({
    id: member.id,
    birthYear: member.birthYear,
    // Non-null: a null date put `retirement_date` in `missing` and returned above.
    retirementYear: yearOf(member.targetRetirementDate!),
    socialSecurityClaimAge: member.socialSecurityClaimAge,
    socialSecurityAnnualBenefitCents: member.socialSecurityAnnualBenefitCents ?? 0n,
  }))

  /*
   * The horizon is the year the longest-lived member reaches their stated life expectancy. Taking
   * the longest rather than the first is the only safe direction: a plan that stops modelling while
   * somebody is still alive reports that the money lasted.
   */
  const endYear = plan.members.reduce(
    (latest, member) => Math.max(latest, member.birthYear + member.lifeExpectancy!),
    yearOf(today),
  )

  const input: ProjectionInput = {
    startYear: yearOf(today),
    endYear,
    openingBuckets: [...openingByTreatment.entries()].map(([treatment, balanceCents]) => ({
      treatment,
      balanceCents,
    })),
    contributions: [...contributionsByTreatment.entries()].map(([treatment, annualCents]) => ({
      treatment,
      annualCents,
    })),
    spending,
    members,
    retirementEffectiveRateBasisPoints: plan.profile.retirementEffectiveRateBasisPoints,
    withdrawalOrder: plan.profile.withdrawalOrder,
    ...(plan.profile.pre65HealthcareAnnualCents === null
      ? {}
      : { pre65HealthcareAnnualCents: plan.profile.pre65HealthcareAnnualCents }),
  }

  const scenarios: ProjectionScenario[] = plan.scenarios.map((scenario) => ({
    id: scenario.id,
    name: scenario.name,
    preRetirementReturnBasisPoints: scenario.preRetirementReturnBasisPoints,
    postRetirementReturnBasisPoints: scenario.postRetirementReturnBasisPoints,
    ...(scenario.annualSpendingOverrideCents === null
      ? {}
      : { annualSpendingOverrideCents: scenario.annualSpendingOverrideCents }),
    ...(scenario.retirementYearsOffset === null
      ? {}
      : { retirementYearsOffset: scenario.retirementYearsOffset }),
  }))

  return { ready: true, input, scenarios }
}
