import { SEED_SCENARIOS, type IsoDate, type TaxTreatment } from '@beans/shared'
import type { HouseholdContext } from './household-context.js'

/**
 * The retirement plan: the profile, the people in it, and the scenarios it is run under.
 *
 * Reads and writes **domain types — `bigint` cents, not decimal strings.** The account repositories
 * hand back strings because what they return goes almost straight onto the wire; this is consumed by
 * the projection engine, which works in cents, so converting to a string here would mean parsing it
 * back three lines later. The route does the string conversion at the boundary where it belongs.
 */

export class RetirementError extends Error {
  override readonly name = 'RetirementError'
}

export type RetirementProfile = {
  id: string
  /** An assumption, shown beside every figure it produces. Never presented as a calculation. */
  retirementEffectiveRateBasisPoints: number
  /** Null means the engine's default order. */
  withdrawalOrder: TaxTreatment[] | null
  /** Null means nobody has been asked yet, which is different from an answer of zero. */
  pre65HealthcareAnnualCents: bigint | null
}

export type RetirementMember = {
  id: string
  displayName: string
  userId: string | null
  birthYear: number
  targetRetirementDate: IsoDate | null
  socialSecurityClaimAge: number | null
  /** Read off an SSA statement. Never computed — see ARCHITECTURE §19.5. */
  socialSecurityAnnualBenefitCents: bigint | null
  lifeExpectancy: number | null
}

export type RetirementScenario = {
  id: string
  name: string
  preRetirementReturnBasisPoints: number
  postRetirementReturnBasisPoints: number
  annualSpendingOverrideCents: bigint | null
  retirementYearsOffset: number | null
  isDefault: boolean
  sortOrder: number
}

export type RetirementPlan = {
  profile: RetirementProfile
  members: RetirementMember[]
  scenarios: RetirementScenario[]
}

type ProfileRow = {
  id: string
  retirement_effective_rate_basis_points: number
  withdrawal_order: string[] | null
  pre65_healthcare_annual_amount: Buffer | null
}

/**
 * The plan, or null when this household has never opened the planner.
 *
 * Null rather than an empty plan, deliberately. "No plan yet" is the state the setup wizard exists
 * to resolve, and a profile full of defaults is indistinguishable from one somebody reviewed and
 * left alone — which is the same mistake the unreviewed-spending flag avoids.
 */
export async function readRetirementPlan(
  context: HouseholdContext,
): Promise<RetirementPlan | null> {
  const profiles = await context.client.query<ProfileRow>(
    `select id, retirement_effective_rate_basis_points, withdrawal_order,
            pre65_healthcare_annual_amount
       from retirement_profiles`,
  )

  const profileRow = profiles.rows[0]
  if (profileRow === undefined) return null

  /*
   * Sequential, deliberately. Both share the transaction's one `PoolClient`, and a single
   * connection cannot run queries concurrently — node-postgres serializes them and warns that it
   * will stop doing so in pg@9. `Promise.all` here buys nothing and breaks later. Same reasoning as
   * `readWorkingSet`, which carries the same note.
   */
  const members = await readMembers(context, profileRow.id)
  const scenarios = await readScenarios(context, profileRow.id)

  return { profile: toProfile(context, profileRow), members, scenarios }
}

/**
 * Creates the plan if it does not exist, and returns it either way.
 *
 * Idempotent, because the wizard is revisitable and the first screen of it should not care whether
 * it is being opened for the first time. Seeding the three scenarios happens here rather than at
 * household creation: a household that never opens the planner should not carry rows for it, and
 * every path that creates a household would otherwise have to remember to.
 */
