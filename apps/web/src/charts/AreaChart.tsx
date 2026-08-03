import { useMemo, type ReactNode } from 'react'
import { cn } from '../lib/cn.js'

/**
 * The area chart, hand-rolled in SVG.
 *
 * Deliberately not Recharts, and the reasoning matters because the spec named Recharts as the
 * starting point.
 *
 * What this chart has to do is not "draw a series" — it is to **crossfade between two series while
 * the y-axis rescales**, many times, as the user scrolls. Recharts owns its own DOM and animation
 * scheduling, so driving that from outside means fighting it. What it buys in return — axes,
 * tooltips, legends, composability — is almost entirely unused here: one filled path, no legend,
 * one axis rendered as text labels.
 *
 * So this is roughly eighty lines that do exactly what is needed and can be transitioned by CSS,
 * against a dependency that does much more and cannot. The wrapper boundary the spec asked for
 * still exists — this file is it, and nothing outside `charts/` knows how the pixels are made.
 */

export type SeriesPoint = {
  /** `YYYY-MM-DD`. */
  date: string
  /** Integer cents. Kept as a bigint end to end; only converted for pixel geometry. */
  value: bigint
}

export type AreaChartProps = {
  series: readonly SeriesPoint[]
  /** Drives the fill and stroke. Categories each carry their own. */
  color: string
  /** Rendered as the value axis, in the same units the caller formats elsewhere. */
  formatValue: (cents: bigint) => string
  className?: string
  height?: number
}

const GRID_LINES = 5

/** Room under the plot for the date labels. Taken out of `height`, so the box stays its stated size. */
const AXIS_HEIGHT = 18

const AXIS_DATE = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  /*
   * Forced to UTC. A `YYYY-MM-DD` handed to `Date` is parsed as UTC midnight but formatted in local
   * time, so anywhere west of Greenwich every label renders as the previous day — the same
   * off-by-one the `date` type parser guards against on the server side.
   */
  timeZone: 'UTC',
})

function formatAxisDate(date: string): string {
  return AXIS_DATE.format(new Date(`${date}T00:00:00Z`))
}

/**
 * Picks tick values a person would choose.
 *
 * Dividing the domain into five equal parts gives arithmetically correct but unreadable labels —
 * `-$817.12K`, `-$820.06K`, `-$823K`. An axis exists to convey scale at a glance, and irregular
 * values defeat that: the reader ends up parsing each label instead of absorbing the range.
 *
 * So the step is snapped to 1, 2, 2.5 or 5 times a power of ten, and ticks land on multiples of it.
 * The chart's own domain still comes from the data — only the labelled lines are rounded.
 */
function niceTicks(min: number, max: number, target: number): number[] {
  const span = max - min
  if (span <= 0 || !Number.isFinite(span)) {
    return [min]
  }

  const rough = span / (target - 1)
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const normalized = rough / magnitude

  /*
   * Nearest nice number, not the next one up. Always rounding up overshoots: a span needing a step
   * of 2.9 gets 5, which halves the gridlines and leaves the axis sparse enough to stop conveying
   * scale. Rounding to nearest keeps the count close to what was asked for.
   */
  const step = (normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10) * magnitude

  const ticks: number[] = []
  // Start at the first multiple of `step` at or above the domain floor.
  for (let value = Math.ceil(min / step) * step; value <= max; value += step) {
    ticks.push(value)
  }

  // A very narrow domain can round to nothing inside it; fall back rather than drawing no axis.
  return ticks.length === 0 ? [min, max] : ticks
}

/**
 * Converts cents to a plain number for geometry only.
 *
 * Safe here and nowhere else: this is pixel math on a value already bounded by the chart's own
 * domain, and the result is a coordinate rather than an amount. Money never becomes a number
 * anywhere it could be stored, summed or displayed.
 */
function toPixelUnits(cents: bigint): number {
  return Number(cents)
}

