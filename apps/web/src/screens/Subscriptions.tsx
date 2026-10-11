import {
  NET_WORTH_STATE_COPY,
  SUBSCRIPTIONS_COPY,
  formatCents,
  type RecurringDecision,
  type RecurringSeries,
} from '@beans/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { useId, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'wouter'
import { useHere, withReturn } from '../lib/back.js'
import { cn } from '../lib/cn.js'
import { localToday } from '../lib/today.js'
import { formatShortDate } from '../net-worth/display.js'
import { clearRecurringDecision, setRecurringDecision } from '../recurring/api.js'
import { buildRecurringView } from '../recurring/derive.js'
import type { StoredTransaction } from '../working-set/db.js'
import { useWorkingSet } from '../working-set/use-working-set.js'

/**
 * Charges that repeat on a schedule (ARCHITECTURE.md §20).
 *
 * Everything on this screen is computed in the browser from the working set — the server could not
 * group charges by merchant if it tried, because descriptions are ciphertext there. The only thing
 * sent back is a person's correction: this is a bill, this is a subscription, this is not recurring.
 *
 * **Spending stays negative until it is drawn.** Every figure below is negated at the point of
 * display and nowhere earlier (§3.2).
 */

/** The positive magnitude of a spending amount, for display only. */
const spent = (cents: bigint): string => formatCents(-cents)

export function Subscriptions(): ReactNode {
  const workingSet = useWorkingSet()
  const queryClient = useQueryClient()
  const today = localToday()

  const view = useMemo(
    () =>
      buildRecurringView({
        transactions: workingSet.transactions,
        categories: workingSet.categories,
        confirmedTransferIds: workingSet.confirmedTransferIds,
        decisions: workingSet.recurringDecisions,
        today,
      }),
    [
      workingSet.transactions,
      workingSet.categories,
      workingSet.confirmedTransferIds,
      workingSet.recurringDecisions,
      today,
    ],
  )

  /*
   * A decision reaches the screen the same way every other change does: the server stores it, the
   * next sync carries it, and the store is re-read. No local copy is patched in the meantime, so
   * there is one path by which the screen learns anything.
   */
  const decide = useMutation({
    mutationFn: async (input: { series: RecurringSeries; decision: RecurringDecision | null }) => {
      const existing = view.decisionIds.get(input.series.key)
      if (input.decision === null) {
        if (existing !== undefined) await clearRecurringDecision(existing)
        return
      }
      await setRecurringDecision({
        merchantKey: input.series.key,
        decision: input.decision,
        accountId: input.series.lastAccountId,
      })
    },
    onSuccess: () => queryClient.refetchQueries({ queryKey: ['working-set', 'sync'] }),
  })

  const transactionsById = useMemo(
    () => new Map(workingSet.transactions.map((entry) => [entry.id, entry])),
    [workingSet.transactions],
  )

  if (workingSet.isLoading) return <Message title={SUBSCRIPTIONS_COPY.loading} />

  if (workingSet.error !== null) {
    return (
      <Message
        title={NET_WORTH_STATE_COPY.failed}
        detail={NET_WORTH_STATE_COPY.failedDetail}
        technical={workingSet.error.message}
      />
    )
  }

  const nothing =
    view.subscriptions.length === 0 && view.bills.length === 0 && view.hidden.length === 0
  if (nothing) {
    return <Message title={SUBSCRIPTIONS_COPY.empty} detail={SUBSCRIPTIONS_COPY.emptyDetail} />
  }

  const onDecide = (series: RecurringSeries, decision: RecurringDecision | null): void => {
    decide.mutate({ series, decision })
  }
  const busyKey = decide.isPending ? decide.variables?.series.key : undefined

  return (
    <div className="mx-auto max-w-2xl px-5 pb-16 pt-6">
      <h1 className="text-2xl font-semibold">{SUBSCRIPTIONS_COPY.title}</h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{SUBSCRIPTIONS_COPY.blurb}</p>

      <dl className="mt-5 grid grid-cols-2 gap-3">
        <Figure
          label={SUBSCRIPTIONS_COPY.yearlyTotal}
          value={spent(view.subscriptionsAnnualCents)}
          note={SUBSCRIPTIONS_COPY.activeCount(view.activeSubscriptions)}
        />
        <Figure
          label={SUBSCRIPTIONS_COPY.monthlyTotal}
          // Integer division: a fraction of a cent of a monthly average is not worth displaying.
          value={spent(view.subscriptionsAnnualCents / 12n)}
        />
      </dl>

      {decide.error instanceof Error && (
        <p role="alert" className="mt-4 text-sm text-slate-700 dark:text-slate-200">
          {SUBSCRIPTIONS_COPY.actionFailed}
        </p>
      )}

      <Section
        heading={SUBSCRIPTIONS_COPY.subscriptionsHeading}
        series={view.subscriptions}
        onDecide={onDecide}
        busyKey={busyKey}
        transactionsById={transactionsById}
      />
      <Section
        heading={SUBSCRIPTIONS_COPY.billsHeading}
        subtotal={view.bills.length > 0 ? spent(view.billsAnnualCents) : undefined}
        series={view.bills}
        onDecide={onDecide}
        busyKey={busyKey}
        transactionsById={transactionsById}
      />

      <HiddenSection
        series={view.hidden}
        onDecide={onDecide}
        busyKey={busyKey}
        transactionsById={transactionsById}
      />

      <div className="mt-8 space-y-2 text-xs text-slate-500 dark:text-slate-400">
        <p>{SUBSCRIPTIONS_COPY.lapsedNote}</p>
        <p>{SUBSCRIPTIONS_COPY.windowNote}</p>
      </div>
    </div>
  )
}

