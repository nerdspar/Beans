import { useMemo, type ReactNode } from 'react'
import { labelPrecision, niceTicks } from './axis.js'
import { bandGeometry, type BandInput } from './band-geometry.js'
import { ChartTable, type ChartTableRow } from './ChartTable.js'
import { CHART_TABLE_ROWS, sampleIndices } from './table-rows.js'
import { cn } from '../lib/cn.js'

/**
 * A projection drawn as a band, never a line.
 *
 * The whole reason this component exists rather than reusing `AreaChart`: a single curve through
 * thirty years of unknown returns implies a precision that does not exist. The fill is the spread
 * between the most and least optimistic assumptions; the line inside it is whichever scenario the
 * household chose for its headline.
 *
 * **Zero is always on the axis**, and drawn solid where the gridlines are dashed. The question this
 * chart answers is whether the money lasts, so the reader has to be able to see where running out
 * would be — a band scaled to its own minimum would make a plan that merely dips look like one that
 * ended.
 */

export type ProjectionBandProps = {
  points: readonly BandInput[]
  formatValue: (cents: bigint, fractionDigits: number) => string
  /** Names the table fallback, e.g. "Projected balance". Not a sentence. */
  tableLabel: string
  /** Column headings for the fallback, after the year column. */
  tableColumns: readonly string[]
  /** Extra per-year cells for the fallback — spending, withdrawals, shortfall. */
  tableCells?: ((point: BandInput, index: number) => readonly string[]) | undefined
  /** Overrides the shared sampled-rows sentence, which assumes days and a slider. */
  tableSampledNote?: ((shown: number, total: number) => string) | undefined
  height?: number
  className?: string
}

const AXIS_HEIGHT = 18
const GRID_LINES = 4
const WIDTH = 1000

export function ProjectionBand({
  points,
  formatValue,
  tableLabel,
  tableColumns,
  tableCells,
  tableSampledNote,
  height = 240,
  className,
}: ProjectionBandProps): ReactNode {
  const geometry = useMemo(() => {
    if (points.length === 0) return null

    const plotHeight = Math.max(1, height - AXIS_HEIGHT)
    const paths = bandGeometry(points, WIDTH, plotHeight)

    const span = paths.max - paths.min
    const y = (value: number): number =>
      plotHeight - ((value - paths.min) / (span === 0 ? 1 : span)) * plotHeight

    const halfLabel = 9
    const ticks = niceTicks(paths.min, paths.max, GRID_LINES).map((value) => ({
      value: BigInt(Math.round(value)),
      y: y(value),
      labelY: Math.min(Math.max(y(value), halfLabel), plotHeight - halfLabel),
    }))

    const rows: ChartTableRow[] = sampleIndices(points.length, CHART_TABLE_ROWS).flatMap(
      (index) => {
        const point = points[index]
        if (point === undefined) return []

        return [
          {
            header: String(point.year),
            cells: [
              formatValue(point.headline, 2),
              formatValue(point.low, 2),
              formatValue(point.high, 2),
              ...(tableCells?.(point, index) ?? []),
            ],
          },
        ]
      },
    )

    return {
      plotHeight,
      band: paths.band,
      line: paths.line,
      ticks,
      zeroY: paths.min <= 0 && paths.max >= 0 ? y(0) : null,
      precision: labelPrecision(
        ticks.map((tick) => tick.value),
        formatValue,
      ),
      firstYear: points[0]?.year,
      lastYear: points[points.length - 1]?.year,
      rows,
    }
  }, [points, height, formatValue, tableCells])

  if (geometry === null) return null

  return (
    <div className={cn('relative', className)}>
      <svg
        viewBox={`0 0 ${WIDTH} ${geometry.plotHeight}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height: geometry.plotHeight }}
        /*
         * The paths say nothing useful aloud — a thirty-year area announced point by point is
         * noise. The table at the end of this component is what a screen reader reads instead.
         */
        aria-hidden
      >
        {geometry.ticks.map((tick) => (
          <line
            key={`tick-${tick.y}`}
            x1={0}
            x2={WIDTH}
            y1={tick.y}
            y2={tick.y}
            className="stroke-slate-200 dark:stroke-slate-800"
            strokeWidth={1}
            strokeDasharray="4 6"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        <path d={geometry.band} className="fill-sky-500/20 dark:fill-sky-400/20" />
        <path
          d={geometry.line}
          fill="none"
          className="stroke-sky-600 dark:stroke-sky-400"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />

        {/*
         * Zero, solid where the other gridlines are dashed. Running out of money is the one
         * threshold on this chart that means something, so it is drawn as a threshold rather than
         * as another tick.
         */}
        {geometry.zeroY !== null && (
          <line
            x1={0}
            x2={WIDTH}
            y1={geometry.zeroY}
            y2={geometry.zeroY}
            className="stroke-slate-400 dark:stroke-slate-500"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>

      <div className="flex justify-between px-1 pt-1 text-xs text-slate-500 dark:text-slate-400">
        <span>{geometry.firstYear}</span>
        <span>{geometry.lastYear}</span>
      </div>

      <ChartTable
        label={tableLabel}
        columns={tableColumns}
        rows={geometry.rows}
        sampledFrom={points.length}
        sampledNote={tableSampledNote}
      />
    </div>
  )
}
