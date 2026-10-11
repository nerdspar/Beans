import { centsToDecimalString, parseDecimalToCents, type ScenarioProjection } from '@beans/shared'

/**
 * Turning the engine's output and the wizard's input into wire shapes.
 *
 * Extracted from the route so it can be tested without a server, because two things here are
 * genuinely easy to get wrong and both fail in ways a thin route would not reveal:
 *
 * 1. **A `bigint` that reaches the response throws.** `JSON.stringify` does not serialize BigInt —
 *    it raises `TypeError: Do not know how to serialize a BigInt`. So a single missed conversion in
 *    a forty-year, three-scenario payload is a 500 on the dashboard, not a slightly wrong number.
 * 2. **Absent and null are different operations.** A patch that omits a field must leave it alone;
 *    one that sends `null` must clear it. Collapsing them is the bug that made every `tab_order`
 *    save fail silently, and it is invisible from both ends.
 */

/** Money out. Null stays null rather than becoming `"0"` — unanswered is not zero. */
export function moneyOut(cents: bigint | null): string | null {
  return cents === null ? null : centsToDecimalString(cents)
}

/** Money in, where the field may be absent, explicitly null, or a value. */
export function moneyIn(value: string | null | undefined): bigint | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  return parseDecimalToCents(value)
}

export type WireProjection = {
  scenarioId: string
  name: string
  terminalTotal: string
  depletionYear: number | null
  heldBack: string
  fundedRatioBasisPoints: number | null
  gap: string
  notModelled: string[]
  years: {
    year: number
    retired: boolean
    total: string
    spending: string
    socialSecurity: string
    portfolioNeed: string
    withdrawals: string
    tax: string
    contributions: string
    growth: string
    shortfall: string
    buckets: { treatment: string; balance: string }[]
  }[]
}

/**
 * Every figure as a decimal string.
 *
 * **Money crosses the API boundary as a decimal string, never a JSON number** (CLAUDE.md). A JSON
 * number is an IEEE-754 double and loses precision above 2^53 — which a retirement projection
 * reaches sooner than most things, because it compounds a portfolio for forty years.
 *
 * `fundedRatioBasisPoints` and `depletionYear` stay numbers on purpose: an integer basis-point rate
 * and a calendar year have no precision problem, and stringifying them would make every consumer
 * parse them back.
 */
export function serializeProjection(projection: ScenarioProjection): WireProjection {
  return {
    scenarioId: projection.scenarioId,
    name: projection.name,
    terminalTotal: centsToDecimalString(projection.terminalTotalCents),
    depletionYear: projection.depletionYear,
    heldBack: centsToDecimalString(projection.heldBackCents),
    fundedRatioBasisPoints: projection.fundedRatioBasisPoints,
    gap: centsToDecimalString(projection.gapCents),
    /** Declared gaps. The UI is obliged to state these beside the figures (§19.4a). */
    notModelled: [...projection.notModelled],
    years: projection.years.map((year) => ({
      year: year.year,
      retired: year.retired,
      total: centsToDecimalString(year.totalCents),
      spending: centsToDecimalString(year.spendingCents),
      socialSecurity: centsToDecimalString(year.socialSecurityCents),
      portfolioNeed: centsToDecimalString(year.portfolioNeedCents),
      withdrawals: centsToDecimalString(year.withdrawalsCents),
      tax: centsToDecimalString(year.taxCents),
      contributions: centsToDecimalString(year.contributionsCents),
      growth: centsToDecimalString(year.growthCents),
      shortfall: centsToDecimalString(year.shortfallCents),
      buckets: year.buckets.map((bucket) => ({
        treatment: bucket.treatment,
        balance: centsToDecimalString(bucket.balanceCents),
      })),
    })),
  }
}

export type MemberWire = {
  displayName: string
  birthYear: number
  targetRetirementDate?: string | null | undefined
  socialSecurityClaimAge?: number | null | undefined
  socialSecurityAnnualBenefit?: string | null | undefined
  lifeExpectancy?: number | null | undefined
}

/**
 * A member patch, preserving the difference between "absent" and "null".
 *
 * `in` rather than `!== undefined`, because the two diverge on exactly the case that matters: a
 * body that explicitly sent `null` has the key present with an undefined-ish value after parsing,
 * and treating that as absent would silently refuse to clear a field.
 */
export function toMemberInput(body: MemberWire): {
  displayName: string
  birthYear: number
  targetRetirementDate?: string | null
  socialSecurityClaimAge?: number | null
  socialSecurityAnnualBenefitCents?: bigint | null
  lifeExpectancy?: number | null
} {
  return {
    displayName: body.displayName,
    birthYear: body.birthYear,
    ...('targetRetirementDate' in body
      ? { targetRetirementDate: body.targetRetirementDate ?? null }
      : {}),
    ...('socialSecurityClaimAge' in body
      ? { socialSecurityClaimAge: body.socialSecurityClaimAge ?? null }
      : {}),
    ...('socialSecurityAnnualBenefit' in body
      ? { socialSecurityAnnualBenefitCents: moneyIn(body.socialSecurityAnnualBenefit) ?? null }
      : {}),
    ...('lifeExpectancy' in body ? { lifeExpectancy: body.lifeExpectancy ?? null } : {}),
  }
}
