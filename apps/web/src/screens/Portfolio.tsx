import {
  NET_WORTH_STATE_COPY,
  PORTFOLIO_COPY,
  dayChange,
  formatCents,
  formatShares,
  groupBySymbol,
  holdingMove,
  latestMove,
  parseDecimalToCents,
  personalIndex,
  pricePerShare,
  resolveWindow,
  sliceToWindow,
  type GroupedHolding,
} from '@beans/shared'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'wouter'
import { readHouseholdHoldings } from '../accounts/api.js'
import { withReturn } from '../lib/back.js'
import { AreaChart } from '../charts/AreaChart.js'
import { StackedArea } from '../charts/StackedArea.js'
import { cn } from '../lib/cn.js'
import { SECTION_COLORS } from '../net-worth/colors.js'
import { formatAxisValue, formatShortDate } from '../net-worth/display.js'
import { RangeControl } from '../net-worth/RangeControl.js'
import { DEFAULT_RANGE, type RangeSelection } from '../net-worth/range.js'
import { useWorkingSet } from '../working-set/use-working-set.js'
import { localToday } from '../lib/today.js'

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
  const [grouping, setGrouping] = useState<Grouping>('account')
  const today = localToday()

  /*
   * Fetched only once the reader asks for it.
   *
   * The account breakdown needs nothing but the working set, so somebody who never opens this
   * dropdown never pays for the request — which matters because it decrypts every position in the
   * household to answer.
   */
  const holdings = useQuery({
    queryKey: ['household-holdings'],
    queryFn: readHouseholdHoldings,
    enabled: grouping === 'holding',
  })

  /*
   * The same security across accounts, collapsed into one row.
   *
   * Grouped on the symbol rather than the provider's holding id, which is per-account by
   * construction — two accounts holding VWO have two unrelated ids for one security.
   */
  const grouped = useMemo(
    () =>
      groupBySymbol(
        (holdings.data?.holdings ?? []).map((holding) => ({
          symbol: holding.symbol,
          description: holding.description,
          shares: holding.shares,
          marketValueCents: parseDecimalToCents(holding.marketValue),
          previousMarketValueCents:
            holding.previousMarketValue === null
              ? null
              : parseDecimalToCents(holding.previousMarketValue),
        })),
      ),
    [holdings.data],
  )

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

  /*
   * The portfolio's own performance, indexed to zero at the start of the window.
   *
   * Answers "how did my money do", which is not the question the stacked chart answers. Flows are
   * stripped day by day and the days chain-linked, so a contribution does not read as a good day —
   * where the provider sends no investment transactions the flow is zero and this degrades to plain
   * percent change, which the note under the chart says.
   */
  const indexSeries = useMemo(() => {
    const investmentIds = new Set(investments.map((account) => account.id))
    const flowByDate = new Map<string, bigint>()

    for (const transaction of workingSet.transactions) {
      if (!investmentIds.has(transaction.accountId) || transaction.status === 'void') continue
      flowByDate.set(
        transaction.postedDate,
        (flowByDate.get(transaction.postedDate) ?? 0n) + transaction.amountCents,
      )
    }

    return personalIndex(series, flowByDate).map((point) => ({
      date: point.date,
      value: point.basisPoints,
    }))
  }, [series, investments, workingSet.transactions])

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
    { change: ReturnType<typeof dayChange>; asOf: string } | null
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
     * Always dated, never conditionally.
     *
     * This is the difference that made a correct figure look wrong beside a broker's app: a
     * brokerage shows today's session live, while the same account through SimpleFIN reports a
     * settled balance dated to a completed day. Both are right about different days, and only the
     * date says which — so an undated percentage is the one thing this column must never be.
     *
     * Judging staleness against "today" would need a notion of it, and `toIsoDate` is UTC: after
     * 8pm Eastern the browser's today is already tomorrow, so every account would read as stale
     * every evening. The date is stated instead of inferred.
     *
     * Carried per account and hoisted into the heading below only when they all agree, which is the
     * usual case — institutions publish on their own schedules, so one date above the list is a
     * summary and not a guarantee.
     */
    dayChanges.set(account.id, {
      change: dayChange(move.openingCents, move.closingCents, flow),
      asOf: move.toDate,
    })
  }

  /*
   * Whether Beans has anything to net out at all.
   *
   * The figures above claim to be the market alone, and that claim holds only where the provider
   * reports transactions for these accounts. Where it reports none the flow is always zero and each
   * figure is a plain balance change — a contribution lands in it as a gain, which is the one thing
   * this column is supposed to prevent. Better to say which of the two the reader is looking at.
   */
  const investmentIds = new Set(investments.map((account) => account.id))
  const reportsFlows = workingSet.transactions.some(
    (transaction) => investmentIds.has(transaction.accountId) && transaction.status !== 'void',
  )

  /*
   * One date above the list when every figure shares it, which is what a single sync produces.
   *
   * Repeating it on every row was noise. Dropping it entirely would not be — the date is the whole
   * reason these figures can be compared against a broker's app — so where accounts genuinely
   * disagree the newest goes in the heading and only the rows behind it keep their own.
   */
  const readingDates = [...dayChanges.values()]
    .map((reading) => reading?.asOf)
    .filter((date): date is string => date !== undefined)

  const newestReading = readingDates.length === 0 ? null : readingDates.reduce(
    (latest, date) => (date > latest ? date : latest),
  )
  const datesAgree = readingDates.every((date) => date === newestReading)

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
      {grouping === 'holding' && indexSeries.length > 0 && (
        <div className="mt-3">
          {/*
            Performance, not composition.
            
            The stacked chart says which accounts hold the money, which is exactly the question the
            holding list is not about — leaving it here meant the picture and the list underneath
            were answering different questions.
          */}
          <AreaChart
            series={indexSeries}
            color={SECTION_COLORS.investment}
            formatValue={(basisPoints) => formatPercent(basisPoints)}
            height={CHART_HEIGHT}
            scrubLabel={PORTFOLIO_COPY.indexScrubLabel}
          />
          <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
            {reportsFlows ? PORTFOLIO_COPY.indexNote : PORTFOLIO_COPY.indexNoteWithoutFlows}
          </p>
        </div>
      )}

      {grouping === 'account' && series.length > 0 && (
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

      {grouping === 'account' && (
        <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
          {PORTFOLIO_COPY.historyNote}
        </p>
      )}

      <div className="mt-6 flex items-baseline justify-between gap-3">
        <label className="flex items-baseline gap-1.5">
          <span className="sr-only">{PORTFOLIO_COPY.groupingLabel}</span>
          {/*
            A native select, not a custom menu. It is two options on a screen that already has a
            range control, and the platform's own picker is both smaller and better at being
            reachable than anything hand-rolled here.
          */}
          <select
            value={grouping}
            onChange={(event) => setGrouping(event.target.value as Grouping)}
            className={cn(
              '-ml-1 cursor-pointer rounded-md bg-transparent px-1 py-0.5 text-sm font-semibold',
              'focus-visible:outline-2 focus-visible:outline-sky-500',
            )}
          >
            <option value="account">{PORTFOLIO_COPY.byAccount}</option>
            <option value="holding">{PORTFOLIO_COPY.byHolding}</option>
          </select>
        </label>
        {grouping === 'account' && newestReading !== null && (
          <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
            {PORTFOLIO_COPY.asOfDay(formatShortDate(newestReading))}
          </span>
        )}
        {grouping === 'holding' && holdings.data?.asOfDate != null && (
          <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
            {PORTFOLIO_COPY.asOfDay(formatShortDate(holdings.data.asOfDate))}
          </span>
        )}
      </div>
      {grouping === 'holding' ? (
        <HoldingGroups
          groups={grouped}
          total={grouped.reduce((sum, group) => sum + group.marketValueCents, 0n)}
          isLoading={holdings.isLoading}
          hasFailed={holdings.error !== null}
        />
      ) : (
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

              <DayChangeCell
                reading={dayChanges.get(account.id) ?? null}
                showDate={!datesAgree}
              />

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
      )}

      {grouping === 'account' && (
        <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
          {reportsFlows ? PORTFOLIO_COPY.oneDayNote : PORTFOLIO_COPY.oneDayNoteWithoutFlows}
        </p>
      )}

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
  showDate,
}: {
  reading: { change: ReturnType<typeof dayChange>; asOf: string } | null
  /** Only when the accounts disagree — otherwise the heading has already said it once. */
  showDate: boolean
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
      {/* Only where this row is behind the date in the heading. */}
      {showDate && (
        <span className="block text-[11px] font-normal text-slate-500 dark:text-slate-400">
          {PORTFOLIO_COPY.asOfDay(formatShortDate(reading.asOf))}
        </span>
      )}
    </span>
  )
}

