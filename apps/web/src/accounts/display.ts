import {
  ACCOUNT_COPY,
  assessConnection,
  connectionBanner,
  describeAge,
  toIsoDate,
  type ConnectionBannerCopy,
  type HealthAssessment,
} from '@beans/shared'

/**
 * The account shape these helpers need, structurally.
 *
 * Deliberately not the full stored account: everything here is about freshness, and naming only the
 * fields that bear on it keeps the coupling honest.
 */
export type SyncableAccount = {
  institutionName: string | null
  connectionStatus: 'healthy' | 'stale' | 'error' | null
  lastSuccessAt: string | null
  consecutiveFailures: number
  isManual: boolean
}

/**
 * Presentation for a single account: how fresh it is, and what to say when it isn't.
 */

const TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const DATE = new Intl.DateTimeFormat(undefined, {
  month: 'numeric',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
})

/**
 * When this account last reported.
 *
 * A time for today and a date otherwise, matching how the reference reads — "4:08 PM" says *this is
 * current* far more directly than today's date does, and a time on a three-week-old balance would be
 * a false precision.
 */
export function formatLastUpdated(account: SyncableAccount): string {
  if (account.isManual) return ACCOUNT_COPY.manualAccount
  if (account.lastSuccessAt === null) return 'Never'

  const instant = new Date(account.lastSuccessAt)
  return toIsoDate(instant) === toIsoDate(new Date()) ? TIME.format(instant) : DATE.format(instant)
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
    age: describeAge(assessment.daysSinceSuccess, formatLastUpdated(account)),
    neverSucceeded: account.lastSuccessAt === null,
  })

  return { assessment, banner }
}
