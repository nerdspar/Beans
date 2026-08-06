import { CHART_COPY } from '@beans/shared'
import { useCallback, useMemo, type ReactNode } from 'react'
import { ChartTable } from './ChartTable.js'
import { CHART_TABLE_ROWS, sampleIndices } from './table-rows.js'
import { useChartScrub } from './use-chart-scrub.js'
import { cn } from '../lib/cn.js'

/**
 * A bar per month, for a range that spans more than one.
 *
 * Separate from `AreaChart` rather than a mode of it. That chart draws a continuous quantity — a
 * balance exists on every day, so a line between two points is a real claim about the days between.
 * A month's cash flow is not continuous: nothing happened "between" July and August, and drawing a
 * slope there would invent a trajectory. Bars say twelve discrete facts, which is what these are.
 *
 * The average is drawn because it is the only thing that makes one bar readable. A $60K month means
 * nothing until you know the usual month is $21K.
 */

export type MonthlyPoint = {
  /** `YYYY-MM`. */
  month: string
  incomeCents: bigint
  spendingCents: bigint
  netCents: bigint
}

export type MonthlyBarsProps = {
  periods: readonly MonthlyPoint[]
  /**
   * Which quantity the bars show.
   *
   * `net` draws both directions around a zero line with the net marked on top; the others draw one
   * direction only, because a breakdown of a single direction is what those tabs are answering.
   */
  mode: 'net' | 'income' | 'spending'
  formatValue: (cents: bigint) => string
  averageLabel: (formatted: string) => string
  height?: number
  className?: string

  /** The month being read, as an index into `periods`. Null when none is. */
  scrubIndex?: number | null
  onScrub?: ((index: number | null) => void) | undefined
  describePoint?: ((index: number) => string) | undefined
  scrubLabel?: string
  /**
   * Names the table fallback — "Net", "Spending".
   *
   * The table follows `mode` rather than listing all three figures. It stands in for the chart, and
   * a chart showing spending should not have a fallback that quietly also reports income: a reader
   * comparing notes with someone looking at the picture would be reading a different thing.
   */
  tableLabel?: string | undefined
  /** A committed reading: a tap, or the end of a drag. See use-chart-scrub. */
  onSelect?: ((index: number, viaTap: boolean) => void) | undefined
  /** The pinned month, drawn as held rather than as hovered. */
  selectedIndex?: number | null
}

/**
 * The month under a pointer.
 *
 * Slot-based rather than nearest-point, which is what separates this from the line charts. A bar
 * owns a width, so anywhere inside it is that month — nearest-point would flip to the next month
 * halfway across the one you are pointing at.
 */
export function monthAtPosition(offsetX: number, width: number, count: number): number | null {
  if (count === 0 || width <= 0) return null
  const fraction = Math.min(Math.max(offsetX / width, 0), 1)
  return Math.min(count - 1, Math.floor(fraction * count))
}

const INCOME_COLOR = '#34d399'
const SPENDING_COLOR = '#fb923c'

/** Room under the plot for month labels, taken out of `height` so the box stays its stated size. */
const AXIS_HEIGHT = 18

/**
 * The month spelled out, for the table fallback.
 *
 * The axis uses a single initial, which is right under a bar and useless in a table — four rows
 * labelled "J" is not a reading of anything. The year is included because a twelve-month range
 * crosses one, and "January" alone would be ambiguous exactly where the comparison matters.
 */
const MONTH_LABEL = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})

function monthLabel(month: string): string {
  return MONTH_LABEL.format(new Date(`${month}-01T00:00:00Z`))
}

const MONTH_INITIAL = new Intl.DateTimeFormat(undefined, { month: 'narrow', timeZone: 'UTC' })

function monthInitial(month: string): string {
  return MONTH_INITIAL.format(new Date(`${month}-01T00:00:00Z`))
}

/** Cents to a plain number for pixel geometry only — never for anything stored or displayed. */
function toPixelUnits(cents: bigint): number {
  return Number(cents)
}

