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
  | 'all'

export type RangeSelection =
  | { kind: 'preset'; key: PresetRangeKey }
  | { kind: 'custom'; start: IsoDate; end: IsoDate }

export type DateWindow = { start: IsoDate; end: IsoDate }

/**
 * The floor for "All time".
 *
 * Early enough that no household's records precede it, late enough to stay a plausible date rather
 * than reading as a bug when it surfaces in a URL or a request log.
 */
export const EARLIEST_SUPPORTED_DATE: IsoDate = '1970-01-01'

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

    /*
     * Everything, expressed as a date no financial history reaches behind.
     *
     * A sentinel rather than "the earliest date in the data" because this function is pure and knows
     * nothing about the data — and because the two would behave identically anyway: `sliceToWindow`
     * keeps what exists, and a series cannot start before its first point.
     *
     * The value matters for one caller beyond slicing. The history backfill asks the server for
     * everything from the window start, and the server echoes that back as how far the cache now
     * reaches — so after one "All time" the condition that triggers a backfill is false forever
     * rather than re-fetching on every render.
     */
    case 'all':
      return { start: EARLIEST_SUPPORTED_DATE, end: today }
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

/**
 * The whole calendar month containing a date, both endpoints inclusive.
 *
 * Distinct from the window a range resolves to. "This month" ends *today*, which is what the totals
 * should cover — but a chart drawn over that span would redraw its own axis every day and give a
 * month in progress no room to run into. The chart wants the month; the totals want what has
 * happened.
 */
export function monthWindow(date: IsoDate): DateWindow {
  const start = startOfMonth(date)
  /*
   * Thirty-two days past the first is always inside the next month, whatever its length. Taking the
   * first of *that* month and stepping back one day lands on this month's last day — February and
   * leap years included, with no month-length table.
   */
  const nextMonth = startOfMonth(addDays(start, 32))
  return { start, end: addDays(nextMonth, -1) }
}

/** The calendar month before the one containing `date`. */
export function previousMonthWindow(date: IsoDate): DateWindow {
  return monthWindow(addDays(startOfMonth(date), -1))
}
