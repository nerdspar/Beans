import type { IsoDate } from '@beans/shared'

/**
 * What day it is where the reader is.
 *
 * `toIsoDate` converts an instant to the **UTC** calendar date it falls on, which is right for the
 * server and wrong in a browser. Those two dates are not the same for most of the evening in the
 * Americas: at 11:45pm Eastern, UTC is already tomorrow.
 *
 * Every use of it in the client meant the reader's today, and the consequences ran from cosmetic to
 * real — a sync from this afternoon described as "yesterday", a date input refusing today as a
 * future date, and on the last evening of a month, "This month" quietly resolving to the next one.
 *
 * The server keeps using `toIsoDate`. It has no reader and no timezone to speak of, and the daily
 * snapshot deliberately runs on the UTC calendar.
 */
export function localIsoDate(instant: Date): IsoDate {
  const year = instant.getFullYear()
  const month = String(instant.getMonth() + 1).padStart(2, '0')
  const day = String(instant.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Today, on the reader's calendar. */
export function localToday(): IsoDate {
  return localIsoDate(new Date())
}
