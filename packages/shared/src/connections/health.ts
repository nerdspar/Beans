import { daysBetween, toIsoDate, type IsoDate } from '../balance-history/dates.js'

/**
 * Turning a connection's state into the one thing the user should do about it.
 *
 * Silent staleness is this app's worst failure mode: the numbers quietly stop updating and every
 * screen still looks fine. Surfacing *that* something is wrong is necessary but not sufficient — a
 * red dot the user cannot act on trains them to ignore red dots.
 *
 * So health resolves to a **recommended action**, and the distinction that matters is between a
 * failure the user has to fix and one Beans will fix by itself. Telling somebody to re-authorize
 * their bank because a single sync timed out is how a warning becomes noise.
 *
 * Lives in shared because the same assessment drives the account screen, the connections list and
 * eventually a notification. Three copies of these thresholds would disagree.
 */

export type ConnectionStatus = 'healthy' | 'stale' | 'error'

export type ConnectionHealth = {
  status: ConnectionStatus
  /** ISO instant of the last successful sync. Null when one has never succeeded. */
  lastSuccessAt: string | null
  /** Consecutive failed attempts. Drives backoff on the server and the verdict here. */
  consecutiveFailures: number
}

/**
 * - `none`      nothing to do.
 * - `wait`      a failure Beans expects to recover from on its own. Retrying by hand is allowed but
 *               pointless; the user is told so rather than being sent to fix their bank login.
 * - `sync-now`  data is old but nothing is failing. Asking for a fresh pull is the whole fix.
 * - `reconnect` the institution needs the user to sign in again. The only action Beans cannot take.
 */
export type RecommendedAction = 'none' | 'wait' | 'sync-now' | 'reconnect'

export type HealthAssessment = {
  /** `caution` is amber and informational; `attention` is red and means something is broken. */
  severity: 'ok' | 'caution' | 'attention'
  action: RecommendedAction
  /** Whole days since the last successful sync. Null when there has never been one. */
  daysSinceSuccess: number | null
}

/**
 * Repeated failures mean the credentials went bad rather than the network hiccuping.
 *
 * Three rather than one because a single failure is usually the institution being briefly
 * unavailable, and the Bridge's 24-requests-per-day ceiling means Beans retries slowly enough that
 * two failures can still be the same outage.
 */
const RECONNECT_AFTER_FAILURES = 3

/**
 * A stale connection that has not reported in a month is not slow, it is broken.
 *
 * SimpleFIN can keep returning a stale balance without erroring when the institution has quietly
 * stopped authorizing the link, so "no error" is not evidence the connection works.
 */
const STALE_RECONNECT_DAYS = 30

export function assessConnection(health: ConnectionHealth, today: IsoDate): HealthAssessment {
  const daysSinceSuccess =
    health.lastSuccessAt === null
      ? null
      : daysBetween(toIsoDate(new Date(health.lastSuccessAt)), today)

  if (health.status === 'healthy') {
    return { severity: 'ok', action: 'none', daysSinceSuccess }
  }

  // Never once succeeded: whatever was entered at setup did not work, so there is nothing to wait
  // for. Distinct from a connection that worked and then broke, and worth saying differently.
  if (daysSinceSuccess === null) {
    return { severity: 'attention', action: 'reconnect', daysSinceSuccess }
  }

  if (health.status === 'error') {
    /*
     * A failure Beans will retry out of is `caution`, not `attention`. Painting a single timed-out
     * sync the same red as dead credentials is how the red one stops meaning anything — the user
     * learns both colours resolve themselves and stops looking. Severity tracks *does this need
     * you*, which is exactly what the action already says.
     */
    return health.consecutiveFailures >= RECONNECT_AFTER_FAILURES
      ? { severity: 'attention', action: 'reconnect', daysSinceSuccess }
      : { severity: 'caution', action: 'wait', daysSinceSuccess }
  }

  return daysSinceSuccess >= STALE_RECONNECT_DAYS
    ? { severity: 'attention', action: 'reconnect', daysSinceSuccess }
    : { severity: 'caution', action: 'sync-now', daysSinceSuccess }
}
