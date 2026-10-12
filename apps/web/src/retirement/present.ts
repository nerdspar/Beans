import type {
  MissingPlanInput,
  Projection,
  ScenarioProjection,
  UnmodelledFactor,
} from './api.js'

/**
 * Turning a projection into the handful of things the screens actually render.
 *
 * Pure, so the decisions that matter are testable without a browser: which end of the band is
 * which, what "funded" means when the plan has no retirement years in it, and whether the
 * disclosures are shown.
 *
 * Everything here works on the decimal strings the API sends. Money is never parsed into a
 * `number` on the way past — comparisons go through `BigInt`, which is exact, and the strings are
 * handed to the formatter untouched.
 */

/** Compares two decimal money strings exactly, via cents. */
function toCents(decimal: string): bigint {
  const negative = decimal.startsWith('-')
  const [whole = '0', fraction = ''] = (negative ? decimal.slice(1) : decimal).split('.')
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2))
  return negative ? -cents : cents
}

export type BandPoint = {
  year: number
  /** The lowest and highest totals across the scenarios, by value. */
  low: string
  high: string
  /** The default scenario's total — the line drawn inside the band. */
  headline: string
}

/**
 * The band, year by year.
 *
 * **Low and high are computed from the values, never from the order the scenarios arrive in.**
 * The engine is monotonic in the return rate, so the seeded three come back in order — but every
 * rate is editable, and somebody who raises the return on "Markets disappoint" would otherwise get
 * a band drawn upside down with the fill inverted. Which scenario is named what is not evidence of
 * anything.
 */
export function bandSeries(
  projections: readonly ScenarioProjection[],
  headlineScenarioId: string | null,
): BandPoint[] {
  const first = projections[0]
  if (first === undefined) return []

  const headline =
    projections.find((projection) => projection.scenarioId === headlineScenarioId) ?? first

  return first.years.map((_, index) => {
    const totals = projections
      .map((projection) => projection.years[index]?.total)
      .filter((total): total is string => total !== undefined)

    let low = totals[0] ?? '0.00'
    let high = low
    for (const total of totals) {
      if (toCents(total) < toCents(low)) low = total
      if (toCents(total) > toCents(high)) high = total
    }

    return {
      year: first.years[index]?.year ?? 0,
      low,
      high,
      headline: headline.years[index]?.total ?? low,
    }
  })
}

/**
 * What the plan comes to, as a state rather than a pile of nullable fields.
 *
 * A union so the screen cannot render "fully funded" beside a depletion year: the three outcomes
 * are mutually exclusive and saying so in the type is cheaper than remembering to check.
 */
export type FundedOutcome =
  /** No retirement year inside the horizon. Nothing to fund is not the same as fully funded. */
  | { kind: 'no-horizon' }
  | { kind: 'covered'; terminalTotal: string }
  | { kind: 'short'; depletionYear: number; gap: string; fundedRatioBasisPoints: number }

export function fundedOutcome(projection: ScenarioProjection): FundedOutcome {
  if (projection.fundedRatioBasisPoints === null) return { kind: 'no-horizon' }

  if (projection.depletionYear === null) {
    return { kind: 'covered', terminalTotal: projection.terminalTotal }
  }

  return {
    kind: 'short',
    depletionYear: projection.depletionYear,
    gap: projection.gap,
    fundedRatioBasisPoints: projection.fundedRatioBasisPoints,
  }
}

/**
 * Basis points as a percentage, keeping a decimal place only when there is one.
 *
 * 2200 is "22%", 350 is "3.5%", 7350 is "73.5%". Rounding everything to whole percents rendered a
 * seeded 3.5% post-retirement return as "4%" — so the assumption shown beside the figures was not
 * the assumption that produced them, which is precisely what the "no number without its
 * assumption" rule exists to prevent.
 */
