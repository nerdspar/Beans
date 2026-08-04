import {
  CASH_FLOW_COPY,
  CATEGORY_COPY,
  NET_WORTH_STATE_COPY,
  formatCents,
  parseDecimalToCents,
  resolveWindow,
  sliceToWindow,
  compareDates,
  cumulativeDailyFlow,
  incomeByCategory,
  precedingWindow,
  spendingByCategory,
  uncategorizedTotal,
  summarizeCashFlow,
  toIsoDate,
  type CashFlowPeriod,
} from '@beans/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Search } from 'lucide-react'
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'wouter'
import { CumulativeFlow } from '../charts/CumulativeFlow.js'
import { MonthlyBars } from '../charts/MonthlyBars.js'
import { SECTION_COLORS } from '../net-worth/colors.js'
import { formatAxisValue, formatShortDate } from '../net-worth/display.js'
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
  /*
   * Collapsed by default once there is nothing to decide. Proposals are a chore that appears after a
   * sync and then sits there; the totals above are what the screen is for, and a long list of
   * settled suggestions should not push them off the top.
   */
  const [showProposals, setShowProposals] = useState(false)
  /** Which question is being asked. Not a rendering toggle — see CASH_FLOW_COPY.tabCashFlow. */
  const [tab, setTab] = useState<'cash-flow' | 'income' | 'expenses'>('cash-flow')
  /** The day being read off the running total. Drives the header and scrolls the list. */
  const [scrubIndex, setScrubIndex] = useState<number | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  /*
   * Which side is driving.
   *
   * Scrubbing scrolls the list and scrolling the list moves the scrubber, so without a claim on who
   * is in charge each one re-triggers the other and the pair oscillates. Whoever the user is
   * touching wins until they stop.
   */
  const driver = useRef<'none' | 'chart' | 'list'>('none')


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

  const {
    summary,
    byCategory,
    byIncomeCategory,
    uncategorizedSpending,
    uncategorizedIncome,
    window,
    daily,
    dailyBefore,
    entries,
  } = useMemo(() => {
    const inWindow = sliceToWindow(
      workingSet.transactions.map((transaction) => ({
        ...transaction,
        date: transaction.postedDate,
      })),
      resolveWindow(range, today),
    )

    const rows = inWindow.map((transaction) => ({
      id: transaction.id,
      postedDate: transaction.postedDate,
      amountCents: transaction.amountCents,
      status: transaction.status,
      categoryId: transaction.categoryId,
      // The category's kind is the second half of the exclusion rule, for money sent somewhere
      // Beans does not track and so has nothing to pair with.
      categoryKind:
        transaction.categoryId === null
          ? undefined
          : workingSet.categories.get(transaction.categoryId)?.kind,
    }))

    const spending = spendingByCategory(rows, workingSet.confirmedTransferIds)
    const income = incomeByCategory(rows, workingSet.confirmedTransferIds)

    /*
     * The daily running total, and the same span immediately before it.
     *
     * Built from every transaction rather than the sliced set, because the preceding window is by
     * definition outside the current slice — slicing first would compare against nothing.
     */
    const window = resolveWindow(range, today)
    const allRows = workingSet.transactions.map((transaction) => ({
      id: transaction.id,
      postedDate: transaction.postedDate,
      amountCents: transaction.amountCents,
      status: transaction.status,
      categoryId: transaction.categoryId,
      categoryKind:
        transaction.categoryId === null
          ? undefined
          : workingSet.categories.get(transaction.categoryId)?.kind,
    }))

    const previous = precedingWindow(window.start, window.end)

    /*
     * The running total follows the tab. On Income it accumulates only money in, on Expenses only
     * money out — the same question each tab's bars answer, asked across days instead of months.
     */
    const direction = tab === 'income' ? 'in' : tab === 'expenses' ? 'out' : 'net'

    return {
      summary: summarizeCashFlow(rows, workingSet.confirmedTransferIds),
      byCategory: spending,
      byIncomeCategory: income,
      uncategorizedSpending: uncategorizedTotal(spending),
      uncategorizedIncome: uncategorizedTotal(income),
      window,
      daily: cumulativeDailyFlow(
        allRows,
        window.start,
        window.end,
        direction,
        workingSet.confirmedTransferIds,
      ),
      dailyBefore: cumulativeDailyFlow(
        allRows,
        previous.from,
        previous.to,
        direction,
        workingSet.confirmedTransferIds,
      ),
      /** Newest first, for the list the scrubber drives. */
      entries: [...inWindow].sort(
        (left, right) =>
          compareDates(right.postedDate, left.postedDate) || left.id.localeCompare(right.id),
      ),
    }
  }, [
    workingSet.transactions,
    workingSet.confirmedTransferIds,
    workingSet.categories,
    range,
    today,
    tab,
  ])

  /** How much of the window has actually happened — the rest has not, and is not drawn. */
  const elapsedDays = useMemo(() => {
    const index = daily.findIndex((point) => point.date > today)
    return index === -1 ? daily.length : index
  }, [daily, today])

  const onScrub = useCallback(
    (index: number | null): void => {
      driver.current = index === null ? 'none' : 'chart'
      setScrubIndex(index)

      const date = index === null ? null : daily[index]?.date
      if (date === undefined || date === null) return

      /*
       * The first row on or before the scrubbed day. Exact-date lookup would find nothing on the
       * many days with no transactions, and the list would sit still while the line moved.
       */
      const target = listRef.current?.querySelector<HTMLElement>(`[data-on-or-before="${date}"]`)
      target?.scrollIntoView({ block: 'nearest' })
    },
    [daily],
  )

  /*
   * The other direction: the topmost visible row decides where the line sits.
   *
   * Ignored while the chart is driving, or scrolling triggered by a scrub would move the scrubber,
   * which would scroll again. The chart releases its claim when the gesture ends.
   */
  const onListScroll = useCallback((): void => {
    if (driver.current === 'chart') return

    const list = listRef.current
    if (list === null) return

    const top = list.getBoundingClientRect().top
    const row = [...list.querySelectorAll<HTMLElement>('[data-on-or-before]')].find(
      (candidate) => candidate.getBoundingClientRect().bottom >= top,
    )

    const date = row?.dataset['onOrBefore']
    if (date === undefined) return

    const index = daily.findIndex((point) => point.date === date)
    if (index === -1) return

    driver.current = 'list'
    setScrubIndex(index)
  }, [daily])

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

  /*
   * What the unconfirmed proposals are worth.
   *
   * One side of each pair, not both: the pair is equal and opposite, so this amount appears once in
   * income and once in spending. Saying it once is what makes "counted as both" a checkable claim.
   */
  const pendingCents = pending.reduce(
    (sum, transfer) => sum + parseDecimalToCents(transfer.amount),
    0n,
  )

  return (
    <div className="mx-auto max-w-2xl px-5 pb-16 pt-5">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold">{CASH_FLOW_COPY.title}</h1>
        <RangeControl value={range} onChange={setRange} />
      </div>

      {/*
        Split by question, not by rendering.

        A breakdown by category only means something once a direction is chosen: groceries and a
        paycheck cannot share an axis, and the figure they would sum to is net — which nobody breaks
        down by category. So the combined tab answers what the two did to each other, and the
        breakdowns live where a direction has been picked.
      */}
      <div
        role="tablist"
        aria-label={CASH_FLOW_COPY.title}
        className="mt-3 flex gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-900"
      >
        {(
          [
            ['cash-flow', CASH_FLOW_COPY.tabCashFlow],
            ['income', CASH_FLOW_COPY.tabIncome],
            ['expenses', CASH_FLOW_COPY.tabExpenses],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={cn(
              'min-h-9 flex-1 rounded-md text-sm font-medium',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-500',
              tab === value
                ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100'
                : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <Caveats
        pendingCount={pending.length}
        pendingCents={pendingCents}
        uncategorizedCents={tab === 'income' ? uncategorizedIncome : uncategorizedSpending}
        direction={tab === 'income' ? 'income' : 'spending'}
        onReview={() => setShowProposals(true)}
      />

      {summary.periods.length === 0 ? (
        <Message title={CASH_FLOW_COPY.empty} detail={CASH_FLOW_COPY.emptyDetail} />
      ) : tab === 'cash-flow' ? (
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

          {/*
            One month gets the running total; more than one gets bars.

            Not a preference. A cumulative line across a year would be dominated by the trend and
            say nothing about any month in it, and a bar per day for thirty days is unreadable. The
            question changes with the span, so the chart does.
          */}
          {summary.periods.length <= 1 && daily.length > 1 && (
            <section className="mt-6">
              <CumulativeFlow
                series={daily}
                comparison={dailyBefore}
                color={SECTION_COLORS.household}
                formatValue={(cents, digits) => formatAxisValue(cents, 'household', digits)}
                scrubIndex={scrubIndex}
                onScrub={onScrub}
                describePoint={(index) => {
                  const point = daily[Math.min(Math.max(index, 0), daily.length - 1)]
                  return point === undefined
                    ? ''
                    : `${formatShortDate(point.date)}: ${formatCents(point.cumulativeCents)}`
                }}
                scrubLabel={CASH_FLOW_COPY.runningTotal}
                elapsedCount={elapsedDays}
              />
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {CASH_FLOW_COPY.comparedWith}
              </p>
            </section>
          )}

          {summary.periods.length > 1 && (
            <MonthlyBars
              className="mt-6"
              periods={summary.periods}
              mode="net"
              formatValue={formatCents}
              averageLabel={CASH_FLOW_COPY.average}
            />
          )}

          {/* Kept below the chart: this is its table fallback as much as it is detail. */}
          {summary.periods.length > 1 && (
            <>
              <h2 className="mt-6 text-sm font-semibold">{CASH_FLOW_COPY.byMonth}</h2>
              <ul className="mt-2 space-y-3">
                {[...summary.periods].reverse().map((period) => (
                  <li key={period.month}>
                    <MonthRow period={period} scale={largestMonth(summary.periods)} />
                  </li>
                ))}
              </ul>
            </>
          )}

          {/*
            The list the chart indexes into.
            
            A cumulative line says when the money moved; this says what it was. Scrubbing scrolls
            here, and scrolling here moves the line — the two are one view of the same days, and
            reading either alone means holding the other in your head.
          */}
          {summary.periods.length <= 1 && (
            <section className="mt-6">
              <h2 className="text-sm font-semibold">{CASH_FLOW_COPY.activityHeading}</h2>

              {entries.length === 0 ? (
                <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                  {CASH_FLOW_COPY.activityEmpty}
                </p>
              ) : (
                <ul
                  ref={listRef}
                  onScroll={onListScroll}
                  className="mt-2 max-h-96 overflow-y-auto"
                >
                  {/*
                    Grouped under a date, with the category on the row.
                    
                    The date was repeated on every row and the category was nowhere, which is the
                    wrong way round: consecutive rows usually share a date and never share a
                    category. A heading says it once for the group, and the row spends its second
                    line on the thing that actually differs.
                  */}
                  {groupByDate(entries).map(([date, rows]) => (
                    <li key={date} data-on-or-before={date}>
                      <h3
                        className={cn(
                          'sticky top-0 z-10 py-1 text-xs font-medium tabular-nums',
                          'bg-slate-50/95 text-slate-500 backdrop-blur',
                          'dark:bg-slate-950/95 dark:text-slate-400',
                        )}
                      >
                        {formatShortDate(date)}
                      </h3>

                      <ul className="divide-y divide-slate-200 dark:divide-slate-800">
                        {rows.map((entry) => (
                          <li
                            key={entry.id}
                            className="flex items-baseline justify-between gap-3 py-2.5"
                          >
                            <div className="min-w-0">
                              <p className="truncate text-sm">
                                {entry.payee ?? entry.description ?? '—'}
                              </p>
                              <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                                {entry.categoryId === null
                                  ? CATEGORY_COPY.uncategorized
                                  : (workingSet.categories.get(entry.categoryId)?.name ??
                                    CATEGORY_COPY.uncategorized)}
                              </p>
                            </div>
                            <span
                              className={cn(
                                'shrink-0 text-sm tabular-nums',
                                entry.amountCents > 0n && 'text-emerald-600 dark:text-emerald-400',
                              )}
                            >
                              {formatCents(entry.amountCents)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      ) : (
        <Breakdown
          periods={summary.periods}
          daily={daily}
          dailyBefore={dailyBefore}
          elapsedCount={elapsedDays}
          mode={tab === 'income' ? 'income' : 'spending'}
          totals={tab === 'income' ? byIncomeCategory : byCategory}
          totalCents={tab === 'income' ? summary.incomeCents : -summary.spendingCents}
          label={tab === 'income' ? CASH_FLOW_COPY.income : CASH_FLOW_COPY.spending}
          heading={
            tab === 'income' ? CASH_FLOW_COPY.byCategoryIncome : CASH_FLOW_COPY.byCategory
          }
          categories={workingSet.categories}
        />
      )}

      <section className="mt-8">
        <div className="flex items-baseline justify-between gap-3">
          <button
            type="button"
            onClick={() => setShowProposals(!showProposals)}
            aria-expanded={showProposals}
            className="flex items-center gap-1.5 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-sky-500"
          >
            <ChevronRight
              className={cn('size-4 transition-transform', showProposals && 'rotate-90')}
              aria-hidden
            />
            {CASH_FLOW_COPY.reviewHeading}
            {/* The count is on the summary line, so a pending decision is visible while collapsed. */}
            {pending.length > 0 && (
              <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-800 dark:bg-sky-950 dark:text-sky-300">
                {pending.length}
              </span>
            )}
          </button>

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

        {showProposals && (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {CASH_FLOW_COPY.reviewBlurb}
          </p>
        )}

        {/*
          Shown rather than swallowed. A confirmation that silently fails looks identical to one
          that worked — the proposal simply stays put — and the totals it should have moved do not.
        */}
        {(resolve.error instanceof Error || detect.error instanceof Error) && (
          <p role="alert" className="mt-2 text-xs text-rose-600 dark:text-rose-400">
            {(resolve.error instanceof Error ? resolve.error : (detect.error as Error)).message}
          </p>
        )}

        {showProposals &&
          (pending.length === 0 ? (
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
          ))}
      </section>
    </div>
  )
}

/**
 * One category's share of spending.
 *
 * Uncategorized is muted rather than hidden — it is real spending, and showing it is what prompts
 * somebody to sort it. Dropping it would make the bars add up to less than the total above them.
 */
function CategoryRow({
  label,
  cents,
  largest,
  muted,
}: {
  label: string
  cents: bigint
  largest: bigint
  muted: boolean
}): ReactNode {
  const width = `${Math.min(100, Number((cents * 100n) / (largest <= 0n ? 1n : largest)))}%`

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className={cn('truncate', muted && 'text-slate-500 dark:text-slate-400')}>
          {label}
        </span>
        <span className="shrink-0 tabular-nums">{formatCents(cents)}</span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-slate-200 dark:bg-slate-800" aria-hidden>
        <div
          className={cn('h-full rounded-full', muted ? 'bg-slate-400' : 'bg-sky-500')}
          style={{ width }}
        />
      </div>
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

/**
 * Reasons the totals below may be wrong, each with its size.
 *
 * Every entry names a number. "$4,200 of the spending below has no category" is something somebody
 * can act on; "some transactions are uncategorized" is a disclaimer people learn to scroll past.
 *
 * The strip renders nothing at all when there is nothing to say, which is what keeps its presence
 * meaningful — a permanent advisory bar is furniture, and gets read as furniture.
 */
function Caveats({
  pendingCount,
  pendingCents,
  uncategorizedCents,
  direction,
  onReview,
}: {
  pendingCount: number
  pendingCents: bigint
  uncategorizedCents: bigint
  direction: 'income' | 'spending'
  onReview: () => void
}): ReactNode {
  const entries: Array<{ key: string; text: string; action?: { label: string; href?: string; onClick?: () => void } }> = []

  if (pendingCount > 0) {
    entries.push({
      key: 'transfers',
      text: CASH_FLOW_COPY.caveatTransfers(pendingCount, formatCents(pendingCents)),
      action: { label: CASH_FLOW_COPY.caveatTransfersAction, onClick: onReview },
    })
  }

  if (uncategorizedCents > 0n) {
    entries.push({
      key: 'uncategorized',
      text:
        direction === 'income'
          ? CASH_FLOW_COPY.caveatUncategorizedIncome(formatCents(uncategorizedCents))
          : CASH_FLOW_COPY.caveatUncategorizedSpending(formatCents(uncategorizedCents)),
      action: { label: CASH_FLOW_COPY.caveatCategorize, href: '/transactions' },
    })
  }

  if (entries.length === 0) return null

  return (
    <section
      aria-label={CASH_FLOW_COPY.caveatsHeading}
      className={cn(
        'mt-3 rounded-xl border p-3',
        'border-amber-200 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/30',
      )}
    >
      <h2 className="text-xs font-semibold text-amber-900 dark:text-amber-200">
        {CASH_FLOW_COPY.caveatsHeading}
      </h2>
      <ul className="mt-1.5 space-y-1.5">
        {entries.map((entry) => (
          <li
            key={entry.key}
            className="flex items-baseline justify-between gap-3 text-xs text-amber-900 dark:text-amber-200"
          >
            <span className="min-w-0">{entry.text}</span>
            {entry.action?.href !== undefined ? (
              <Link
                href={entry.action.href}
                className="shrink-0 font-medium underline underline-offset-2"
              >
                {entry.action.label}
              </Link>
            ) : (
              <button
                type="button"
                onClick={entry.action?.onClick}
                className="shrink-0 font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-amber-600"
              >
                {entry.action?.label}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * One direction's categories, largest first.
 *
 * The total is shown above the bars so the parts can be checked against the whole — a breakdown
 * whose rows do not obviously sum to something is a ranking, not an account of where money went.
 */
function Breakdown({
  periods,
  daily,
  dailyBefore,
  elapsedCount,
  mode,
  totals,
  totalCents,
  label,
  heading,
  categories,
}: {
  periods: readonly CashFlowPeriod[]
  daily: readonly { date: string; cumulativeCents: bigint }[]
  dailyBefore: readonly { date: string; cumulativeCents: bigint }[]
  elapsedCount: number
  mode: 'income' | 'spending'
  totals: readonly { categoryId: string | null; cents: bigint }[]
  totalCents: bigint
  label: string
  heading: string
  categories: ReadonlyMap<string, { name: string }>
}): ReactNode {
  // Magnitudes for display; the stored sign is never re-decided here.
  const magnitude = (cents: bigint): bigint => (cents < 0n ? -cents : cents)
  const largest = magnitude(totals[0]?.cents ?? 1n)

  return (
    <>
      <div className="mt-4">
        {/* `exactOptionalPropertyTypes`: an absent tone and an explicit undefined are not the same. */}
        {label === CASH_FLOW_COPY.income ? (
          <Total label={label} cents={totalCents} tone="income" />
        ) : (
          <Total label={label} cents={totalCents} />
        )}
      </div>

      {/*
        The same split as the combined tab: one month gets the running total, more gets bars. A tab
        that showed only bars would answer "which month" while the other two answered "which day".
      */}
      {periods.length <= 1 && daily.length > 1 && (
        <section className="mt-6">
          <CumulativeFlow
            series={daily}
            comparison={dailyBefore}
            color={mode === 'income' ? SECTION_COLORS.household : '#fb923c'}
            /*
             * Negated for the axis only, and only here. Spending stays negative in the data; a
             * y-axis running to -$6K under a heading that already says Expenses is the minus sign
             * being reported twice.
             */
            formatValue={(cents, digits) =>
              formatAxisValue(mode === 'spending' ? -cents : cents, 'household', digits)
            }
            elapsedCount={elapsedCount}
          />
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {CASH_FLOW_COPY.comparedWith}
          </p>
        </section>
      )}

      {periods.length > 1 && (
        <MonthlyBars
          className="mt-6"
          periods={periods}
          mode={mode}
          /*
           * Negated for the label only, and only here. Spending stays negative in the data and is
           * drawn below the zero line as such; "Avg $-15,942" under a heading that already says
           * Expenses is the minus sign being reported twice.
           */
          formatValue={(cents) => formatCents(mode === 'spending' ? -cents : cents)}
          averageLabel={CASH_FLOW_COPY.average}
        />
      )}

      {totals.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
          {CASH_FLOW_COPY.empty}
        </p>
      ) : (
        <section className="mt-6">
          <h2 className="text-sm font-semibold">{heading}</h2>
          <ul className="mt-2 space-y-2">
            {totals.map((total) => (
              <li key={total.categoryId ?? 'uncategorized'}>
                <Link
                  href={
                    total.categoryId === null
                      ? '/transactions'
                      : `/transactions?category=${encodeURIComponent(total.categoryId)}`
                  }
                  className="block rounded-lg focus-visible:outline-2 focus-visible:outline-sky-500"
                >
                  <CategoryRow
                    label={
                      total.categoryId === null
                        ? CATEGORY_COPY.uncategorized
                        : (categories.get(total.categoryId)?.name ?? CATEGORY_COPY.uncategorized)
                    }
                    cents={magnitude(total.cents)}
                    largest={largest}
                    muted={total.categoryId === null}
                  />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

/**
 * Rows grouped under the date they posted, newest first.
 *
 * Only dates with something on them get a heading — an empty day is not a fact worth a row, and the
 * chart above already shows the gap as a flat stretch.
 */
function groupByDate<T extends { postedDate: string }>(rows: readonly T[]): Array<[string, T[]]> {
  const byDate = new Map<string, T[]>()

  for (const row of rows) {
    const existing = byDate.get(row.postedDate)
    if (existing === undefined) {
      byDate.set(row.postedDate, [row])
    } else {
      existing.push(row)
    }
  }

  // Insertion order is already newest-first, because the rows arrive sorted.
  return [...byDate.entries()]
}
