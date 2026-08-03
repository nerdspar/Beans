import { useState, type ReactNode } from 'react'
import { formatCents } from '@beans/shared'
import { CategoryChart } from '../charts/CategoryChart.js'
import type { SeriesPoint } from '../charts/AreaChart.js'
import { cn } from '../lib/cn.js'
import { SECTION_COLORS } from '../net-worth/colors.js'
import { describeChange, formatSectionTotal, toChartSeries } from '../net-worth/display.js'

/**
 * The category transition, in isolation.
 *
 * Built before wiring any of this to real data, deliberately. The transition is the part of this
 * screen worth getting right and the part most likely to need several attempts — judging it while
 * also fighting data loading, scroll observation and layout would mean never knowing which part
 * felt wrong.
 *
 * The fixtures below are shaped like the real thing rather than smooth: a dead-flat mortgage, a
 * jagged cash line, and an order-of-magnitude gap between household net worth and its parts. That
 * combination is exactly what makes a path morph look wrong, and what the axis rescale has to sell.
 */

const DAYS = 90

/** Deterministic pseudo-noise, so the fixture looks the same on every render. */
function wobble(seed: number, index: number): number {
  const value = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453
  return value - Math.floor(value) - 0.5
}

function buildSeries(
  startCents: number,
  driftPerDay: number,
  volatility: number,
  seed: number,
): SeriesPoint[] {
  const points: SeriesPoint[] = []
  let value = startCents

  for (let index = 0; index < DAYS; index += 1) {
    value += driftPerDay + wobble(seed, index) * volatility
    const date = new Date(Date.UTC(2026, 4, 5 + index)).toISOString().slice(0, 10)
    points.push({ date, value: BigInt(Math.round(value)) })
  }

  return points
}

const FIXTURES = [
  {
    key: 'household',
    label: 'Net worth',
    color: SECTION_COLORS.household,
    // ~$2.6M, gently upward, moderately noisy.
    series: buildSeries(255_000_000, 60_000, 900_000, 1),
  },
  {
    key: 'cash',
    label: 'Cash',
    color: SECTION_COLORS.cash,
    // ~$300K and visibly jagged — payroll in, bills out.
    series: buildSeries(31_500_000, -18_000, 700_000, 2),
  },
  {
    key: 'investment',
    label: 'Investment',
    color: SECTION_COLORS.investment,
    // ~$1M, market-driven, the noisiest of the set.
    series: buildSeries(96_000_000, 55_000, 1_400_000, 3),
  },
  {
    key: 'credit_card',
    label: 'Credit card',
    color: SECTION_COLORS.credit_card,
    // A few thousand owed. Small, negative, and stepped.
    series: buildSeries(-250_000, -3_000, 90_000, 4),
  },
  {
    key: 'mortgage',
    label: 'Mortgage',
    color: SECTION_COLORS.mortgage,
    // Dead flat but for the monthly payment — the case a morph handles worst.
    series: buildSeries(-82_800_000, 11_000, 0, 5),
  },
] as const

export function TransitionPrototype(): ReactNode {
  const [index, setIndex] = useState(0)
  const active = FIXTURES[index] ?? FIXTURES[0]

  const total = active.series.at(-1)?.value ?? 0n
  const first = active.series[0]?.value ?? 0n
  const change = total - first

  // Liabilities chart as the amount owed, so paying one down slopes downward.
  const section = active.key as Parameters<typeof toChartSeries>[1]
  const chartSeries = toChartSeries(active.series, section)
  const described = describeChange(change, section)

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="text-lg font-semibold tracking-tight">Transition prototype</h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        Tap between categories and watch the swap. Not wired to real data — this exists to judge the
        feel before anything is built on top of it.
      </p>

      <div className="mt-6">
        <div className="text-3xl font-semibold tabular-nums">
          {formatSectionTotal(total, section)}
        </div>
        <div
          className={cn(
            'mt-1 text-sm font-medium tabular-nums',
            // Calm and factual either way. No colour-coded celebration, no commiseration.
            described.favourable
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-rose-600 dark:text-rose-400',
          )}
        >
          {described.text} over 90 days
        </div>
      </div>

      <CategoryChart
        className="mt-4"
        categoryKey={active.key}
        series={chartSeries}
        color={active.color}
        formatValue={(cents) => formatCents(cents, { compact: true })}
        height={240}
      />

      <div className="mt-6 flex flex-wrap gap-2">
        {FIXTURES.map((fixture, fixtureIndex) => (
          <button
            key={fixture.key}
            type="button"
            onClick={() => setIndex(fixtureIndex)}
            className={cn(
              'rounded-full px-4 py-2 text-sm font-medium transition-colors',
              'focus-visible:outline-2 focus-visible:outline-sky-500',
              fixtureIndex === index
                ? 'text-white'
                : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
            )}
            style={fixtureIndex === index ? { backgroundColor: fixture.color } : undefined}
          >
            {fixture.label}
          </button>
        ))}
      </div>

      <p className="mt-8 text-xs text-slate-500 dark:text-slate-400">
        The scale gap is the point: net worth is ~$2.6M and credit card is a few thousand. What has
        to land is &ldquo;different, much smaller number&rdquo;, and the axis carries that — not the
        shape of the line.
      </p>
    </div>
  )
}
