import type { TaxTreatment } from '@beans/shared'

/**
 * The retirement planner's client. Mirrors `apps/api/src/routes/retirement.ts`.
 *
 * **Money arrives and leaves as decimal strings**, matching the API. Nothing here parses one into a
 * `number` — the formatter takes the string, and the only arithmetic the client does on money is
 * none.
 */

export type MissingPlanInput =
  | 'members'
  | 'retirement_date'
  | 'life_expectancy'
  | 'spending_baseline'
  | 'balances'

export type UnmodelledFactor = 'required_minimum_distributions' | 'social_security_taxation'

export type PlanMember = {
  id: string
  displayName: string
  userId: string | null
  birthYear: number
  targetRetirementDate: string | null
  socialSecurityClaimAge: number | null
  /** Decimal string, or null when nobody has entered it. Null is not zero. */
  socialSecurityAnnualBenefit: string | null
  lifeExpectancy: number | null
}

export type PlanScenario = {
  id: string
  name: string
  preRetirementReturnBasisPoints: number
  postRetirementReturnBasisPoints: number
  annualSpendingOverride: string | null
  retirementYearsOffset: number | null
  isDefault: boolean
}

export type PlanProfile = {
  id: string
  retirementEffectiveRateBasisPoints: number
  withdrawalOrder: TaxTreatment[] | null
  pre65HealthcareAnnual: string | null
}

export type AccountBuckets = {
  accountId: string
  anchors: { asOfDate: string; buckets: { treatment: TaxTreatment; balance: string }[] }[]
}

export type AccountRouting = {
  accountId: string
  treatment: TaxTreatment
  annualAmount: string
  active: boolean
}

export type StoredSpendingAnswer = {
  categoryId: string
  treatment: 'continues' | 'stops' | 'adjusted'
  adjustmentBasisPoints: number | null
  lastYear: number | null
  reviewedAt: string | null
}

export type AccountPlanFeatures = {
  accountId: string
  allowsAfterTaxContributions: boolean | null
  allowsInPlanRothConversion: boolean | null
  allowsInServiceWithdrawal: boolean | null
  acceptsIraRollIns: boolean | null
  employerMatchDescription: string | null
  answeredAt: string | null
}

/** `started: false` is the ordinary state of a household that has not opened the planner. */
export type RetirementPlan =
  | { started: false }
  | {
      started: true
      profile: PlanProfile
      members: PlanMember[]
      scenarios: PlanScenario[]
      taxBuckets: AccountBuckets[]
      routing: AccountRouting[]
      planFeatures: AccountPlanFeatures[]
      /** The answers already given, so the review shows them rather than resetting to defaults. */
      spendingAssumptions: StoredSpendingAnswer[]
      /** Offered for the spending review to pre-fill with. Never applied on its own. */
      loanPayoffYears: { accountId: string; payoffYear: number }[]
    }

export type ProjectionYear = {
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
  buckets: { treatment: TaxTreatment; balance: string }[]
}

export type ScenarioProjection = {
  scenarioId: string
  name: string
  terminalTotal: string
  depletionYear: number | null
  heldBack: string
  /** 10000 is fully funded. Null when the plan contains no retirement year at all. */
  fundedRatioBasisPoints: number | null
  gap: string
  notModelled: UnmodelledFactor[]
  years: ProjectionYear[]
}

export type Projection =
  | { ready: false; missing: MissingPlanInput[] }
  | {
      ready: true
      startYear: number
      endYear: number
      /** Non-empty means the baseline contains guesses, and the screen has to say so. */
      unreviewedCategoryIds: (string | null)[]
      monthsObserved: number
      annualizedFromPartialYear: boolean
      projections: ScenarioProjection[]
    }

async function send<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Request failed with ${response.status}`)
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T)
}

function write(path: string, method: string, body?: unknown): Promise<void> {
  return send(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
}

export function getRetirementPlan(): Promise<RetirementPlan> {
  return send('/api/retirement')
}

export function getProjection(): Promise<Projection> {
  return send('/api/retirement/projection')
}

/** Idempotent — the wizard is revisitable and its first screen should not care. */
export function startPlan(): Promise<{ profileId: string }> {
  return send('/api/retirement', { method: 'POST' })
}

/**
 * Only the keys sent are changed.
 *
 * A key present with `null` clears the field; an absent key leaves it alone. The two are different
 * operations all the way down to the SQL, so this type keeps them distinguishable rather than
 * collapsing both into "optional".
 */
export type ProfilePatch = {
  retirementEffectiveRateBasisPoints?: number
  withdrawalOrder?: TaxTreatment[] | null
  pre65HealthcareAnnual?: string | null
}

export function patchProfile(patch: ProfilePatch): Promise<void> {
  return write('/api/retirement/profile', 'PATCH', patch)
}

export type MemberInput = {
  displayName: string
  birthYear: number
  targetRetirementDate?: string | null
  socialSecurityClaimAge?: number | null
  socialSecurityAnnualBenefit?: string | null
  lifeExpectancy?: number | null
}

export function addMember(input: MemberInput): Promise<{ id: string }> {
  return send('/api/retirement/members', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function updateMember(id: string, input: MemberInput): Promise<void> {
  return write(`/api/retirement/members/${id}`, 'PATCH', input)
}

export function removeMember(id: string): Promise<void> {
  return write(`/api/retirement/members/${id}`, 'DELETE')
}

export type ScenarioPatch = {
  name?: string
  preRetirementReturnBasisPoints?: number
  postRetirementReturnBasisPoints?: number
  annualSpendingOverride?: string | null
  retirementYearsOffset?: number | null
}

export function patchScenario(id: string, patch: ScenarioPatch): Promise<void> {
  return write(`/api/retirement/scenarios/${id}`, 'PATCH', patch)
}

export function makeScenarioDefault(id: string): Promise<void> {
  return write(`/api/retirement/scenarios/${id}/default`, 'POST')
}

export type SpendingAnswer = {
  treatment: 'continues' | 'stops' | 'adjusted'
  adjustmentBasisPoints?: number | null
  /** The last year this cost is incurred, for a category that pays off a loan. */
  lastYear?: number | null
}

export function setSpendingAnswer(categoryId: string, answer: SpendingAnswer): Promise<void> {
  return write(`/api/retirement/spending/${categoryId}`, 'PUT', answer)
}

/** A whole date at a time. An empty list removes the anchor. */
export function setBuckets(
  accountId: string,
  asOfDate: string,
  buckets: { treatment: TaxTreatment; balance: string }[],
): Promise<void> {
  return write(`/api/retirement/accounts/${accountId}/buckets`, 'PUT', { asOfDate, buckets })
}

export function setRouting(
  accountId: string,
  input: { treatment: TaxTreatment; annualAmount: string; active?: boolean },
): Promise<void> {
  return write(`/api/retirement/accounts/${accountId}/routing`, 'PUT', input)
}

export function clearRouting(accountId: string, treatment: TaxTreatment): Promise<void> {
  return write(`/api/retirement/accounts/${accountId}/routing/${treatment}`, 'DELETE')
}

export type PlanFeaturesPatch = {
  allowsAfterTaxContributions?: boolean | null
  allowsInPlanRothConversion?: boolean | null
  allowsInServiceWithdrawal?: boolean | null
  acceptsIraRollIns?: boolean | null
  employerMatchDescription?: string | null
}

export function setPlanFeatures(accountId: string, patch: PlanFeaturesPatch): Promise<void> {
  return write(`/api/retirement/accounts/${accountId}/plan-features`, 'PUT', patch)
}
