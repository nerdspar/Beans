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
  /** Null means nobody has said whether this is an employer plan or an IRA. Blocks the pro-rata rule. */
  isEmployerPlan: boolean | null
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
    is_employer_plan: boolean | null
    allows_after_tax_contributions: boolean | null
    allows_in_plan_roth_conversion: boolean | null
    allows_in_service_withdrawal: boolean | null
    accepts_ira_roll_ins: boolean | null
    employer_match_description: Buffer | null
    answered_at: Date | null
  }>(
    `select f.account_id, f.is_employer_plan, f.allows_after_tax_contributions,
            f.allows_in_plan_roth_conversion,
            f.allows_in_service_withdrawal, f.accepts_ira_roll_ins,
            f.employer_match_description, f.answered_at
       from plan_features f
       join accounts a on a.id = f.account_id
      order by f.account_id`,
  )

  return result.rows.map((row) => ({
    accountId: row.account_id,
    isEmployerPlan: row.is_employer_plan,
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
  isEmployerPlan?: boolean | null | undefined
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
        employer_match_description, answered_at, is_employer_plan)
     values ($1, $2, $3, $5, $7, $9, $11, $13, $14)
     on conflict (account_id) do update
       set allows_after_tax_contributions = case
             when $4 then $3 else plan_features.allows_after_tax_contributions end,
           is_employer_plan = case
             when $15 then $14 else plan_features.is_employer_plan end,
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
      patch.isEmployerPlan ?? null,
      'isEmployerPlan' in patch,
    ],
  )
}

/**
 * The accounts whose balances the projection may draw on, as the engine needs them.
 *
 * Selected straight from `accounts`, so the policy applies without a join — including the
 * private-account clause. Unconfirmed accounts are excluded for the same reason every rollup
 * excludes them: a provider's sign has not been checked by a human yet (§3.3), and a flipped credit
 * balance in a retirement projection is wrong by twice the number in a plausible direction.
 *
 * Closed accounts are excluded too. A closed account's balance is zero or historical, and carrying
 * it would put money in the opening portfolio that nobody can spend.
 */
export async function readDrawableAccounts(
  context: HouseholdContext,
): Promise<
  {
    id: string
    name: string
    type: string
    taxTreatment: TaxTreatment
    balanceCents: bigint | null
  }[]
> {
  const result = await context.client.query<{
    id: string
    display_name: Buffer | null
    provider_name: Buffer | null
    type: string
    tax_treatment: TaxTreatment
    current_balance: Buffer | null
  }>(
    `select id, display_name, provider_name, type, tax_treatment, current_balance
       from accounts
      where confirmed_at is not null
        and not is_closed
      order by created_at, id`,
  )

  return result.rows.map((row) => ({
    id: row.id,
    /*
     * The name, decrypted here at the repository boundary.
     *
     * Added because the opportunities screen rendered a raw UUID at somebody — "still to answer:
     * a1106ea9-…" is not a question anybody can act on. The user's own name wins over the
     * provider's, matching every other account list.
     */
    name:
      (row.display_name === null ? null : context.cipher.decryptText(row.display_name)) ??
      (row.provider_name === null ? null : context.cipher.decryptText(row.provider_name)) ??
      'Account',
    type: row.type,
    taxTreatment: row.tax_treatment,
    balanceCents:
      row.current_balance === null ? null : context.cipher.decryptMoney(row.current_balance),
  }))
}

/**
 * Transactions in a window, for building the retirement spending baseline.
 *
 * **Joins `accounts`, which is what settles a privacy question rather than a technical one.** A
 * private account's spending is outside the household baseline, exactly as it is outside every
 * other rollup (§6.4). The consequence is deliberate and worth stating plainly: two members of one
 * household see *different* retirement projections, because the owner's baseline includes spending
 * the other member cannot see.
 *
 * The alternative considered was summing every household account into the total while hiding the
 * per-category breakdown. That keeps one coherent plan, but it leaks an aggregate — subtract the
 * visible categories from the total and you have inferred roughly what is being spent on the hidden
 * account. A privacy rule that can be defeated with arithmetic is not one.
 *
 * Amounts come back signed, as stored. Transfers and voided rows are **not** filtered here: that
 * judgement lives in `isExcludedFromCashFlow`, which also needs the confirmed-pair set, and
 * duplicating it in SQL is how the two come to disagree.
 */
export async function readSpendingWindow(
  context: HouseholdContext,
  from: IsoDate,
  to: IsoDate,
): Promise<
  {
    id: string
    postedDate: IsoDate
    amountCents: bigint
    categoryId: string | null
    categoryKind: 'income' | 'expense' | 'transfer' | undefined
    status: 'active' | 'void'
  }[]
> {
  const result = await context.client.query<{
    id: string
    posted_date: IsoDate
    amount: Buffer
    category_id: string | null
    category_kind: 'income' | 'expense' | 'transfer' | null
    status: 'active' | 'void'
  }>(
    `select t.id, t.posted_date, t.amount, t.category_id, c.kind as category_kind, t.status
       from transactions t
       join accounts a on a.id = t.account_id
       left join categories c on c.id = t.category_id
      where t.posted_date >= $1 and t.posted_date <= $2
      order by t.posted_date, t.id`,
    [from, to],
  )

  return result.rows.map((row) => ({
    id: row.id,
    postedDate: row.posted_date,
    amountCents: context.cipher.decryptMoney(row.amount),
    categoryId: row.category_id,
    categoryKind: row.category_kind ?? undefined,
    status: row.status,
  }))
}
