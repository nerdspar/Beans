/**
 * Copy for the holdings list on an account.
 *
 * The distinction the whole screen turns on is **"we were told nothing" versus "there is nothing"**,
 * and these strings exist mostly to keep those apart. An account whose institution does not report
 * positions must not read as an empty portfolio.
 */

export const HOLDINGS_COPY = {
  heading: 'Holdings',

  loading: 'Counting the beans.',

  /** Not "no holdings". The account holds something; we were simply not told what. */
  unsupported: 'No positions reported',
  unsupportedDetail:
    'This institution sends Beans a balance for this account but not what is inside it. Nothing is missing from your net worth — only the breakdown is unavailable.',

  /**
   * The other empty state, and the reason there are two.
   *
   * Positions are only recorded during a sync, so an account that has not synced since holdings
   * were added has none for a reason that says nothing about the institution. Showing that as "no
   * positions reported" would blame a provider that has not been asked yet.
   */
  notCheckedYet: 'Not looked at yet',
  notCheckedYetDetail:
    'Positions arrive with a sync. This account has not synced since Beans started reading them — refresh the connection on the accounts screen, and they will appear here if the institution sends them.',

  failed: 'Could not load holdings',

  /** The column, and the caveat that belongs to it. */
  columnMove: 'Change',
  columnValue: 'Value',

  /**
   * Shown only when the positions are dated differently from the account's move above them.
   *
   * The two come from different places — the heading's date is the last day the *balance* changed,
   * this one is the last day *positions* were recorded — so they usually agree and occasionally do
   * not. Printing it unconditionally repeated the heading; dropping it unconditionally would let a
   * genuine disagreement pass silently.
   */
  asOf: (date: string): string => `Positions as of ${date}`,

  /** A continuation of the line above, and the same thing standing alone. */
  since: (date: string): string => `change since ${date}`,
  changeSince: (date: string): string => `Change since ${date}`,

  /** A position with no earlier observation to measure against. */
  noPrevious: 'New',

  /**
   * Said once, under the list.
   *
   * A position has no transactions to net out the way an account does, so shares bought or sold
   * land in the change exactly like a price move and nothing here can tell them apart. Better to
   * state it than to let a purchase read as a good day.
   */
  movesNote:
    'A change is the difference between two reported positions. Shares bought or sold in between move it too, so it is not the market alone.',

  /** `88.47 @ $147.81`, or just the share count where no price can be derived. */
  quantity: (shares: string, price: string | null): string =>
    price === null ? `${shares} shares` : `${shares} @ ${price}`,

  costBasis: (amount: string): string => `Cost ${amount}`,

  // ── The security's own page ────────────────────────────────────────────────
  backToPortfolio: 'Portfolio',
  byAccount: 'Held in',
  chartScrubLabel: 'Value of this holding. Arrow keys move by day.',

  /**
   * The coverage boundary, restated for a security.
   *
   * A cash balance can be walked backwards through its transactions; a position cannot, because a
   * share price moving is not something anybody posts. So this history starts where Beans started
   * looking rather than where the position started, and saying so beats a line that implies the
   * holding was opened the day we first saw it.
   */
  historyNote:
    'History starts when Beans first recorded this position. A holding’s past value cannot be worked out from transactions the way a cash balance can.',

  notFound: 'Nothing recorded for this holding',
  notFoundDetail:
    'It may have been sold, or it may be outside the selected range. Positions are only recorded on days a sync saw them.',
} as const
