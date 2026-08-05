import {
  NET_WORTH_STATE_COPY,
  PORTFOLIO_COPY,
  dayChange,
  latestMove,
  formatCents,
  resolveWindow,
  sliceToWindow,
  toIsoDate,
} from '@beans/shared'
import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'wouter'
import { StackedArea } from '../charts/StackedArea.js'
import { cn } from '../lib/cn.js'
import { SECTION_COLORS } from '../net-worth/colors.js'
import { formatAxisValue, formatShortDate } from '../net-worth/display.js'
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

  /*
   * What each account did in its last day, market only.
   *
   * The closing balance minus the opening minus that day's own transactions — a deposit is not
   * performance. Where a provider sends no investment transactions the flow is zero and this is the
   * plain delta, which is the best answer available rather than a claim nothing was paid in.
   */
  const dayChanges = new Map<
    string,
    { change: ReturnType<typeof dayChange>; staleSince: string | null } | null
  >()

  for (const account of investments) {
    /*
     * Measured from the last day the value actually differed, not from yesterday.
     *
     * These series hold each reading flat until the next, so the last two days are routinely the
     * same number and their delta is zero — which is what every account reading $0 was.
     */
    const move = latestMove(account.series)

    if (move === null) {
      dayChanges.set(account.id, null)
      continue
    }

    /*
     * Everything paid in or taken out over the move itself, so the figure is the market alone.
     *
     * Bounded by the day the value arrived rather than the last day of the series: a contribution
     * posted since then is not yet in this balance, and subtracting it would carve a hole out of a
     * move that never included it.
     */
    const flow = workingSet.transactions
      .filter(
        (transaction) =>
          transaction.accountId === account.id &&
          transaction.postedDate > move.fromDate &&
          transaction.postedDate <= move.toDate &&
          transaction.status !== 'void',
      )
      .reduce((sum, transaction) => sum + transaction.amountCents, 0n)

    /*
     * Dated whenever the move did not land today.
     *
     * Compared against today rather than against the end of the series, because both ways of being
     * behind matter and this catches them together: the provider may have published nothing since
     * yesterday, or it may still be repeating a value from days ago.
     *
     * This is the difference that made a figure look wrong next to a broker's app. A brokerage
     * shows today's session live; through SimpleFIN it reports a settled balance dated to a
     * completed day. Both are right about different days, and only the date says which.
     */
    dayChanges.set(account.id, {
      change: dayChange(move.openingCents, move.closingCents, flow),
      staleSince: move.toDate < today ? formatShortDate(move.toDate) : null,
    })
  }

  const ordered = [...investments].sort(
    (left, right) =>
      Number((right.series.at(-1)?.value ?? 0n) - (left.series.at(-1)?.value ?? 0n)),
  )

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

      {/*
        One band per account rather than one line for the total.
        
        The same pixels then also say which accounts hold the money and which one moved — a band
        thickening while the total stays flat is money crossing between two of them, which a single
        line cannot show.
      */}
      {series.length > 0 && (
        <div className="mt-3">
          <StackedArea
            bands={ordered.map((account, index) => ({
              key: account.id,
              label: account.name,
              color: BAND_COLORS[index % BAND_COLORS.length] ?? SECTION_COLORS.investment,
              points: account.series,
            }))}
            formatValue={(cents, digits) => formatAxisValue(cents, 'investment', digits)}
            height={CHART_HEIGHT}
          />
        </div>
      )}

      <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
        {PORTFOLIO_COPY.historyNote}
      </p>

      <h2 className="mt-6 text-sm font-semibold">{PORTFOLIO_COPY.byAccount}</h2>
      <ul className="mt-2 divide-y divide-slate-200 dark:divide-slate-800">
        {ordered.map((account, index) => (
          <li key={account.id}>
            <Link
              href={`/accounts/${account.id}`}
              className="flex items-center gap-3 py-2.5 focus-visible:outline-2 focus-visible:outline-sky-500"
            >
              {/* Ties the row to its band, which is the only thing naming the colours. */}
              <span
                aria-hidden
                className="h-8 w-1 shrink-0 rounded-full"
                style={{ backgroundColor: BAND_COLORS[index % BAND_COLORS.length] }}
              />

              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{account.name}</span>
                <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                  {account.institutionName ?? ''}
                </span>
              </span>

              <DayChangeCell reading={dayChanges.get(account.id) ?? null} />

              <span className="shrink-0 text-right">
                <span className="block text-sm tabular-nums">
                  {formatCents(account.series.at(-1)?.value ?? account.currentBalanceCents ?? 0n)}
                </span>
                <span className="block text-xs tabular-nums text-slate-500 dark:text-slate-400">
                  {shareOf(account.series.at(-1)?.value ?? 0n, total)}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>

      <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
        {PORTFOLIO_COPY.oneDayNote}
      </p>

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

/**
 * Band colours, largest holding first.
 *
 * A ramp rather than a categorical palette: these are slices of one quantity, and distinct hues
 * would imply the accounts are different kinds of thing. Light-to-dark reads as an ordering, which
 * is what the list beneath is.
 */
const BAND_COLORS = [
  '#1d4ed8',
  '#2563eb',
  '#3b82f6',
  '#60a5fa',
  '#38bdf8',
  '#22d3ee',
  '#34d399',
  '#4ade80',
  '#a3e635',
]

/** A share of the whole, to one decimal. More precision than that is noise on a pie. */
function shareOf(cents: bigint, total: bigint): string {
  if (total === 0n) return ''
  return `${((Number(cents) / Number(total)) * 100).toFixed(2)}%`
}

/**
 * A day's move for one account.
 *
 * Silent when there is no prior day to compare against — an account connected today has no
 * performance, and a dash is the honest answer where a zero would read as a flat day.
 */
function DayChangeCell({
  reading,
}: {
  reading: { change: ReturnType<typeof dayChange>; staleSince: string | null } | null
}): ReactNode {
  if (reading === null) {
    return (
      <span className="shrink-0 text-right text-xs text-slate-400 dark:text-slate-500">
        {PORTFOLIO_COPY.noDayChange}
      </span>
    )
  }

  const { change } = reading

  const up = change.marketCents > 0n

  return (
    <span
      className={cn(
        'shrink-0 text-right tabular-nums',
        change.marketCents === 0n
          ? 'text-slate-500 dark:text-slate-400'
          : up
            ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-rose-600 dark:text-rose-400',
      )}
    >
      <span className="block text-sm">
        {change.fraction === null
          ? ''
          : `${up ? '+' : ''}${(change.fraction * 100).toFixed(2)}%`}
      </span>
      <span className="block text-xs">
        {up ? '+' : ''}
        {formatCents(change.marketCents)}
      </span>
      {/* The date, whenever this is not the latest day — a stale figure has to say so. */}
      {reading.staleSince !== null && (
        <span className="block text-[11px] font-normal text-slate-500 dark:text-slate-400">
          {PORTFOLIO_COPY.asOfDay(reading.staleSince)}
        </span>
      )}
    </span>
  )
}
