/**
 * Calendar date arithmetic, on `YYYY-MM-DD` strings.
 *
 * Balance history is indexed by calendar date, never by instant. A transaction posted on the 3rd is
 * on the 3rd regardless of anyone's timezone, and a daily balance series has one entry per calendar
 * day rather than per 24-hour period.
 *
 * Everything here works on strings and converts through UTC only internally, so no local timezone
 * can shift a day. `Date` never escapes this module — the moment a date becomes a `Date` in a
 * timezone-bearing context, off-by-one-day bugs become possible again.
 */

/** A calendar date in `YYYY-MM-DD` form. */
export type IsoDate = string

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 24 * 60 * 60 * 1000

export class DateRangeError extends Error {
  override readonly name = 'DateRangeError'
}

export function assertIsoDate(value: string): IsoDate {
  if (!ISO_DATE.test(value)) {
    throw new DateRangeError(`Expected a YYYY-MM-DD date, received ${JSON.stringify(value)}`)
  }
  return value
}

/** Converts an instant to the UTC calendar date it falls on. */
export function toIsoDate(value: Date): IsoDate {
  return value.toISOString().slice(0, 10)
}

function toUtcMillis(date: IsoDate): number {
  // Appending the time and zone explicitly, rather than relying on Date's bare-date parsing, which
  // is UTC for `YYYY-MM-DD` but local for other forms — a distinction too subtle to depend on.
  return Date.parse(`${date}T00:00:00.000Z`)
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return new Date(toUtcMillis(date) + days * DAY_MS).toISOString().slice(0, 10)
}

/** Whole days from `from` to `to`. Negative when `to` precedes `from`. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((toUtcMillis(to) - toUtcMillis(from)) / DAY_MS)
}

export function compareDates(left: IsoDate, right: IsoDate): number {
  // Lexicographic comparison is correct for zero-padded ISO dates, and avoids parsing entirely.
  return left < right ? -1 : left > right ? 1 : 0
}

export function minDate(left: IsoDate, right: IsoDate): IsoDate {
  return left <= right ? left : right
}

export function maxDate(left: IsoDate, right: IsoDate): IsoDate {
  return left >= right ? left : right
}

/**
 * Every calendar date from `from` to `to`, inclusive at both ends.
 *
 * Returns empty when `to` precedes `from` rather than throwing — an empty range is a normal result
 * for an account whose coverage has not started yet.
 */
export function eachDay(from: IsoDate, to: IsoDate): IsoDate[] {
  const span = daysBetween(from, to)
  if (span < 0) {
    return []
  }

  const dates: IsoDate[] = new Array<IsoDate>(span + 1)
  let cursor = from
  for (let index = 0; index <= span; index += 1) {
    dates[index] = cursor
    cursor = addDays(cursor, 1)
  }
  return dates
}