export async function ensureRetirementPlan(context: HouseholdContext): Promise<RetirementPlan> {
  const existing = await readRetirementPlan(context)
  if (existing !== null) return existing

  const inserted = await context.client.query<ProfileRow>(
    `insert into retirement_profiles (household_id)
     values ($1)
     on conflict (household_id) do nothing
     returning id, retirement_effective_rate_basis_points, withdrawal_order,
               pre65_healthcare_annual_amount`,
    [context.householdId],
  )

  /*
   * `do nothing` returns no row when another request won the race. Re-reading is the correct
   * resolution: the other transaction's profile is just as good as the one this one wanted, and
   * the alternative — failing, or inserting again — turns two people opening the planner at once
   * into an error nobody can explain.
   */
  const profileRow = inserted.rows[0]
  if (profileRow === undefined) {
    const after = await readRetirementPlan(context)
    if (after === null) {
      throw new RetirementError('The retirement profile could not be created or read')
    }
    return after
  }

  await seedScenarios(context, profileRow.id)

  return {
    profile: toProfile(context, profileRow),
    members: [],
    scenarios: await readScenarios(context, profileRow.id),
  }
}

export type ProfilePatch = {
  retirementEffectiveRateBasisPoints?: number | undefined
  /** Present and null clears it, absent leaves it alone. The two are different operations. */
  withdrawalOrder?: TaxTreatment[] | null | undefined
  pre65HealthcareAnnualCents?: bigint | null | undefined
}

export async function updateRetirementProfile(
  context: HouseholdContext,
  patch: ProfilePatch,
): Promise<void> {
  /*
   * **`JSON.stringify`, because the column is `jsonb`.** node-pg serializes a JavaScript array as
   * Postgres array-literal syntax — `{a,b,c}` — which `jsonb` rejects outright. That exact mistake
   * made every save of `user_preferences.tab_order` fail silently from the day it shipped, and the
   * symptom was a button that appeared to do nothing.
   */
  const withdrawalOrder =
    patch.withdrawalOrder === undefined || patch.withdrawalOrder === null
      ? null
      : JSON.stringify(patch.withdrawalOrder)

  await context.client.query(
    `update retirement_profiles
        set retirement_effective_rate_basis_points =
              coalesce($1, retirement_effective_rate_basis_points),
            withdrawal_order = case when $2 then $3::jsonb else withdrawal_order end,
            pre65_healthcare_annual_amount =
              case when $4 then $5 else pre65_healthcare_annual_amount end`,
    [
      patch.retirementEffectiveRateBasisPoints ?? null,
      // Distinguishes "clear it" from "leave it alone" — both arrive as null above.
      'withdrawalOrder' in patch,
      withdrawalOrder,
      'pre65HealthcareAnnualCents' in patch,
      patch.pre65HealthcareAnnualCents === undefined || patch.pre65HealthcareAnnualCents === null
        ? null
        : context.cipher.encryptMoney(patch.pre65HealthcareAnnualCents),
    ],
  )
}

export type MemberInput = {
  displayName: string
  userId?: string | null | undefined
  birthYear: number
  targetRetirementDate?: IsoDate | null | undefined
  socialSecurityClaimAge?: number | null | undefined
  socialSecurityAnnualBenefitCents?: bigint | null | undefined
  lifeExpectancy?: number | null | undefined
}

export async function addRetirementMember(
  context: HouseholdContext,
  profileId: string,
  input: MemberInput,
): Promise<string> {
  const result = await context.client.query<{ id: string }>(
    `insert into retirement_members
       (household_id, profile_id, display_name, user_id, birth_year, target_retirement_date,
        social_security_claim_age, social_security_annual_benefit, life_expectancy)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning id`,
    [
      context.householdId,
      profileId,
      context.cipher.encryptText(input.displayName),
      input.userId ?? null,
      input.birthYear,
      input.targetRetirementDate ?? null,
      input.socialSecurityClaimAge ?? null,
      input.socialSecurityAnnualBenefitCents === undefined ||
      input.socialSecurityAnnualBenefitCents === null
        ? null
        : context.cipher.encryptMoney(input.socialSecurityAnnualBenefitCents),
      input.lifeExpectancy ?? null,
    ],
  )

  const row = result.rows[0]
  if (row === undefined) {
    /*
     * Unreachable through the household context, and worth saying out loud rather than
     * non-null-asserting: an insert that returns nothing under RLS means the `with check` clause
     * rejected the row, which would mean the household id did not match the session. That is an
     * isolation failure, not a validation error, and it should read like one.
     */
    throw new RetirementError('The member was not written — the household context did not match')
  }

  return row.id
}

