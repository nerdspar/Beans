import type { RecommendedAction } from '../connections/health.js'

/**
 * Copy for the connection banner.
 *
 * **Calm and factual, with no personality at all.** The copy rules allow a voice in error states,
 * and this one deliberately declines it. A broken bank connection means the numbers on screen are
 * not current — the user is being told their financial data is wrong and asked to go do something
 * about it. A joke sitting above an action button is friction in the one place a person needs to
 * read carefully and act.
 *
 * Every message says three things in the same order: **what is wrong, how old the data is, and what
 * to do**. The age is never omitted, because "this might be out of date" without a date is an
 * anxiety generator rather than information.
 */

export type ConnectionBannerCopy = {
  title: string
  detail: string
  /** Null when there is genuinely nothing for the user to press. */
  actionLabel: string | null
}

/**
 * How long ago, in words.
 *
 * Days rather than a date up to a week, because "4 days ago" is instantly legible as staleness where
 * "7/30/2026" requires the reader to do the arithmetic. Past a week the exact date carries more.
 */
export function describeAge(days: number | null, isoDate: string | null): string {
  if (days === null || isoDate === null) return 'never'
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`

  return `on ${isoDate}`
}

export function connectionBanner(input: {
  action: RecommendedAction
  institution: string
  /** Already run through {@link describeAge}. */
  age: string
  neverSucceeded: boolean
}): ConnectionBannerCopy | null {
  const { action, institution, age, neverSucceeded } = input

  switch (action) {
    case 'none':
      return null

    case 'reconnect':
      return neverSucceeded
        ? {
            title: `Beans has never synced ${institution}`,
            detail: `This connection was set up but no sync has ever succeeded, so there are no balances behind it. Reconnecting and signing in again is usually the fix.`,
            actionLabel: 'Reconnect',
          }
        : {
            title: `Beans can't reach ${institution}`,
            detail: `Syncing has failed repeatedly, which normally means the bank wants you to sign in again — a changed password or an expired two-factor approval will both do it. The balance below is from the last successful sync, ${age}.`,
            actionLabel: 'Reconnect',
          }

    case 'wait':
      return {
        title: `The last sync of ${institution} failed`,
        detail: `Beans will try again on its own shortly, so this usually needs nothing from you. The balance below is from ${age}.`,
        // Offered even though waiting is the recommendation — being told to sit still with no way to
        // check is worse than a button that is merely unnecessary.
        actionLabel: 'Try now',
      }

    case 'sync-now':
      return {
        title: 'This balance may be out of date',
        detail: `Nothing is failing — ${institution} simply hasn't reported anything newer since ${age}.`,
        actionLabel: 'Sync now',
      }
  }
}

/** The short form, for the dot beside an account row. */
export const CONNECTION_STATUS_LABEL: Record<RecommendedAction, string> = {
  none: 'Connection healthy',
  wait: 'Last sync failed, retrying',
  'sync-now': 'Balance may be out of date',
  reconnect: 'Connection needs attention',
}
