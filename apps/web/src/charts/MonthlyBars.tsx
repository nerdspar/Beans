import { useMemo, type ReactNode } from 'react'
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
}

const INCOME_COLOR = '#34d399'
const SPENDING_COLOR = '#fb923c'

/** Room under the plot for month labels, taken out of `height` so the box stays its stated size. */
const AXIS_HEIGHT = 18

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
}: MonthlyBarsProps): ReactNode {
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
      zero: y(0),
    }
  }, [periods, mode, height])

  if (geometry === null) return null

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
    </div>
  )
}
