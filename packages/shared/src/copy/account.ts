/**
 * Copy for the account detail screen.
 *
 * Labels and headings stay plain and legible — these are things a user navigates by, so they are
 * the wrong place for a voice. Personality, where it appears at all, belongs in the empty and error
 * states below.
 */

export const ACCOUNT_COPY = {
  /** Section headings. */
  balanceHeading: 'Balance',
  detailsHeading: 'Details',
  activityHeading: 'Recent activity',

  /** Field labels. */
  accountType: 'Type',
  institution: 'Institution',
  accountNumber: 'Account number',
  taxTreatment: 'Tax treatment',
  lastUpdated: 'Last updated',
  connection: 'Connection',

  /** Values that are an absence rather than a number. */
  noAccountNumber: 'Not provided',
  manualAccount: 'Manual entry',
  manualAccountDetail: 'You keep this balance up to date yourself. Beans never changes it.',

  backToNetWorth: 'Net worth',

  /*
   * Transactions do not exist yet. Saying so plainly beats an empty list, which reads as "this
   * account has no transactions" — a claim Beans is in no position to make.
   */
  activityUnavailable: 'Transactions land here once syncing is built.',

  notFound: 'No such account',
  notFoundDetail: 'This account may have been removed, or the link may be out of date.',
} as const

/**
 * The states before there is anything to show.
 *
 * These are the empty and loading states, so they are the places the copy rules allow a voice — and
 * the only ones on this screen that take it. `loading` is the exception even among those: it is read
 * for a few hundred milliseconds and a joke that lands the first time is an obstacle the twentieth.
 */
export const NET_WORTH_STATE_COPY = {
  loading: 'Counting the beans.',

  signedOut: 'Sign in to see your accounts',
  signedOutDetail: 'Your balances stay on your own server. Beans just needs to know it is you.',

  noHousehold: 'No household yet',
  noHouseholdDetail:
    'A household is what your accounts belong to, and what you share with anyone you invite. Create one to get started.',

  empty: 'Nothing to add up yet',
  emptyDetail: 'Connect an institution and Beans will start keeping track. Nothing here is manual.',

  failed: 'Could not load your accounts',
  failedDetail: 'The last known balances are shown if there are any. Beans will try again shortly.',
} as const

/**
 * The caption under a chart whose right-hand end is carried rather than observed.
 *
 * A flat line is not self-explanatory — read without context it says "this balance genuinely did not
 * move", which is a claim Beans has no basis for. Naming the last day of real data turns the flat
 * stretch from a statement about the account into a statement about what is known.
 */
export function carriedNotice(lastRealDate: string): string {
  return `Flat after ${lastRealDate} — Beans has had no data for this account since then.`
}
