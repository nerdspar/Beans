import { CHART_COPY } from '@beans/shared'
import type { ReactNode } from 'react'

/**
 * The table behind a chart, for readers who cannot see the chart.
 *
 * Every chart in Beans draws into an `aria-hidden` SVG, which is right — a path element announced
 * point by point is noise. What replaces it has to be a real table: a `caption` naming what it
 * shows, `th scope="col"` on the headings and `th scope="row"` on each row label, so a screen
 * reader can say "Net worth, 3 March 2019, $412,000" when the reader lands on a cell. A grid of
 * `div`s with the same text in it announces as a wall of numbers with no way to tell which column
 * you are in.
 *
 * Visually hidden rather than shown behind a toggle. A toggle is arguably better — sighted readers
 * want exact numbers too — but it is a design change to five screens, and the fallback is the part
 * that is currently missing. This is the smaller thing that closes the gap; the toggle can come
 * later without changing this component.
 */

export type ChartTableRow = {
  /** The row's own heading — a date or a month, not a value. */
  header: string
  /** Formatted values, one per column after the first. Already strings: money is never a number. */
  cells: readonly string[]
}

export type ChartTableProps = {
  /** What the chart shows, e.g. "Net worth". Not a sentence — the caption builds one. */
  label: string
  /** Headings, starting with the row-label column. */
  columns: readonly string[]
  rows: readonly ChartTableRow[]
  /**
   * The full series length, when `rows` is a sample of it. Omit when the table is complete —
   * a "24 of 24" note tells the reader nothing and implies something was withheld.
   */
  sampledFrom?: number | undefined
  /**
   * Replaces the default sampled-rows sentence.
   *
   * The default mentions a slider and talks about days, which is right for the five daily charts it
   * was written for and wrong for anything else. A projection plots calendar years and has no
   * slider, so telling a screen-reader user to reach for one sends them looking for a control that
   * is not there.
   */
  sampledNote?: ((shown: number, total: number) => string) | undefined
}

export function ChartTable({
  label,
  columns,
  rows,
  sampledFrom,
  sampledNote,
}: ChartTableProps): ReactNode {
  if (rows.length === 0) return null

  const sampled = sampledFrom !== undefined && sampledFrom > rows.length

  /*
   * `sr-only` goes on a wrapping div, not on the table.
   *
   * It cannot do its job on a `<table>`. The utility works by clamping to 1×1 and clipping, but a
   * table box takes its specified width as a *minimum* — CSS table layout will not shrink below
   * min-content — so `width: 1px` is ignored and the element stays its natural size. Measured in a
   * browser: 261×480, positioned absolutely over the chart, hidden only because `clip-path` happens
   * to still apply.
   *
   * That works, and it is one `overflow: auto` ancestor away from not working. A div has no such
   * rule, collapses to 1×1 as intended, and clips the table inside it.
   */
  return (
    <div className="sr-only">
      <table>
        <caption>
          {CHART_COPY.tableCaption(label)}
          {sampled
            ? `. ${(sampledNote ?? CHART_COPY.sampledNote)(rows.length, sampledFrom)}`
            : ''}
        </caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            // Index, not the header: two rows can legitimately share a label once a series is
            // sampled by month, and a duplicate key drops one of them silently.
            <tr key={index}>
              <th scope="row">{row.header}</th>
              {row.cells.map((cell, cellIndex) => (
                <td key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
