import {
  NET_WORTH_STATE_COPY,
  PORTFOLIO_COPY,
  formatCents,
  resolveWindow,
  sliceToWindow,
  toIsoDate,
} from '@beans/shared'
import { useMemo, useState, type ReactNode } from 'react'
import { CategoryChart } from '../charts/CategoryChart.js'
import { cn } from '../lib/cn.js'
import { SECTION_COLORS } from '../net-worth/colors.js'
import { formatAxisValue } from '../net-worth/display.js'
import { RangeControl } from '../net-worth/RangeControl.js'
import { DEFAULT_RANGE, type RangeSelection } from '../net-worth/range.js'
import { useWorkingSet } from '../working-set/use-working-set.js'

/**
 * Investments, at account level.
 *
 * **Account level is not a shortcut, it is what the data supports.** SimpleFIN reports a balance per
 * investment account and no holdings inside it, so there are no positions to show and none are
 * implied. Grouping by tax treatment is the one breakdown that is both available and consequential —
 * it decides what a withdrawal is worth, and phase 5 projection depends on it entirely.
 */

const CHART_HEIGHT = 180

export function Portfolio(): ReactNode {
  const workingSet = useWorkingSet()
  const [range, setRange] = useState<RangeSelection>(DEFAULT_RANGE)
  const today = toIsoDate(new Date())

  const investments = useMemo(
    () =>
      [...(workingSet.data?.byId.values() ?? [])].filter(
        (account) => account.section === 'investment',
      ),
    [workingSet.data],
  )

  const series = useMemo(() => {
    if (investments.length === 0) return []
    const window = resolveWindow(range, today)

    /*
     * Summed across accounts starting where they all have data, for the same reason net worth does:
     * a total missing an account it claims to include reads as a drop that never happened.
     */
    const start = investments.reduce(
      (latest, account) => {
        const first = account.series[0]?.date
        return first !== undefined && first > latest ? first : latest
      },
      investments[0]?.series[0]?.date ?? window.start,
    )

    const byDate = new Map<string, bigint>()
    for (const account of investments) {
      for (const point of account.series) {
        if (point.date < start) continue
        byDate.set(point.date, (byDate.get(point.date) ?? 0n) + point.value)
      }
    }

    return sliceToWindow(
      [...byDate.entries()]
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([date, value]) => ({ date, value })),
      window,
    )
  }, [investments, range, today])

  if (workingSet.isLoading) return <Message title={PORTFOLIO_COPY.loading} />

  if (workingSet.error !== null) {
    return (
      <Message
        title={NET_WORTH_STATE_COPY.failed}
        detail={NET_WORTH_STATE_COPY.failedDetail}
        technical={workingSet.error.message}
      />
    )
  }

  if (investments.length === 0) {
    return <Message title={PORTFOLIO_COPY.empty} detail={PORTFOLIO_COPY.emptyDetail} />
  }

  const total = investments.reduce(
    (sum, account) => sum + (account.series.at(-1)?.value ?? account.currentBalanceCents ?? 0n),
    0n,
  )

  const byTax = new Map<string, bigint>()
  for (const account of investments) {
    const value = account.series.at(-1)?.value ?? account.currentBalanceCents ?? 0n
    byTax.set(account.taxTreatment, (byTax.get(account.taxTreatment) ?? 0n) + value)
  }

  return (
    <div className="mx-auto max-w-2xl px-5 pb-16 pt-5">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{PORTFOLIO_COPY.title}</h1>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {PORTFOLIO_COPY.total}
          </p>
        </div>
        <RangeControl value={range} onChange={setRange} />
      </div>

      <p className="mt-1 text-3xl font-semibold tabular-nums">{formatCents(total)}</p>

      {series.length > 0 && (
        <div className="mt-3">
          <CategoryChart
            categoryKey="portfolio"
            series={series}
            color={SECTION_COLORS.investment}
            formatValue={(cents, digits) => formatAxisValue(cents, 'investment', digits)}
            height={CHART_HEIGHT}
          />
        </div>
      )}

      <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
        {PORTFOLIO_COPY.historyNote}
      </p>

      <h2 className="mt-6 text-sm font-semibold">{PORTFOLIO_COPY.byAccount}</h2>
      <ul className="mt-2 space-y-2">
        {[...investments]
          .sort(
            (left, right) =>
              Number((right.series.at(-1)?.value ?? 0n) - (left.series.at(-1)?.value ?? 0n)),
          )
          .map((account) => (
            <li key={account.id}>
              <Share
                label={account.name}
                sublabel={account.institutionName}
                cents={account.series.at(-1)?.value ?? account.currentBalanceCents ?? 0n}
                total={total}
              />
            </li>
          ))}
      </ul>

      <h2 className="mt-6 text-sm font-semibold">{PORTFOLIO_COPY.byTax}</h2>
      <ul className="mt-2 space-y-2">
        {[...byTax.entries()]
          .sort(([, left], [, right]) => Number(right - left))
          .map(([treatment, cents]) => (
            <li key={treatment}>
              <Share
                label={
                  PORTFOLIO_COPY.taxLabel[treatment as keyof typeof PORTFOLIO_COPY.taxLabel] ??
                  treatment
                }
                cents={cents}
                total={total}
              />
            </li>
          ))}
      </ul>
    </div>
  )
}

function Share({
  label,
  sublabel,
  cents,
  total,
}: {
  label: string
  sublabel?: string | null
  cents: bigint
  total: bigint
}): ReactNode {
  const share = total <= 0n ? 0 : Number((cents * 1000n) / total) / 10

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate">
          {label}
          {sublabel !== undefined && sublabel !== null && (
            <span className="text-slate-500 dark:text-slate-400"> · {sublabel}</span>
          )}
        </span>
        <span className="shrink-0 tabular-nums">
          {formatCents(cents)}
          <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
            {share.toFixed(1)}%
          </span>
        </span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-slate-200 dark:bg-slate-800" aria-hidden>
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.max(0, Math.min(100, share))}%`, backgroundColor: SECTION_COLORS.investment }}
        />
      </div>
    </div>
  )
}

function Message({
  title,
  detail,
  technical,
}: {
  title: string
  detail?: string
  technical?: string
}): ReactNode {
  return (
    <div className={cn('mx-auto flex max-w-2xl flex-col items-center px-6 py-20 text-center')}>
      <p className="text-base font-medium">{title}</p>
      {detail !== undefined && (
        <p className="mt-2 max-w-sm text-sm text-slate-500 dark:text-slate-400">{detail}</p>
      )}
      {technical !== undefined && (
        <p className="mt-2 max-w-sm rounded-lg bg-slate-100 px-3 py-2 text-left font-mono text-xs text-slate-600 dark:bg-slate-900 dark:text-slate-300">
          {technical}
        </p>
      )}
    </div>
  )
}
