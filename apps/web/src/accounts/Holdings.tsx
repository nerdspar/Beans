import {
  HOLDINGS_COPY,
  formatCents,
  formatShares,
  holdingMove,
  parseDecimalToCents,
  pricePerShare,
} from '@beans/shared'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { readHoldings, type Holding } from './api.js'
import { cn } from '../lib/cn.js'
import { formatShortDate } from '../net-worth/display.js'

/**
 * The positions inside one investment account.
 *
 * **Only rendered for investment accounts, and only fetched when one is on screen.** Holdings are
 * drill-down detail rather than something every screen needs, so they are their own request instead
 * of riding along in the working set.
 *
 * The state this screen exists to get right is the one where a provider reports no positions at all.
 * That is the common case, not the exception — an institution can happily report a balance and
 * nothing about what is inside it — and it must never render as an empty portfolio. Nothing is
 * missing from net worth when this list is empty; only the breakdown is.
 */

export function Holdings({ accountId }: { accountId: string }): ReactNode {
  const query = useQuery({
    queryKey: ['holdings', accountId],
    queryFn: () => readHoldings(accountId),
  })

  if (query.isLoading) {
    return <Note>{HOLDINGS_COPY.loading}</Note>
  }

  if (query.error !== null) {
    return <Note>{HOLDINGS_COPY.failed}</Note>
  }

  const reading = query.data

  if (reading === undefined || reading.asOfDate === null || reading.holdings.length === 0) {
    /*
     * Two different empty states, and telling them apart is most of the value of this screen.
     *
     * Positions are only ever written by a sync, so an account that has not synced since holdings
     * existed has none for a reason that says nothing whatsoever about its institution. Presenting
     * that as "no positions reported" would blame a provider nobody has asked yet.
     */
    const neverChecked = reading === undefined || reading.checkedAt === null

    return (
      <div className="px-5 pb-2">
        <p className="text-sm font-medium">
          {neverChecked ? HOLDINGS_COPY.notCheckedYet : HOLDINGS_COPY.unsupported}
        </p>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {neverChecked ? HOLDINGS_COPY.notCheckedYetDetail : HOLDINGS_COPY.unsupportedDetail}
        </p>
      </div>
    )
  }

  const total = reading.holdings.reduce(
    (sum, holding) => sum + parseDecimalToCents(holding.marketValue),
    0n,
  )

  return (
    <div>
      <p className="px-5 text-xs text-slate-500 dark:text-slate-400">
        {HOLDINGS_COPY.asOf(formatShortDate(reading.asOfDate))}
        {reading.previousAsOfDate !== null &&
          `, ${HOLDINGS_COPY.since(formatShortDate(reading.previousAsOfDate))}`}
      </p>

      <ul className="mt-2 divide-y divide-slate-200 dark:divide-slate-800">
        {reading.holdings.map((holding) => (
          <Row
            key={holding.providerHoldingId}
            holding={holding}
            previous={reading.previousMarketValues[holding.providerHoldingId]}
            total={total}
          />
        ))}
      </ul>

      <p className="px-5 pt-2 text-[11px] text-slate-500 dark:text-slate-400">
        {HOLDINGS_COPY.movesNote}
      </p>
    </div>
  )
}

function Row({
  holding,
  previous,
  total,
}: {
  holding: Holding
  previous: string | undefined
  total: bigint
}): ReactNode {
  const valueCents = parseDecimalToCents(holding.marketValue)
  const move = holdingMove(
    valueCents,
    previous === undefined ? null : parseDecimalToCents(previous),
  )
  const price = pricePerShare(valueCents, holding.shares)

  const up = move !== null && move.changeCents > 0n
  const down = move !== null && move.changeCents < 0n

  return (
    <li className="flex items-start gap-3 px-5 py-2.5">
      <span className="min-w-0 flex-1">
        {/* Symbol first: it is what somebody scans for, and the description is often truncated. */}
        <span className="block truncate text-sm font-medium">
          {holding.symbol ?? holding.description ?? '—'}
        </span>
        <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
          {holding.symbol === null ? '' : (holding.description ?? '')}
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
          // Not a zero. A position bought since the last observation has no move, and showing its
          // whole value as a gain would be the most misleading number on the screen.
          <span className="block">{HOLDINGS_COPY.noPrevious}</span>
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
        <span className="block text-sm tabular-nums">{formatCents(valueCents)}</span>
        <span className="block text-xs tabular-nums text-slate-500 dark:text-slate-400">
          {holding.shares === null
            ? shareOf(valueCents, total)
            : HOLDINGS_COPY.quantity(
                formatShares(holding.shares),
                price === null ? null : formatCents(price),
              )}
        </span>
      </span>
    </li>
  )
}

function Note({ children }: { children: ReactNode }): ReactNode {
  return <p className="px-5 pb-2 text-sm text-slate-500 dark:text-slate-400">{children}</p>
}

/** The fallback second line where no share count was reported. */
function shareOf(cents: bigint, total: bigint): string {
  if (total === 0n) return ''
  return `${((Number(cents) / Number(total)) * 100).toFixed(1)}%`
}
