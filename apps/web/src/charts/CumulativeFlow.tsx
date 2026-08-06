import { CHART_COPY } from '@beans/shared'
import { useCallback, useMemo, type ReactNode } from 'react'
import { indexAtPosition } from './AreaChart.js'
import { ChartTable } from './ChartTable.js'
import { CHART_TABLE_ROWS, sampleIndices } from './table-rows.js'
import { useChartScrub } from './use-chart-scrub.js'
import { labelPrecision, niceTicks } from './axis.js'
import { cn } from '../lib/cn.js'

/**
 * A running total across one period, with the period before it dotted behind.
 *
 * The comparison line is the whole point. A cumulative total on its own says what happened; the same
 * period a month earlier, aligned by day, says whether that is unusual — which is the question
 * somebody actually opens this screen with.
 *
 * Aligned **by index, not by date**: point 7 is the seventh day of each window. Months are not the
 * same length, and matching 31 days against 28 would end the comparison three days early and read
 * as a collapse in spending.
 */

export type CumulativePoint = {
  date: string
  cumulativeCents: bigint
}

export type CumulativeFlowProps = {
  series: readonly CumulativePoint[]
  /** The same window one period earlier. Drawn dotted, and omitted when there is no history. */
  comparison?: readonly CumulativePoint[] | undefined
  color: string
  /**
   * Rendered as the value axis.
   *
   * Takes a decimal count, because the chart is the only thing that knows how close together its
   * own ticks are — a narrow domain collapses every label to the same string at two places.
   */
  formatValue: (cents: bigint, fractionDigits: number) => string
  height?: number
  className?: string

  /** Index being read, or null. The screen owns it so the header and the list can follow. */
  scrubIndex?: number | null
  onScrub?: ((index: number | null) => void) | undefined
  describePoint?: ((index: number) => string) | undefined
  scrubLabel?: string
  /** A committed reading: a tap, or the end of a drag. See use-chart-scrub. */
  onSelect?: ((index: number, viaTap: boolean) => void) | undefined
  /** The pinned day, held after the pointer leaves. */
  selectedIndex?: number | null

  /**
   * How many points are real rather than future.
   *
   * A month in progress has days that have not happened. Drawing them would be a line at today's
   * total running to the end of the month, which reads as "nothing more will be spent" — a forecast
   * the chart is in no position to make.
   */
  elapsedCount?: number | undefined

  /** Names the table fallback — "Running total". */
  tableLabel?: string | undefined
  /** Heads the comparison column. Ignored when there is no comparison series. */
  comparisonLabel?: string | undefined
}

const AXIS_HEIGHT = 18

/** Five is enough to convey scale and few enough to stay legible at phone width. */
const GRID_LINES = 5

/**
 * A label every seventh day, and a tick on every one.
 *
 * Weekly, because a month's rhythm is weekly — rent on the 1st, pay on the 15th, a weekend of
 * spending — and a reader locating "the week I overspent" is counting weeks, not days. Ticks on
 * every day keep the axis honest about what the line is made of.
 */
const LABEL_EVERY = 7

/** Cents to a plain number for pixel geometry only. */
function toPixelUnits(cents: bigint): number {
  return Number(cents)
}

const DAY_LABEL = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
})

function formatDay(date: string): string {
  return DAY_LABEL.format(new Date(`${date}T00:00:00Z`))
}

