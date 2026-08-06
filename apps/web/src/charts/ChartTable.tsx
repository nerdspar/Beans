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
}

export function ChartTable({ label, columns, rows, sampledFrom }: ChartTableProps): ReactNode {
  if (rows.length === 0) return null

  const sampled = sampledFrom !== undefined && sampledFrom > rows.length

  return (
    <table className="sr-only">
      <caption>
        {CHART_COPY.tableCaption(label)}
        {sampled ? `. ${CHART_COPY.sampledNote(rows.length, sampledFrom)}` : ''}
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
  )
}
