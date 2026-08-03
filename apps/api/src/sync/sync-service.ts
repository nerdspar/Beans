import type { Fetcher } from '../simplefin/client.js'
import type { HouseholdContext } from '../repositories/household-context.js'
import { canSync, type SyncTrigger } from './quota.js'
import { connectionStatusFor, syncConnection, type SyncOutcome } from './sync-connection.js'

/**
 * Orchestrates one connection sync: budget check, sync, audit, status.
 *
 * Everything that decides *whether* to spend a request lives here or in `quota.ts`; everything that
 * decides *what to do with the response* lives in `sync-connection.ts`. Keeping the budget in one
 * place is what makes the 24-a-day ceiling enforceable rather than aspirational.
 *
 * **Every attempt is recorded**, including refusals and failures. Silent sync failure is this app's
 * worst bug — the numbers quietly go stale and everything still looks fine — so "why is this
 * balance old?" has to be answerable after the fact rather than guessed at.
 */

export type SyncAttempt =
  /** Ran and reached the provider. `outcome.errors` may still carry institution-level complaints. */
  | { ran: true; ok: true; outcome: SyncOutcome; syncRunId: string }
  /** Ran and failed outright — transport, auth, or an unparseable response. */
  | { ran: true; ok: false; error: string; syncRunId: string }
  /** Refused before spending anything: out of budget, backing off, or refreshed a moment ago. */
  | { ran: false; reason: string; retryAfter: Date | null }

/**
 * Requests spent today for this connection.
 *
 * Counted from `sync_runs` rather than tracked in a counter, so it survives a restart and cannot
 * drift from reality. The day boundary is UTC, matching the quota reset.
 */
async function requestsSpentToday(
  context: HouseholdContext,
  connectionId: string,
  now: Date,
): Promise<number> {
  const startOfDay = new Date(now)
  startOfDay.setUTCHours(0, 0, 0, 0)

  const result = await context.client.query<{ total: string | null }>(
    `select sum(requests_spent)::text as total
       from sync_runs
      where connection_id = $1 and started_at >= $2`,
    [connectionId, startOfDay],
  )

  return Number(result.rows[0]?.total ?? 0)
}

type ConnectionState = {
  lastSuccessAt: Date | null
  lastAttemptAt: Date | null
  consecutiveFailures: number
}

async function loadConnectionState(
  context: HouseholdContext,
  connectionId: string,
): Promise<ConnectionState> {
  const result = await context.client.query<{
    last_success_at: Date | null
    last_attempt_at: Date | null
    consecutive_failures: number
  }>(
    `select last_success_at, last_attempt_at, consecutive_failures
       from connections where id = $1 and household_id = $2`,
    [connectionId, context.householdId],
  )

  const row = result.rows[0]
  if (row === undefined) {
    throw new Error('Connection not found')
  }

  return {
    lastSuccessAt: row.last_success_at,
    lastAttemptAt: row.last_attempt_at,
    consecutiveFailures: row.consecutive_failures,
  }
}

/**
 * Syncs a connection if the budget allows.
 *
 * Returns rather than throws when refused: a connection backing off is an expected state, not an
 * error, and treating it as one would fill the logs with noise that hides real failures.
 */
export async function runSync(
  context: HouseholdContext,
  connectionId: string,
  fetcher: Fetcher,
  trigger: SyncTrigger,
  now: Date = new Date(),
): Promise<SyncAttempt> {
  const state = await loadConnectionState(context, connectionId)
  const spent = await requestsSpentToday(context, connectionId, now)

  const decision = canSync(
    {
      requestsToday: spent,
      lastAttemptAt: state.lastAttemptAt,
      consecutiveFailures: state.consecutiveFailures,
    },
    trigger,
    now,
  )

  if (!decision.allowed) {
    return { ran: false, reason: decision.reason, retryAfter: decision.retryAfter }
  }

  const syncRunId = await startSyncRun(context, connectionId, now)

  try {
    const outcome = await syncConnection(context, connectionId, fetcher, {
      lastSuccessAt: state.lastSuccessAt,
      now,
    })

    await finishSyncRun(context, syncRunId, outcome, now)
    await applyOutcomeToConnection(context, connectionId, outcome, now)

    return { ran: true, ok: true, outcome, syncRunId }
  } catch (error) {
    /**
     * Returned, never rethrown.
     *
     * `withHouseholdContext` wraps the caller in a transaction, so rethrowing would roll back the
     * very rows written here — the sync run recording the failure, and the incremented backoff
     * counter. The failure would then leave no trace at all, which is precisely the silent
     * staleness this audit trail exists to prevent, and the connection would retry immediately
     * because its failure count never rose.
     */
    const message = error instanceof Error ? error.message : String(error)
    await recordSyncFailure(context, syncRunId, connectionId, message, now)
    return { ran: true, ok: false, error: message, syncRunId }
  }
}