export function CumulativeFlow({
  series,
  comparison,
  color,
  formatValue,
  height = 190,
  className,
  scrubIndex = null,
  onScrub,
  describePoint,
  scrubLabel,
  elapsedCount,
  onSelect,
  selectedIndex = null,
  tableLabel,
  comparisonLabel,
}: CumulativeFlowProps): ReactNode {
  /*
   * Readable up to the last day that has happened, not to the end of the month.
   *
   * The line already stops at `elapsedCount` — drawing further would forecast — but the scrub
   * resolved across the whole series, so dragging into the rest of the month reported a running
   * total for days that have not occurred. It read as a real figure because every other position
   * on the chart is one.
   *
   * Resolved against the full width so a position still maps to the day under the finger, then
   * clamped: the alternative, mapping the elapsed days across the whole width, would slide the
   * reading away from the pointer.
   */
  const lastReadable = Math.max(0, Math.min(elapsedCount ?? series.length, series.length) - 1)

  const resolveIndex = useCallback(
    (offsetX: number, width: number) => {
      const index = indexAtPosition(offsetX, width, series.length)
      return index === null ? null : Math.min(index, lastReadable)
    },
    [series.length, lastReadable],
  )

  /*
   * Stops at `lastReadable`, for the same reason the scrub does.
   *
   * A month-to-date series runs to the end of the month, and the days after today carry the last
   * real running total repeated forward. Listing them would report a figure for the 28th on the
   * 12th — indistinguishable from a real one in a table, where there is no flat line to see.
   */
  const tableRows = useMemo(
    () =>
      tableLabel === undefined
        ? []
        : sampleIndices(lastReadable + 1, CHART_TABLE_ROWS).flatMap((index) => {
            const point = series[index]
            if (point === undefined) return []

            const cells = [formatValue(point.cumulativeCents, 2)]
            if (comparison !== undefined) {
              const against = comparison[index]
              cells.push(
                against === undefined ? CHART_COPY.noValue : formatValue(against.cumulativeCents, 2),
              )
            }

            return [{ header: formatDay(point.date), cells }]
          }),
    [tableLabel, lastReadable, series, comparison, formatValue],
  )

  const scrub = useChartScrub({
    count: series.length,
    resolveIndex,
    onScrub,
    onSelect,
    scrubIndex,
    // A week, because stepping through a month one day at a time is not a real option.
    pageStep: 7,
  })

  const geometry = useMemo(() => {
    if (series.length === 0) return null

    const elapsed = Math.max(1, Math.min(elapsedCount ?? series.length, series.length))
    const drawn = series.slice(0, elapsed)

    /*
     * The domain spans both lines, so the comparison is measured on the same scale. Scaling each to
     * its own range would put them on top of each other and make every period look identical.
     */
    const values = [
      ...drawn.map((point) => toPixelUnits(point.cumulativeCents)),
      ...(comparison ?? []).map((point) => toPixelUnits(point.cumulativeCents)),
      // Zero is always in view: a cumulative total is read against having started at nothing.
      0,
    ]

    const rawMin = Math.min(...values)
    const rawMax = Math.max(...values)
    const pad = Math.max((rawMax - rawMin) * 0.1, 1)
    const min = rawMin - pad
    const max = rawMax + pad

    const width = 1000
    const plotHeight = Math.max(1, height - AXIS_HEIGHT)

    // Both lines use the *current* window's length, so day 7 sits at the same x on each.
    const span = Math.max(1, series.length - 1)
    const x = (index: number): number => (index / span) * width
    const y = (value: number): number => plotHeight - ((value - min) / (max - min)) * plotHeight

    const path = (points: readonly CumulativePoint[]): string =>
      points
        .map(
          (point, index) => `${x(index)},${y(toPixelUnits(point.cumulativeCents))}`,
        )
        .join(' ')

    /*
     * `y` is where the gridline goes; `labelY` is where its text goes. They differ only at the
     * extremes, where a label centred on its line would hang outside the plot.
     */
    const halfLabel = 9
    const ticks = niceTicks(min, max, GRID_LINES).map((value) => ({
      value: BigInt(Math.round(value)),
      y: y(value),
      labelY: Math.min(Math.max(y(value), halfLabel), plotHeight - halfLabel),
    }))

    return {
      width,
      plotHeight,
      zeroY: y(0),
      ticks,
      precision: labelPrecision(
        ticks.map((tick) => tick.value),
        formatValue,
      ),
      /*
       * Where the month stops being real, as a fraction of the width.
       *
       * Null on a period with nothing outstanding, so a completed month draws no band at all rather
       * than a zero-width one.
       */
      elapsedFraction: elapsed >= series.length ? null : x(elapsed - 1) / width,
      days: series.map((point, index) => ({
        date: point.date,
        x: x(index),
        // Day 2, 9, 16, 23, 30 on a full month — the same weekly cadence Empower uses, and the one
        // a person counting weeks is already using.
        label: index % LABEL_EVERY === 1 ? point.date.slice(-2).replace(/^0/, '') : null,
      })),
      line: path(drawn),
      comparisonLine:
        comparison === undefined || comparison.length === 0 ? null : path(comparison.slice(0, series.length)),
      elapsed,
      at: (index: number): { left: number; top: number } | null => {
        const point = series[index]
        if (point === undefined) return null
        return { left: index / span, top: y(toPixelUnits(point.cumulativeCents)) }
      },
      start: series[0]?.date,
      end: series[series.length - 1]?.date,
    }
  }, [series, comparison, height, elapsedCount, formatValue])

  if (geometry === null) return null

  /* A hover previews over a pin; leaving the chart restores what was pinned. */
  const activeIndex = scrubIndex ?? selectedIndex
  const marker = activeIndex === null ? null : geometry.at(activeIndex)

  return (
    <div className={cn('relative', className)}>
      <svg
        viewBox={`0 0 ${geometry.width} ${geometry.plotHeight}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height: geometry.plotHeight }}
        // Decorative: the transaction list beside it is what a screen reader should read.
        aria-hidden
      >
        {/*
          The rest of the month, shaded rather than left blank.
          
          An empty right-hand side reads as a chart that stops early, or worse as a period with
          nothing in it. Shading says the days exist and have not happened yet, which is the actual
          state — the same thing Empower does, and the reason the line's end is not the axis's end.
        */}
        {geometry.elapsedFraction !== null && (
          <rect
            x={geometry.elapsedFraction * geometry.width}
            y={0}
            width={geometry.width - geometry.elapsedFraction * geometry.width}
            height={geometry.plotHeight}
            className="fill-slate-200/40 dark:fill-slate-800/40"
          />
        )}

        {geometry.ticks.map((tick) => (
          <line
            key={`grid-${tick.y}`}
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

        {/* Zero, so a line below it is visibly below it rather than just low. */}
        <line
          x1={0}
          x2={geometry.width}
          y1={geometry.zeroY}
          y2={geometry.zeroY}
          className="stroke-slate-300 dark:stroke-slate-700"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />

        {/* The period before, behind and dotted — context, not a second subject. */}
        {geometry.comparisonLine !== null && (
          <polyline
            points={geometry.comparisonLine}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            strokeOpacity={0.45}
            strokeDasharray="3 4"
            vectorEffect="non-scaling-stroke"
          />
        )}

        <polyline
          points={geometry.line}
          fill="none"
          stroke={color}
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />

        {marker !== null && (
          <line
            x1={marker.left * geometry.width}
            x2={marker.left * geometry.width}
            y1={0}
            y2={geometry.plotHeight}
            className="stroke-slate-400 dark:stroke-slate-500"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>

      {marker !== null && (
        <div
          className="pointer-events-none absolute size-2.5 rounded-full border-2 border-white dark:border-slate-950"
          style={{
            left: `${marker.left * 100}%`,
            top: marker.top,
            transform: 'translate(-50%, -50%)',
            backgroundColor: color,
          }}
          aria-hidden
        />
      )}

      {onScrub !== undefined && (
        <div
          ref={scrub.plotRef}
          role="slider"
          tabIndex={0}
          aria-label={scrubLabel ?? CHART_COPY.scrubByDate}
          aria-valuemin={0}
          aria-valuemax={Math.max(0, series.length - 1)}
          aria-valuenow={activeIndex ?? Math.max(0, series.length - 1)}
          aria-valuetext={describePoint?.(activeIndex ?? series.length - 1)}
          onPointerDown={scrub.onPointerDown}
          onPointerMove={scrub.onPointerMove}
          onPointerUp={scrub.onPointerUp}
          onPointerCancel={scrub.onPointerCancel}
          onPointerLeave={scrub.onPointerLeave}
          onKeyDown={scrub.onKeyDown}
          onBlur={() => onScrub(null)}
          className={cn(
            /*
             * The chart claims the gesture outright. `touch-pan-y` left the browser free to pan
             * vertically on the same drag, so reading a chart scrolled the page under it — the
             * reading moved and so did the thing being read.
             */
            'absolute inset-x-0 top-0 cursor-crosshair touch-none',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500',
          )}
          style={{ height: geometry.plotHeight }}
        />
      )}

      {/* A tick per day, so the axis says what the line is made of rather than only where it ends. */}
      <div className="relative" style={{ height: AXIS_HEIGHT }} aria-hidden>
        <svg
          viewBox={`0 0 ${geometry.width} 4`}
          preserveAspectRatio="none"
          className="w-full"
          style={{ height: 4 }}
        >
          {geometry.days.map((day) => (
            <line
              key={`tick-${day.date}`}
              x1={day.x}
              x2={day.x}
              y1={0}
              y2={day.label === null ? 2 : 4}
              className="stroke-slate-300 dark:stroke-slate-700"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>

        {geometry.days.map((day) =>
          day.label === null ? null : (
            <span
              key={`label-${day.date}`}
              className="absolute -translate-x-1/2 text-[11px] tabular-nums text-slate-500 dark:text-slate-400"
              style={{ left: `${(day.x / geometry.width) * 100}%`, top: 4 }}
            >
              {day.label}
            </span>
          ),
        )}
      </div>

      {/* Value labels over the plot rather than drawn in SVG, so they stay crisp under the stretch. */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0"
        style={{ height: geometry.plotHeight }}
        aria-hidden
      >
        {/*
          The rest of the month, shaded rather than left blank.
          
          An empty right-hand side reads as a chart that stops early, or worse as a period with
          nothing in it. Shading says the days exist and have not happened yet, which is the actual
          state — the same thing Empower does, and the reason the line's end is not the axis's end.
        */}
        {geometry.elapsedFraction !== null && (
          <rect
            x={geometry.elapsedFraction * geometry.width}
            y={0}
            width={geometry.width - geometry.elapsedFraction * geometry.width}
            height={geometry.plotHeight}
            className="fill-slate-200/40 dark:fill-slate-800/40"
          />
        )}

        {geometry.ticks.map((tick) => (
          <span
            key={`value-${tick.y}`}
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

      {tableLabel === undefined ? (
        // No table asked for, so the range is all a reader gets — still better than nothing.
        <span className="sr-only">
          {geometry.start === undefined ? '' : formatDay(geometry.start)} –{' '}
          {geometry.end === undefined ? '' : formatDay(geometry.end)}
        </span>
      ) : (
        <ChartTable
          label={tableLabel}
          columns={[
            CHART_COPY.dateColumn,
            tableLabel,
            ...(comparison === undefined
              ? []
              : [comparisonLabel ?? CHART_COPY.comparisonColumn]),
          ]}
          rows={tableRows}
          sampledFrom={lastReadable + 1}
        />
      )}
    </div>
  )
}
