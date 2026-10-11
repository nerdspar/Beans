import {
  addDays,
  isExcludedFromCashFlow,
  projectScenarios,
  retirementSpending,
  spendingByCategory,
  type AccountType,
  type IsoDate,
  type ScenarioProjection,
  type SpendingAssumption,
} from '@beans/shared'
import type { HouseholdContext } from '../repositories/household-context.js'
import { confirmedPairMembers } from '../repositories/transfers.js'
import {
  readAccountTaxBuckets,
  readContributionRouting,
  readDrawableAccounts,
  readSpendingWindow,
} from '../repositories/retirement-accounts.js'
import { readRetirementPlan, readSpendingAssumptions } from '../repositories/retirement.js'
import { assembleProjection, type MissingPlanInput } from './assemble.js'

/**
 * Running the plan: read everything, assemble it, project it.
 *
 * The reading and the arithmetic are deliberately in different files. Everything interesting —
 * which accounts count, how a split resolves, what makes a plan unrunnable — lives in
 * `assembleProjection` and the engine, both pure and both tested without a database. What is left
 * here is the order of the reads, which is the uninteresting part.
 */

export type RetirementProjectionResult =
  | {
      ready: true
      projections: ScenarioProjection[]
      /** Echoed back so the UI can show the assumptions beside the figures, as the spec requires. */
      startYear: number
      endYear: number
      /** Categories the review never answered. Non-empty means the baseline contains guesses. */
      unreviewedCategoryIds: (string | null)[]
      monthsObserved: number
      annualizedFromPartialYear: boolean
    }
  | { ready: false; missing: MissingPlanInput[] }

/** How far back the baseline looks. Twelve months, which is what makes seasonality cancel. */
const BASELINE_DAYS = 365

export type RunProjectionOptions = {
  /**
   * Today, passed in rather than read from a clock.
   *
   * A projection is a function of its inputs and should be reproducible from them — and every test
   * in this feature uses fixed dates (CLAUDE.md).
   */
  today: IsoDate
}

export async function runRetirementProjection(
  context: HouseholdContext,
  options: RunProjectionOptions,
): Promise<RetirementProjectionResult> {
  const plan = await readRetirementPlan(context)
  if (plan === null) {
    /*
     * No profile at all. Reported as every input missing rather than as an error: the caller is the
     * setup wizard, and "you have not started" is a state it renders rather than a failure it
     * handles.
     */
    return {
      ready: false,
      missing: ['members', 'retirement_date', 'life_expectancy', 'spending_baseline', 'balances'],
    }
  }

  const windowStart = addDays(options.today, -BASELINE_DAYS)

  /*
   * Sequential, deliberately. All six share the transaction's one `PoolClient`, and a single
   * connection cannot run queries concurrently — node-postgres serializes them and warns that it
   * will stop doing so in pg@9. `Promise.all` reads as a speed-up and is not one. `readWorkingSet`
   * carries the same note for the same reason, and the integration test's deprecation warning is
   * what caught it here.
   */
  const accounts = await readDrawableAccounts(context)
  const bucketAnchors = await readAccountTaxBuckets(context)
  const routing = await readContributionRouting(context)
  const assumptions = await readSpendingAssumptions(context, plan.profile.id)
  const transactions = await readSpendingWindow(context, windowStart, options.today)
  const pairMembers = await confirmedPairMembers(context)

  const confirmed = new Set(pairMembers)

  /*
   * Transfers and voided rows come out here rather than in SQL, using the same predicate the cash
   * flow screens use. Two implementations of "what counts as spending" would eventually disagree,
   * and the one in the retirement baseline would be the one nobody notices.
   */
  const spendable = transactions.filter(
    (transaction) => !isExcludedFromCashFlow(transaction, confirmed),
  )

  const spending = retirementSpending({
    trailingByCategory: spendingByCategory(spendable, confirmed),
    monthsObserved: monthsCovered(spendable.map((transaction) => transaction.postedDate)),
    assumptions: assumptions.map(toSpendingAssumption),
  })

  const assembled = assembleProjection({
    today: options.today,
    plan,
    accounts: accounts.map((account) => ({
      id: account.id,
      type: account.type as AccountType,
      taxTreatment: account.taxTreatment,
      balanceCents: account.balanceCents,
    })),
    bucketAnchors,
    routing,
    spending,
  })

  if (!assembled.ready) return { ready: false, missing: assembled.missing }

  return {
    ready: true,
    projections: projectScenarios(assembled.input, assembled.scenarios),
    startYear: assembled.input.startYear,
    endYear: assembled.input.endYear,
    unreviewedCategoryIds: spending.unreviewedCategoryIds,
    monthsObserved: spending.monthsObserved,
    annualizedFromPartialYear: spending.annualizedFromPartialYear,
  }
}

/**
 * How many distinct calendar months the observed spending actually covers.
 *
 * Counted from the data rather than assumed to be twelve. A household that connected an account
 * three months ago has three months of history, and scaling three months to a year is a decision
 * the baseline makes visible (`annualizedFromPartialYear`) rather than one made silently here.
 *
 * Distinct months rather than a date span, because a gap matters: six months of transactions either
 * side of a broken sync is six months of data, not twelve.
 */
function monthsCovered(dates: readonly IsoDate[]): number {
  const months = new Set<string>()
  for (const date of dates) months.add(date.slice(0, 7))
  return months.size
}

function toSpendingAssumption(stored: {
  categoryId: string
  treatment: 'continues' | 'stops' | 'adjusted'
  adjustmentBasisPoints: number | null
  lastYear: number | null
}): SpendingAssumption {
  const base = {
    categoryId: stored.categoryId,
    ...(stored.lastYear === null ? {} : { lastYear: stored.lastYear }),
  }

  /*
   * An `adjusted` row with no percentage falls back to `continues`. The repository refuses to write
   * one, so this is unreachable through the app — but `continues` is the expensive assumption, and
   * if the impossible happens the projection should overstate the cost of retirement rather than
   * understate it.
   */
  if (stored.treatment === 'adjusted' && stored.adjustmentBasisPoints !== null) {
    return { ...base, treatment: 'adjusted', adjustmentBasisPoints: stored.adjustmentBasisPoints }
  }

  return { ...base, treatment: stored.treatment === 'stops' ? 'stops' : 'continues' }
}
