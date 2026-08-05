/**
 * Copy for cash flow.
 *
 * Plain throughout, and especially where a number is unfavourable. Spending more than you earned in
 * a month is stated and not commented on — no encouragement, no commiseration, no joke. That rule
 * matters more here than anywhere else in the app, because this is the screen where it happens.
 */

export const CASH_FLOW_COPY = {
  title: 'Cash flow',
  income: 'Income',
  spending: 'Spending',
  net: 'Net',

  /** Words, not a bare sign: for a monthly total the direction is the whole point. */
  saved: 'saved',
  overspent: 'more than you earned',

  loading: 'Counting the beans.',
  empty: 'Nothing to add up yet',
  emptyDetail:
    'Cash flow is built from transactions. Connect an institution, or widen the date range if you have only just synced.',

  /*
   * Tabs split by question, not by rendering.
   *
   * A category breakdown only means something once a direction is chosen — groceries and a paycheck
   * cannot share an axis, and the figure they would sum to is net, which nobody breaks down by
   * category. So the breakdowns live under Income and Expenses, and the combined tab answers the
   * different question of what the two did to each other.
   */
  tabCashFlow: 'Cash flow',
  tabIncome: 'Income',
  tabExpenses: 'Expenses',

  /** Prefixed rather than bare: an unlabelled dashed line is a mystery, not a reference. */
  average: (amount: string): string => `Avg ${amount}`,

  byCategory: 'Where it went',
  byCategoryIncome: 'Where it came from',
  byMonth: 'By month',

  /*
   * The single-month view. "Compared with" rather than "vs" because the dotted line is doing real
   * work — without naming it, a second line on a chart is decoration nobody can interpret.
   */
  comparedWith: 'Dotted: the period before, day by day.',
  runningTotal: 'Running total',
  byMonthReading: 'Month',

  /*
   * A pinned selection needs a way out that is not "hit the same pixel again".
   *
   * Tapping the same bar clears it, which is fine on a bar and impossible on a 31-day line — so the
   * chip is the escape hatch that always works, and it doubles as the only visible statement that
   * the figures below describe a selection rather than the range.
   */
  showingSelection: (label: string): string => `Showing ${label}`,
  clearSelection: 'Clear',
  throughDay: (label: string): string => `Through ${label}`,
  activityHeading: 'What happened',
  activityEmpty: 'Nothing posted in this period.',

  /**
   * Reasons the totals below may be wrong, each with its size.
   *
   * The point is the number. "$4,200 of the spending below is uncategorized" is something somebody
   * can act on; "some transactions are uncategorized" is a disclaimer people learn to scroll past.
   * The strip disappears entirely when there is nothing to say, so its presence means something.
   */
  caveatsHeading: 'Worth checking',
  /** The count carries while collapsed, so folding it away does not hide that anything is wrong. */
  caveatsCount: (count: number): string => `${count}`,
  caveatTransfers: (count: number, amount: string): string =>
    `${count} possible transfer${count === 1 ? '' : 's'} not confirmed — ${amount} is counted as both income and spending.`,
  caveatTransfersAction: 'Review',
  caveatUncategorizedSpending: (amount: string): string =>
    `${amount} of the spending below has no category.`,
  caveatUncategorizedIncome: (amount: string): string =>
    `${amount} of the income below has no category.`,
  caveatCategorize: 'Categorize',

  transfersHeading: 'Money you moved',
  /** Stated because a number that silently ignored some transactions would be unaccountable. */
  transfersExcluded: (count: number): string =>
    count === 0
      ? 'No transfers excluded.'
      : `${count} transfer${count === 1 ? '' : 's'} excluded, so moving money between your own accounts does not read as income or spending.`,

  reviewHeading: 'Possible transfers',
  reviewBlurb:
    'These look like money moved between your own accounts. Confirming keeps them out of income and spending; they are counted until you do.',
  reviewFind: 'Look for transfers',
  reviewFinding: 'Looking',
  confirm: 'Yes, a transfer',
  reject: 'Not a transfer',
  reviewNone: 'Nothing to review.',
  /** The amount is deliberately shown once — the two sides are equal by construction. */
  movedFrom: 'from',
  movedTo: 'to',
} as const
