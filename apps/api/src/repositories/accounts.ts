import {
  applySignConvention,
  centsToDecimalString,
  defaultTaxTreatment,
  toIsoDate,
  type AccountType,
  type IsoDate,
  type TaxTreatment,
} from '@beans/shared'
import { rebuildAccountHistory } from '../balance-history/rebuild.js'
import type { HouseholdContext } from './household-context.js'

/**
 * Managing accounts directly, rather than through the connection that created them.
 *
 * Everything here was reachable only by re-confirming a whole connection, which is the wrong shape
 * for renaming one account — and impossible for a manual account, which has no connection at all.
 */

export class AccountError extends Error {
  override readonly name = 'AccountError'
}

export type ManagedAccount = {
  id: string
  connectionId: string | null
  institutionName: string | null
  name: string
  providerName: string | null
  mask: string | null
  type: AccountType
  taxTreatment: string
  balance: string | null
  isManual: boolean
  isClosed: boolean
  closedOn: IsoDate | null
  signInverted: boolean
  /** What deletion would take with it. Shown before confirming, so the stake is a number. */
  transactionCount: number
}

/** Every account the household can edit, closed ones included — hiding them hides how to reopen. */
export async function listManagedAccounts(context: HouseholdContext): Promise<ManagedAccount[]> {
  const result = await context.client.query<{
    id: string
    connection_id: string | null
    institution_name: Buffer | null
    display_name: Buffer | null
    provider_name: Buffer | null
    mask: Buffer | null
    type: AccountType
    tax_treatment: string
    current_balance: Buffer | null
    is_manual: boolean
    is_closed: boolean
    closed_on: IsoDate | null
    provider_sign_inverted: boolean
    transaction_count: string
  }>(
    `select a.id, a.connection_id, i.name as institution_name, a.display_name, a.provider_name,
            a.mask, a.type, a.tax_treatment, a.current_balance, a.is_manual, a.is_closed,
            a.closed_on,
            a.provider_sign_inverted,
            (select count(*) from transactions t where t.account_id = a.id) as transaction_count
       from accounts a
       left join institutions i on i.id = a.institution_id
      where a.confirmed_at is not null
      order by a.created_at, a.id`,
  )

  return result.rows.map((row) => ({
    id: row.id,
    connectionId: row.connection_id,
    institutionName:
      row.institution_name === null ? null : context.cipher.decryptText(row.institution_name),
    name:
      (row.display_name === null ? null : context.cipher.decryptText(row.display_name)) ??
      (row.provider_name === null ? null : context.cipher.decryptText(row.provider_name)) ??
      'Account',
    providerName:
      row.provider_name === null ? null : context.cipher.decryptText(row.provider_name),
    mask: row.mask === null ? null : context.cipher.decryptText(row.mask),
    type: row.type,
    taxTreatment: row.tax_treatment,
    balance:
      row.current_balance === null
        ? null
        : centsToDecimalString(context.cipher.decryptMoney(row.current_balance)),
    isManual: row.is_manual,
    isClosed: row.is_closed,
    closedOn: row.closed_on,
    signInverted: row.provider_sign_inverted,
    transactionCount: Number(row.transaction_count),
  }))
}

export type AccountPatch = {
  displayName?: string | undefined
  type?: AccountType | undefined
  taxTreatment?: TaxTreatment | undefined
  isClosed?: boolean | undefined
  /** Only consulted when closing. Defaults to today, and is cleared when reopening. */
  closedOn?: IsoDate | undefined
  signInverted?: boolean | undefined
}

/**
 * Applies an edit, rebuilding history when the change affects what the balances mean.
 *
 * **A sign change rewrites history, a rename does not.** Flipping the sign negates the stored
 * balance — `provider_sign_inverted` applies to the balance only, never to transaction amounts
 * (see `sync-connection.ts`) — and every derived snapshot was computed from that balance, so
 * leaving them would keep the whole series on the wrong side of zero while the headline figure
 * moved. Renaming touches nothing numeric and triggers nothing.
 */
