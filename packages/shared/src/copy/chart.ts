/**
 * Copy for charts and their table fallbacks.
 *
 * Plain throughout. A caption and a set of column headings are things a reader navigates by — and
 * this reader is navigating by them without the picture, so they carry more weight here than usual,
 * not less. The one place a voice would be allowed is the empty state, and it declines: a chart with
 * nothing in it is often a chart that is still loading or an account that failed to sync, and a joke
 * lands badly on both.
 */

export const CHART_COPY = {
  /** Column headings for the row label — the thing each row is *about*. */
  dateColumn: 'Date',
  monthColumn: 'Month',
  /** The stacked total, where a chart's bands sum to something the reader cares about. */
  totalColumn: 'Total',
  /** Heads a second series drawn for contrast, when the caller does not name it. */
  comparisonColumn: 'Compared with',

  /**
   * A cell with no figure behind it.
   *
   * A dash rather than a zero, and the distinction is the point: zero is a balance, absence is not
   * knowing. Reading "$0.00" for a day a comparison series does not reach would be Beans asserting
   * something it has no basis for.
   */
  noValue: '—',

  /** Names the table so it is not announced as an unlabelled table of numbers. */
  tableCaption: (label: string): string => `${label}, as a table`,

  /**
   * Says the table is a sample, and is not optional.
   *
   * Without it the fallback reads as the whole series, and a reader could reasonably conclude that
   * Beans holds twenty-four readings of their net worth rather than eight years of them. The chart
   * is a slider that steps through every point, so the full detail is there — this sentence is what
   * tells someone it is worth reaching for.
   */
  sampledNote: (shown: number, total: number): string =>
    `${shown} of ${total.toLocaleString()} readings, evenly spaced. Use the chart slider for any single day.`,

  /**
   * No data to draw.
   *
   * Deliberately "yet". The usual cause is a range that starts before Beans had any history for the
   * account, which resolves itself as history accumulates — so the state is temporary and saying
   * otherwise would send someone looking for a fault that is not there.
   */
  empty: 'Nothing to chart yet.',

  /**
   * Fallback names for the chart scrubber, used when a screen does not supply its own.
   *
   * Every real screen should: "Read by date" says how to work the control but not what it reads,
   * and on a screen with two charts that is the one thing the label needed to do. They exist so a
   * chart is never an unlabelled slider, which is the worse failure.
   */
  scrubByDate: 'Read by date',
  scrubByMonth: 'Read by month',
} as const
