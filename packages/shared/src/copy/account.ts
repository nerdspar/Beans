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
/**
 * Reading the chart by date.
 *
 * The date replaces the change line rather than sitting beside it. While a day is being read, "up
 * $4,200 over the year" is answering a question nobody is asking, and two numbers competing for the
 * same glance is how a header stops being read at all.
 */
export const NET_WORTH_SCRUB_COPY = {
  label: 'Read net worth by date. Use the arrow keys to move a day at a time.',
  /** Spoken as the slider moves, so the value is heard rather than only seen. */
  describe: (date: string, value: string): string => `${date}: ${value}`,
} as const

export const NET_WORTH_STATE_COPY = {
  loading: 'Counting the beans.',

  empty: 'Nothing to add up yet',
  emptyDetail: 'Connect an institution and Beans will start keeping track. Nothing here is manual.',
  /** The empty state names the next step; without a way to take it, it is only an observation. */
  emptyAction: 'Connect an institution',

  failed: 'Could not load your accounts',
  /** Followed by the actual error. Beans is self-hosted: the person reading this can act on it. */
  failedDetail: 'Beans will keep trying. What went wrong:',
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
/**
 * Says what is missing from the earlier part of a total, rather than what was hidden to avoid it.
 *
 * The previous wording — "History starts X — that is as far back as every account reaches" — was
 * true of a series that had been truncated to X. It is not truncated now: the chart runs as far back
 * as anything reaches, and the part before X is a real total of the accounts that existed then. That
 * needs saying, because a total stepping up on the day an account appears otherwise reads as a gain.
 */
export function coverageNotice(completeFrom: string): string {
  return `Before ${completeFrom}, this leaves out accounts whose history does not reach that far back.`
}
