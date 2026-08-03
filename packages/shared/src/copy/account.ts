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
 * The caption under a chart whose right-hand end is carried rather than observed.
 *
 * A flat line is not self-explanatory — read without context it says "this balance genuinely did not
 * move", which is a claim Beans has no basis for. Naming the last day of real data turns the flat
 * stretch from a statement about the account into a statement about what is known.
 */
export function carriedNotice(lastRealDate: string): string {
  return `Flat after ${lastRealDate} — Beans has had no data for this account since then.`
}
