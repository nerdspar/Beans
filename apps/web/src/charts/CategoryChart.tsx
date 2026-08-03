import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '../lib/cn.js'
import { AreaChart, type SeriesPoint } from './AreaChart.js'

/**
 * The chart that swaps as the user scrolls between net worth categories.
 *
 * ## Why a crossfade and not a morph
 *
 * The obvious reading of "the chart redraws to that category's series" is a path morph. It is the
 * wrong shape, for two reasons.
 *
 * **The intermediate frames are meaningless.** Morphing a dead-flat mortgage line into a jagged
 * cash line walks through a sequence of curves that were never anybody's balance. The animation
 * spends its whole duration displaying financial data that is false.
 *
 * **The y-axis is doing the real work.** Cash is ~$300K and net worth is ~$2.6M. What has to land
 * is "this is a different, much smaller number", and that is carried by the axis rescaling, not by
 * the line's shape. A morph actively fights it: interpolating between two paths in two different
 * domains means the y-axis has to hold still or lie.
 *
 * So: the outgoing series fades out, the incoming fades in, and the axis labels change with them.
 * Cheap, honest, and it reads instantly — which matters more here than anywhere else in the app,
 * because this fires repeatedly during a single scroll.
 *
 * `prefers-reduced-motion` swaps with no animation at all, handled globally in the stylesheet.
 */

export type CategoryChartProps = {
  /** Changing this is what triggers a transition. */
  categoryKey: string
  series: readonly SeriesPoint[]
  color: string
  formatValue: (cents: bigint) => string
  height?: number
  className?: string
}

/**
 * Short on purpose. This fires on every section crossing during an ordinary scroll, so it is one of
 * the most repeated animations in the app — and a duration that reads as elegant the first time
 * reads as lag by the tenth. Long enough to register as a swap rather than a jump cut, and no
 * longer.
 */
const TRANSITION_MS = 140

type Layer = {
  key: string
  series: readonly SeriesPoint[]
  color: string
}

export function CategoryChart({
  categoryKey,
  series,
  color,
  formatValue,
  height = 220,
  className,
}: CategoryChartProps): ReactNode {
  const [current, setCurrent] = useState<Layer>({ key: categoryKey, series, color })
  const [outgoing, setOutgoing] = useState<Layer | null>(null)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (categoryKey === current.key) {
      // Same category, new data — the range control moved, or a sync landed. Replace in place
      // rather than crossfading against ourselves.
      setCurrent({ key: categoryKey, series, color })
      return
    }

    setOutgoing(current)
    setCurrent({ key: categoryKey, series, color })

    /*
     * A fast scroll can cross three categories before the first fade finishes. Clearing the pending
     * timer means the outgoing layer is always the one actually being replaced, rather than a stale
     * layer from two categories ago lingering underneath.
     */
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      setOutgoing(null)
    }, TRANSITION_MS)

    return () => {
      window.clearTimeout(timer.current)
    }
    // `current` is deliberately not a dependency: including it would re-run this on every swap and
    // crossfade against the layer we just installed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryKey, series, color])

  return (
    <div className={cn('relative', className)} style={{ height }}>
      {outgoing !== null && (
        <div
          key={outgoing.key}
          className="absolute inset-0 motion-reduce:hidden"
          style={{ animation: `beans-fade-out ${TRANSITION_MS}ms ease-out forwards` }}
        >
          <AreaChart
            series={outgoing.series}
            color={outgoing.color}
            formatValue={formatValue}
            height={height}
          />
        </div>
      )}

      <div
        key={current.key}
        className="absolute inset-0"
        style={{ animation: `beans-fade-in ${TRANSITION_MS}ms ease-out forwards` }}
      >
        <AreaChart
          series={current.series}
          color={current.color}
          formatValue={formatValue}
          height={height}
        />
      </div>
    </div>
  )
}
