import {
  ACCOUNT_COPY,
  assessConnection,
  connectionBanner,
  daysBetween,
  describeAge,
  toIsoDate,
  type ConnectionBannerCopy,
  type HealthAssessment,
  type SyncMoment,
} from '@beans/shared'
import { localIsoDate } from '../lib/today.js'

/**
 * The account shape these helpers need, structurally.
 *
 * Deliberately not the full stored account: everything here is about freshness, and naming only the
 * fields that bear on it keeps the coupling honest.
 */
export type SyncableAccount = {
  institutionName: string | null
  /** When the balance itself was observed. The honest answer to "how current is this number". */
  balanceAsOf: string | null
  connectionStatus: 'healthy' | 'stale' | 'error' | null
  lastSuccessAt: string | null
  consecutiveFailures: number
  isManual: boolean
}

/**
 * Presentation for a single account: how fresh it is, and what to say when it isn't.
 */

const TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

/**
 * Local, deliberately — unlike the formatter for stored calendar dates.
 *
 * A sync time is an *instant*, and rendering an instant in UTC puts a 10pm Eastern sync on the
 * following day. The `timeZone: 'UTC'` that a `YYYY-MM-DD` needs is exactly wrong here.
 */
const LOCAL_DATE = new Intl.DateTimeFormat(undefined, {
  month: 'numeric',
  day: 'numeric',
  year: 'numeric',
})

/** Whole days between a sync and now, both on the reader's calendar. */
export function localDaysSince(iso: string | null, now: Date): number | null {
  if (iso === null) return null
  return daysBetween(localIsoDate(new Date(iso)), localIsoDate(now))
}

/** A sync instant split into the two parts {@link describeAge} assembles. */
export function formatSyncMoment(iso: string | null): SyncMoment | null {
  if (iso === null) return null
  const instant = new Date(iso)
  return { date: LOCAL_DATE.format(instant), time: TIME.format(instant) }
}

/**
 * When this account's balance was last observed.
 *
 * A time for today and a date otherwise, matching how the reference reads — "4:08 PM" says *this is
 * current* far more directly than today's date does, and a time on a three-week-old balance would be
 * a false precision.
 *
 * **`balanceAsOf` first, `lastSuccessAt` only as a fallback.** They are not the same question. The
 * sync time says when Beans last spoke to the provider; the balance date says how current the number
 * on screen is, and a provider that answers today with yesterday's close makes those differ — which
 * is exactly the confusion the portfolio's dated figures exist to prevent. An account with no
 * connection at all has no sync time and a perfectly good balance date.
 */
export function formatLastUpdated(account: SyncableAccount): string {
  if (account.isManual) return ACCOUNT_COPY.manualAccount

  const observed = account.balanceAsOf ?? account.lastSuccessAt
  const moment = formatSyncMoment(observed)
  if (moment === null) return 'Never'

  const days = localDaysSince(observed, new Date())
  return days === 0 ? moment.time : moment.date
}

export type AccountHealth = {
  assessment: HealthAssessment
  /** Null when there is nothing wrong, or nothing that is Beans' business to fix. */
  banner: ConnectionBannerCopy | null
}

/**
 * The health verdict and the banner for it.
 *
 * A manual account is exempt from all of this. It has no connection, so it cannot fail, go stale, or
 * be reconnected — telling somebody their hand-entered car valuation needs re-authorizing would be
 * nonsense.
 */
export function accountHealth(account: SyncableAccount, today: string): AccountHealth {
  if (account.isManual) {
    return { assessment: { severity: 'ok', action: 'none', daysSinceSuccess: null }, banner: null }
  }

  const assessment = assessConnection(
    {
      // A manual account is already handled above, so a null status here means an account with no
      // connection row that is not manual either — treat it as healthy rather than inventing alarm.
      status: account.connectionStatus ?? 'healthy',
      lastSuccessAt: account.lastSuccessAt,
      consecutiveFailures: account.consecutiveFailures,
    },
    today,
  )

  const banner = connectionBanner({
    action: assessment.action,
    institution: account.institutionName ?? 'this institution',
    age: describeAge(
      localDaysSince(account.lastSuccessAt, new Date()),
      formatSyncMoment(account.lastSuccessAt),
    ),
    neverSucceeded: account.lastSuccessAt === null,
  })

  return { assessment, banner }
}
