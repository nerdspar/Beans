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

  /*
   * Split by direction, not by category.
   *
   * "Deposits" and "Expenses" describe where the money went rather than what it was for, which is
   * the question this filter answers — and it works on every account, including a card where a
   * deposit is a payment rather than income.
   */
  flowAll: 'All',
  flowIn: 'Deposits',
  flowOut: 'Expenses',

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

/**
 * Copy for categorizing.
 *
 * The rule prompt says what a rule will and will not do, because the surprising part is what it
 * leaves alone: rules only touch transactions with no category yet, so one can never undo a
 * decision somebody made by hand.
 */
export const CATEGORY_COPY = {
  assign: 'Category',
  uncategorized: 'Uncategorized',
  clear: 'Clear category',

  ruleFrom: 'Always categorize like this',
  rulePrompt: (payee: string, category: string): string =>
    `Categorize anything matching “${payee}” as ${category}.`,
  ruleScope: 'Applies to transactions that have no category yet. Nothing you set by hand changes.',
  ruleCreate: 'Create rule',
  ruleCreating: 'Creating',
  ruleCreated: (count: number): string =>
    count === 0
      ? 'Rule saved. Nothing else matched it.'
      : `Rule saved, and ${count} transaction${count === 1 ? '' : 's'} categorized.`,

  rulesHeading: 'Rules',
  rulesEmpty: 'No rules yet. Categorize something and Beans will offer to remember it.',
  ruleDelete: 'Delete',
  /** Deleting a rule leaves what it already did in place, which is worth saying. */
  ruleDeleteNote: 'Deleting a rule leaves transactions it already categorized as they are.',
  ruleApply: 'Apply rules',
  /** Named because the order decides outcomes: the first matching rule wins. */
  ruleRegex: 'Matched as a regular expression.',

  categoriesHeading: 'Categories',
  categoriesNote:
    'The set every household starts with. Renaming and adding your own is not built yet — rules reference a category’s stable slug, so a rename will not break them when it is.',
  kindLabel: {
    income: 'Income',
    expense: 'Spending',
    transfer: 'Transfer — left out of cash flow',
  },
} as const
