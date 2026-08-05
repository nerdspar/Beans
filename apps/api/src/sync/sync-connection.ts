import { toIsoDate, type AccountType } from '@beans/shared'
import { ensureCoverageStart } from '../balance-history/rebuild.js'
import { applySignConvention } from '../simplefin/account-type.js'
import { fetchAccounts, splitIntoWindows, type Fetcher } from '../simplefin/client.js'
import type { SimplefinAccount, SimplefinTransaction } from '../simplefin/protocol.js'
import { isConnectionAttentionError, isRateLimitError } from '../simplefin/protocol.js'
import { loadAccessUrl } from '../repositories/connections.js'
import { markHoldingsChecked, replaceHoldings } from '../repositories/holdings.js'
import type { HouseholdContext } from '../repositories/household-context.js'
import { syncWindowStart } from './quota.js'

/**
 * Pulling transactions and balances for one connection.
 *
 * ## The transaction sign question
 *
 * `provider_sign_inverted` is applied to the **balance only**, never to transaction amounts.
 *
 * The reasoning: the protocol *does* specify a transaction sign — "positive numbers indicate money
 * being deposited into the account" — and institutions generally follow a spec where one exists.
 * It specifies nothing at all about balance signs, which is exactly why balances vary. So the most
 * likely arrangement is transactions that are consistent and balances that are not, and inverting
 * both would corrupt the consistent half.
 *
 * **This is a reasoned default, not a verified one**, and it matters: backward reconstruction
 * computes `balance(T) = current balance − transactions after T`, which is only meaningful if the
 * two are in the same sign space. If some institution turns out to invert transactions as well, the
 * derived history for that account will drift steadily rather than fail loudly.
 *
 * Milestone 4 adds a reconstruction check that would catch exactly that drift. Until then it is
 * recorded in TESTING-BACKLOG.md as something only a real token can settle.
 */

export type SyncOutcome = {
  accountsUpdated: number
  transactionsUpserted: number
  /** Pending transactions that disappeared without posting. */
  transactionsVoided: number
  requestsSpent: number
  errors: string[]
  rateLimited: boolean
  /** Accounts touched this run, so history is rebuilt for exactly those. */
  accountIds: Set<string>
  /** Positions written. Zero is the normal answer for an institution that reports none. */
  holdingsRecorded: number
}

type LinkedAccount = {
  id: string
  simplefinAccountId: string
  providerSignInverted: boolean
  type: AccountType
}

/**
 * Syncs one connection: fetches its window, updates balances, upserts transactions, and reaps
 * pending rows that vanished.
 *
 * The caller is responsible for having checked the request budget first — this spends one request
 * per window and does not consult the quota itself, so that all budgeting lives in one place.
 */
