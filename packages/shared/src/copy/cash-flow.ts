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

  byCategory: 'Where it went',
  byMonth: 'By month',

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
