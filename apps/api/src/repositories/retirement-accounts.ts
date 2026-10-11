import type { BucketAnchor, IsoDate, TaxTreatment } from '@beans/shared'
import type { HouseholdContext } from './household-context.js'
import { RetirementError } from './retirement.js'

/**
 * The per-account retirement overlay: the tax split, where contributions land, and what the
 * employer plan permits.
 *
 * **Every read joins `accounts`, and every write checks it first.** This is not incidental. The
 * private-account rule — `is_shared or owner_user_id = me` — lives on the `accounts` RLS policy
 * (§6.4), and these three tables carry only the household check. A query that filtered by
 * `account_id` alone would hand one member the tax breakdown of an account they cannot even see in
 * the account list, which is precisely the thing `is_shared` exists to prevent.
 *
 * The join is what reaches the rule, because the subquery runs under the caller's own policies. It
 * is the same mechanism `transactions`, `balance_snapshots` and `holdings` already rely on, written
 * down here because an `account_id` index makes the unsafe query the obvious one to write.
 */

/** The dated breakdowns a user has entered for one account, oldest first. */
export type AccountBucketAnchors = {
  accountId: string
  anchors: BucketAnchor[]
}

/**
 * Confirms the account is one this caller may act on, and returns nothing useful if it is not.
 *
 * Selecting through `accounts` rather than trusting the foreign key: the FK proves the account
 * exists, and the `with check` on these tables proves the household matches, but neither says
 * anything about whether *this member* can see it. Only the `accounts` policy knows that.
 */
async function assertAccountVisible(
  context: HouseholdContext,
  accountId: string,
): Promise<void> {
  const result = await context.client.query<{ id: string }>(
    'select id from accounts where id = $1',
    [accountId],
  )

  if (result.rows[0] === undefined) {
    /*
     * One message for "does not exist", "belongs to another household" and "is somebody else's
     * private account". Distinguishing them would confirm the existence of an account the caller is
     * not allowed to know about, and the remedy is the same in all three cases.
     */
    throw new RetirementError('No such account in this household')
  }
}

export async function readAccountTaxBuckets(
  context: HouseholdContext,
): Promise<AccountBucketAnchors[]> {
  const result = await context.client.query<{
    account_id: string
    as_of_date: IsoDate
    treatment: TaxTreatment
    balance: Buffer
  }>(
    `select b.account_id, b.as_of_date, b.treatment, b.balance
       from account_tax_buckets b
       join accounts a on a.id = b.account_id
      order by b.account_id, b.as_of_date, b.treatment`,
  )

  const byAccount = new Map<string, Map<IsoDate, BucketAnchor>>()

  for (const row of result.rows) {
    const dates = byAccount.get(row.account_id) ?? new Map<IsoDate, BucketAnchor>()
    const anchor = dates.get(row.as_of_date) ?? { asOfDate: row.as_of_date, buckets: [] }

    // `buckets` is readonly on the shared type, which is right for consumers and awkward here.
    ;(anchor.buckets as { treatment: TaxTreatment; balanceCents: bigint }[]).push({
      treatment: row.treatment,
      balanceCents: context.cipher.decryptMoney(row.balance),
    })

    dates.set(row.as_of_date, anchor)
    byAccount.set(row.account_id, dates)
  }

  return [...byAccount.entries()].map(([accountId, dates]) => ({
    accountId,
    anchors: [...dates.values()],
  }))
}

export type BucketEntry = {
  treatment: TaxTreatment
  balanceCents: bigint
}

/**
 * Replaces one account's breakdown for one date, as a unit.
 *
 * A whole anchor rather than one bucket at a time, because a partial anchor is a wrong anchor: the
 * carry-forward reads the proportions across every bucket at a date, so a breakdown saved half-way
 * would model a split the user never entered. Delete-then-insert inside the caller's transaction
 * makes the replacement atomic.
 *
 * An empty `buckets` list removes the anchor, which is how a user undoes a breakdown and goes back
 * to the account-level `tax_treatment` fallback.
 */
export async function setAccountTaxBuckets(
  context: HouseholdContext,
  accountId: string,
  asOfDate: IsoDate,
  buckets: readonly BucketEntry[],
): Promise<void> {
  await assertAccountVisible(context, accountId)

  await context.client.query(
    'delete from account_tax_buckets where account_id = $1 and as_of_date = $2',
    [accountId, asOfDate],
  )

  for (const entry of buckets) {
    await context.client.query(
      `insert into account_tax_buckets
         (household_id, account_id, treatment, balance, as_of_date)
       values ($1, $2, $3, $4, $5)`,
      [
        context.householdId,
        accountId,
        entry.treatment,
        context.cipher.encryptMoney(entry.balanceCents),
        asOfDate,
      ],
    )
  }
}

export type ContributionRoute = {
  accountId: string
  treatment: TaxTreatment
  annualCents: bigint
  active: boolean
}

export async function readContributionRouting(
  context: HouseholdContext,
): Promise<ContributionRoute[]> {
  const result = await context.client.query<{
    account_id: string
    treatment: TaxTreatment
    annual_amount: Buffer
    active: boolean
  }>(
    `select r.account_id, r.treatment, r.annual_amount, r.active
       from account_contribution_routing r
       join accounts a on a.id = r.account_id
      order by r.account_id, r.treatment`,
  )

  return result.rows.map((row) => ({
    accountId: row.account_id,
    treatment: row.treatment,
    annualCents: context.cipher.decryptMoney(row.annual_amount),
    active: row.active,
  }))
}