/** Which breakdown the list below the chart is showing. */
type Grouping = 'account' | 'holding'

/**
 * The same security wherever it is held, as one row.
 *
 * The reason to want this: holding VWO in three accounts is one exposure, and the account
 * breakdown above can only ever show it as three unrelated slivers. This is the view that answers
 * "how much of this do I actually own".
 *
 * A row whose members span several accounts says so, because that row is then a **sum** rather than
 * a position — nothing at any institution looks like it, and somebody reconciling against a
 * statement should not have to work that out.
 */
function HoldingGroups({
  groups,
  total,
  isLoading,
  hasFailed,
}: {
  groups: readonly GroupedHolding[]
  total: bigint
  isLoading: boolean
  hasFailed: boolean
}): ReactNode {
  if (isLoading) {
    return <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{PORTFOLIO_COPY.loading}</p>
  }

  if (hasFailed || groups.length === 0) {
    return (
      <div className="mt-2">
        <p className="text-sm font-medium">{PORTFOLIO_COPY.holdingsEmpty}</p>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {PORTFOLIO_COPY.holdingsEmptyDetail}
        </p>
      </div>
    )
  }

  return (
    <ul className="mt-2 divide-y divide-slate-200 dark:divide-slate-800">
      {groups.map((group) => {
        const move = holdingMove(group.marketValueCents, group.previousMarketValueCents)
        const price = pricePerShare(group.marketValueCents, group.shares)
        const up = move !== null && move.changeCents > 0n
        const down = move !== null && move.changeCents < 0n

        return (
          <li key={group.key}>
            {/* Links through, like an account row — the row is the way into where it is held. */}
            <Link
              href={withReturn(`/holdings/${encodeURIComponent(group.key)}`, {
                href: '/portfolio',
                label: PORTFOLIO_COPY.title,
              })}
              className="flex items-start gap-3 py-2.5 focus-visible:outline-2 focus-visible:outline-sky-500"
            >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {group.symbol ?? group.description ?? '—'}
              </span>
              {/*
                Always the description, never the account count.
                
                The count used to take this line whenever a security sat in more than one account,
                so the column alternated between a fund's name and a number — two different kinds of
                fact in one place, which is unreadable at a glance. The row is a link now, and where
                it is held is the first thing behind it.
              */}
              <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                {group.symbol === null ? '' : (group.description ?? '')}
              </span>
            </span>

            <span
              className={cn(
                'shrink-0 text-right text-xs tabular-nums',
                up
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : down
                    ? 'text-rose-600 dark:text-rose-400'
                    : 'text-slate-500 dark:text-slate-400',
              )}
            >
              {move === null ? (
                // Either the position is new, or one account in the group is a day behind. Both
                // mean there is no honest comparison to draw, and a zero would imply a flat day.
                <span className="block">{PORTFOLIO_COPY.noDayChange}</span>
              ) : (
                <>
                  <span className="block">
                    {move.fraction === null
                      ? ''
                      : `${up ? '+' : ''}${(move.fraction * 100).toFixed(2)}%`}
                  </span>
                  <span className="block">
                    {up ? '+' : ''}
                    {formatCents(move.changeCents)}
                  </span>
                </>
              )}
            </span>

            <span className="shrink-0 text-right">
              <span className="block text-sm tabular-nums">
                {formatCents(group.marketValueCents)}
              </span>
              <span className="block text-xs tabular-nums text-slate-500 dark:text-slate-400">
                {/* Share of the portfolio, which is what the grouped view exists to show. */}
                {shareOf(group.marketValueCents, total)}
                {group.shares !== null &&
                  ` · ${formatShares(group.shares)}${price === null ? '' : ` @ ${formatCents(price)}`}`}
              </span>
            </span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

/** Basis points as a signed percentage. The index chart's only unit. */
function formatPercent(basisPoints: bigint): string {
  const percent = Number(basisPoints) / 100
  return `${percent > 0 ? '+' : ''}${percent.toFixed(2)}%`
}