export async function updateRetirementMember(
  context: HouseholdContext,
  memberId: string,
  input: MemberInput,
): Promise<void> {
  const result = await context.client.query(
    `update retirement_members
        set display_name = $2,
            user_id = $3,
            birth_year = $4,
            target_retirement_date = $5,
            social_security_claim_age = $6,
            social_security_annual_benefit = $7,
            life_expectancy = $8
      where id = $1`,
    [
      memberId,
      context.cipher.encryptText(input.displayName),
      input.userId ?? null,
      input.birthYear,
      input.targetRetirementDate ?? null,
      input.socialSecurityClaimAge ?? null,
      input.socialSecurityAnnualBenefitCents === undefined ||
      input.socialSecurityAnnualBenefitCents === null
        ? null
        : context.cipher.encryptMoney(input.socialSecurityAnnualBenefitCents),
      input.lifeExpectancy ?? null,
    ],
  )

  // Zero rows means the id belongs to another household, which RLS turned into "not found".
  if (result.rowCount === 0) throw new RetirementError('No such member in this household')
}

export async function deleteRetirementMember(
  context: HouseholdContext,
  memberId: string,
): Promise<void> {
  const result = await context.client.query('delete from retirement_members where id = $1', [
    memberId,
  ])

  if (result.rowCount === 0) throw new RetirementError('No such member in this household')
}

export type ScenarioPatch = {
  name?: string | undefined
  preRetirementReturnBasisPoints?: number | undefined
  postRetirementReturnBasisPoints?: number | undefined
  annualSpendingOverrideCents?: bigint | null | undefined
  retirementYearsOffset?: number | null | undefined
}

export async function updateRetirementScenario(
  context: HouseholdContext,
  scenarioId: string,
  patch: ScenarioPatch,
): Promise<void> {
  const result = await context.client.query(
    `update retirement_scenarios
        set name = coalesce($2, name),
            pre_retirement_return_basis_points =
              coalesce($3, pre_retirement_return_basis_points),
            post_retirement_return_basis_points =
              coalesce($4, post_retirement_return_basis_points),
            annual_spending_override =
              case when $5 then $6 else annual_spending_override end,
            retirement_years_offset =
              case when $7 then $8 else retirement_years_offset end
      where id = $1`,
    [
      scenarioId,
      patch.name ?? null,
      patch.preRetirementReturnBasisPoints ?? null,
      patch.postRetirementReturnBasisPoints ?? null,
      'annualSpendingOverrideCents' in patch,
      patch.annualSpendingOverrideCents === undefined || patch.annualSpendingOverrideCents === null
        ? null
        : context.cipher.encryptMoney(patch.annualSpendingOverrideCents),
      'retirementYearsOffset' in patch,
      patch.retirementYearsOffset ?? null,
    ],
  )

  if (result.rowCount === 0) throw new RetirementError('No such scenario in this household')
}

/**
 * Moves the default to one scenario, clearing it from the others.
 *
 * Two statements in a deliberate order: clear, then set. The partial unique index allows exactly
 * one default per profile, so setting before clearing would collide with the row already holding
 * it — and both statements are in the caller's transaction, so there is no window where a profile
 * has no default at all.
 */
export async function setDefaultScenario(
  context: HouseholdContext,
  scenarioId: string,
): Promise<void> {
  const target = await context.client.query<{ profile_id: string }>(
    'select profile_id from retirement_scenarios where id = $1',
    [scenarioId],
  )

  const row = target.rows[0]
  if (row === undefined) throw new RetirementError('No such scenario in this household')

  await context.client.query(
    'update retirement_scenarios set is_default = false where profile_id = $1 and is_default',
    [row.profile_id],
  )
  await context.client.query('update retirement_scenarios set is_default = true where id = $1', [
    scenarioId,
  ])
}

async function seedScenarios(context: HouseholdContext, profileId: string): Promise<void> {
  for (const seed of SEED_SCENARIOS) {
    await context.client.query(
      `insert into retirement_scenarios
         (household_id, profile_id, name, pre_retirement_return_basis_points,
          post_retirement_return_basis_points, is_default, sort_order)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (profile_id, name) do nothing`,
      [
        context.householdId,
        profileId,
        seed.name,
        seed.preRetirementReturnBasisPoints,
        seed.postRetirementReturnBasisPoints,
        seed.isDefault,
        seed.sortOrder,
      ],
    )
  }
}

