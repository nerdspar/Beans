import { addDays, compareDates, type IsoDate } from '../balance-history/dates.js'

/**
 * Resolving a selected time range to the calendar window it covers.
 *
 * Ranges started life as a trailing day count — "this month" meant 30 days, "YTD" meant 215 — which
 * held up only while nothing depended on where a range landed. It stops holding up as soon as a
 * range has real boundaries: "last month" starts on the 1st and ends on the last day, and a custom
 * range is two dates with no day count behind them at all.
 *
 * So a range resolves to an explicit `{ start, end }` and slicing is a date filter. Calendar options
 * then mean what they say, and custom stops being a special case — it is the same shape as
 * everything else, supplied rather than computed.
 *
 * Lives in shared rather than the client because the net worth endpoint has to resolve the same
 * names. A server that disagreed with the client about where "last month" begins would return a
 * window the user did not ask for, and the disagreement would show up as an off-by-a-few-days
 * discrepancy that is very hard to attribute after the fact.
 *
 * `today` is always a parameter. Reading the clock in here would make every result depend on when
 * the test ran, and on the runner's timezone.
 */

export type PresetRangeKey =
  | 'this-month'
  | 'last-month'
  | '90-days'
  | '1-year'
  | 'ytd'
  | 'last-year'

export type RangeSelection =
  | { kind: 'preset'; key: PresetRangeKey }
  | { kind: 'custom'; start: IsoDate; end: IsoDate }

export type DateWindow = { start: IsoDate; end: IsoDate }

function startOfMonth(date: IsoDate): IsoDate {
  return `${date.slice(0, 7)}-01`
}

function startOfYear(date: IsoDate): IsoDate {
  return `${date.slice(0, 4)}-01-01`
}

/**
 * Turns a selection into the window it covers.
 *
 * Every preset ends at `today` except the two naming a closed period — "last month" and "last year"
 * end where that period ended, not where the data does. A completed month running on to today would
 * not be last month.
 */
export function resolveWindow(selection: RangeSelection, today: IsoDate): DateWindow {
  if (selection.kind === 'custom') {
    return { start: selection.start, end: selection.end }
  }

  switch (selection.key) {
    case 'this-month':
      return { start: startOfMonth(today), end: today }

    case 'last-month': {
      // Backing up one day from the 1st lands on the last day of the previous month, whatever length
      // that month was, February included. No month-length table, no leap year case.
      const end = addDays(startOfMonth(today), -1)
      return { start: startOfMonth(end), end }
    }

    /*
     * Inclusive of both endpoints, so "90 days" spans ninety days rather than ninety-one. Worth the
     * pedantry now that the axis states its own start date: a range labelled 90 days whose labels
     * are 91 days apart is visibly wrong.
     */
    case '90-days':
      return { start: addDays(today, -89), end: today }

    case '1-year':
      return { start: addDays(today, -364), end: today }

    case 'ytd':
      return { start: startOfYear(today), end: today }

    case 'last-year': {
      const year = Number(today.slice(0, 4)) - 1
      return { start: `${year}-01-01`, end: `${year}-12-31` }
    }
  }
}

/** Narrows a series to a window. Inclusive at both ends, matching {@link resolveWindow}. */
export function sliceToWindow<T extends { date: IsoDate }>(
  series: readonly T[],
  window: DateWindow,
): T[] {
  return series.filter(
    (point) =>
      compareDates(point.date, window.start) >= 0 && compareDates(point.date, window.end) <= 0,
  )
}

export type CustomRangeError = 'order' | 'future' | null

/**
 * Why a pair of dates is not usable as a range, or null if it is.
 *
 * A future end date is rejected rather than clamped. Clamping silently shows a different range than
 * the one that was asked for, and this is the last place to quietly change what a number covers.
 */
export function validateCustomRange(
  start: IsoDate,
  end: IsoDate,
  today: IsoDate,
): CustomRangeError {
  if (compareDates(end, start) < 0) return 'order'
  if (compareDates(end, today) > 0) return 'future'
  return null
}