export function MonthlyBars({
  periods,
  mode,
  formatValue,
  averageLabel,
  height = 190,
  className,
  scrubIndex = null,
  onScrub,
  describePoint,
  scrubLabel,
  onSelect,
  selectedIndex = null,
  tableLabel,
}: MonthlyBarsProps): ReactNode {
  const resolveIndex = useCallback(
    (offsetX: number, width: number) => monthAtPosition(offsetX, width, periods.length),
    [periods.length],
  )

  const tableRows = useMemo(
    () =>
      tableLabel === undefined
        ? []
        : sampleIndices(periods.length, CHART_TABLE_ROWS).flatMap((index) => {
            const period = periods[index]
            if (period === undefined) return []

            const value =
              mode === 'income'
                ? period.incomeCents
                : mode === 'spending'
                  ? period.spendingCents
                  : period.netCents

            return [{ header: monthLabel(period.month), cells: [formatValue(value)] }]
          }),
    [tableLabel, periods, mode, formatValue],
  )

  const scrub = useChartScrub({
    count: periods.length,
    resolveIndex,
    onScrub,
    onSelect,
    scrubIndex,
  })

  const geometry = useMemo(() => {
    if (periods.length === 0) return null

    /*
     * Spending is stored negative and drawn below the line as such. Negating it to a magnitude here
     * would be a second sign decision outside the ingest edge — the axis handles the direction.
     */
    const highs = periods.map((period) =>
      mode === 'spending' ? 0 : toPixelUnits(period.incomeCents),
    )
    const lows = periods.map((period) =>
      mode === 'income' ? 0 : toPixelUnits(period.spendingCents),
    )

    // Zero is always in the domain, so the baseline is where zero actually is rather than wherever
    // the smallest bar happens to start.
    const rawMax = Math.max(0, ...highs)
    const rawMin = Math.min(0, ...lows)
    const pad = Math.max((rawMax - rawMin) * 0.1, 1)
    const max = rawMax + pad
    const min = rawMin - pad

    const width = 1000
    const plotHeight = Math.max(1, height - AXIS_HEIGHT)
    const y = (value: number): number => plotHeight - ((value - min) / (max - min)) * plotHeight

    const slot = width / periods.length
    // A gap either side, so twelve bars read as twelve rather than as a filled block.
    const barWidth = Math.max(2, slot * 0.55)

    const totalCents = periods.reduce(
      (sum, period) =>
        sum +
        (mode === 'income'
          ? period.incomeCents
          : mode === 'spending'
            ? period.spendingCents
            : period.netCents),
      0n,
    )

    /*
     * Mean per month over the months shown, matching the figure in the header. Integer division
     * truncates, which is correct here — an average rendered to the cent implies a precision that a
     * mean of twelve months does not have.
     */
    const averageCents = totalCents / BigInt(periods.length)

    return {
      width,
      plotHeight,
      zeroY: y(0),
      averageY: y(toPixelUnits(averageCents)),
      averageCents,
      bars: periods.map((period, index) => {
        const centre = index * slot + slot / 2
        const incomeY = y(toPixelUnits(period.incomeCents))
        const spendingY = y(toPixelUnits(period.spendingCents))
        return {
          month: period.month,
          x: centre - barWidth / 2,
          centre,
          incomeY,
          spendingY,
          netY: y(toPixelUnits(period.netCents)),
        }
      }),
      barWidth,
      slot,
      zero: y(0),
    }
  }, [periods, mode, height])

  if (geometry === null) return null

  /* A hover previews over a pin; leaving the chart restores what was pinned. */
  const activeIndex = scrubIndex ?? selectedIndex

  const showIncome = mode !== 'spending'
  const showSpending = mode !== 'income'

  return (
    <div className={cn('relative', className)}>
      <svg
        viewBox={`0 0 ${geometry.width} ${geometry.plotHeight}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height: geometry.plotHeight }}
        // Decorative: the month list beneath is the table fallback a screen reader should read.
        aria-hidden
      >
        {/*
          The month being read, as a band rather than a line.
          
          A bar owns a width, so the thing being pointed at is a span — a hairline through the
          middle of it would be pointing at a coordinate the data does not have. Drawn first, so the
          bars stay legible on top of it.
        */}
        {activeIndex !== null && geometry.bars[activeIndex] !== undefined && (
          <rect
            x={(geometry.bars[activeIndex]?.centre ?? 0) - geometry.slot / 2}
            y={0}
            width={geometry.slot}
            height={geometry.plotHeight}
            className={cn(
              // A pin is held, a hover is passing. The held one reads stronger.
              selectedIndex !== null && scrubIndex === null
                ? 'fill-slate-400/25 dark:fill-slate-400/20'
                : 'fill-slate-400/15 dark:fill-slate-400/10',
            )}
          />
        )}

        {geometry.bars.map((bar) => (
          <g key={bar.month}>
            {showIncome && (
              <rect
                x={bar.x}
                y={Math.min(bar.incomeY, geometry.zero)}
                width={geometry.barWidth}
                height={Math.abs(geometry.zero - bar.incomeY)}
                fill={INCOME_COLOR}
                rx={2}
              />
            )}
            {showSpending && (
              <rect
                x={bar.x}
                y={Math.min(bar.spendingY, geometry.zero)}
                width={geometry.barWidth}
                height={Math.abs(geometry.zero - bar.spendingY)}
                fill={SPENDING_COLOR}
                rx={2}
              />
            )}
          </g>
        ))}

        {/* The zero line, drawn over the bars so both directions are measured from something. */}
        <line
          x1={0}
          x2={geometry.width}
          y1={geometry.zeroY}
          y2={geometry.zeroY}
          className="stroke-slate-400 dark:stroke-slate-600"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />

        {/*
          Net, only where both directions are shown. On a single-direction tab the bars already are
          the quantity, and a line tracing their tops would restate them.
        */}
        {mode === 'net' && (
          <polyline
            points={geometry.bars.map((bar) => `${bar.centre},${bar.netY}`).join(' ')}
            fill="none"
            className="stroke-slate-500 dark:stroke-slate-400"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        )}

        <line
          x1={0}
          x2={geometry.width}
          y1={geometry.averageY}
          y2={geometry.averageY}
          className="stroke-slate-500 dark:stroke-slate-400"
          strokeWidth={1}
          strokeDasharray="5 4"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      {/*
        A dot per month on the net line.
        
        DOM elements rather than SVG circles: the viewBox is stretched with
        `preserveAspectRatio="none"`, so anything round drawn inside it comes out an ellipse. The
        line alone is hard to place against the bars — the dots are what say which month a point
        belongs to.
      */}
      {mode === 'net' &&
        geometry.bars.map((bar, index) => (
          <div
            key={`dot-${bar.month}`}
            className={cn(
              'pointer-events-none absolute rounded-full border bg-slate-500',
              'border-white dark:border-slate-950 dark:bg-slate-300',
              // The month being read gets the bigger dot, so the reading has a definite place.
              index === activeIndex ? 'size-3 border-2' : 'size-2',
            )}
            style={{
              left: `${(bar.centre / geometry.width) * 100}%`,
              top: bar.netY,
              transform: 'translate(-50%, -50%)',
            }}
            aria-hidden
          />
        ))}

      {/* Positioned over the plot rather than drawn in SVG, so it is not stretched by the viewBox. */}
      <span
        className={cn(
          'pointer-events-none absolute right-0 -translate-y-1/2 rounded px-1.5 py-0.5 text-[11px] tabular-nums',
          'bg-slate-100/90 text-slate-600 dark:bg-slate-800/90 dark:text-slate-300',
        )}
        style={{ top: geometry.averageY }}
      >
        {averageLabel(formatValue(geometry.averageCents))}
      </span>

      {onScrub !== undefined && (
        <div
          ref={scrub.plotRef}
          role="slider"
          tabIndex={0}
          aria-label={scrubLabel ?? CHART_COPY.scrubByMonth}
          aria-valuemin={0}
          aria-valuemax={Math.max(0, periods.length - 1)}
          aria-valuenow={scrubIndex ?? selectedIndex ?? Math.max(0, periods.length - 1)}
          aria-valuetext={describePoint?.(scrubIndex ?? selectedIndex ?? periods.length - 1)}
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

      <div
        className="flex text-[11px] tabular-nums text-slate-500 dark:text-slate-400"
        style={{ height: AXIS_HEIGHT }}
        aria-hidden
      >
        {geometry.bars.map((bar, index) => (
          <span
            key={bar.month}
            className="flex-1 text-center"
            // Every month on a short range, every other on a long one — twelve initials at phone
            // width overlap into an unreadable smear.
            style={{ visibility: periods.length > 8 && index % 2 === 1 ? 'hidden' : 'visible' }}
          >
            {monthInitial(bar.month)}
          </span>
        ))}
      </div>

      {tableLabel !== undefined && (
        <ChartTable
          label={tableLabel}
          columns={[CHART_COPY.monthColumn, tableLabel]}
          rows={tableRows}
          sampledFrom={periods.length}
        />
      )}
    </div>
  )
}
