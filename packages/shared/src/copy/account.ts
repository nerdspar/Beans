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
 *
 * Signed-out and no-household are **not** here: `Gate` resolves both before this screen renders, and
 * their copy lives with the screens that actually show it in `AUTH_COPY`.
 */
export const NET_WORTH_STATE_COPY = {
  loading: 'Counting the beans.',

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

/**
 * Why the net worth chart starts where it does.
 *
 * Shown when accounts disagree about how far back they reach — typically a new investment account,
 * whose value moves with the market and so cannot be reconstructed backwards the way a cash or card
 * balance can. Without this the truncation is silent, and a chart that quietly starts later than the
 * range asked for is indistinguishable from one that has nothing to show.
 */
export function coverageNotice(startDate: string): string {
  return `History starts ${startDate} — that is as far back as every account reaches.`
}
