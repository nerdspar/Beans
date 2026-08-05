/**
 * Copy for the portfolio screen, and for the positions inside one account.
 *
 * Holdings are optional in SimpleFIN and genuinely absent from many institutions, so every string
 * here has to work when there are none. The empty state names the institution rather than blaming
 * the account, because "no holdings" from a brokerage that plainly holds things reads as a bug.
 */

export const PORTFOLIO_COPY = {
  title: 'Portfolio',
  total: 'Invested',

  loading: 'Counting the beans.',
  empty: 'No investment accounts',
  emptyDetail:
    'Anything typed as an investment appears here. Connect an institution, or change an account’s type on the accounts screen.',

  byAccount: 'By account',
  byTax: 'By tax treatment',

  /** Named because it changes what a projection would mean, not merely how a total is labelled. */
  /*
   * A day's move, and what it excludes.
   *
   * Money paid in is not performance, so it is taken out — which means this figure will not match a
   * broker's on a day something was contributed. Said once, under the list, rather than annotating
   * every row.
   */
  oneDay: '1-day',
  /**
   * The date a figure describes, shown only when it is not the latest day on the chart.
   *
   * A balance read this morning is often still yesterday's close: the provider has not published a
   * new one, so the series repeats the old value and there is no move to report for today. Showing
   * the figure undated would present a stale number as today's. This is the difference between a
   * quiet day and a day that has not arrived yet.
   */
  asOfDay: (date: string): string => `as of ${date}`,
  oneDayNote:
    'Change is the market only — money paid in or taken out is excluded, so this will differ from your provider after a contribution. A dated figure is the most recent move your provider has published, not today’s.',
  /**
   * The same note when there is nothing to do the excluding with.
   *
   * Beans can only subtract a contribution it was told about, and not every institution reports
   * transactions for an investment account. Where none arrive, the figure is a plain balance change
   * and a deposit lands in it as a gain — so claiming the market alone would be false precisely
   * when it misleads most. Saying which of the two you are looking at costs one line.
   */
  oneDayNoteWithoutFlows:
    'Your provider reports no transactions for these accounts, so each figure is the plain change in balance: money paid in or taken out appears here as a gain or a loss. A dated figure is the most recent move your provider has published, not today’s.',
  noDayChange: 'No change yet',

  taxLabel: {
    taxable: 'Taxable',
    traditional: 'Traditional — taxed on withdrawal',
    roth: 'Roth — taxed already',
    hsa: 'HSA',
    education: 'Education',
    none: 'Not specified',
  },

  /**
   * The caveat that matters here more than anywhere else.
   *
   * An investment balance moves with the market rather than with postings, so it cannot be
   * reconstructed backwards the way a cash balance can (ARCHITECTURE.md §4). History therefore
   * begins when Beans first saw the account, and a short chart is a fact about Beans rather than
   * about the account.
   */
  historyNote:
    'History starts when Beans first saw each account. An investment balance moves with the market, so earlier values cannot be worked out from transactions the way a cash balance can.',
} as const