export async function syncConnection(
  context: HouseholdContext,
  connectionId: string,
  fetcher: Fetcher,
  options: { lastSuccessAt: Date | null; now: Date },
): Promise<SyncOutcome> {
  const accessUrl = await loadAccessUrl(context, connectionId)
  const linked = await loadLinkedAccounts(context, connectionId)

  const outcome: SyncOutcome = {
    accountsUpdated: 0,
    transactionsUpserted: 0,
    transactionsVoided: 0,
    requestsSpent: 0,
    errors: [],
    rateLimited: false,
    accountIds: new Set<string>(),
    holdingsRecorded: 0,
  }

  if (linked.size === 0) {
    // Nothing has been confirmed yet, so there is nowhere to put anything. Spending a request here
    // would be pure waste against a budget of 24 a day.
    return outcome
  }

  const windowStart = syncWindowStart(options.lastSuccessAt, options.now)
  const windows = splitIntoWindows(windowStart, options.now)

  // Every provider transaction id seen this run, per account — the basis for reaping vanished
  // pending rows below.
  const seenByAccount = new Map<string, Set<string>>()

  for (const window of windows) {
    const response = await fetchAccounts(accessUrl, fetcher, {
      startDate: window.startDate,
      endDate: window.endDate,
      // Pending transactions are not returned unless asked for.
      includePending: true,
    })
    outcome.requestsSpent += 1

    for (const error of response.errors) {
      if (!outcome.errors.includes(error)) {
        outcome.errors.push(error)
      }
    }

    if (isRateLimitError(response.errors)) {
      // Stop immediately rather than working through remaining windows. Continuing would spend
      // more of a budget the provider has already said is exhausted.
      outcome.rateLimited = true
      break
    }

    for (const providerAccount of response.accounts) {
      const account = linked.get(providerAccount.id)
      if (account === undefined) {
        // An account discovered at the institution but never confirmed. Ignored deliberately —
        // adopting it silently would bypass the type and sign confirmation entirely.
        continue
      }

      await updateBalance(context, account, providerAccount, options.now)
      outcome.accountsUpdated += 1

      /*
       * Positions, dated to the same day as the balance they belong to.
       *
       * `balance-date` rather than now, so a holding sits on the day the provider says it was
       * true — the same day its account's balance lands on. Dating it to the sync instant would
       * put a settled Monday position on Tuesday and make a day's move unmeasurable.
       *
       * Only written when the provider actually sent positions. An empty array here is the normal
       * answer from most institutions, and replacing a real set with nothing on the strength of a
       * silent response would delete a portfolio.
       */
      if (providerAccount.holdings.length > 0) {
        outcome.holdingsRecorded += await replaceHoldings(
          context,
          account.id,
          toIsoDate(providerAccount.balanceDate ?? options.now),
          providerAccount.holdings,
        )
      }

      /*
       * Recorded whether or not any arrived — that is what makes it worth having.
       *
       * An account with no holdings rows is otherwise ambiguous between "this institution reports
       * no positions" and "nothing has synced since holdings existed", and the holdings table
       * cannot settle it: writing nothing is precisely the correct behaviour for an empty response.
       */
      await markHoldingsChecked(context, account.id, options.now)

      /**
       * Set once, on the first window that produces data, and never moved afterwards.
       *
       * Investment accounts start at the day they were connected rather than the window start:
       * their value moves with the market, so nothing before the connection is knowable however far
       * back the transaction window reaches.
       */
      await ensureCoverageStart(
        context,
        account.id,
        account.type === 'investment' ? toIsoDate(options.now) : toIsoDate(window.startDate),
      )
      outcome.accountIds.add(account.id)

      const seen = seenByAccount.get(account.id) ?? new Set<string>()
      seenByAccount.set(account.id, seen)

      for (const transaction of providerAccount.transactions) {
        seen.add(transaction.id)
        await upsertTransaction(context, account, transaction)
        outcome.transactionsUpserted += 1
      }
    }
  }

  // Only reap when the whole range was fetched. A run cut short by rate limiting has an incomplete
  // picture, and voiding rows on that basis would delete real data.
  if (!outcome.rateLimited && windows.length > 0) {
    outcome.transactionsVoided = await voidVanishedPending(
      context,
      seenByAccount,
      windowStart,
      options.now,
    )
  }

  return outcome
}

async function loadLinkedAccounts(
  context: HouseholdContext,
  connectionId: string,
): Promise<Map<string, LinkedAccount>> {
  const result = await context.client.query<{
    id: string
    simplefin_account_id: string
    provider_sign_inverted: boolean
    type: AccountType
  }>(
    `select id, simplefin_account_id, provider_sign_inverted, type
       from accounts
      where connection_id = $1
        and simplefin_account_id is not null
        and confirmed_at is not null`,
    [connectionId],
  )

  return new Map(
    result.rows.map((row) => [
      row.simplefin_account_id,
      {
        id: row.id,
        simplefinAccountId: row.simplefin_account_id,
        providerSignInverted: row.provider_sign_inverted,
        type: row.type,
      },
    ]),
  )
}