function toProfile(context: HouseholdContext, row: ProfileRow): RetirementProfile {
  return {
    id: row.id,
    retirementEffectiveRateBasisPoints: row.retirement_effective_rate_basis_points,
    // `jsonb` comes back already parsed, so only the write needed serializing.
    withdrawalOrder: row.withdrawal_order as TaxTreatment[] | null,
    pre65HealthcareAnnualCents:
      row.pre65_healthcare_annual_amount === null
        ? null
        : context.cipher.decryptMoney(row.pre65_healthcare_annual_amount),
  }
}

async function readMembers(
  context: HouseholdContext,
  profileId: string,
): Promise<RetirementMember[]> {
  const result = await context.client.query<{
    id: string
    display_name: Buffer
    user_id: string | null
    birth_year: number
    target_retirement_date: IsoDate | null
    social_security_claim_age: number | null
    social_security_annual_benefit: Buffer | null
    life_expectancy: number | null
  }>(
    `select id, display_name, user_id, birth_year, target_retirement_date,
            social_security_claim_age, social_security_annual_benefit, life_expectancy
       from retirement_members
      where profile_id = $1
      order by birth_year, created_at, id`,
    [profileId],
  )

  return result.rows.map((row) => ({
    id: row.id,
    displayName: context.cipher.decryptText(row.display_name),
    userId: row.user_id,
    birthYear: row.birth_year,
    targetRetirementDate: row.target_retirement_date,
    socialSecurityClaimAge: row.social_security_claim_age,
    socialSecurityAnnualBenefitCents:
      row.social_security_annual_benefit === null
        ? null
        : context.cipher.decryptMoney(row.social_security_annual_benefit),
    lifeExpectancy: row.life_expectancy,
  }))
}

async function readScenarios(
  context: HouseholdContext,
  profileId: string,
): Promise<RetirementScenario[]> {
  const result = await context.client.query<{
    id: string
    name: string
    pre_retirement_return_basis_points: number
    post_retirement_return_basis_points: number
    annual_spending_override: Buffer | null
    retirement_years_offset: number | null
    is_default: boolean
    sort_order: number
  }>(
    `select id, name, pre_retirement_return_basis_points, post_retirement_return_basis_points,
            annual_spending_override, retirement_years_offset, is_default, sort_order
       from retirement_scenarios
      where profile_id = $1
      order by sort_order, name`,
    [profileId],
  )

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    preRetirementReturnBasisPoints: row.pre_retirement_return_basis_points,
    postRetirementReturnBasisPoints: row.post_retirement_return_basis_points,
    annualSpendingOverrideCents:
      row.annual_spending_override === null
        ? null
        : context.cipher.decryptMoney(row.annual_spending_override),
    retirementYearsOffset: row.retirement_years_offset,
    isDefault: row.is_default,
    sortOrder: row.sort_order,
  }))
}

/**
 * What happens to each spending category in retirement.
 *
 * Shaped to feed `retirementSpending` directly: a discriminated union where an `adjusted` row
 * cannot exist without its percentage. The column is nullable, so the conversion happens here — and
 * a row claiming `adjusted` with no percentage is treated as `continues`, which is the expensive
 * assumption and therefore the safe one to fall back on. The repository is what guarantees the
 * pairing on write; this is the belt to that braces.
 */
export type StoredSpendingAssumption = {
  categoryId: string
  treatment: 'continues' | 'stops' | 'adjusted'
  adjustmentBasisPoints: number | null
  reviewedAt: Date | null
  /** The last year this cost is incurred, from the payoff date of a loan it pays. */
  lastYear: number | null
}

