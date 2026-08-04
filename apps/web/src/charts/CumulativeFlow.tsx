import {
  useCallback,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { indexAtPosition } from './AreaChart.js'
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
  formatValue: (cents: bigint) => string
  height?: number
  className?: string

  /** Index being read, or null. The screen owns it so the header and the list can follow. */
  scrubIndex?: number | null
  onScrub?: ((index: number | null) => void) | undefined
  describePoint?: ((index: number) => string) | undefined
  scrubLabel?: string

  /**
   * How many points are real rather than future.
   *
   * A month in progress has days that have not happened. Drawing them would be a line at today's
   * total running to the end of the month, which reads as "nothing more will be spent" — a forecast
   * the chart is in no position to make.
   */
  elapsedCount?: number | undefined
}

const AXIS_HEIGHT = 18

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
}: CumulativeFlowProps): ReactNode {
  const plotRef = useRef<HTMLDivElement>(null)

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

    return {
      width,
      plotHeight,
      zeroY: y(0),
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
  }, [series, comparison, height, elapsedCount])

  const scrubTo = useCallback(
    (clientX: number): void => {
      const box = plotRef.current?.getBoundingClientRect()
      if (box === undefined) return
      const index = indexAtPosition(clientX - box.left, box.width, series.length)
      if (index !== null) onScrub?.(index)
    },
    [series.length, onScrub],
  )

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId)
    scrubTo(event.clientX)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const dragging = event.currentTarget.hasPointerCapture(event.pointerId)
    if (event.pointerType === 'mouse' || dragging) scrubTo(event.clientX)
  }

  const endScrub = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    onScrub?.(null)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (series.length === 0 || onScrub === undefined) return

    const last = series.length - 1
    const from = scrubIndex ?? last
    const absolute: Record<string, number | null> = { Escape: null, Home: 0, End: last }
    const step: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      PageUp: -7,
      PageDown: 7,
    }

    if (event.key in absolute) {
      onScrub(absolute[event.key] ?? null)
    } else if (event.key in step) {
      onScrub(Math.min(last, Math.max(0, from + (step[event.key] ?? 0))))
    } else {
      return
    }

    event.preventDefault()
  }

  if (geometry === null) return null

  const marker = scrubIndex === null ? null : geometry.at(scrubIndex)

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
          ref={plotRef}
          role="slider"
          tabIndex={0}
          aria-label={scrubLabel ?? 'Read by date'}
          aria-valuemin={0}
          aria-valuemax={Math.max(0, series.length - 1)}
          aria-valuenow={scrubIndex ?? Math.max(0, series.length - 1)}
          aria-valuetext={describePoint?.(scrubIndex ?? series.length - 1)}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endScrub}
          onPointerCancel={endScrub}
          onPointerLeave={endScrub}
          onKeyDown={onKeyDown}
          onBlur={() => onScrub(null)}
          className={cn(
            'absolute inset-x-0 top-0 cursor-crosshair touch-pan-y',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500',
          )}
          style={{ height: geometry.plotHeight }}
        />
      )}

      <div
        className="flex justify-between px-1 text-[11px] tabular-nums text-slate-500 dark:text-slate-400"
        style={{ height: AXIS_HEIGHT }}
        aria-hidden
      >
        <span>{geometry.start === undefined ? '' : formatDay(geometry.start)}</span>
        <span>{geometry.end === undefined ? '' : formatDay(geometry.end)}</span>
      </div>

      <span className="sr-only">{formatValue(series.at(-1)?.cumulativeCents ?? 0n)}</span>
    </div>
  )
}