export async function setContributionRoute(
  context: HouseholdContext,
  accountId: string,
  treatment: TaxTreatment,
  annualCents: bigint,
  active = true,
): Promise<void> {
  await assertAccountVisible(context, accountId)

  await context.client.query(
    `insert into account_contribution_routing
       (household_id, account_id, treatment, annual_amount, active)
     values ($1, $2, $3, $4, $5)
     on conflict (account_id, treatment) do update
       set annual_amount = excluded.annual_amount,
           active = excluded.active`,
    [context.householdId, accountId, treatment, context.cipher.encryptMoney(annualCents), active],
  )
}

export async function deleteContributionRoute(
  context: HouseholdContext,
  accountId: string,
  treatment: TaxTreatment,
): Promise<void> {
  await assertAccountVisible(context, accountId)

  await context.client.query(
    'delete from account_contribution_routing where account_id = $1 and treatment = $2',
    [accountId, treatment],
  )
}

/**
 * What an employer plan permits, as the user answered it.
 *
 * Every flag is **nullable and stays nullable**. `null` is "not asked", `false` is "asked, and no",
 * and collapsing them would make an unanswered plan look restrictive and silently suppress a rule
 * that might apply. The phase B gating reads these, and the whole point of gating is that it never
 * tells somebody a strategy is available when their plan does not offer it.
 */
export type PlanFeatures = {
  accountId: string
  allowsAfterTaxContributions: boolean | null
  allowsInPlanRothConversion: boolean | null
  allowsInServiceWithdrawal: boolean | null
  acceptsIraRollIns: boolean | null
  employerMatchDescription: string | null
  answeredAt: Date | null
}

export async function readPlanFeatures(context: HouseholdContext): Promise<PlanFeatures[]> {
  const result = await context.client.query<{
    account_id: string
    allows_after_tax_contributions: boolean | null
    allows_in_plan_roth_conversion: boolean | null
    allows_in_service_withdrawal: boolean | null
    accepts_ira_roll_ins: boolean | null
    employer_match_description: Buffer | null
    answered_at: Date | null
  }>(
    `select f.account_id, f.allows_after_tax_contributions, f.allows_in_plan_roth_conversion,
            f.allows_in_service_withdrawal, f.accepts_ira_roll_ins,
            f.employer_match_description, f.answered_at
       from plan_features f
       join accounts a on a.id = f.account_id
      order by f.account_id`,
  )

  return result.rows.map((row) => ({
    accountId: row.account_id,
    allowsAfterTaxContributions: row.allows_after_tax_contributions,
    allowsInPlanRothConversion: row.allows_in_plan_roth_conversion,
    allowsInServiceWithdrawal: row.allows_in_service_withdrawal,
    acceptsIraRollIns: row.accepts_ira_roll_ins,
    employerMatchDescription:
      row.employer_match_description === null
        ? null
        : context.cipher.decryptText(row.employer_match_description),
    answeredAt: row.answered_at,
  }))
}

export type PlanFeaturesPatch = {
  allowsAfterTaxContributions?: boolean | null | undefined
  allowsInPlanRothConversion?: boolean | null | undefined
  allowsInServiceWithdrawal?: boolean | null | undefined
  acceptsIraRollIns?: boolean | null | undefined
  employerMatchDescription?: string | null | undefined
  /** When these answers were given. Passed in rather than read from the clock, so tests can fix it. */
  answeredAt: Date
}

export async function setPlanFeatures(
  context: HouseholdContext,
  accountId: string,
  patch: PlanFeaturesPatch,
): Promise<void> {
  await assertAccountVisible(context, accountId)

  /*
   * `coalesce` is wrong for a tri-state, so each field carries an explicit "was it mentioned" flag.
   * With `coalesce($n, column)` there would be no way to answer *no* to a question previously
   * answered *yes* — false would be indistinguishable from absent, and the answer would silently
   * fail to save.
   */
  await context.client.query(
    `insert into plan_features
       (household_id, account_id, allows_after_tax_contributions,
        allows_in_plan_roth_conversion, allows_in_service_withdrawal, accepts_ira_roll_ins,
        employer_match_description, answered_at)
     values ($1, $2, $3, $5, $7, $9, $11, $13)
     on conflict (account_id) do update
       set allows_after_tax_contributions = case
             when $4 then $3 else plan_features.allows_after_tax_contributions end,
           allows_in_plan_roth_conversion = case
             when $6 then $5 else plan_features.allows_in_plan_roth_conversion end,
           allows_in_service_withdrawal = case
             when $8 then $7 else plan_features.allows_in_service_withdrawal end,
           accepts_ira_roll_ins = case
             when $10 then $9 else plan_features.accepts_ira_roll_ins end,
           employer_match_description = case
             when $12 then $11 else plan_features.employer_match_description end,
           answered_at = $13`,
    [
      context.householdId,
      accountId,
      patch.allowsAfterTaxContributions ?? null,
      'allowsAfterTaxContributions' in patch,
      patch.allowsInPlanRothConversion ?? null,
      'allowsInPlanRothConversion' in patch,
      patch.allowsInServiceWithdrawal ?? null,
      'allowsInServiceWithdrawal' in patch,
      patch.acceptsIraRollIns ?? null,
      'acceptsIraRollIns' in patch,
      patch.employerMatchDescription === undefined || patch.employerMatchDescription === null
        ? null
        : context.cipher.encryptText(patch.employerMatchDescription),
      'employerMatchDescription' in patch,
      patch.answeredAt,
    ],
  )
}