/**
 * Every recorded assumption for this profile.
 *
 * `last_year` is **stored per category, not derived from the loan.** The first version of this
 * query tried to be clever and resolved it with a subquery over `accounts.payoff_date` — which was
 * not correlated to the category at all, so every row got the mortgage's payoff year and the
 * projection would have stopped buying groceries the month the house was paid off. A derivation
 * that silently applies to the wrong rows is worse than asking.
 *
 * There is also no link in the schema to derive it from. A mortgage payment is a transaction in a
 * *checking* account under whatever category the household chose, and §9.1 is explicit that it is
 * not a transfer to the mortgage account — the interest is a real expense. So nothing joins the
 * category to the loan, and the honest design is the one the ground rules already call for: the
 * wizard pre-fills the year from `accounts.payoff_date` and the user confirms it.
 */
export async function readSpendingAssumptions(
  context: HouseholdContext,
  profileId: string,
): Promise<StoredSpendingAssumption[]> {
  const result = await context.client.query<{
    category_id: string
    treatment: 'continues' | 'stops' | 'adjusted'
    adjustment_basis_points: number | null
    reviewed_at: Date | null
    last_year: number | null
  }>(
    `select s.category_id, s.treatment, s.adjustment_basis_points, s.reviewed_at, s.last_year
       from retirement_spending_assumptions s
      where s.profile_id = $1
      order by s.category_id`,
    [profileId],
  )

  return result.rows.map((row) => ({
    categoryId: row.category_id,
    treatment: row.treatment,
    adjustmentBasisPoints: row.adjustment_basis_points,
    reviewedAt: row.reviewed_at,
    lastYear: row.last_year,
  }))
}

/**
 * The payoff year of each loan or mortgage, for the wizard to pre-fill a spending answer with.
 *
 * Returned as a list for the UI to offer, never applied automatically. Which category pays which
 * loan is something only the household knows, and the cost of guessing wrong is a projection that
 * drops an entire category on the wrong date.
 */
export async function readLoanPayoffYears(
  context: HouseholdContext,
): Promise<{ accountId: string; payoffYear: number }[]> {
  const result = await context.client.query<{ id: string; payoff_year: number }>(
    `select id, extract(year from payoff_date)::int as payoff_year
       from accounts
      where payoff_date is not null
        and type in ('mortgage', 'loan')
      order by payoff_date`,
  )

  return result.rows.map((row) => ({ accountId: row.id, payoffYear: row.payoff_year }))
}

export type SpendingAssumptionInput = {
  categoryId: string
  treatment: 'continues' | 'stops' | 'adjusted'
  /** Required when the treatment is `adjusted`, and rejected otherwise. */
  adjustmentBasisPoints?: number | null | undefined
  /**
   * The last calendar year this cost is incurred, for a category that pays off a loan.
   *
   * Confirmed by the user, pre-filled from `accounts.payoff_date` by the wizard. Never inferred —
   * see the note on {@link readSpendingAssumptions}.
   */
  lastYear?: number | null | undefined
  reviewedAt: Date
}

export async function setSpendingAssumption(
  context: HouseholdContext,
  profileId: string,
  input: SpendingAssumptionInput,
): Promise<void> {
  /*
   * The pairing is enforced here rather than by a CHECK constraint, so the error can say something
   * useful. "adjustment_basis_points is required when the treatment is adjusted" is a sentence; a
   * constraint name met at 2am is not.
   */
  if (input.treatment === 'adjusted') {
    if (input.adjustmentBasisPoints === undefined || input.adjustmentBasisPoints === null) {
      throw new RetirementError('An adjusted category needs a percentage')
    }
    if (input.adjustmentBasisPoints < 0) {
      throw new RetirementError('An adjustment cannot be negative')
    }
  }

  await context.client.query(
    `insert into retirement_spending_assumptions
       (household_id, profile_id, category_id, treatment, adjustment_basis_points, last_year,
        reviewed_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (profile_id, category_id) do update
       set treatment = excluded.treatment,
           adjustment_basis_points = excluded.adjustment_basis_points,
           last_year = excluded.last_year,
           reviewed_at = excluded.reviewed_at`,
    [
      context.householdId,
      profileId,
      input.categoryId,
      input.treatment,
      // Cleared whenever the treatment is not `adjusted`, so a stale percentage cannot linger and
      // be picked up if somebody switches the treatment back.
      input.treatment === 'adjusted' ? (input.adjustmentBasisPoints ?? null) : null,
      input.lastYear ?? null,
      input.reviewedAt,
    ],
  )
}