export async function updateAccount(
  context: HouseholdContext,
  accountId: string,
  patch: AccountPatch,
  today = toIsoDate(new Date()),
): Promise<{ rebuilt: boolean }> {
  const existing = await context.client.query<{
    current_balance: Buffer | null
    provider_sign_inverted: boolean
  }>('select current_balance, provider_sign_inverted from accounts where id = $1', [accountId])

  const row = existing.rows[0]
  if (row === undefined) {
    // RLS is already scoped, so an empty result means it does not exist rather than being hidden.
    throw new AccountError('No such account')
  }

  const signChanged =
    patch.signInverted !== undefined && patch.signInverted !== row.provider_sign_inverted

  /*
   * Negated rather than recomputed from the provider's figure, because the provider's figure is not
   * stored — only our reading of it is. Negating is exactly the inverse of `applySignConvention`,
   * which is what makes that safe.
   */
  const balance =
    signChanged && row.current_balance !== null
      ? context.cipher.encryptMoney(
          applySignConvention(context.cipher.decryptMoney(row.current_balance), true),
        )
      : null

  await context.client.query(
    `update accounts
        set display_name = coalesce($2, display_name),
            type = coalesce($3, type),
            type_is_user_set = case when $3::text is null then type_is_user_set else true end,
            tax_treatment = coalesce($4, tax_treatment),
            is_closed = coalesce($5, is_closed),
            -- Kept in lockstep with is_closed, never set independently: two columns describing
            -- one fact is how they end up disagreeing. Closing without naming a date means today,
            -- and reopening clears it.
            closed_on = case
              when $8::boolean is null then closed_on
              when $8::boolean then coalesce($9::date, closed_on, $10::date)
              else null
            end,
            provider_sign_inverted = coalesce($6, provider_sign_inverted),
            current_balance = coalesce($7, current_balance)
      where id = $1`,
    [
      accountId,
      patch.displayName === undefined ? null : context.cipher.encryptText(patch.displayName),
      patch.type ?? null,
      patch.taxTreatment ?? null,
      patch.isClosed ?? null,
      patch.signInverted ?? null,
      balance,
      patch.isClosed ?? null,
      patch.closedOn ?? null,
      today,
    ],
  )

  /*
   * Closing rewrites history as surely as a sign change does: the series has to stop at the close
   * date and contribute zero afterwards, and reopening has to undo that. Neither is visible until
   * the snapshots are rebuilt.
   */
  const closureChanged = patch.isClosed !== undefined
  const rebuilt = signChanged || closureChanged

  if (rebuilt) {
    await rebuildAccountHistory(context, accountId, today)
  }

  return { rebuilt }
}

export type ManualAccountInput = {
  name: string
  institutionName: string
  type: AccountType
  /** Signed as it should be stored — the caller has already decided asset or liability. */
  balanceCents: bigint
  effectiveDate: string
  taxTreatment?: TaxTreatment | undefined
  /**
   * Set when the account no longer exists — a closed card, or one the provider no longer lists.
   *
   * Such an account is created **not manual**, which reads oddly until you see what `is_manual`
   * selects: a series built only from entered balances, with transactions ignored entirely. That is
   * right for a house and wrong for a closed current account, whose imported transactions
   * reconstruct its history exactly, backwards from the closing balance.
   */
  closedOn?: string | undefined
}

/**
 * Creates a manual account and its first balance.
 *
 * `confirmed_at` is set immediately. The confirmation gate exists to make a human check a *provider's*
 * sign before it counts (§3.3); a figure the user typed has already had that attention, and leaving
 * it unconfirmed would hide it from every rollup with nothing to resolve it.
 */
export async function createManualAccount(
  context: HouseholdContext,
  input: ManualAccountInput,
): Promise<{ accountId: string }> {
  const institution = await context.client.query<{ id: string }>(
    `insert into institutions (household_id, simplefin_org_domain, name)
     values ($1, $2, $3)
     on conflict (household_id, simplefin_org_domain) do update set name = excluded.name
     returning id`,
    [
      context.householdId,
      // Manual institutions have no provider domain, so one is synthesized from the name. Keyed
      // this way, two manual accounts at the same institution share a row rather than duplicating.
      `manual:${input.institutionName.trim().toLowerCase()}`,
      context.cipher.encryptText(input.institutionName.trim()),
    ],
  )

  const isClosed = input.closedOn !== undefined

  const account = await context.client.query<{ id: string }>(
    `insert into accounts (
       household_id, institution_id, type, type_is_user_set, display_name, currency,
       current_balance, balance_as_of, is_manual, tax_treatment, coverage_start_date, confirmed_at,
       is_closed, closed_on
     ) values ($1,$2,$3,true,$4,'USD',$5,
               coalesce($8::date::timestamptz, now()), $9, $6, $7, now(),
               $8::date is not null, $8::date)
     returning id`,
    [
      context.householdId,
      institution.rows[0]?.id,
      input.type,
      context.cipher.encryptText(input.name.trim()),
      context.cipher.encryptMoney(input.balanceCents),
      input.taxTreatment ?? defaultTaxTreatment(input.type),
      /*
       * Coverage starts the day the value was true, not today. A house valued as of January has
       * history from January, and drawing it from today would discard what the user just said.
       *
       * A closed account starts with none: how far back its history reaches is decided by the
       * transactions about to be imported into it, and committing an import fills this in from the
       * earliest one. Guessing the close date here would collapse the whole series to a point.
       */
      isClosed ? null : input.effectiveDate,
      input.closedOn ?? null,
      !isClosed,
    ],
  )

  const accountId = account.rows[0]?.id
  if (accountId === undefined) throw new AccountError('Could not create the account')

  /*
   * Only a manual account gets a manual balance. `manual_balance_updates` feeds the series built
   * for `is_manual` accounts alone, so writing one for a closed account would record a figure
   * nothing ever reads while implying it is maintained by hand.
   */
  if (!isClosed) {
    await recordManualBalance(context, accountId, input.effectiveDate, input.balanceCents)
  }

  return { accountId }
}

