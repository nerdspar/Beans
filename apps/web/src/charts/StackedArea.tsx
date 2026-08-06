import { CHART_COPY } from '@beans/shared'
import { useMemo, type ReactNode } from 'react'
import { labelPrecision, niceTicks } from './axis.js'
import { ChartTable } from './ChartTable.js'
import { CHART_TABLE_ROWS, sampleIndices } from './table-rows.js'
import { cn } from '../lib/cn.js'

/**
 * One band per account, stacked to the portfolio's total.
 *
 * A single line for a portfolio answers "what is it worth" and nothing else. Stacked, the same
 * pixels also say which accounts hold the money and which one moved — a band that thickens while
 * the total is flat is a transfer between two of them, and that is invisible on one line.
 *
 * Bands are drawn largest-first from the bottom, so the ordering matches the list beneath and does
 * not reshuffle as values cross.
 */

export type StackBand = {
  key: string
  label: string
  color: string
  /** One point per day. Days this account did not exist are simply absent. */
  points: ReadonlyArray<{ date: string; value: bigint }>
}

export type StackedAreaProps = {
  bands: readonly StackBand[]
  formatValue: (cents: bigint, fractionDigits: number) => string
  height?: number
  className?: string
  /**
   * Names the table fallback — "Portfolio by account".
   *
   * This chart used to be marked purely decorative, on the grounds that the account list beneath it
   * was the table a screen reader should read. That list is only ever *today*: it has no dates in
   * it. Everything this chart is actually for — which account grew, when a new one appeared, the
   * transfer that shows up as one band thickening while the total holds flat — lives in the time
   * axis, and none of it reached a reader who could not see the picture.
   */
  tableLabel?: string | undefined
}

const AXIS_HEIGHT = 18
const GRID_LINES = 4

const AXIS_DATE = new Intl.DateTimeFormat(undefined, {
  month: 'numeric',
  day: 'numeric',
  year: 'numeric',
  // UTC, as everywhere a YYYY-MM-DD meets Date: local formatting shifts it a day west of Greenwich.
  timeZone: 'UTC',
})

/** Cents to a plain number, for pixel geometry only. */
function toPixelUnits(cents: bigint): number {
  return Number(cents)
}

