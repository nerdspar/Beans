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

  // ── One transaction, in full ───────────────────────────────────────────────
  notFound: 'That transaction is no longer here.',
  detailAccount: 'Account',
  /**
   * Named plainly, because the point of showing it is that it is *raw*.
   *
   * The payee is the readable half; the description is where an institution puts the reference code
   * that actually identifies a charge. When a name is ambiguous that string is the answer, and the
   * list can only ever show a truncated line of it.
   */
  detailDescription: 'As your bank sent it',
  detailCategorize: 'Set category',

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
  ruleRegex: 'Matched as patterns.',

  // ── Building a rule ────────────────────────────────────────────────────────
  ruleNew: 'New rule',
  ruleEdit: 'Edit rule',
  ruleAdd: 'Add a rule',
  ruleKeywordsLabel: 'Keywords',
  ruleKeywordPlaceholder: 'Type a word and press Enter',
  ruleKeywordRemove: (keyword: string): string => `Remove ${keyword}`,
  ruleModeLabel: 'Match when',
  ruleMode: { any: 'Any keyword', all: 'Every keyword' },
  /**
   * Spelled out rather than labelled AND/OR.
   *
   * This choice changes what a rule does more than any other field, and the failure is silent:
   * "every" on a merchant's several spellings never fires, "any" on two narrowing words fires on
   * far too much. Neither looks wrong until transactions are already categorized.
   */
  ruleModeHelp: {
    any: 'One merchant, spelled several ways',
    all: 'Narrow a broad word with a second',
  },
  ruleCategoryLabel: 'Category',
  rulePickCategory: 'Choose a category',
  /**
   * Named for when you would want it, not for what it does.
   *
   * It read "treat each keyword as a regular expression", which answers a question nobody asked and
   * assumes the reader knows what that is. It is also mostly obsolete: the reason people reached for
   * it was alternation, and a keyword list already says "any of these" without a syntax.
   */
  ruleRegexToggle: 'Advanced: match with patterns',
  ruleRegexHelp:
    'Keywords normally match anywhere in a description. Turn this on to use regular expressions instead — for things plain words cannot say, like “starts with”. Most rules never need it.',
  ruleSave: 'Save rule',
  ruleSaving: 'Saving',
  ruleCancel: 'Cancel',
  ruleEditAction: 'Edit',

  // ── Suggested rules ────────────────────────────────────────────────────────
  suggestionsHeading: 'Worth a rule',
  /**
   * Says where these come from, because "how did it know that" is the first question.
   *
   * They are read off the household's own transactions rather than a merchant list shipped with
   * Beans — nothing leaves the machine, and the merchants are the ones that actually appear.
   */
  suggestionsNote:
    'Merchants appearing more than once with nothing assigned, read from your own transactions. Tap one to build a rule from it.',
  suggestionDetail: (count: number, category: string | null): string =>
    category === null
      ? `${count} uncategorized`
      : `${count} uncategorized · you usually call this ${category}`,

  categoriesHeading: 'Categories',
  categoriesNote:
    'Rules reference a category’s stable slug rather than its label, so renaming one never breaks them.',

  // ── Editing categories ─────────────────────────────────────────────────────
  categoryAdd: 'Add category',
  categoryAddChild: 'Add subcategory',
  categoryName: 'Name',
  categoryKind: 'Kind',
  categoryParent: 'Inside',
  categoryTopLevel: 'Top level',
  categorySave: 'Save',
  categorySaving: 'Saving',
  categoryCancel: 'Cancel',
  categoryRename: 'Rename',
  categoryDelete: 'Delete',

  /**
   * Deleting asks where things go, rather than telling you afterwards.
   *
   * "Deleted" quietly meaning "and uncategorized four hundred transactions" is the kind of thing
   * somebody finds a month later in a cash flow chart, by which point they cannot tell what changed.
   */
  categoryDeleteTitle: (name: string): string => `Remove “${name}”?`,
  categoryDeletePrompt: 'Move anything using it to:',
  categoryDeleteUncategorized: 'Leave it uncategorized',
  categoryDeleted: (transactions: number, rules: number): string => {
    const parts: string[] = []
    if (transactions > 0) {
      parts.push(`${transactions} transaction${transactions === 1 ? '' : 's'} moved`)
    }
    if (rules > 0) parts.push(`${rules} rule${rules === 1 ? '' : 's'} moved`)
    return parts.length === 0 ? 'Category removed.' : `Category removed, ${parts.join(' and ')}.`
  },
  kindLabel: {
    income: 'Income',
    expense: 'Spending',
    transfer: 'Transfer — left out of cash flow',
  },
} as const