function Figure({
  label,
  value,
  note,
}: {
  label: string
  value: string
  note?: string
}): ReactNode {
  return (
    <div className="rounded-xl border border-slate-200 px-4 py-3 dark:border-slate-800">
      <dt className="text-xs text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums">{value}</dd>
      {note !== undefined && <dd className="text-xs text-slate-500 dark:text-slate-400">{note}</dd>}
    </div>
  )
}

type DecideProps = {
  onDecide: (series: RecurringSeries, decision: RecurringDecision | null) => void
  busyKey: string | undefined
  transactionsById: ReadonlyMap<string, StoredTransaction>
}

function Section({
  heading,
  subtotal,
  series,
  onDecide,
  busyKey,
  transactionsById,
}: {
  heading: string
  subtotal?: string | undefined
  series: RecurringSeries[]
} & DecideProps): ReactNode {
  const headingId = useId()
  if (series.length === 0) return null

  return (
    <section aria-labelledby={headingId} className="mt-8">
      <div className="flex items-baseline justify-between">
        <h2 id={headingId} className="text-sm font-semibold">
          {heading}
        </h2>
        {subtotal !== undefined && (
          <span className="text-sm tabular-nums text-slate-500 dark:text-slate-400">
            {SUBSCRIPTIONS_COPY.perYear(subtotal)}
          </span>
        )}
      </div>
      <ul className="mt-2 divide-y divide-slate-200 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
        {series.map((entry) => (
          <SeriesRow
            key={entry.key}
            series={entry}
            onDecide={onDecide}
            busyKey={busyKey}
            transactionsById={transactionsById}
          />
        ))}
      </ul>
    </section>
  )
}

