import type { NetWorthSection } from '@beans/shared'

/**
 * A colour per net worth section, used for both the pinned header fill and the chart fill.
 *
 * Chosen so that adjacent sections in the scroll order are distinguishable, and so the two
 * liability sections read as liabilities without being the same colour as each other. Household
 * net worth gets its own, distinct from every category, because it is the state you return to
 * rather than a category you scroll into.
 *
 * Deliberately not the semantic red/green used for a change over a range — a mortgage section is
 * not "bad", it is a category. Direction of change is a separate signal and keeps its own palette.
 */
export const SECTION_COLORS: Record<NetWorthSection | 'household', string> = {
  household: '#3b82f6',
  cash: '#6366f1',
  investment: '#0ea5e9',
  credit_card: '#f43f5e',
  loan: '#f97316',
  mortgage: '#eab308',
  other_assets: '#22d3ee',
  other_liabilities: '#a855f7',
}

/** Section headings. Plain labels — this is chrome you navigate by. */
export const SECTION_LABELS: Record<NetWorthSection, string> = {
  cash: 'Cash',
  investment: 'Investment',
  credit_card: 'Credit card',
  loan: 'Loan',
  mortgage: 'Mortgage',
  other_assets: 'Other assets',
  other_liabilities: 'Other liabilities',
}
