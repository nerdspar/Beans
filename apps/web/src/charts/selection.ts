/**
 * Holding a point on a chart.
 *
 * Kept apart from the screen that uses it because the rule is subtle enough to be worth stating and
 * testing on its own: **only a tap toggles.** A drag ends on the index it was already reading, so
 * treating release as a toggle would clear the selection the instant a finger lifted — which is the
 * whole interaction on a phone.
 */

export type ChartSelection = { kind: 'month'; month: string } | { kind: 'day'; date: string }

function isSame(left: ChartSelection, right: ChartSelection): boolean {
  if (left.kind === 'month' && right.kind === 'month') return left.month === right.month
  if (left.kind === 'day' && right.kind === 'day') return left.date === right.date
  return false
}

/**
 * What a committed reading does to the current selection.
 *
 * Selections are stored by date rather than by index, so they survive a change of tab — the three
 * cash flow tabs are three views of the same selected month, and an index would point somewhere
 * else under each one's series.
 */
export function nextSelection(
  current: ChartSelection | null,
  incoming: ChartSelection,
  viaTap: boolean,
): ChartSelection | null {
  if (viaTap && current !== null && isSame(current, incoming)) return null
  return incoming
}
