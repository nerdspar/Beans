import { formatCents, isLiabilitySection, type NetWorthSection } from '@beans/shared'
import { useMemo, useState, type ReactNode } from 'react'
import { CategoryChart } from '../charts/CategoryChart.js'
import { cn } from '../lib/cn.js'
import { SECTION_COLORS, SECTION_LABELS } from '../net-worth/colors.js'
import {
  describeChange,
  formatAxisValue,
  formatSectionTotal,
  toChartSeries,
} from '../net-worth/display.js'
import { buildSections, householdSeries, type FixtureAccount } from '../net-worth/fixtures.js'
import { RangeControl } from '../net-worth/RangeControl.js'
import {
  DEFAULT_RANGE,
  resolveWindow,
  sliceToWindow,
  todayIso,
  type RangeSelection,
} from '../net-worth/range.js'
import { useActiveSection } from '../net-worth/use-active-section.js'

/**
 * Net worth — the screen this app exists for.
 *
 * **One continuous scrolling list.** No tabs, no separate category pages, no tap-to-filter. As the
 * user scrolls into a section, its header pins below the chart and takes its category's colour, and
 * everything above re-scopes: the total, the change, and the chart itself. Scrolling back to the
 * top returns to household net worth and the assets/liabilities bars.
 *
 * Still on fixtures — the net worth API and the client working set do not exist yet. The
 * interaction is what needed building first, and the data shape it consumes is deliberately what
 * the real one will produce.
 */

/** Where the pinned header sits, and therefore the line that decides the active section. */
const CHART_BLOCK_HEIGHT = 320

export function NetWorth(): ReactNode {
  const [range, setRange] = useState<RangeSelection>(DEFAULT_RANGE)

  const sections = useMemo(() => buildSections(), [])
  const sectionKeys = useMemo(() => sections.map((group) => group.section), [sections])

  const { activeKey, registerSection, scrollToSection } = useActiveSection(sectionKeys, {
    lineOffset: CHART_BLOCK_HEIGHT,
  })

  const household = useMemo(() => householdSeries(sections), [sections])

  /**
   * Slicing the range is a local operation on a series already in memory — no fetch, no spinner.
   * That is what makes changing the range feel instant.
   */
  const sliced = useMemo(() => {
    const window = resolveWindow(range, todayIso())
    const take = <T extends { date: string }>(series: readonly T[]): T[] =>
      sliceToWindow(series, window)

    return {
      household: take(household),
      bySection: new Map(sections.map((group) => [group.section, take(group.series)])),
    }
  }, [range, household, sections])

  const activeGroup = sections.find((group) => group.section === activeKey)
  const scope = activeKey ?? 'household'

  const series =
    activeGroup === undefined ? sliced.household : (sliced.bySection.get(activeGroup.section) ?? [])

  const total = series.at(-1)?.value ?? 0n
  const change = total - (series[0]?.value ?? 0n)
  const described = describeChange(change, scope)

  const chartSeries = toChartSeries(series, scope)
  const color =
    activeGroup === undefined ? SECTION_COLORS.household : SECTION_COLORS[activeGroup.section]

  const assets = sections
    .filter((group) => !isLiabilitySection(group.section))
    .reduce((sum, group) => sum + group.totalCents, 0n)
  const liabilities = sections
    .filter((group) => isLiabilitySection(group.section))
    .reduce((sum, group) => sum + group.totalCents, 0n)

  return (
    <div className="mx-auto max-w-2xl">
      {/*
        The chart block is sticky so the pinned section header lands directly beneath it, and the
        list scrolls under both.
      */}
      <div
        className="sticky top-0 z-20 bg-slate-50/95 px-5 pt-5 backdrop-blur dark:bg-slate-950/95"
        style={{ height: CHART_BLOCK_HEIGHT }}
      >
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <div className="text-3xl font-semibold tabular-nums">
              {formatSectionTotal(total, scope)}
            </div>
            <div
              className={cn(
                'mt-0.5 text-sm font-medium tabular-nums',
                described.favourable
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-rose-600 dark:text-rose-400',
              )}
            >
              {described.text}
            </div>
          </div>
          <RangeControl value={range} onChange={setRange} />
        </div>

        <CategoryChart
          className="mt-3"
          categoryKey={scope}
          series={chartSeries}
          color={color}
          formatValue={(cents) => formatAxisValue(cents, scope)}
          height={190}
        />

        {/*
          Announces the scope change for anyone who cannot see the chart recolour. Polite so it
          waits for a pause rather than interrupting mid-scroll.
        */}
        <span aria-live="polite" className="sr-only">
          {activeGroup === undefined
            ? 'Showing household net worth'
            : `Showing ${SECTION_LABELS[activeGroup.section]}`}
        </span>
      </div>

      {/* Assets and liabilities, shown only at the top — they describe the household, not a category. */}
      <div
        className={cn(
          'px-5 transition-opacity duration-200',
          activeGroup === undefined
            ? 'opacity-100'
            : 'pointer-events-none h-0 overflow-hidden opacity-0',
        )}
      >
        <ProportionBar label="Assets" amount={assets} against={assets} color="#3b82f6" />
        <ProportionBar label="Liabilities" amount={liabilities} against={assets} color="#f97316" />
      </div>

      <div className="mt-4">
        {sections.map((group, index) => {
          const isActive = group.section === activeKey
          const sectionColor = SECTION_COLORS[group.section]
          const isLast = index === sections.length - 1

          return (
            <section
              key={group.section}
              ref={registerSection(group.section)}
              /*
               * The last section needs enough height to scroll its own top up to the detection
               * line. Without it the page runs out of scroll while the final section is still
               * below the line, and that one category can never be selected by scrolling at all —
               * it is simply unreachable, which is easy to miss because every other section works.
               *
               * `dvh` rather than `vh`: on mobile the two differ by the height of the browser
               * chrome, and `vh` would under-reserve exactly when the address bar is showing.
               */
              style={isLast ? { minHeight: `calc(100dvh - ${CHART_BLOCK_HEIGHT}px)` } : undefined}
            >
              <h2
                className={cn(
                  'sticky z-10 flex items-center justify-between px-5 py-2.5 text-sm font-semibold',
                  'transition-colors duration-200',
                  isActive ? 'text-white' : 'bg-slate-100 dark:bg-slate-900',
                )}
                style={{
                  top: CHART_BLOCK_HEIGHT,
                  ...(isActive ? { backgroundColor: sectionColor } : {}),
                }}
              >
                {/*
                  Focusable and activatable: the non-scroll path to the same result. A keyboard or
                  screen-reader user scopes the chart by activating a header rather than by
                  scrolling, which they may not be doing at all.
                */}
                <button
                  type="button"
                  onClick={() => scrollToSection(group.section)}
                  className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
                >
                  {SECTION_LABELS[group.section]}
                </button>
                <span className="tabular-nums">{formatCents(group.totalCents)}</span>
              </h2>

              <ul>
                {group.accounts.map((account) => (
                  <AccountRow key={account.id} account={account} />
                ))}
              </ul>
            </section>
          )
        })}
      </div>

      <p className="px-5 py-8 text-xs text-slate-500 dark:text-slate-400">
        Sample data. Not yet connected to your accounts.
      </p>
    </div>
  )
}