function SeriesRow({
  series,
  onDecide,
  busyKey,
  transactionsById,
}: { series: RecurringSeries } & DecideProps): ReactNode {
  const [open, setOpen] = useState(false)
  const detailId = useId()
  const here = useHere(SUBSCRIPTIONS_COPY.title)
  const lapsed = series.status === 'lapsed'
  const busy = busyKey === series.key

  const when = lapsed
    ? SUBSCRIPTIONS_COPY.lapsed(formatShortDate(series.lastDate))
    : SUBSCRIPTIONS_COPY.next(formatShortDate(series.nextDate))

  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
      >
        <ChevronRight
          aria-hidden
          className={cn('size-4 shrink-0 text-slate-400 transition-transform', open && 'rotate-90')}
        />
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              'block truncate font-medium',
              lapsed && 'text-slate-500 dark:text-slate-400',
            )}
          >
            {series.label}
          </span>
          <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
            {SUBSCRIPTIONS_COPY.cadence[series.cadence]} · {when}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block font-medium tabular-nums">
            {series.fixedAmount
              ? spent(series.amountCents)
              : SUBSCRIPTIONS_COPY.typical(spent(series.amountCents))}
          </span>
          <span className="block text-xs tabular-nums text-slate-500 dark:text-slate-400">
            {SUBSCRIPTIONS_COPY.perYear(spent(series.annualCents))}
          </span>
        </span>
      </button>

      {open && (
        <div id={detailId} className="space-y-3 px-4 pb-4 pl-11 text-sm">
          {series.priceChange !== null && (
            <p className="text-slate-600 dark:text-slate-300">
              {SUBSCRIPTIONS_COPY.priceChange(
                spent(series.priceChange.fromCents),
                formatShortDate(series.priceChange.on),
              )}
            </p>
          )}

          <Actions series={series} onDecide={onDecide} busy={busy} />

          <details>
            <summary className="cursor-pointer text-slate-600 dark:text-slate-300">
              {SUBSCRIPTIONS_COPY.viewCharges(series.transactionIds.length)}
            </summary>
            <ul className="mt-2 space-y-1">
              {/* Newest first: the recent charges are the ones somebody comes here to check. */}
              {[...series.transactionIds].reverse().map((id) => (
                <li key={id}>
                  <Link
                    href={withReturn(`/transactions/${id}`, here)}
                    className="text-slate-600 underline-offset-2 hover:underline dark:text-slate-300"
                  >
                    <ChargeLabel transaction={transactionsById.get(id)} />
                  </Link>
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </li>
  )
}

/** One charge's date and amount. */
function ChargeLabel({ transaction }: { transaction: StoredTransaction | undefined }): ReactNode {
  if (transaction === undefined) return null
  return (
    <span className="tabular-nums">
      {formatShortDate(transaction.postedDate)} · {spent(transaction.amountCents)}
    </span>
  )
}

function Actions({
  series,
  onDecide,
  busy,
}: {
  series: RecurringSeries
  onDecide: DecideProps['onDecide']
  busy: boolean
}): ReactNode {
  const button =
    'rounded-lg border border-slate-200 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-slate-700'

  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        className={button}
        disabled={busy}
        onClick={() => onDecide(series, series.kind === 'subscription' ? 'bill' : 'subscription')}
      >
        {series.kind === 'subscription'
          ? SUBSCRIPTIONS_COPY.moveToBills
          : SUBSCRIPTIONS_COPY.moveToSubscriptions}
      </button>
      <button
        type="button"
        className={button}
        disabled={busy}
        onClick={() => onDecide(series, 'ignored')}
      >
        {SUBSCRIPTIONS_COPY.hide}
      </button>
      {series.decision !== null && (
        <button
          type="button"
          className={button}
          disabled={busy}
          onClick={() => onDecide(series, null)}
        >
          {SUBSCRIPTIONS_COPY.resetDecision}
        </button>
      )}
    </div>
  )
}

function HiddenSection({
  series,
  onDecide,
  busyKey,
}: { series: RecurringSeries[] } & DecideProps): ReactNode {
  if (series.length === 0) return null

  return (
    <details className="mt-8">
      <summary className="cursor-pointer text-sm font-semibold">
        {SUBSCRIPTIONS_COPY.hiddenHeading} ({series.length})
      </summary>
      <ul className="mt-2 divide-y divide-slate-200 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
        {series.map((entry) => (
          <li key={entry.key} className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="min-w-0 truncate text-slate-500 dark:text-slate-400">
              {entry.label}
            </span>
            <button
              type="button"
              disabled={busyKey === entry.key}
              onClick={() => onDecide(entry, null)}
              className="shrink-0 rounded-lg border border-slate-200 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-slate-700"
            >
              {SUBSCRIPTIONS_COPY.unhide}
            </button>
          </li>
        ))}
      </ul>
    </details>
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
    <div className="mx-auto flex max-w-2xl flex-col items-center px-6 py-20 text-center">
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
