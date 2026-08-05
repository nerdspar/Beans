import {
  HOLDINGS_COPY,
  PORTFOLIO_COPY,
  formatCents,
  formatShares,
  holdingMove,
  parseDecimalToCents,
  pricePerShare,
} from '@beans/shared'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft } from 'lucide-react'
import { useCallback, useState, type ReactNode } from 'react'
import { Link } from 'wouter'
import { readHoldingDetail } from '../accounts/api.js'
import { AreaChart } from '../charts/AreaChart.js'
import { cn } from '../lib/cn.js'
import { SECTION_COLORS } from '../net-worth/colors.js'
import { formatAxisValue, formatShortDate } from '../net-worth/display.js'
import { RangeControl } from '../net-worth/RangeControl.js'
import { DEFAULT_RANGE, resolveWindow, todayIso, type RangeSelection } from '../net-worth/range.js'

/**
 * One security, in detail.
 *
 * The counterpart to account detail, and deliberately its mirror image: an account page asks what
 * is inside this account, this asks where this security is held. Same chart, same range control,
 * same ordering — a holding is a slice of the portfolio, not a different kind of thing.
 *
 * **Its history starts when Beans first recorded positions, not when the security was bought.** A
 * position's value cannot be reconstructed backwards the way a cash balance can, so there is
 * genuinely nothing before the first snapshot and the screen says so rather than drawing a line
 * that implies otherwise.
 */

const CHART_HEIGHT = 190

export function HoldingDetail({ params }: { params: { key: string } }): ReactNode {
  const [range, setRange] = useState<RangeSelection>(DEFAULT_RANGE)
  const symbol = decodeURIComponent(params.key)
  const window = resolveWindow(range, todayIso())

  const query = useQuery({
    queryKey: ['holding-detail', symbol, window.start],
    queryFn: () => readHoldingDetail(symbol, window.start),
  })

  const formatValue = useCallback(
    (cents: bigint, digits: number) => formatAxisValue(cents, 'investment', digits),
    [],
  )

  const detail = query.data

  const series = (detail?.series ?? []).map((point) => ({
    date: point.date,
    value: parseDecimalToCents(point.value),
  }))

  const total = series.at(-1)?.value ?? 0n

  const previousTotal =
    detail === undefined || detail.previousAsOfDate === null
      ? null
      : (series.find((point) => point.date === detail.previousAsOfDate)?.value ?? null)

  const move = holdingMove(total, previousTotal)
  const up = move !== null && move.changeCents > 0n

  return (
    <div className="mx-auto max-w-2xl pb-10">
      <div className="flex items-center gap-1 px-3 pt-3">
        <Link
          href="/portfolio"
          className={cn(
            'inline-flex items-center gap-1 rounded-lg py-1.5 pl-1 pr-2.5 text-sm font-medium',
            'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-900',
            'focus-visible:outline-2 focus-visible:outline-sky-500',
          )}
        >
          <ChevronLeft className="size-5" aria-hidden />
          {HOLDINGS_COPY.backToPortfolio}
        </Link>
      </div>

      <div className="flex items-baseline justify-between gap-3 px-5 pt-2">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold">{detail?.symbol ?? symbol}</h1>
          {detail?.description != null && (
            <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
              {detail.description}
            </p>
          )}
        </div>
        <RangeControl value={range} onChange={setRange} />
      </div>

      <p className="px-5 pt-1 text-3xl font-semibold tabular-nums">{formatCents(total)}</p>

      {move !== null && (
        <p
          className={cn(
            'px-5 text-sm tabular-nums',
            move.changeCents === 0n
              ? 'text-slate-500 dark:text-slate-400'
              : up
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-rose-600 dark:text-rose-400',
          )}
        >
          {up ? '+' : ''}
          {formatCents(move.changeCents)}
          {move.fraction === null
            ? ''
            : ` (${up ? '+' : ''}${(move.fraction * 100).toFixed(2)}%)`}
          {detail?.asOfDate != null && (
            <span className="ml-1.5 text-xs font-normal text-slate-500 dark:text-slate-400">
              {PORTFOLIO_COPY.asOfDay(formatShortDate(detail.asOfDate))}
            </span>
          )}
        </p>
      )}

      {query.isLoading && (
        <p className="px-5 pt-4 text-sm text-slate-500 dark:text-slate-400">
          {HOLDINGS_COPY.loading}
        </p>
      )}

      {!query.isLoading && series.length > 0 && (
        <div className="mt-3 px-5">
          <AreaChart
            series={series}
            color={SECTION_COLORS.investment}
            formatValue={formatValue}
            height={CHART_HEIGHT}
            scrubLabel={HOLDINGS_COPY.chartScrubLabel}
          />
          {/*
            The coverage boundary, restated for a security.
            
            A position's value cannot be walked backwards through transactions the way a cash
            balance can — a share price moving is not something anybody posts — so this line starts
            where Beans started looking, not where the position started.
          */}
          <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
            {HOLDINGS_COPY.historyNote}
          </p>
        </div>
      )}

      {!query.isLoading && (detail?.accounts.length ?? 0) > 0 && (
        <>
          <h2 className="px-5 pb-1 pt-6 text-sm font-semibold">{HOLDINGS_COPY.byAccount}</h2>
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {detail?.accounts.map((slice) => {
              const valueCents = parseDecimalToCents(slice.marketValue)
              const price = pricePerShare(valueCents, slice.shares)

              return (
                <li key={slice.accountId}>
                  <Link
                    href={`/accounts/${slice.accountId}`}
                    className="flex items-center gap-3 px-5 py-2.5 focus-visible:outline-2 focus-visible:outline-sky-500"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {slice.accountName}
                      </span>
                      <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                        {slice.institutionName ?? ''}
                      </span>
                    </span>

                    <span className="shrink-0 text-right">
                      <span className="block text-sm tabular-nums">{formatCents(valueCents)}</span>
                      <span className="block text-xs tabular-nums text-slate-500 dark:text-slate-400">
                        {shareOf(valueCents, total)}
                        {slice.shares !== null &&
                          ` · ${formatShares(slice.shares)}${
                            price === null ? '' : ` @ ${formatCents(price)}`
                          }`}
                      </span>
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </>
      )}

      {!query.isLoading && series.length === 0 && (
        <div className="px-5 pt-6">
          <p className="text-sm font-medium">{HOLDINGS_COPY.notFound}</p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {HOLDINGS_COPY.notFoundDetail}
          </p>
        </div>
      )}
    </div>
  )
}

/** This account's share of the security, not of the portfolio. */
function shareOf(cents: bigint, total: bigint): string {
  if (total === 0n) return ''
  return `${((Number(cents) / Number(total)) * 100).toFixed(1)}%`
}