async function updateBalance(
  context: HouseholdContext,
  account: LinkedAccount,
  providerAccount: SimplefinAccount,
  now: Date,
): Promise<void> {
  const balance = applySignConvention(providerAccount.balanceCents, account.providerSignInverted)

  // available_balance is deliberately not sign-corrected: for a credit card it carries available
  // credit rather than a cash balance, it is shown only on account detail, and it feeds no total.
  await context.client.query(
    `update accounts
        set current_balance = $1,
            available_balance = $2,
            balance_as_of = $3,
            provider_name = $4
      where id = $5`,
    [
      context.cipher.encryptMoney(balance),
      context.cipher.encryptMoneyOrNull(providerAccount.availableBalanceCents),
      providerAccount.balanceDate ?? now,
      // provider_name tracks the institution freely. display_name is never touched here — sync
      // must not overwrite a name the user set.
      context.cipher.encryptText(providerAccount.name),
      account.id,
    ],
  )
}

/**
 * Upserts one transaction, keyed on the provider id.
 *
 * Amounts, descriptions and pending status all change after a transaction first appears, so this
 * updates in place rather than inserting — the row's identity has to stay stable or every amendment
 * would look like a new transaction and double-count.
 *
 * `category_id` is deliberately absent from the update: a user's categorization must survive an
 * amended description.
 */
async function upsertTransaction(
  context: HouseholdContext,
  account: LinkedAccount,
  transaction: SimplefinTransaction,
): Promise<void> {
  // Date only — a transaction posted on the 3rd is on the 3rd regardless of anyone's timezone.
  const postedDate = transaction.date.toISOString().slice(0, 10)

  await context.client.query(
    `insert into transactions (
       household_id, account_id, simplefin_id, posted_date, amount,
       description, payee, memo, pending, status, source
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active','synced')
     on conflict (account_id, simplefin_id) where simplefin_id is not null
     do update set
       posted_date = excluded.posted_date,
       amount = excluded.amount,
       description = excluded.description,
       payee = excluded.payee,
       memo = excluded.memo,
       pending = excluded.pending,
       -- A row that had been voided and then reappears is genuinely active again.
       status = 'active'`,
    [
      context.householdId,
      account.id,
      transaction.id,
      postedDate,
      context.cipher.encryptMoney(transaction.amountCents),
      context.cipher.encryptText(transaction.description),
      context.cipher.encryptTextOrNull(transaction.payee),
      context.cipher.encryptTextOrNull(transaction.memo),
      transaction.pending,
    ],
  )
}

/**
 * Voids pending transactions that disappeared without ever posting.
 *
 * A documented SimpleFIN failure mode: a pending transaction that never posts simply **vanishes
 * from the response with no tombstone**. Left alone it strands in the ledger forever and corrupts
 * every balance derived from it.
 *
 * Voided rather than deleted, so delta sync carries the change to clients instead of leaving them
 * holding a row the server no longer has.
 *
 * Scoped to pending rows inside the fetched window only. A pending row outside the window was not
 * looked for, so its absence says nothing.
 */
async function voidVanishedPending(
  context: HouseholdContext,
  seenByAccount: Map<string, Set<string>>,
  windowStart: Date,
  windowEnd: Date,
): Promise<number> {
  let voided = 0

  for (const [accountId, seen] of seenByAccount) {
    const result = await context.client.query(
      `update transactions
          set status = 'void'
        where account_id = $1
          and pending = true
          and status = 'active'
          and source = 'synced'
          and posted_date between $2 and $3
          and not (simplefin_id = any($4::text[]))`,
      [
        accountId,
        windowStart.toISOString().slice(0, 10),
        windowEnd.toISOString().slice(0, 10),
        [...seen],
      ],
    )
    voided += result.rowCount ?? 0
  }

  return voided
}

/**
 * Derives connection health from a sync outcome.
 *
 * Silent staleness is this app's worst failure, so anything the provider complains about becomes
 * visible rather than being averaged away into a green light.
 */
export function connectionStatusFor(outcome: SyncOutcome): 'healthy' | 'stale' | 'error' {
  if (outcome.errors.some(isConnectionAttentionError)) {
    // The request succeeded, but an institution behind it is broken and its balances are stale.
    return 'error'
  }
  if (outcome.rateLimited) {
    return 'stale'
  }
  return 'healthy'
}