/**
 * Records a manual balance and rebuilds from it.
 *
 * Each entry becomes an `observed` snapshot held flat until the next one — a step function, not an
 * interpolation. Nobody knows what a house was worth between two valuations, and drawing a smooth
 * line between them would invent the months in between.
 */
export async function recordManualBalance(
  context: HouseholdContext,
  accountId: string,
  effectiveDate: string,
  balanceCents: bigint,
  today = toIsoDate(new Date()),
): Promise<void> {
  await context.client.query(
    `insert into manual_balance_updates (household_id, account_id, effective_date, balance)
     values ($1, $2, $3, $4)
     on conflict (account_id, effective_date) do update set balance = excluded.balance`,
    [context.householdId, accountId, effectiveDate, context.cipher.encryptMoney(balanceCents)],
  )

  /*
   * Coverage always extends, whether or not this is the newest entry.
   *
   * This used to be folded into the update below, behind its "only if newest" guard — so a
   * backdated valuation wrote its row and then moved nothing. The series is built from
   * `coverage_start_date` forward, so the entry was invisible: the only way to give a manual asset
   * earlier history silently did nothing. `least` ignores nulls, so a first entry sets it.
   */
  await context.client.query(
    `update accounts
        set coverage_start_date = least(coverage_start_date, $2::date)
      where id = $1`,
    [accountId, effectiveDate],
  )

  /*
   * The account's headline balance follows only when this entry is the most recent one. Backdating
   * a correction for last March must not overwrite what the account is worth today.
   */
  await context.client.query(
    `update accounts
        set current_balance = $2, balance_as_of = now()
      where id = $1
        and not exists (
          select 1 from manual_balance_updates m
           where m.account_id = $1 and m.effective_date > $3::date
        )`,
    [accountId, context.cipher.encryptMoney(balanceCents), effectiveDate],
  )

  await rebuildAccountHistory(context, accountId, today)
}

/**
 * Removes an account and everything derived from it.
 *
 * **Closing is almost always the better answer**, and the UI offers it first: a closed account keeps
 * its transactions and its history while leaving net worth alone, so last year's spending still adds
 * up. Deleting is for something added by mistake, where the history is not real to begin with.
 *
 * The tombstone is the load-bearing part. Foreign keys cascade the transactions and snapshots away
 * server-side, but every client holds its own copy in IndexedDB and learns about removals only from
 * the `deletions` log — without a row here the account would sit in the working set of every device
 * the household has ever signed in from, permanently, with nothing able to remove it (§7.3).
 *
 * One tombstone for the account, not thousands for its rows: clients cascade on their side, which is
 * why {@link applyDelta} deletes an account's balances and transactions by index.
 */
export async function deleteAccount(
  context: HouseholdContext,
  accountId: string,
): Promise<{ transactionsDeleted: number }> {
  const counted = await context.client.query<{ count: string }>(
    'select count(*) as count from transactions where account_id = $1',
    [accountId],
  )

  const deleted = await context.client.query(
    'delete from accounts where id = $1 returning id',
    [accountId],
  )

  if (deleted.rowCount === 0) {
    throw new AccountError('No such account')
  }

  await context.client.query(
    `insert into deletions (household_id, entity_type, entity_id) values ($1, 'account', $2)`,
    [context.householdId, accountId],
  )

  return { transactionsDeleted: Number(counted.rows[0]?.count ?? 0) }
}
