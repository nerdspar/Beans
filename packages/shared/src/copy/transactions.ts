/**
 * Copy for the transactions list.
 *
 * Plain throughout. This is a screen people scan looking for one thing, and the labels are what they
 * navigate by — the copy rules keep personality out of exactly this kind of surface. What voice
 * there is appears only where there is nothing to show.
 */

export const TRANSACTIONS_COPY = {
  title: 'Activity',
  search: 'Search',
  searchPlaceholder: 'Payee, description, amount',
  allAccounts: 'All accounts',

  loading: 'Counting the beans.',

  empty: 'Nothing here yet',
  emptyDetail:
    'Transactions arrive when an institution syncs. If you have just connected one, the first sync pulls up to a year of history.',

  noMatches: 'Nothing matches',
  noMatchesDetail: 'Try a shorter search, a wider date range, or a different account.',

  pending: 'Pending',
  /** A pending charge that vanished. Kept visible rather than deleted, so the change is explainable. */
  voided: 'Removed by the bank',

  /** Reported so a short list is not mistaken for a complete one. */
  showing: (shown: number, total: number): string =>
    shown === total
      ? `${total} transaction${total === 1 ? '' : 's'}`
      : `${shown} of ${total} transactions`,

  uncategorized: 'Uncategorized',
} as const
