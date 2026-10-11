import type { RecurringDecision, WorkingSetRecurringDecision } from '@beans/shared'
import type { HouseholdContext } from './household-context.js'

/**
 * What the household has said about recurring series (ARCHITECTURE.md §20).
 *
 * Detection is a pure function the browser runs over the working set; nothing about a series is
 * stored here except a person's override of it. The merchant key is encrypted, so it cannot be a
 * unique constraint or a `where` clause — rows are decrypted and matched in application code, which
 * at a few dozen rows per household costs nothing.
 *
 * **Every read inner-joins `accounts`.** That join is what keeps a decision about a charge on a
 * private account away from the household members who cannot see that account (§6.4).
 */

export class RecurringAccountNotFoundError extends Error {
  override readonly name = 'RecurringAccountNotFoundError'
}

type DecisionRow = {
  id: string
  merchant_key: Buffer
  decision: RecurringDecision
}

export async function listRecurringDecisions(
  context: HouseholdContext,
): Promise<WorkingSetRecurringDecision[]> {
  const result = await context.client.query<DecisionRow>(
    `select d.id, d.merchant_key, d.decision
       from recurring_decisions d
       join accounts a on a.id = d.account_id
      order by d.updated_at, d.id`,
  )

  return result.rows.map((row) => ({
    id: row.id,
    merchantKey: context.cipher.decryptText(row.merchant_key),
    decision: row.decision,
  }))
}

/**
 * Records a decision, replacing any earlier one for the same series.
 *
 * Writes are serialized per household with a transaction-scoped advisory lock. Without a unique
 * constraint to lean on, two saves of the same series racing would both find nothing and both
 * insert; the lock makes the second one find the first.
 */
export async function setRecurringDecision(
  context: HouseholdContext,
  input: { merchantKey: string; decision: RecurringDecision; accountId: string },
): Promise<{ id: string }> {
  await context.client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `recurring_decisions:${context.householdId}`,
  ])

  // An account this person cannot see is reported as missing, not as forbidden — the same answer
  // RLS gives, so the response does not confirm that a private account exists.
  const account = await context.client.query('select 1 from accounts where id = $1', [
    input.accountId,
  ])
  if (account.rowCount === 0) {
    throw new RecurringAccountNotFoundError('Account not found')
  }

  const existing = await listRecurringDecisions(context)
  const match = existing.find((row) => row.merchantKey === input.merchantKey)

  if (match !== undefined) {
    await context.client.query(
      `update recurring_decisions
          set decision = $2::recurring_decision, account_id = $3, decided_by_user_id = $4
        where id = $1`,
      [match.id, input.decision, input.accountId, context.userId],
    )
    return { id: match.id }
  }

  const inserted = await context.client.query<{ id: string }>(
    `insert into recurring_decisions
       (household_id, merchant_key, decision, account_id, decided_by_user_id)
     values ($1, $2, $3::recurring_decision, $4, $5)
     returning id`,
    [
      context.householdId,
      context.cipher.encryptText(input.merchantKey),
      input.decision,
      input.accountId,
      context.userId,
    ],
  )

  const id = inserted.rows[0]?.id
  if (id === undefined) throw new Error('Insert returned no row')
  return { id }
}

/**
 * Removes a decision, returning the series to whatever the detector concludes.
 *
 * Limited to decisions on visible accounts, so nobody can clear an override they cannot see.
 */
export async function clearRecurringDecision(
  context: HouseholdContext,
  id: string,
): Promise<boolean> {
  const result = await context.client.query(
    `delete from recurring_decisions d
      using accounts a
      where a.id = d.account_id and d.id = $1`,
    [id],
  )
  return (result.rowCount ?? 0) > 0
}
