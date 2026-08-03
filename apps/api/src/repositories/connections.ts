import {
  checkBalanceSign,
  defaultTaxTreatment,
  type AccountType,
  type SignAnomaly,
  type TaxTreatment,
} from '@beans/shared'
import {
  applySignConvention,
  guessAccountType,
  suggestSignInversion,
  type TypeGuess,
} from '../simplefin/account-type.js'
import { claimSetupToken, fetchAccounts, type Fetcher } from '../simplefin/client.js'
import type { HouseholdContext } from './household-context.js'

/**
 * SimpleFIN connections, account discovery, and confirmation.
 *
 * **Discovery never writes accounts.** It fetches, interprets, and returns a proposal; nothing
 * touches `accounts` until a human confirms. That is not caution for its own sake — the protocol
 * gives us neither an account type nor a reliable balance sign, so confirmation is the only place
 * those two facts can be established at all (ARCHITECTURE.md §3.3).
 */

export class ConnectionError extends Error {
  override readonly name = 'ConnectionError'
}

/**
 * Claims a setup token and stores the resulting access URL, encrypted.
 *
 * The claim is **single-use**, so this is deliberately not retryable: the connection row is written
 * in the same transaction as the successful claim, and a failure leaves nothing behind to confuse a
 * second attempt with a fresh token.
 */
export async function createConnection(
  context: HouseholdContext,
  setupToken: string,
  fetcher: Fetcher,
): Promise<{ connectionId: string }> {
  // Claim first. If this fails there is nothing to roll back, and burning the token on a request
  // whose result we then fail to store would be the worst outcome.
  const accessUrl = await claimSetupToken(setupToken, fetcher)

  const result = await context.client.query<{ id: string }>(
    `insert into connections (household_id, owner_user_id, access_url, status)
     values ($1, $2, $3, 'healthy')
     returning id`,
    [context.householdId, context.userId, context.cipher.encryptText(accessUrl)],
  )

  const row = result.rows[0]
  if (row === undefined) {
    throw new ConnectionError('Failed to store the connection')
  }

  return { connectionId: row.id }
}

export type DiscoveredAccount = {
  simplefinAccountId: string
  /** What the provider calls it. */
  providerName: string
  institutionName: string | null
  institutionDomain: string | null
  currency: string | null

  /** Exactly what the provider sent, before any interpretation. Shown beside our reading of it. */
  providerBalanceCents: bigint

  typeGuess: TypeGuess
  /** Null when we decline to guess — a low-confidence type, or a zero balance. */
  suggestedSignInverted: boolean | null

  /** The balance as we would store it if the suggestions above were accepted. */
  interpretedBalanceCents: bigint
  /** Set when the interpreted sign is implausible for the guessed type. */
  anomaly: SignAnomaly | null

  /** True when this provider account already maps to one of ours — a reconnect, not a discovery. */
  alreadyLinked: boolean

  /**
   * What is stored for this account today, when it is already linked.
   *
   * Without it, revisiting a connection re-proposed the *guess* over answers the user had already
   * given — silently reverting a corrected type on the way to fixing a sign. `type_is_user_set`
   * exists so sync can never do that, and this closes the one path that still could.
   */
  current: { type: AccountType; signInverted: boolean } | null
}

export type DiscoveryResult = {
  accounts: DiscoveredAccount[]
  /** Provider errors, surfaced rather than swallowed. */
  errors: string[]
}

/**
 * Fetches the accounts behind a connection and interprets them, without committing anything.
 *
 * Uses `balances-only`, which costs the same single request but skips the transaction payload —
 * there is nowhere to put transactions until accounts exist, so fetching them here would be work
 * thrown away.
 */
export async function discoverAccounts(
  context: HouseholdContext,
  connectionId: string,
  fetcher: Fetcher,
): Promise<DiscoveryResult> {
  const accessUrl = await loadAccessUrl(context, connectionId)

  const response = await fetchAccounts(accessUrl, fetcher, { balancesOnly: true })

  const linked = await context.client.query<{
    simplefin_account_id: string
    type: AccountType
    provider_sign_inverted: boolean
  }>(
    `select simplefin_account_id, type, provider_sign_inverted from accounts
      where connection_id = $1 and simplefin_account_id is not null`,
    [connectionId],
  )

  const linkedById = new Map(
    linked.rows.map((row) => [
      row.simplefin_account_id,
      { type: row.type, signInverted: row.provider_sign_inverted },
    ]),
  )

  const accounts = response.accounts.map((account): DiscoveredAccount => {
    const typeGuess = guessAccountType(account.name, account.org.name)
    const suggested = suggestSignInversion(typeGuess, account.balanceCents)
    const interpreted = applySignConvention(account.balanceCents, suggested ?? false)

    return {
      simplefinAccountId: account.id,
      providerName: account.name,
      institutionName: account.org.name,
      institutionDomain: account.org.domain,
      currency: account.currency,
      providerBalanceCents: account.balanceCents,
      typeGuess,
      suggestedSignInverted: suggested,
      interpretedBalanceCents: interpreted,
      anomaly: checkBalanceSign(typeGuess.type, interpreted),
      alreadyLinked: linkedById.has(account.id),
      current: linkedById.get(account.id) ?? null,
    }
  })

  return { accounts, errors: response.errors }
}

export type AccountConfirmation = {
  simplefinAccountId: string
  /** The user's answer, not ours. Stored with `type_is_user_set` so sync never overwrites it. */
  type: AccountType
  signInverted: boolean
  /**
   * Optional rename. Institution names are frequently unreadable.
   *
   * Explicitly `| undefined` rather than merely optional: under `exactOptionalPropertyTypes` an
   * absent property and one set to `undefined` are different types, and a parsed request body
   * produces the latter.
   */
  displayName?: string | undefined
  taxTreatment?: TaxTreatment | undefined
  /** False leaves the account undiscovered — not every account at an institution is wanted. */
  include: boolean
}

