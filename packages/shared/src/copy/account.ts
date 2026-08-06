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
  taxTreatment: 'Tax treatment',
  lastUpdated: 'Last updated',
  /**
   * What the provider says is actually available.
   *
   * Shown beside the balance rather than merged into it, because on a card it is available *credit*
   * — a different quantity in the same field. Labelled, so the two are never read as one number.
   */
  availableBalance: 'Available',
  /** Searching one account's activity, which is the common case for "when did I pay that". */
  searchActivity: 'Search this account',
  /** Distinct from having no activity at all — one is a fact, the other is a narrowed view. */
  activityNoMatches: 'Nothing here matches that.',
  connection: 'Connection',

  /** Values that are an absence rather than a number. */
  manualAccount: 'Manual entry',
  manualAccountDetail: 'You keep this balance up to date yourself. Beans never changes it.',

  backToNetWorth: 'Net worth',

  /*
   * Transactions do not exist yet. Saying so plainly beats an empty list, which reads as "this
   * account has no transactions" — a claim Beans is in no position to make.
   */
  activityUnavailable: 'Nothing has posted to this account yet.',
  /** The list is deliberately short — this is a summary, and Activity is the full record. */
  activityAll: 'See all activity',
  /*
   * Renaming matters more than it looks. Providers publish names their own customers do not
   * recognize — Wealthfront sends investment accounts as "Joint (7E56)" — and a rename is
   * permanent, because sync never overwrites a name the user has set.
   */
  manualEdit: 'Rename or edit',
  manualRecord: 'Record value',

  /**
   * Why a liability reads as a negative number.
   *
   * Signs are decided once, at ingest. This only names the convention so the screen explains itself
   * rather than looking like a bug — a mortgage shown as −$281,640 is the balance being correct, and
   * nothing on the screen otherwise says so.
   */
  liabilitySignNote: 'Shown as a negative amount because it is money owed.',

  /**
   * Why the edit buttons are greyed out.
   *
   * They are disabled whenever the editable copy of the account has not arrived, which is right —
   * an editor opened over nothing is worse. But a disabled control with no explanation is its own
   * dead end: during a load it is brief and unremarkable, and after a failure it is permanent, and
   * the reader has no way to tell those apart. Everything else on the screen is still correct, so
   * this says what is unavailable rather than presenting the screen as broken.
   */
  editUnavailable: 'Editing is unavailable — the account settings could not be loaded.',

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
/**
 * The choice between more history and complete history.
 *
 * Both options are defensible, which is why this is a setting rather than a decision. The copy
 * names the cost of each rather than recommending one — a household that has just connected
 * everything wants the complete total; one with five years and a new house wants the history.
 */
export const HISTORY_SETTING_COPY = {
  heading: 'Net worth history',
  label: 'Show history before every account was tracked',
  on: 'The chart goes back as far as any account reaches. Earlier parts leave out accounts added later, and are marked where that applies.',
  off: 'The chart starts where every account has data. Less history, all of it complete — but it shortens again each time you add an account.',
} as const

export const NET_WORTH_SCRUB_COPY = {
  label: 'Read net worth by date. Use the arrow keys to move a day at a time.',
  /** Spoken as the slider moves, so the value is heard rather than only seen. */
  describe: (date: string, value: string): string => `${date}: ${value}`,
} as const

/**
 * Naming which slice of net worth the chart is currently showing.
 *
 * Used twice, and it has to be the same words both times: the live region that announces a scroll
 * crossing, and the caption on the chart's table fallback. A reader who hears "Showing Cash" and
 * then finds a table captioned something else has to work out whether they are looking at the same
 * thing — which is the one question the announcement existed to answer.
 */
export const NET_WORTH_SCOPE_COPY = {
  /** Everything, as opposed to one category section. */
  household: 'Net worth',
  /** Kept verbatim: "household net worth" reads better here than the bare label does. */
  showingHousehold: 'Showing household net worth',
  showing: (label: string): string => `Showing ${label}`,
} as const

/**
 * The date range control.
 *
 * The two validation messages are the only place a voice would be tempting and the only place it is
 * clearly wrong: someone has just typed dates and been refused, and what they need is which field to
 * change. They say what is wrong with the dates, not what the reader did.
 */
export const RANGE_COPY = {
  title: 'Select date range',
  customTitle: 'Custom range',
  /** Names the back arrow, which is otherwise an unlabelled chevron. */
  backToPresets: 'Back to preset ranges',
  /** Describes the dialog for a screen reader, which gets no layout to infer it from. */
  description: 'Choose the period the totals and chart cover.',
  /** Marks the range currently in force. */
  selected: 'Selected',

  /** The custom-range preset, and the fields behind it. */
  custom: 'Custom',
  start: 'Start',
  end: 'End',
  apply: 'Apply',

  errorOrder: 'The end date is before the start date.',
  errorFuture: 'The end date is in the future.',
} as const

/**
 * The two proportion bars at the top of net worth.
 *
 * Shown only at household scope: they describe the household, not a category. Plain nouns — these
 * label a number, and there is no version of a joke here that survives the number being bad.
 */
export const NET_WORTH_TOTALS_COPY = {
  assets: 'Assets',
  liabilities: 'Liabilities',
} as const

export const NET_WORTH_STATE_COPY = {
  /**
   * Fetching history older than the cache holds.
   *
   * Said because the alternative is an empty stretch of chart with no explanation — which reads as
   * "this history does not exist" rather than "it has not arrived yet", and those want completely
   * different reactions.
   */
  loadingHistory: 'Fetching older history…',
  loadingHistoryFailed: 'Could not fetch the older history. The chart shows what is already here.',

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