function ProportionBar({
  label,
  amount,
  against,
  color,
}: {
  label: string
  amount: bigint
  against: bigint
  color: string
}): ReactNode {
  const magnitude = amount < 0n ? -amount : amount
  const scale = against <= 0n ? 0 : Number((magnitude * 100n) / against)

  return (
    <div className="py-1.5">
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums">{formatCents(amount)}</span>
      </div>
      <div className="mt-1 h-1 rounded-full bg-slate-200 dark:bg-slate-800">
        {/* Proportional to assets, so the two bars are comparable rather than each self-scaled. */}
        <div
          className="h-full rounded-full transition-[width] duration-300"
          style={{ width: `${Math.min(100, scale)}%`, backgroundColor: color }}
        />
      </div>
    </div>
  )
}

function AccountRow({ account }: { account: FixtureAccount }): ReactNode {
  return (
    <li>
      <button
        type="button"
        className={cn(
          'flex w-full items-center justify-between gap-3 px-5 py-3 text-left',
          'border-b border-slate-200 dark:border-slate-800',
          'hover:bg-slate-100 dark:hover:bg-slate-900',
          'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sky-500',
        )}
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{account.institution}</span>
          <span className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            {account.syncStatus !== 'healthy' && (
              <span
                className={cn(
                  'size-2 shrink-0 rounded-full',
                  account.syncStatus === 'error' ? 'bg-rose-500' : 'bg-amber-500',
                )}
                // The dot is the only signal that a balance is not current, so it cannot be
                // decorative — colour alone would leave it invisible to a screen reader.
                aria-label={
                  account.syncStatus === 'error'
                    ? 'Connection needs attention'
                    : 'Balance may be out of date'
                }
              />
            )}
            <span className="truncate">
              {account.name}
              {account.mask !== null && ` - Ending in ${account.mask}`}
            </span>
          </span>
        </span>

        <span className="shrink-0 text-right">
          <span className="block text-sm font-medium tabular-nums">
            {formatCents(account.balanceCents)}
          </span>
          <span className="block text-xs text-slate-500 dark:text-slate-400">
            {account.updated}
          </span>
        </span>
      </button>
    </li>
  )
}
