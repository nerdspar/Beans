/**
 * Copy for the subscriptions screen.
 *
 * Plain. A price rise and a yearly total are both numbers moving the wrong way for somebody, and
 * they are stated without comment — no "ouch", no nudge to cancel. The empty and loading states are
 * where the voice is allowed.
 */

export const SUBSCRIPTIONS_COPY = {
  title: 'Subscriptions',
  blurb: 'Charges that repeat on a schedule, found from your transactions.',

  subscriptionsHeading: 'Subscriptions',
  billsHeading: 'Bills',
  hiddenHeading: 'Hidden',

  /** The headline figure: what the active ones add up to over a year. */
  yearlyTotal: 'Per year',
  monthlyTotal: 'Per month',
  activeCount: (count: number): string => `${count} active`,

  cadence: {
    weekly: 'Weekly',
    biweekly: 'Every two weeks',
    monthly: 'Monthly',
    quarterly: 'Quarterly',
    annual: 'Yearly',
  },

  perYear: (amount: string): string => `${amount}/yr`,
  next: (date: string): string => `Next around ${date}`,
  lapsed: (date: string): string => `No charge since ${date}`,
  /** A bill's amount moves, so it is described as typical rather than stated as the price. */
  typical: (amount: string): string => `Usually ${amount}`,
  priceChange: (from: string, date: string): string => `Was ${from} until ${date}`,

  /** Actions on one series. */
  moveToBills: 'Move to bills',
  moveToSubscriptions: 'Move to subscriptions',
  hide: 'Not recurring',
  unhide: 'Show again',
  /** Undoing a move puts it back to what the detector concluded. */
  resetDecision: 'Undo',
  actionFailed: 'That did not save. Try again in a moment.',

  charges: 'Charges',
  viewCharges: (count: number): string => `${count} charge${count === 1 ? '' : 's'}`,

  /** Stated because a lapsed series could equally be a cancellation or a changed card. */
  lapsedNote:
    'Lapsed means a charge is overdue. That is usually a cancellation, but a new card number can look the same.',
  windowNote:
    'Found from about two years of history. A yearly charge needs to appear twice before it shows up here.',

  loading: 'Looking for patterns.',
  empty: 'Nothing recurring yet',
  emptyDetail:
    'Beans needs a few months of transactions to spot a pattern. Check back after a couple more syncs.',
  hiddenEmpty: 'Nothing hidden.',
} as const
