import {
  CASH_FLOW_COPY,
  NET_WORTH_STATE_COPY,
  formatCents,
  resolveWindow,
  sliceToWindow,
  summarizeCashFlow,
  toIsoDate,
  type CashFlowPeriod,
} from '@beans/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { cn } from '../lib/cn.js'
import { RangeControl } from '../net-worth/RangeControl.js'
import { DEFAULT_RANGE, type RangeSelection } from '../net-worth/range.js'
import {
  detectTransfers,
  listProposedTransfers,
  resolveTransfer,
  type ProposedTransfer,
} from '../transfers/api.js'
import { WORKING_SET_KEY } from '../working-set/use-working-set.js'
import { useWorkingSet } from '../working-set/use-working-set.js'

/**
 * What came in, what went out, and what is neither.
 *
 * **Transfers are excluded, and that is the whole difficulty.** Paying a credit card is an outflow
 * from checking and an inflow to the card; counted naively it adds the same amount to both sides —
 * money neither earned nor spent. Net is unaffected, which is exactly why the error survives casual
 * inspection. Exclusion is decided by one function in `@beans/shared` (ARCHITECTURE.md §9), never
 * re-implemented here.
 */

export function CashFlow(): ReactNode {
  const workingSet = useWorkingSet()
  const queryClient = useQueryClient()
  const [range, setRange] = useState<RangeSelection>(DEFAULT_RANGE)

  const proposals = useQuery({ queryKey: ['transfers', 'proposed'], queryFn: listProposedTransfers })

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['transfers'] })
    // A confirmation changes what counts, so the working set has to be re-read for its pair list.
    await queryClient.invalidateQueries({ queryKey: ['working-set', 'sync'] })
    await queryClient.invalidateQueries({ queryKey: WORKING_SET_KEY })
  }

  const detect = useMutation({ mutationFn: detectTransfers, onSuccess: refresh })
  const resolve = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'confirmed' | 'rejected' }) =>
      resolveTransfer(id, decision),
    onSuccess: refresh,
  })

  const today = toIsoDate(new Date())

  const summary = useMemo(() => {
    const inWindow = sliceToWindow(
      workingSet.transactions.map((transaction) => ({
        ...transaction,
        date: transaction.postedDate,
      })),
      resolveWindow(range, today),
    )

    return summarizeCashFlow(
      inWindow.map((transaction) => ({
        id: transaction.id,
        postedDate: transaction.postedDate,
        amountCents: transaction.amountCents,
        status: transaction.status,
      })),
      workingSet.confirmedTransferIds,
    )
  }, [workingSet.transactions, workingSet.confirmedTransferIds, range, today])

  if (workingSet.isLoading) {
    return <Message title={CASH_FLOW_COPY.loading} />
  }

  if (workingSet.error !== null) {
    return (
      <Message
        title={NET_WORTH_STATE_COPY.failed}
        detail={NET_WORTH_STATE_COPY.failedDetail}
        technical={workingSet.error.message}
      />
    )
  }

  const pending = proposals.data ?? []

  return (
    <div className="mx-auto max-w-2xl px-5 pb-16 pt-5">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold">{CASH_FLOW_COPY.title}</h1>
        <RangeControl value={range} onChange={setRange} />
      </div>

      {summary.periods.length === 0 ? (
        <Message title={CASH_FLOW_COPY.empty} detail={CASH_FLOW_COPY.emptyDetail} />
      ) : (
        <>
          <div className="mt-4 grid grid-cols-3 gap-3">
            <Total label={CASH_FLOW_COPY.income} cents={summary.incomeCents} tone="income" />
            {/* Negated for display only. It stays negative everywhere else so it adds directly. */}
            <Total label={CASH_FLOW_COPY.spending} cents={-summary.spendingCents} />
            <Total label={CASH_FLOW_COPY.net} cents={summary.netCents} tone="net" />
          </div>

          {/* Said out loud: a total that quietly ignored some transactions would be unaccountable. */}
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            {CASH_FLOW_COPY.transfersExcluded(summary.excludedCount)}
          </p>

          <ul className="mt-5 space-y-3">
            {[...summary.periods].reverse().map((period) => (
              <li key={period.month}>
                <MonthRow period={period} scale={largestMonth(summary.periods)} />
              </li>
            ))}
          </ul>
        </>
      )}

      <section className="mt-8">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold">{CASH_FLOW_COPY.reviewHeading}</h2>
          <button
            type="button"
            onClick={() => detect.mutate()}
            disabled={detect.isPending}
            className={cn(
              'inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium',
              'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800',
              'focus-visible:outline-2 focus-visible:outline-sky-500 disabled:opacity-50',
            )}
          >
            <Search className="size-3.5" aria-hidden />
            {detect.isPending ? CASH_FLOW_COPY.reviewFinding : CASH_FLOW_COPY.reviewFind}
          </button>
        </div>

        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {CASH_FLOW_COPY.reviewBlurb}
        </p>

        {/*
          Shown rather than swallowed. A confirmation that silently fails looks identical to one
          that worked — the proposal simply stays put — and the totals it should have moved do not.
        */}
        {(resolve.error instanceof Error || detect.error instanceof Error) && (
          <p role="alert" className="mt-2 text-xs text-rose-600 dark:text-rose-400">
            {(resolve.error instanceof Error ? resolve.error : (detect.error as Error)).message}
          </p>
        )}

        {pending.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
            {CASH_FLOW_COPY.reviewNone}
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {pending.map((transfer) => (
              <li key={transfer.id}>
                <ProposalCard
                  transfer={transfer}
                  isPending={resolve.isPending}
                  onDecide={(decision) => resolve.mutate({ id: transfer.id, decision })}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function largestMonth(periods: readonly CashFlowPeriod[]): bigint {
  return periods.reduce((largest, period) => {
    const income = period.incomeCents
    const spending = -period.spendingCents
    const bigger = income > spending ? income : spending
    return bigger > largest ? bigger : largest
  }, 1n)
}

function Total({
  label,
  cents,
  tone,
}: {
  label: string
  cents: bigint
  tone?: 'income' | 'net'
}): ReactNode {
  /*
   * Only net is coloured by direction, and only when negative. Income is always positive and
   * spending always negative, so colouring them says nothing; a negative net says something.
   */
  const unfavourable = tone === 'net' && cents < 0n

  return (
    <div>
      <p className="text-xs text-slate-500 dark:text-slate-400">{label}</p>
      <p
        className={cn(
          'mt-0.5 text-lg font-semibold tabular-nums',
          tone === 'income' && 'text-emerald-600 dark:text-emerald-400',
          unfavourable && 'text-rose-600 dark:text-rose-400',
        )}
      >
        {formatCents(cents)}
      </p>
    </div>
  )
}

function MonthRow({ period, scale }: { period: CashFlowPeriod; scale: bigint }): ReactNode {
  const spending = -period.spendingCents
  const width = (value: bigint): string =>
    `${Math.min(100, Number((value * 100n) / (scale === 0n ? 1n : scale)))}%`

  const saved = period.netCents >= 0n

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{formatMonth(period.month)}</span>
        {/*
          Words rather than a bare sign. "$412 more than you earned" cannot be misread the way a
          negative number can, and it is stated plainly — no commentary on a month that went badly.
        */}
        <span
          className={cn(
            'tabular-nums',
            saved
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-rose-600 dark:text-rose-400',
          )}
        >
          {formatCents(saved ? period.netCents : -period.netCents)}{' '}
          {saved ? CASH_FLOW_COPY.saved : CASH_FLOW_COPY.overspent}
        </span>
      </div>

      <div className="mt-1.5 space-y-1" aria-hidden>
        <div className="h-1.5 rounded-full bg-slate-200 dark:bg-slate-800">
          <div
            className="h-full rounded-full bg-emerald-500"
            style={{ width: width(period.incomeCents) }}
          />
        </div>
        <div className="h-1.5 rounded-full bg-slate-200 dark:bg-slate-800">
          <div className="h-full rounded-full bg-slate-400" style={{ width: width(spending) }} />
        </div>
      </div>

      {/* The bars are decorative; these are the numbers they stand for. */}
      <p className="mt-1 text-xs text-slate-500 tabular-nums dark:text-slate-400">
        {formatCents(period.incomeCents)} in · {formatCents(spending)} out
      </p>
    </div>
  )
}

const MONTH = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})

function formatMonth(month: string): string {
  return MONTH.format(new Date(`${month}-01T00:00:00Z`))
}

function ProposalCard({
  transfer,
  isPending,
  onDecide,
}: {
  transfer: ProposedTransfer
  isPending: boolean
  onDecide: (decision: 'confirmed' | 'rejected') => void
}): ReactNode {
  return (
    <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
      <p className="text-sm font-semibold tabular-nums">${transfer.amount}</p>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
        {CASH_FLOW_COPY.movedFrom} {transfer.fromAccountName} {CASH_FLOW_COPY.movedTo}{' '}
        {transfer.toAccountName}
      </p>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => onDecide('confirmed')}
          disabled={isPending}
          className={cn(
            'min-h-9 flex-1 rounded-lg text-xs font-semibold',
            'bg-sky-600 text-white hover:bg-sky-500 disabled:opacity-50',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500',
          )}
        >
          {CASH_FLOW_COPY.confirm}
        </button>
        <button
          type="button"
          onClick={() => onDecide('rejected')}
          disabled={isPending}
          className={cn(
            'min-h-9 flex-1 rounded-lg border text-xs font-medium',
            'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800',
            'focus-visible:outline-2 focus-visible:outline-sky-500 disabled:opacity-50',
          )}
        >
          {CASH_FLOW_COPY.reject}
        </button>
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
    <div className="flex flex-col items-center px-6 py-16 text-center">
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
