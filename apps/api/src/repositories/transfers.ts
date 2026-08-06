import { centsToDecimalString, pairKeyFor, proposeTransferPairs } from '@beans/shared'
import type { HouseholdContext } from './household-context.js'

/**
 * Detecting and confirming transfers.
 *
 * Matching itself is a pure function in `@beans/shared` so it can be tested against fixtures without
 * a database — including the mortgage case, where declining to match is the correct answer and the
 * one most likely to be "improved" into a bug (ARCHITECTURE.md §9.1).
 */

export type ProposedTransfer = {
  id: string
  pairKey: string
  amount: string
  fromTransactionId: string
  fromAccountName: string
  fromDate: string
  toTransactionId: string
  toAccountName: string
  toDate: string
}

/**
 * Runs the matcher over recent transactions and records what it finds as `proposed`.
 *
 * Nothing is excluded from cash flow on the strength of a proposal — only confirmation does that.
 * A matcher quietly deciding what counts as income would be worse than no matcher.
 */
export async function detectTransfers(
  context: HouseholdContext,
  withinDays = 120,
): Promise<{ proposed: number }> {
  const rows = await context.client.query<{
    id: string
    account_id: string
    posted_date: string
    amount: Buffer
  }>(
    /*
     * Joined to accounts so a private account cannot be paired by somebody who cannot see it.
     *
     * `transactions` is isolated by household alone, which is right — but a proposal names two
     * transactions, and one of them being from an account another member marked private would
     * disclose both its existence and an amount. The join means account visibility decides what is
     * pairable, without a second copy of that rule living here.
     */
    `select t.id, t.account_id, t.posted_date, t.amount
       from transactions t
       join accounts a on a.id = t.account_id
      where t.status = 'active'
        and t.posted_date >= current_date - ($1::int || ' days')::interval
      order by t.posted_date`,
    [withinDays],
  )

  const existing = await context.client.query<{
    pair_key: string
    from_transaction_id: string
    to_transaction_id: string
    status: string
  }>('select pair_key, from_transaction_id, to_transaction_id, status from transfer_matches')

  // A transaction already in a pair — proposed or confirmed — is not a candidate. Only a rejection
  // frees it, and that is what `rejectedKeys` then prevents from being re-proposed.
  const taken = new Set<string>()
  const rejectedKeys = new Set<string>()

  for (const row of existing.rows) {
    if (row.status === 'rejected') {
      rejectedKeys.add(row.pair_key)
      continue
    }
    taken.add(row.from_transaction_id)
    taken.add(row.to_transaction_id)
  }

  const pairs = proposeTransferPairs(
    rows.rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      postedDate: row.posted_date,
      amountCents: context.cipher.decryptMoney(row.amount),
    })),
    taken,
    rejectedKeys,
  )

  for (const pair of pairs) {
    await context.client.query(
      `insert into transfer_matches
         (household_id, from_transaction_id, to_transaction_id, pair_key, status, confidence)
       values ($1, $2, $3, $4, 'proposed', 90)
       on conflict do nothing`,
      [context.householdId, pair.fromTransactionId, pair.toTransactionId, pair.pairKey],
    )
  }

  return { proposed: pairs.length }
}

export async function listProposedTransfers(
  context: HouseholdContext,
): Promise<ProposedTransfer[]> {
  const result = await context.client.query<{
    id: string
    pair_key: string
    amount: Buffer
    from_transaction_id: string
    from_date: string
    from_name: Buffer | null
    to_transaction_id: string
    to_date: string
    to_name: Buffer | null
  }>(
    `select m.id, m.pair_key,
            tf.amount, tf.id as from_transaction_id, tf.posted_date as from_date,
            coalesce(af.display_name, af.provider_name) as from_name,
            tt.id as to_transaction_id, tt.posted_date as to_date,
            coalesce(at.display_name, at.provider_name) as to_name
       from transfer_matches m
       join transactions tf on tf.id = m.from_transaction_id
       join transactions tt on tt.id = m.to_transaction_id
       join accounts af on af.id = tf.account_id
       join accounts at on at.id = tt.account_id
      where m.status = 'proposed'
      order by tf.posted_date desc`,
  )

  return result.rows.map((row) => ({
    id: row.id,
    pairKey: row.pair_key,
    // The outflow's magnitude, which is what a person calls "the amount" of a transfer.
    amount: centsToDecimalString(-context.cipher.decryptMoney(row.amount)),
    fromTransactionId: row.from_transaction_id,
    fromAccountName: row.from_name === null ? 'Account' : context.cipher.decryptText(row.from_name),
    fromDate: row.from_date,
    toTransactionId: row.to_transaction_id,
    toAccountName: row.to_name === null ? 'Account' : context.cipher.decryptText(row.to_name),
    toDate: row.to_date,
  }))
}

/**
 * Confirms or rejects a proposal.
 *
 * **Rejection keeps the row.** Deleting it would let the matcher propose the same pair after the
 * next sync, and a prompt that reappears no matter how often it is dismissed is a prompt people
 * stop reading.
 */
export async function resolveTransfer(
  context: HouseholdContext,
  matchId: string,
  decision: 'confirmed' | 'rejected',
): Promise<void> {
  /*
   * Both casts are required. Without them Postgres sees `$2` used once as a `transfer_status` and
   * twice compared against a text literal, cannot deduce a single type, and fails the whole
   * statement with 42P08 — "inconsistent types deduced for parameter $2".
   */
  await context.client.query(
    `update transfer_matches
        set status = $2::transfer_status,
            confirmed_by_user_id = case when $2::text = 'confirmed' then $3 else null end,
            confirmed_at = case when $2::text = 'confirmed' then now() else null end
      where id = $1`,
    [matchId, decision, context.userId],
  )
}

/** Transaction ids in a confirmed pair. The client needs these to exclude them from cash flow. */
export async function confirmedPairMembers(context: HouseholdContext): Promise<string[]> {
  const result = await context.client.query<{ id: string }>(
    `select from_transaction_id as id from transfer_matches where status = 'confirmed'
     union all
     select to_transaction_id as id from transfer_matches where status = 'confirmed'`,
  )

  return result.rows.map((row) => row.id)
}
