import { toIsoDate, type IsoDate, type PresetRangeKey, type RangeSelection } from '@beans/shared'

/**
 * The presentation half of the range model.
 *
 * Resolution itself lives in `@beans/shared` — the net worth endpoint has to agree with the client
 * about where "last month" begins, and two implementations of that would disagree eventually. What
 * stays here is only what a server has no opinion about: the labels, the default, and reading the
 * clock.
 */

export {
  resolveWindow,
  sliceToWindow,
  validateCustomRange,
  type DateWindow,
  type PresetRangeKey,
  type RangeSelection,
} from '@beans/shared'

export const PRESETS: ReadonlyArray<{ key: PresetRangeKey; label: string }> = [
  { key: 'this-month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
  { key: '90-days', label: '90 days' },
  { key: '1-year', label: '1 year' },
  { key: 'ytd', label: 'YTD' },
  { key: 'last-year', label: 'Last year' },
]

export const DEFAULT_RANGE: RangeSelection = { kind: 'preset', key: '90-days' }

/**
 * Today as a calendar date.
 *
 * The only place the clock is read. Everything downstream takes it as an argument, which is what
 * keeps the window logic testable and free of the runner's timezone.
 */
export function todayIso(): IsoDate {
  return toIsoDate(new Date())
}

const SHORT_DATE = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  // UTC for the same reason as everywhere else a `YYYY-MM-DD` meets `Date`: formatting a
  // UTC-parsed date in local time shifts the day backwards west of Greenwich.
  timeZone: 'UTC',
})

/**
 * The label for the control that opens the range sheet.
 *
 * A custom range reads as "Custom" rather than spelling out its dates. The dates are long enough to
 * wrap the button onto two lines and shove the headline total around, and they are **already on
 * screen** — the chart's x-axis states both endpoints. Repeating them in the control costs layout
 * to say something the user is looking at. {@link rangeDetail} spells them out where there is room.
 */
export function rangeLabel(selection: RangeSelection): string {
  if (selection.kind === 'custom') {
    return 'Custom'
  }

  return PRESETS.find((preset) => preset.key === selection.key)?.label ?? '90 days'
}

/** The custom range written out, for the sheet — where the width exists and the axis does not. */
export function rangeDetail(selection: RangeSelection): string | null {
  if (selection.kind !== 'custom') return null

  const format = (date: IsoDate): string => SHORT_DATE.format(new Date(`${date}T00:00:00Z`))
  return `${format(selection.start)} – ${format(selection.end)}`
}