export function AreaChart({
  series,
  color,
  formatValue,
  className,
  height = 220,
}: AreaChartProps): ReactNode {
  const geometry = useMemo(() => {
    if (series.length === 0) {
      return null
    }

    const values = series.map((point) => toPixelUnits(point.value))
    const rawMin = Math.min(...values)
    const rawMax = Math.max(...values)

    /**
     * A flat series would otherwise divide by zero and collapse to a line at the top. Padding the
     * domain also keeps the fill from touching the frame, which reads as clipped.
     */
    const span = rawMax - rawMin
    const pad = span === 0 ? Math.max(Math.abs(rawMax) * 0.1, 1) : span * 0.1
    const min = rawMin - pad
    const max = rawMax + pad

    const width = 1000
    const plotHeight = Math.max(1, height - AXIS_HEIGHT)
    const x = (index: number): number =>
      series.length === 1 ? width / 2 : (index / (series.length - 1)) * width
    const y = (value: number): number =>
      plotHeight - ((value - min) / (max - min)) * plotHeight

    const line = values.map((value, index) => `${x(index)},${y(value)}`).join(' ')
    const area = `M0,${plotHeight} L${line.replaceAll(' ', ' L')} L${width},${plotHeight} Z`

    /*
     * `y` is where the gridline goes; `labelY` is where its text goes. They differ only at the
     * extremes: a label is centred on its line, so the bottom-most one hangs half its height below
     * the plot and lands on the date labels. Clamping keeps every label inside the plot box, a few
     * pixels off its line rather than colliding with the axis beneath it.
     */
    const halfLabel = 9
    const ticks = niceTicks(min, max, GRID_LINES).map((value) => ({
      value: BigInt(Math.round(value)),
      y: y(value),
      labelY: Math.min(Math.max(y(value), halfLabel), plotHeight - halfLabel),
    }))

    /*
     * The range endpoints, read off the series rather than recomputed from the selected range. The
     * chart is then guaranteed to label the data it actually drew — if a slice comes back short
     * because history does not reach that far back, the axis says so instead of claiming a start
     * date with no point at it.
     */
    const startDate = series[0]?.date
    const endDate = series[series.length - 1]?.date

    return {
      width,
      plotHeight,
      area,
      line,
      ticks,
      start: startDate === undefined ? null : formatAxisDate(startDate),
      end: endDate === undefined ? null : formatAxisDate(endDate),
    }
  }, [series, height])

  if (geometry === null) {
    return (
      <div
        className={cn('flex items-center justify-center text-sm text-slate-500', className)}
        style={{ height }}
      >
        Nothing to chart yet.
      </div>
    )
  }

  return (
    <div className={cn('relative', className)}>
      <svg
        viewBox={`0 0 ${geometry.width} ${geometry.plotHeight}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height: geometry.plotHeight }}
        // Decorative: every chart has a table fallback beside it, which is what a screen reader
        // should read instead.
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

        <path
          d={geometry.area}
          fill={color}
          fillOpacity={0.85}
          /*
           * The transition is on the path data itself, which browsers do not interpolate — so this
           * is a crossfade, not a morph. See CategoryChart for why that is the right shape.
           */
          style={{ transition: 'fill 140ms ease-out' }}
        />

        <polyline
          points={geometry.line}
          fill="none"
          stroke={color}
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          style={{ transition: 'stroke 140ms ease-out' }}
        />
      </svg>

      {/*
        The range, spelled out at the ends of the x-axis. Two labels rather than a full set of
        ticks: the question this chart answers is "over what period", and the endpoints answer it
        completely. Intermediate dates would crowd a phone-width axis to say much less.
      */}
      <div
        className="flex justify-between px-1 text-[11px] tabular-nums text-slate-500 dark:text-slate-400"
        style={{ height: AXIS_HEIGHT }}
        aria-hidden
      >
        <span>{geometry.start}</span>
        <span>{geometry.end}</span>
      </div>

      {/* Value labels, positioned over the grid lines rather than drawn in SVG so they stay crisp. */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0"
        style={{ height: geometry.plotHeight }}
        aria-hidden
      >
        {geometry.ticks.map((tick) => (
          <span
            key={tick.y}
            /*
             * A backdrop rather than moving the labels outside the plot: the reference layout puts
             * them over the chart, and at phone width the space to the side does not exist. Without
             * it they become unreadable wherever they cross the fill.
             */
            className={cn(
              'absolute left-0 -translate-y-1/2 rounded px-1 text-[11px] tabular-nums',
              'bg-slate-50/80 text-slate-500 dark:bg-slate-950/80 dark:text-slate-400',
            )}
            style={{ top: tick.labelY }}
          >
            {formatValue(tick.value)}
          </span>
        ))}
      </div>
    </div>
  )
}