/**
 * Commits confirmed accounts.
 *
 * Everything here is the user's decision rather than ours, which is why `type_is_user_set` is
 * always true: they were shown the guess and either accepted or changed it, and sync must not
 * later overwrite either outcome.
 *
 * Idempotent per provider account, so re-confirming updates rather than duplicating — this is also
 * the reconnect path.
 */
export async function confirmAccounts(
  context: HouseholdContext,
  connectionId: string,
  confirmations: readonly AccountConfirmation[],
  discovered: readonly DiscoveredAccount[],
  now: Date = new Date(),
): Promise<{ created: number; updated: number }> {
  const byProviderId = new Map(discovered.map((account) => [account.simplefinAccountId, account]))

  let created = 0
  let updated = 0

  for (const confirmation of confirmations) {
    if (!confirmation.include) {
      continue
    }

    const account = byProviderId.get(confirmation.simplefinAccountId)
    if (account === undefined) {
      throw new ConnectionError(
        `Confirmation references an account that was not discovered: ${confirmation.simplefinAccountId}`,
      )
    }

    const institutionId = await upsertInstitution(context, account)
    const balance = applySignConvention(account.providerBalanceCents, confirmation.signInverted)

    const existing = await context.client.query<{ id: string }>(
      'select id from accounts where connection_id = $1 and simplefin_account_id = $2',
      [connectionId, confirmation.simplefinAccountId],
    )

    if (existing.rows[0] === undefined) {
      await context.client.query(
        `insert into accounts (
           household_id, connection_id, institution_id, simplefin_account_id,
           type, type_is_user_set,
           display_name, provider_name, currency, current_balance, balance_as_of,
           provider_sign_inverted, tax_treatment, confirmed_at
         ) values ($1,$2,$3,$4,$5,true,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          context.householdId,
          connectionId,
          institutionId,
          // Load-bearing: this is what re-matches an account on reconnect. Without it, every
          // reconnect would insert duplicates and orphan the original balance history.
          confirmation.simplefinAccountId,
          confirmation.type,
          confirmation.displayName === undefined
            ? null
            : context.cipher.encryptText(confirmation.displayName),
          context.cipher.encryptText(account.providerName),
          account.currency ?? 'USD',
          context.cipher.encryptMoney(balance),
          now,
          confirmation.signInverted,
          confirmation.taxTreatment ?? defaultTaxTreatment(confirmation.type),
          now,
        ],
      )
      created += 1
    } else {
      // Reconnect, or a corrected answer. Deliberately does **not** touch coverage_start_date or
      // any history — re-confirming must never orphan what we already have.
      await context.client.query(
        `update accounts
            set type = $1,
                type_is_user_set = true,
                provider_sign_inverted = $2,
                current_balance = $3,
                balance_as_of = $4,
                confirmed_at = coalesce(confirmed_at, $4),
                institution_id = $5
          where id = $6`,
        [
          confirmation.type,
          confirmation.signInverted,
          context.cipher.encryptMoney(balance),
          now,
          institutionId,
          existing.rows[0].id,
        ],
      )
      updated += 1
    }
  }

  return { created, updated }
}

/**
 * Institutions are household-scoped, so this upserts within the tenant rather than sharing a global
 * row — institution names are encrypted, and a global table could not hold them (ARCHITECTURE.md §10).
 */
async function upsertInstitution(
  context: HouseholdContext,
  account: DiscoveredAccount,
): Promise<string | null> {
  const domain = account.institutionDomain
  if (domain === null) {
    return null
  }

  const existing = await context.client.query<{ id: string }>(
    'select id from institutions where household_id = $1 and simplefin_org_domain = $2',
    [context.householdId, domain],
  )

  const found = existing.rows[0]
  if (found !== undefined) {
    return found.id
  }

  const inserted = await context.client.query<{ id: string }>(
    `insert into institutions (household_id, simplefin_org_domain, name)
     values ($1, $2, $3) returning id`,
    [context.householdId, domain, context.cipher.encryptText(account.institutionName ?? domain)],
  )

  return inserted.rows[0]?.id ?? null
}

/**
 * Decrypts a connection's access URL.
 *
 * This is the only place it is read. It is **never returned to the client, not even partially** —
 * it carries basic auth credentials for the user's entire Bridge account.
 */
export async function loadAccessUrl(
  context: HouseholdContext,
  connectionId: string,
): Promise<string> {
  const result = await context.client.query<{ access_url: Buffer }>(
    'select access_url from connections where id = $1 and household_id = $2',
    [connectionId, context.householdId],
  )

  const row = result.rows[0]
  if (row === undefined) {
    throw new ConnectionError('Connection not found')
  }

  return context.cipher.decryptText(row.access_url)
}

/**
 * Replaces the stored access URL on an existing connection.
 *
 * **Reconnecting must preserve history.** This updates the existing row rather than creating one,
 * so accounts stay attached to it and their balance history is untouched. Creating a new connection
 * instead would orphan every account behind it and silently duplicate them on the next discovery.
 */
export async function reconnect(
  context: HouseholdContext,
  connectionId: string,
  setupToken: string,
  fetcher: Fetcher,
): Promise<void> {
  const accessUrl = await claimSetupToken(setupToken, fetcher)

  const result = await context.client.query(
    `update connections
        set access_url = $1, status = 'healthy', consecutive_failures = 0, last_error = null
      where id = $2 and household_id = $3`,
    [context.cipher.encryptText(accessUrl), connectionId, context.householdId],
  )

  if (result.rowCount === 0) {
    throw new ConnectionError('Connection not found')
  }
}