export function percentFromBasisPoints(basisPoints: number): string {
  const percent = Math.round(basisPoints / 10) / 10
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`
}

/**
 * The scenario whose figures lead the screen.
 *
 * The default one, falling back to the middle by value rather than the first. If the default were
 * ever missing, leading with whichever scenario happened to sort first would be arbitrary — and
 * about a third of the time it would be the optimistic one, which is the wrong accident to have.
 */
export function headlineProjection(
  projections: readonly ScenarioProjection[],
  scenarios: readonly { id: string; isDefault: boolean }[],
): ScenarioProjection | null {
  if (projections.length === 0) return null

  const defaultId = scenarios.find((scenario) => scenario.isDefault)?.id
  const byDefault = projections.find((projection) => projection.scenarioId === defaultId)
  if (byDefault !== undefined) return byDefault

  const sorted = [...projections].sort((left, right) => {
    const a = toCents(left.terminalTotal)
    const b = toCents(right.terminalTotal)
    return a < b ? -1 : a > b ? 1 : 0
  })

  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null
}

/**
 * The earliest year any scenario runs out, and which one.
 *
 * The headline describes one scenario, so on its own it can say "lasts the whole plan" directly
 * beneath a band whose low edge touches zero. That is the same failure as a funded ratio
 * contradicting its own chart (§19.4b): the reader is told the plan holds while looking at a
 * picture of it not holding.
 *
 * Null when every scenario lasts, so the line only appears when it has something to say.
 */
export function earliestDepletion(
  projections: readonly ScenarioProjection[],
): { year: number; scenarioName: string } | null {
  let worst: { year: number; scenarioName: string } | null = null

  for (const projection of projections) {
    if (projection.depletionYear === null) continue
    if (worst === null || projection.depletionYear < worst.year) {
      worst = { year: projection.depletionYear, scenarioName: projection.name }
    }
  }

  return worst
}

/**
 * The gaps the projection declares, shown beside the figures rather than in a footnote.
 *
 * Collected across scenarios and de-duplicated. They are the same for every scenario today, but
 * reading them from the response rather than hard-coding the list means a factor that later
 * becomes modelled stops being mentioned on its own.
 */
export function disclosures(projections: readonly ScenarioProjection[]): UnmodelledFactor[] {
  const seen = new Set<UnmodelledFactor>()
  for (const projection of projections) {
    for (const factor of projection.notModelled) seen.add(factor)
  }
  return [...seen]
}

/**
 * Everything the dashboard needs, or the reason it cannot be shown.
 *
 * One call rather than five, so a screen cannot render the headline from a ready projection while
 * reading the disclosures from a stale one.
 */
export type DashboardView =
  | { kind: 'not-started' }
  | { kind: 'incomplete'; missing: MissingPlanInput[] }
  | {
      kind: 'ready'
      band: BandPoint[]
      headline: ScenarioProjection
      outcome: FundedOutcome
      /**
       * The earliest year *any* scenario runs out. Null when they all last.
       *
       * Separate from `outcome`, which is about the headline scenario alone. Both are shown,
       * because "the plan holds under these assumptions, and runs out in 2057 under those" is the
       * honest sentence and either half on its own is misleading.
       */
      earliestDepletion: { year: number; scenarioName: string } | null
      /** The lowest and highest terminal totals, which is the headline range. */
      terminalLow: string
      terminalHigh: string
      disclosures: UnmodelledFactor[]
      unreviewedCount: number
      monthsObserved: number
      annualizedFromPartialYear: boolean
      /** Today's split and what it is worth after the assumed tax. */
      openingBuckets: { treatment: string; balance: string }[]
      afterTax: {
        nominal: string
        afterTax: string
        deferredTax: string
        ignoresEmbeddedGains: boolean
      }
      effectiveRateBasisPoints: number
    }

export function dashboardView(
  projection: Projection | undefined,
  scenarios: readonly { id: string; isDefault: boolean }[],
  planStarted: boolean,
): DashboardView {
  if (!planStarted) return { kind: 'not-started' }
  if (projection === undefined) return { kind: 'not-started' }

  if (!projection.ready) return { kind: 'incomplete', missing: projection.missing }

  const headline = headlineProjection(projection.projections, scenarios)
  if (headline === null) return { kind: 'incomplete', missing: [] }

  const band = bandSeries(projection.projections, headline.scenarioId)
  const last = band.at(-1)

  return {
    kind: 'ready',
    band,
    headline,
    outcome: fundedOutcome(headline),
    earliestDepletion: earliestDepletion(projection.projections),
    terminalLow: last?.low ?? '0.00',
    terminalHigh: last?.high ?? '0.00',
    disclosures: disclosures(projection.projections),
    unreviewedCount: projection.unreviewedCategoryIds.length,
    monthsObserved: projection.monthsObserved,
    annualizedFromPartialYear: projection.annualizedFromPartialYear,
    openingBuckets: projection.openingBuckets,
    afterTax: projection.afterTax,
    effectiveRateBasisPoints: projection.retirementEffectiveRateBasisPoints,
  }
}
