/**
 * Request budgeting for SimpleFIN.
 *
 * **The Bridge expects 24 or fewer requests per day per token.** That is a hard external constraint,
 * not a soft guideline, and exceeding it degrades or blocks a user's connection. So the budget is
 * explicit and enforced here rather than being an emergent property of how often things happen to
 * run.
 *
 * The failure mode this exists to prevent: a connection starts erroring, something retries it, and
 * the retries quietly consume the whole day's allowance — so when the underlying problem clears,
 * there are no requests left and the data goes stale anyway. Backoff is therefore *hard*, and
 * retries draw from the same budget as everything else.
 *
 * Pure functions with an injected clock. No I/O, no scheduling — the caller supplies observed state
 * and acts on the decision.
 */

/** The Bridge's stated ceiling. */
export const DAILY_REQUEST_BUDGET = 24

/**
 * Scheduled syncs per day. Four is roughly every six hours, which is far more current than a
 * finance app needs while leaving most of the budget for manual refreshes and retries.
 */
export const SCHEDULED_SYNCS_PER_DAY = 4

/**
 * Held back so a broken connection cannot consume the entire day.
 *
 * Once usage passes `DAILY_REQUEST_BUDGET - RESERVED_FOR_SCHEDULED`, manual refreshes are refused
 * but scheduled syncs still run. Losing a manual refresh is an inconvenience; losing the scheduled
 * sync means the numbers silently stop updating, which is this app's worst failure.
 */
export const RESERVED_FOR_SCHEDULED = 6

/** How often a user may force a refresh. Also rate-limited in the UI; enforced here regardless. */
export const MANUAL_REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000

const BACKOFF_BASE_MS = 15 * 60 * 1000
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000

export type SyncTrigger = 'scheduled' | 'manual'

export type ConnectionSyncState = {
  /** Requests already spent today for this connection's token, from the sync_runs audit log. */
  requestsToday: number
  lastAttemptAt: Date | null
  consecutiveFailures: number
}

export type SyncDecision =
  { allowed: true } | { allowed: false; reason: string; retryAfter: Date | null }

/**
 * Exponential backoff after failures, capped.
 *
 * Deterministic rather than jittered: this is a per-connection wait, and there is no thundering
 * herd to spread out. Jitter belongs on the *schedule* (see {@link jitterForSchedule}), where many
 * connections would otherwise fire simultaneously.
 */
export function backoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) {
    return 0
  }
  // Clamp the exponent before shifting so a runaway failure count cannot overflow.
  const exponent = Math.min(consecutiveFailures - 1, 10)
  return Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_MAX_MS)
}

/**
 * Decides whether a sync may run now.
 *
 * Checks are ordered cheapest-and-most-absolute first, so the reason returned is the most
 * fundamental one rather than whichever happened to be evaluated.
 */
export function canSync(state: ConnectionSyncState, trigger: SyncTrigger, now: Date): SyncDecision {
  const startOfTomorrow = nextMidnightUtc(now)

  if (state.requestsToday >= DAILY_REQUEST_BUDGET) {
    return {
      allowed: false,
      reason: `Daily request budget of ${DAILY_REQUEST_BUDGET} is exhausted for this connection.`,
      retryAfter: startOfTomorrow,
    }
  }

  if (
    trigger === 'manual' &&
    state.requestsToday >= DAILY_REQUEST_BUDGET - RESERVED_FOR_SCHEDULED
  ) {
    return {
      allowed: false,
      reason:
        'The remaining requests today are reserved for scheduled syncs, so your data keeps ' +
        'updating on its own.',
      retryAfter: startOfTomorrow,
    }
  }

  if (state.consecutiveFailures > 0 && state.lastAttemptAt !== null) {
    const waitUntil = new Date(state.lastAttemptAt.getTime() + backoffMs(state.consecutiveFailures))
    if (now.getTime() < waitUntil.getTime()) {
      return {
        allowed: false,
        reason: `This connection has failed ${state.consecutiveFailures} time(s) in a row and is backing off.`,
        retryAfter: waitUntil,
      }
    }
  }

  if (trigger === 'manual' && state.lastAttemptAt !== null) {
    const earliest = new Date(state.lastAttemptAt.getTime() + MANUAL_REFRESH_MIN_INTERVAL_MS)
    if (now.getTime() < earliest.getTime()) {
      return {
        allowed: false,
        reason: 'This connection was refreshed a moment ago.',
        retryAfter: earliest,
      }
    }
  }

  return { allowed: true }
}

/**
 * Per-connection jitter for a scheduled run, in milliseconds.
 *
 * Every household's schedule fires on the same cron tick, so without this they would all hit the
 * Bridge simultaneously — bursty for them, and a needless spike for us. Derived from the connection
 * id rather than randomly, so a connection's offset is **stable**: it lands at roughly the same
 * time each day, and re-running the scheduler does not reshuffle everything.
 */
export function jitterForSchedule(connectionId: string, windowMs: number): number {
  let hash = 0
  for (let index = 0; index < connectionId.length; index += 1) {
    // Standard string hash; the exact function does not matter, only that it is stable and spreads.
    hash = (hash * 31 + connectionId.charCodeAt(index)) | 0
  }
  return Math.abs(hash) % Math.max(1, windowMs)
}

/**
 * How far back a sync should ask for transactions.
 *
 * First sync pulls as much history as the endpoint will give. Later syncs **overlap by two weeks**,
 * because transactions post late and get amended after the fact — a window that started exactly
 * where the last one ended would miss both.
 */
export function syncWindowStart(lastSuccessAt: Date | null, now: Date, firstSyncDays = 365): Date {
  if (lastSuccessAt === null) {
    return new Date(now.getTime() - firstSyncDays * 24 * 60 * 60 * 1000)
  }
  return new Date(lastSuccessAt.getTime() - 14 * 24 * 60 * 60 * 1000)
}

function nextMidnightUtc(now: Date): Date {
  const next = new Date(now)
  next.setUTCHours(0, 0, 0, 0)
  next.setUTCDate(next.getUTCDate() + 1)
  return next
}