export function StackedArea({
  bands,
  formatValue,
  height = 220,
  className,
  tableLabel,
}: StackedAreaProps): ReactNode {
  const geometry = useMemo(() => {
    if (bands.length === 0) return null

    /*
     * Every date any band covers, in order.
     *
     * Accounts do not share a start — one connected last week sits inside a series that runs back a
     * year — so the axis is the union, and a band contributes nothing on days it has no value. That
     * is what makes a new account appear as a band growing from zero rather than shifting every
     * band above it.
     */
    const dates = [...new Set(bands.flatMap((band) => band.points.map((point) => point.date)))].sort()
    if (dates.length === 0) return null

    /*
     * One date-to-value lookup per band, built once and shared.
     *
     * The pixel math and the table fallback both need it, and building it twice would mean walking
     * every point of every account a second time on a screen that already has the data in hand.
     */
    const byDate = bands.map(
      (band) => new Map(band.points.map((point) => [point.date, point.value])),
    )
    const valueAt = byDate.map(
      (lookup) =>
        (date: string): number =>
          toPixelUnits(lookup.get(date) ?? 0n),
    )

    // Running totals, so each band's top is everything below it plus itself.
    const tops: number[][] = []
    let running = dates.map(() => 0)
    for (const at of valueAt) {
      running = running.map((sum, index) => sum + at(dates[index] ?? ''))
      tops.push([...running])
    }

    const max = Math.max(...running, 1)
    const width = 1000
    const plotHeight = Math.max(1, height - AXIS_HEIGHT)
    const x = (index: number): number =>
      dates.length === 1 ? width : (index / (dates.length - 1)) * width
    const y = (value: number): number => plotHeight - (value / max) * plotHeight

    /*
     * Each band is its own top edge left-to-right, then the band below it right-to-left. Drawing
     * every band from the baseline instead would stack opaque shapes over each other and leave only
     * the largest visible.
     */
    const paths = tops.map((top, index) => {
      const below = index === 0 ? dates.map(() => 0) : (tops[index - 1] ?? [])
      const forward = top.map((value, at) => `${x(at)},${y(value)}`).join(' L')
      const back = [...below]
        .map((value, at) => ({ value, at }))
        .reverse()
        .map(({ value, at }) => `${x(at)},${y(value)}`)
        .join(' L')
      return `M${forward} L${back} Z`
    })

    const halfLabel = 9
    const ticks = niceTicks(0, max, GRID_LINES).map((value) => ({
      value: BigInt(Math.round(value)),
      y: y(value),
      labelY: Math.min(Math.max(y(value), halfLabel), plotHeight - halfLabel),
    }))

    return {
      width,
      plotHeight,
      paths,
      ticks,
      precision: labelPrecision(
        ticks.map((tick) => tick.value),
        formatValue,
      ),
      start: dates[0],
      end: dates[dates.length - 1],

      /*
       * Built here rather than in a second memo because `dates` is the expensive part — a union of
       * every date across every band, deduplicated and sorted — and it is already in hand.
       *
       * The total is its own column, and is the one most readers want: the stack's height is the
       * portfolio, and reconstructing it by adding six account columns by ear is not a reasonable
       * thing to ask of anyone.
       */
      tableRows: sampleIndices(dates.length, CHART_TABLE_ROWS).flatMap((index) => {
        const date = dates[index]
        if (date === undefined) return []

        const values = bands.map((band, bandIndex) => byDate[bandIndex]?.get(date) ?? 0n)
        const total = values.reduce((sum, value) => sum + value, 0n)

        return [
          {
            header: AXIS_DATE.format(new Date(`${date}T00:00:00Z`)),
            cells: [...values.map((value) => formatValue(value, 2)), formatValue(total, 2)],
          },
        ]
      }),
      dateCount: dates.length,
    }
  }, [bands, height, formatValue])

  if (geometry === null) return null

  return (
    <div className={cn('relative', className)}>
      <svg
        viewBox={`0 0 ${geometry.width} ${geometry.plotHeight}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height: geometry.plotHeight }}
        // The paths themselves say nothing useful aloud; the table at the end of this component is
        // what a screen reader reads instead.
        aria-hidden
      >
        {geometry.ticks.map((tick) => (
          <line
            key={tick.y}
            x1={0}
            x2={geometry.width}
            y1={tick.y}
            y2={tick.y}
            className="stroke-slate-200 dark:stroke-slate-800"
            strokeWidth={1}
            strokeDasharray="4 6"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {geometry.paths.map((path, index) => (
          <path key={bands[index]?.key ?? index} d={path} fill={bands[index]?.color ?? '#64748b'} />
        ))}
      </svg>

      <div
        className="flex justify-between px-1 text-[11px] tabular-nums text-slate-500 dark:text-slate-400"
        style={{ height: AXIS_HEIGHT }}
        aria-hidden
      >
        <span>{geometry.start === undefined ? '' : AXIS_DATE.format(new Date(`${geometry.start}T00:00:00Z`))}</span>
        <span>{geometry.end === undefined ? '' : AXIS_DATE.format(new Date(`${geometry.end}T00:00:00Z`))}</span>
      </div>

      {/* Value labels over the plot rather than in SVG, so they stay crisp under the stretch. */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0"
        style={{ height: geometry.plotHeight }}
        aria-hidden
      >
        {geometry.ticks.map((tick) => (
          <span
            key={tick.y}
            className={cn(
              'absolute left-0 -translate-y-1/2 rounded px-1 text-[11px] tabular-nums',
              'bg-slate-50/80 text-slate-500 dark:bg-slate-950/80 dark:text-slate-400',
            )}
            style={{ top: tick.labelY }}
          >
            {formatValue(tick.value, geometry.precision)}
          </span>
        ))}
      </div>

      {tableLabel !== undefined && (
        <ChartTable
          label={tableLabel}
          columns={[
            CHART_COPY.dateColumn,
            ...bands.map((band) => band.label),
            CHART_COPY.totalColumn,
          ]}
          rows={geometry.tableRows}
          sampledFrom={geometry.dateCount}
        />
      )}
    </div>
  )
}
