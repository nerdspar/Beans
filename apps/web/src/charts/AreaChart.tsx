import {
  useCallback,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { labelPrecision, niceTicks } from './axis.js'
import { useChartScrub } from './use-chart-scrub.js'
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
  /**
   * Rendered as the value axis.
   *
   * Takes the number of decimal places to use, because the chart is the only thing that knows how
   * close together its own ticks are. See {@link labelPrecision}.
   */
  formatValue: (cents: bigint, fractionDigits: number) => string
  className?: string
  height?: number

  /**
   * The point being read, as an index into `series`. Null when nothing is.
   *
   * Positional rather than a date because the chart already thinks in indexes, and the series is
   * one point per day — so moving by one index is moving by one day, which is the whole interaction.
   */
  scrubIndex?: number | null
  /** Called with the index under the pointer, or null when the reading ends. */
  onScrub?: ((index: number | null) => void) | undefined
  /** Read out when the scrubber has focus. Given the index, returns something worth hearing. */
  describePoint?: ((index: number) => string) | undefined
  /** Labels the scrubber for assistive technology. */
  scrubLabel?: string
  /** A committed reading: a tap, or the end of a drag. See use-chart-scrub. */
  onSelect?: ((index: number, viaTap: boolean) => void) | undefined
  /** The held reading, kept after the pointer lets go. */
  selectedIndex?: number | null

  /**
   * Index from which the series is a complete total. Null when the whole of it is.
   *
   * Everything to the left is real but partial — it sums the accounts that had history then, not
   * all of them. Marked rather than hidden: dropping it would make the chart only as long as the
   * newest account, and leaving it unmarked would let the step where the rest joins read as a gain.
   */
  completeFromIndex?: number | null
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
 * Converts cents to a plain number for geometry only.
 *
 * Safe here and nowhere else: this is pixel math on a value already bounded by the chart's own
 * domain, and the result is a coordinate rather than an amount. Money never becomes a number
 * anywhere it could be stored, summed or displayed.
 */
function toPixelUnits(cents: bigint): number {
  return Number(cents)
}

/**
 * The day under a pointer, as an index into the series.
 *
 * Separated from the component because it is the whole interaction and the rest is DOM plumbing:
 * a rectangle, a coordinate, and the question of which day that is.
 *
 * **Rounds to the nearest day rather than flooring.** Flooring lands the marker on the point before
 * the finger for the whole right half of every day's width — imperceptible in pixels, and obvious
 * in the number at the top, which is the thing actually being read.
 *
 * Clamped at both ends so a drag that leaves the chart holds at the first or last day instead of
 * running off into an index that does not exist.
 */
export function indexAtPosition(
  offsetX: number,
  width: number,
  length: number,
): number | null {
  if (length === 0 || width <= 0) return null
  if (length === 1) return 0

  const fraction = Math.min(Math.max(offsetX / width, 0), 1)
  return Math.round(fraction * (length - 1))
}

export function AreaChart({
  series,
  color,
  formatValue,
  className,
  height = 220,
  scrubIndex = null,
  onScrub,
  describePoint,
  scrubLabel,
  completeFromIndex = null,
  onSelect,
  selectedIndex = null,
}: AreaChartProps): ReactNode {
  const resolveIndex = useCallback(
    (offsetX: number, width: number) => indexAtPosition(offsetX, width, series.length),
    [series.length],
  )

  const scrub = useChartScrub({
    count: series.length,
    resolveIndex,
    onScrub,
    onSelect,
    scrubIndex,
    pageStep: 7,
  })

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
      series.length === 1 ? 0 : (index / (series.length - 1)) * width
    const y = (value: number): number =>
      plotHeight - ((value - min) / (max - min)) * plotHeight

    /*
     * One point is drawn as a flat line across the full width, not as a point.
     *
     * Placing a lone value at the midpoint makes the area fan out from the baseline to it and back —
     * a triangle, which reads as a balance that rose and fell within the window. It did not; there
     * is one observation and nothing to say about any other day. A flat line says exactly that, and
     * happens the first time an account is connected, so it is not a rare case.
     */
    const points =
      values.length === 1
        ? [`0,${y(values[0] ?? 0)}`, `${width},${y(values[0] ?? 0)}`]
        : values.map((value, index) => `${x(index)},${y(value)}`)

    const line = points.join(' ')
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

    /*
     * Where a given index sits, as a fraction of the width and a pixel offset from the top.
     *
     * A fraction rather than a viewBox coordinate because the SVG is stretched with
     * `preserveAspectRatio="none"` — anything round drawn inside it comes out an ellipse, so the
     * marker is a DOM element positioned over the plot instead.
     */
    const at = (index: number): { left: number; top: number } | null => {
      const point = series[index]
      if (point === undefined) return null
      return {
        left: series.length === 1 ? 0 : index / (series.length - 1),
        top: y(toPixelUnits(point.value)),
      }
    }

    return {
      width,
      plotHeight,
      at,
      precision: labelPrecision(
        ticks.map((tick) => tick.value),
        formatValue,
      ),
      area,
      line,
      ticks,
      start: startDate === undefined ? null : formatAxisDate(startDate),
      end: endDate === undefined ? null : formatAxisDate(endDate),
    }
  }, [series, height, formatValue])

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

  /* A hover previews over a held reading; leaving the chart restores what was held. */
  const activeIndex = scrubIndex ?? selectedIndex
  const marker = activeIndex === null ? null : geometry.at(activeIndex)

  /*
   * Where the partial region ends, as a fraction of the width. Zero-width regions are dropped: a
   * boundary on the first point means nothing is partial, and a hairline band at the very edge
   * would be visual noise claiming otherwise.
   */
  const partialWidth =
    completeFromIndex === null || completeFromIndex <= 0 || series.length < 2
      ? 0
      : Math.min(completeFromIndex / (series.length - 1), 1)
  const scrubbedDate = activeIndex === null ? undefined : series[activeIndex]?.date

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
        {/*
          The partial region, washed out behind the series.
          
          Behind rather than over the line: the data there is real, and dimming the line itself
          would say it is not. What is uncertain is the *completeness* of the total, which is a
          property of the span — so the span is what gets marked.
        */}
        {partialWidth > 0 && (
          <rect
            x={0}
            y={0}
            width={partialWidth * geometry.width}
            height={geometry.plotHeight}
            className="fill-slate-400/10 dark:fill-slate-500/10"
          />
        )}

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

        {partialWidth > 0 && (
          <line
            x1={partialWidth * geometry.width}
            x2={partialWidth * geometry.width}
            y1={0}
            y2={geometry.plotHeight}
            className="stroke-slate-400 dark:stroke-slate-600"
            strokeWidth={1}
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
          />
        )}

        {/*
          The reading line. Drawn in SVG because `non-scaling-stroke` keeps it one pixel wide
          however far the viewBox is stretched; the dot cannot be, since a circle in a chart with
          `preserveAspectRatio="none"` comes out an ellipse.
        */}
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

      {/* Round because it is a DOM element — see the reading line above for why it has to be. */}
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

      {/*
        The surface that reads the chart.
        
        Sits over the plot only, not the date axis beneath it, so the grab area matches what is
        being read. Exposed as a slider rather than hidden like the chart itself: this is the one
        part of the chart that is interactive, and a keyboard user needs it to exist.
      */}
      {onScrub !== undefined && (
        <div
          ref={scrub.plotRef}
          role="slider"
          tabIndex={0}
          aria-label={scrubLabel ?? 'Read the chart by date'}
          aria-valuemin={0}
          aria-valuemax={Math.max(0, series.length - 1)}
          aria-valuenow={activeIndex ?? Math.max(0, series.length - 1)}
          aria-valuetext={describePoint?.(activeIndex ?? series.length - 1) ?? scrubbedDate}
          onPointerDown={scrub.onPointerDown}
          onPointerMove={scrub.onPointerMove}
          onPointerUp={scrub.onPointerUp}
          onPointerCancel={scrub.onPointerCancel}
          // Only meaningful for a mouse: a captured touch never fires this, and a mouse leaving
          // the chart has stopped reading it.
          onPointerLeave={scrub.onPointerLeave}
          onKeyDown={scrub.onKeyDown}
          onBlur={() => onScrub(null)}
          className={cn(
            'absolute inset-x-0 top-0 cursor-crosshair',
            /*
             * The chart claims the gesture outright. `touch-pan-y` left the browser free to pan
             * vertically on the same drag, so reading a chart scrolled the page under it — the
             * reading moved and so did the thing being read.
             */
            'touch-none',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500',
          )}
          style={{ height: geometry.plotHeight }}
        />
      )}

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
            {formatValue(tick.value, geometry.precision)}
          </span>
        ))}
      </div>
    </div>
  )
}