async function startSyncRun(
  context: HouseholdContext,
  connectionId: string,
  now: Date,
): Promise<string> {
  const result = await context.client.query<{ id: string }>(
    `insert into sync_runs (household_id, connection_id, started_at)
     values ($1, $2, $3) returning id`,
    [context.householdId, connectionId, now],
  )

  const row = result.rows[0]
  if (row === undefined) {
    throw new Error('Failed to open a sync run')
  }
  return row.id
}

async function finishSyncRun(
  context: HouseholdContext,
  syncRunId: string,
  outcome: SyncOutcome,
  now: Date,
): Promise<void> {
  // `partial` rather than `success` when the provider complained: the request worked, but some
  // institution behind it did not, and calling that a success is how staleness becomes invisible.
  const result = outcome.errors.length > 0 ? 'partial' : 'success'

  await context.client.query(
    `update sync_runs
        set finished_at = $1,
            outcome = $2,
            accounts_seen = $3,
            transactions_upserted = $4,
            requests_spent = $5,
            errors = $6
      where id = $7`,
    [
      now,
      result,
      outcome.accountsUpdated,
      outcome.transactionsUpserted,
      outcome.requestsSpent,
      outcome.errors.length === 0 ? null : context.cipher.encryptJson(outcome.errors),
      syncRunId,
    ],
  )
}

async function applyOutcomeToConnection(
  context: HouseholdContext,
  connectionId: string,
  outcome: SyncOutcome,
  now: Date,
): Promise<void> {
  const status = connectionStatusFor(outcome)

  // A run that reached the provider clears the failure streak even when an institution behind it is
  // unhappy: backoff exists for transport failures, and a broken institution link is surfaced
  // through `status` instead. Backing off would only delay noticing it was fixed.
  await context.client.query(
    `update connections
        set status = $1,
            last_attempt_at = $2,
            last_success_at = $2,
            consecutive_failures = 0,
            last_error = $3
      where id = $4`,
    [
      status,
      now,
      outcome.errors.length === 0 ? null : context.cipher.encryptJson(outcome.errors),
      connectionId,
    ],
  )
}

async function recordSyncFailure(
  context: HouseholdContext,
  syncRunId: string,
  connectionId: string,
  message: string,
  now: Date,
): Promise<void> {
  await context.client.query(
    `update sync_runs
        set finished_at = $1, outcome = 'error', errors = $2, requests_spent = 1
      where id = $3`,
    [now, context.cipher.encryptJson([message]), syncRunId],
  )

  // The failure counter drives exponential backoff, so a persistently broken connection makes a
  // handful of attempts a day rather than hundreds.
  await context.client.query(
    `update connections
        set status = 'error',
            last_attempt_at = $1,
            consecutive_failures = consecutive_failures + 1,
            last_error = $2
      where id = $3`,
    [now, context.cipher.encryptJson([message]), connectionId],
  )
}

/**
 * Marks connections stale when they have not succeeded recently.
 *
 * Distinct from a failure: nothing errored, the sync simply has not happened — a paused schedule, a
 * container that was down, a connection nobody has looked at. Without this the UI would show a
 * green light over numbers that are a week old.
 */
export async function markStaleConnections(
  context: HouseholdContext,
  now: Date,
  staleAfterHours = 36,
): Promise<number> {
  const threshold = new Date(now.getTime() - staleAfterHours * 60 * 60 * 1000)

  const result = await context.client.query(
    `update connections
        set status = 'stale'
      where household_id = $1
        and status = 'healthy'
        and (last_success_at is null or last_success_at < $2)`,
    [context.householdId, threshold],
  )

  return result.rowCount ?? 0
}
