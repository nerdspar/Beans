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
  monthWindow,
  precedingWindow,
  previousMonthWindow,
  spendingByCategory,
  uncategorizedTotal,
  summarizeCashFlow,
  type CashFlowPeriod,
} from '@beans/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Search } from 'lucide-react'
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'wouter'
import { useHere, withReturn } from '../lib/back.js'
import { CumulativeFlow } from '../charts/CumulativeFlow.js'
import { MonthlyBars } from '../charts/MonthlyBars.js'
import { nextSelection, type ChartSelection } from '../charts/selection.js'
import { useSessionFlag } from '../lib/use-session-flag.js'
import { SECTION_COLORS } from '../net-worth/colors.js'
import { formatAxisValue, formatShortDate } from '../net-worth/display.js'
import { cn } from '../lib/cn.js'
import { RangeControl } from '../net-worth/RangeControl.js'
import { type RangeSelection } from '../net-worth/range.js'
import {
  detectTransfers,
  listProposedTransfers,
  resolveTransfer,
  type ProposedTransfer,
} from '../transfers/api.js'
import { WORKING_SET_KEY } from '../working-set/use-working-set.js'
import { useWorkingSet } from '../working-set/use-working-set.js'
import { localToday } from '../lib/today.js'

/**
 * What came in, what went out, and what is neither.
 *
 * **Transfers are excluded, and that is the whole difficulty.** Paying a credit card is an outflow
 * from checking and an inflow to the card; counted naively it adds the same amount to both sides —
 * money neither earned nor spent. Net is unaffected, which is exactly why the error survives casual
 * inspection. Exclusion is decided by one function in `@beans/shared` (ARCHITECTURE.md §9), never
 * re-implemented here.
 */

/**
 * How far above the scroll box's edge the date header pins, in pixels.
 *
 * Must match the `-top-2` on the header itself — Tailwind's scale puts that at 8px. A scroll that
 * lands on a date has to overshoot by the same amount, or the header arrives unpinned.
 */
const STICKY_DATE_OFFSET_PX = 8

/**
 * What the by-month table calls its value column, per tab.
 *
 * A record rather than a ternary at the call site so adding a mode cannot quietly fall through to
 * "Net" — the type requires every key, and a missing one is a build error rather than a table
 * mislabelling spending as its opposite.
 */
const MODE_TABLE_LABEL: Record<'net' | 'income' | 'spending', string> = {
  net: CASH_FLOW_COPY.net,
  income: CASH_FLOW_COPY.income,
  spending: CASH_FLOW_COPY.spending,
}

export function CashFlow(): ReactNode {
  const workingSet = useWorkingSet()
  const queryClient = useQueryClient()
  /*
   * This month, not the ninety days the other screens open on.
   *
   * Cash flow is asked about a month at a time — what came in and went out since the last payday,
   * and whether that is normal. Ninety days answers a different question, and answers it as a bar
   * chart of three months rather than the day-by-day view of the one anybody is standing in.
   */
  const [range, setRange] = useState<RangeSelection>({ kind: 'preset', key: 'this-month' })
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
  /** The month being read off the bars. Separate from the daily reading — different charts. */
  const [monthIndex, setMonthIndex] = useState<number | null>(null)

  /**
   * The held selection, stored as a date rather than an index.
   *
   * An index means a different thing under a different series — index 9 is a different month once
   * the tab changes the direction being accumulated. A date survives that, which is what lets the
   * three tabs be three views of the same selected month.
   */
  const [pinned, setPinned] = useState<ChartSelection | null>(null)

  /** Open by default; folded away it holds for this visit and returns on the next one. */
  const [caveatsOpen, setCaveatsOpen] = useSessionFlag('beans.cash-flow.caveats', true)

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

  const today = localToday()
  /* This screen as it stands — tab, range and any held selection — so back returns to it. */
  const here = useHere(CASH_FLOW_COPY.title)

  const {
    summary,
    byCategory,
    byIncomeCategory,
    uncategorizedSpending,
    uncategorizedIncome,
    window,
    singleMonth,
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

    /*
     * The chart's window is not the totals' window.
     *
     * "This month" resolves to start-of-month through *today*, which is right for the totals — they
     * should report what has happened. Drawing the chart over the same span would redraw its own
     * axis every day and leave a month in progress no room to run into, so the chart takes the whole
     * calendar month and stops its solid line at today instead.
     */
    const singleMonth = window.start.slice(0, 7) === window.end.slice(0, 7)
    const chartWindow = singleMonth ? monthWindow(window.start) : window

    /*
     * A calendar month compares against the calendar month before it — that is the question being
     * asked, and it is what makes "over last month" in the header mean anything. Equal-length spans
     * are right for everything else, where there are no month boundaries to respect.
     */
    const comparisonWindow = singleMonth
      ? previousMonthWindow(window.start)
      : precedingWindow(window.start, window.end)

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
      singleMonth,
      daily: cumulativeDailyFlow(
        allRows,
        chartWindow.start,
        chartWindow.end,
        direction,
        workingSet.confirmedTransferIds,
      ),
      dailyBefore: cumulativeDailyFlow(
        allRows,
        comparisonWindow.start,
        comparisonWindow.end,
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

  /*
   * The month under the pointer, clamped. A sync landing mid-read can shorten the list, and an
   * index past the end would read as zero — a month the household never had.
   */
  /**
   * What a selection narrows the figures below to.
   *
   * A pinned month is that month. A pinned day is **everything up to and including it**, because
   * that is what the line says at that point — it is a running total, and a breakdown of the single
   * day would disagree with the number the chart is showing above it.
   */
  /**
   * What is being shown: the point under the pointer, or the one held.
   *
   * A drag previews the whole filtered view rather than only the label. Reading a chart and having
   * the numbers under it wait for you to let go makes the drag a guess — you cannot see what you
   * are choosing until after you have chosen it.
   *
   * Built from primitives so its identity is stable across renders; an object rebuilt inline would
   * re-filter every row on every frame regardless of whether anything moved.
   */
  const previewDate = scrubIndex === null ? null : (daily[scrubIndex]?.date ?? null)
  const previewMonth =
    monthIndex === null ? null : (summary.periods[monthIndex]?.month ?? null)

  const active = useMemo<ChartSelection | null>(() => {
    if (previewDate !== null) return { kind: 'day', date: previewDate }
    if (previewMonth !== null) return { kind: 'month', month: previewMonth }
    return pinned
  }, [previewDate, previewMonth, pinned])

  const selection = useMemo(() => {
    if (active === null) return null

    const rows =
      active.kind === 'month'
        ? entries.filter((entry) => entry.postedDate.slice(0, 7) === active.month)
        : entries.filter((entry) => entry.postedDate <= active.date)

    const cashFlow = rows.map((entry) => ({
      id: entry.id,
      postedDate: entry.postedDate,
      amountCents: entry.amountCents,
      status: entry.status,
      categoryId: entry.categoryId,
      categoryKind:
        entry.categoryId === null
          ? undefined
          : workingSet.categories.get(entry.categoryId)?.kind,
    }))

    const spending = spendingByCategory(cashFlow, workingSet.confirmedTransferIds)
    const income = incomeByCategory(cashFlow, workingSet.confirmedTransferIds)

    return {
      label:
        active.kind === 'month'
          ? formatMonth(active.month)
          : CASH_FLOW_COPY.throughDay(formatShortDate(active.date)),
      summary: summarizeCashFlow(cashFlow, workingSet.confirmedTransferIds),
      byCategory: spending,
      byIncomeCategory: income,
      uncategorizedSpending: uncategorizedTotal(spending),
      uncategorizedIncome: uncategorizedTotal(income),
    }
  }, [active, entries, workingSet.categories, workingSet.confirmedTransferIds])

  /** The index of the pinned point in the current series, for the chart to hold. */
  const pinnedDayIndex =
    pinned?.kind === 'day' ? daily.findIndex((point) => point.date === pinned.date) : -1
  const pinnedMonthIndex =
    pinned?.kind === 'month'
      ? summary.periods.findIndex((period) => period.month === pinned.month)
      : -1

  const dailyReading =
    scrubIndex === null ? null : (daily[Math.min(scrubIndex, daily.length - 1)] ?? null)

  const monthReading =
    monthIndex === null
      ? null
      : (summary.periods[Math.min(monthIndex, summary.periods.length - 1)] ?? null)

  /**
   * A committed reading.
   *
   * Only a tap toggles. A drag ends on the index it was already reading, so treating release as a
   * toggle would clear the selection the instant a finger lifted — which is the whole interaction
   * on a phone.
   */
  const selectDay = useCallback(
    (index: number, viaTap: boolean): void => {
      const date = daily[index]?.date
      if (date === undefined) return

      setPinned((current) => nextSelection(current, { kind: 'day', date }, viaTap))
    },
    [daily],
  )

  const selectMonth = useCallback(
    (index: number, viaTap: boolean): void => {
      const month = summary.periods[index]?.month
      if (month === undefined) return

      setPinned((current) => nextSelection(current, { kind: 'month', month }, viaTap))
    },
    [summary.periods],
  )

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
      const list = listRef.current
      const target = list?.querySelector<HTMLElement>(`[data-on-or-before="${date}"]`)
      if (list === null || target == null) return

      /*
       * The list's own scrollTop, never `scrollIntoView`.
       *
       * `scrollIntoView` walks every scrollable ancestor, so bringing a row into view inside the
       * list also scrolled the *page* — reading the chart dragged the chart out from under the
       * finger reading it. Setting scrollTop moves the list and nothing else.
       *
       * Landed *past* the group's top by the header's sticky offset, not on it. Exactly on it, the
       * header sits at its natural place in the flow rather than its pinned one, so it covers
       * nothing above itself and the divider under the previous group's last row shows as a
       * hairline above the date. Overshooting puts the header in the pinned state it holds at every
       * other scroll position.
       */
      const offset = target.getBoundingClientRect().top - list.getBoundingClientRect().top
      list.scrollTop += offset + STICKY_DATE_OFFSET_PX
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
   * The chip states what is *held*, never what is being previewed — a label that appeared under a
   * passing finger and offered to clear something would be offering to clear the wrong thing.
   */
  const heldLabel = pinned?.kind === 'month' ? formatMonth(pinned.month) : null

  /*
   * A held day reads as plain text, not a chip.
   *
   * On a single month the date is showing anyway — it persists after the drag — so a chip would be
   * a second copy of it wearing a border. The chip earns its place on the monthly bars, where
   * nothing else says which month the figures describe.
   */
  const heldDay =
    pinned?.kind === 'day'
      ? (daily.find((point) => point.date === pinned.date) ?? null)
      : null

  /* Everything below the chart reads from the selection when there is one. */
  const shownSummary = selection?.summary ?? summary
  const shownSpending = selection?.byCategory ?? byCategory
  const shownIncome = selection?.byIncomeCategory ?? byIncomeCategory

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
        <RangeControl
          value={range}
          onChange={(next) => {
            setScrubIndex(null)
            setMonthIndex(null)
            // A new range rewrites which months and days exist, so a held one may no longer be in it.
            setPinned(null)
            setRange(next)
          }}
        />
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
            onClick={() => {
              /*
               * Transient readings are indexes and would point somewhere else under the next tab's
               * series. The pin is a date, so it survives — the three tabs are three views of the
               * same selected month, and losing it on every switch would make comparing them a
               * chore.
               */
              setScrubIndex(null)
              setMonthIndex(null)
              setTab(value)
            }}
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
        uncategorizedCents={
          tab === 'income'
            ? (selection?.uncategorizedIncome ?? uncategorizedIncome)
            : (selection?.uncategorizedSpending ?? uncategorizedSpending)
        }
        direction={tab === 'income' ? 'income' : 'spending'}
        onReview={() => setShowProposals(true)}
        open={caveatsOpen}
        onToggle={setCaveatsOpen}
      />

      {summary.periods.length === 0 ? (
        <Message title={CASH_FLOW_COPY.empty} detail={CASH_FLOW_COPY.emptyDetail} />
      ) : tab === 'cash-flow' ? (
        <>
          {/*
            The totals follow the reading. Pointing at a month while the figures above it describe
            the whole range would put two answers on screen to one question.
          */}
          {/*
            The totals and the chart pin together, not the chart alone.
            
            Pinning only the chart looked like doing nothing: roughly three hundred pixels of
            header — tabs, caveats, totals, the transfers note — has to scroll away before the chart
            reaches the top, and there is rarely that much page left below it. The chart would come
            to rest at the top exactly as the last row disappeared.
            
            Only when there are months to scroll through. On a single month the list below has its
            own scroll box, so the page barely moves and a pinned block would cost height for
            nothing.
          */}
          <div>
          <div className="mt-4 grid grid-cols-3 gap-3">
            <Total
              label={CASH_FLOW_COPY.income}
              cents={shownSummary.incomeCents}
              tone="income"
            />
            {/* Negated for display only. It stays negative everywhere else so it adds directly. */}
            <Total
              label={CASH_FLOW_COPY.spending}
              cents={-shownSummary.spendingCents}
            />
            <Total
              label={CASH_FLOW_COPY.net}
              cents={shownSummary.netCents}
              tone="net"
            />
          </div>

          {/*
            The reading gets a reserved line, always present and usually empty.

            It first *replaced* the transfers note, which moved the chart down the moment a pointer
            touched it — and a chart that shifts under the cursor is one you cannot point at twice.
            Swapping would not have fixed it either: the note wraps to two lines on a phone and the
            reading never does, so the block would still change height.
          */}

          {/* Said out loud: a total that quietly ignored transactions would be unaccountable. */}
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {CASH_FLOW_COPY.transfersExcluded(summary.excludedCount)}
          </p>

          {/*
            One month gets the running total; more than one gets bars.

            Not a preference. A cumulative line across a year would be dominated by the trend and
            say nothing about any month in it, and a bar per day for thirty days is unreadable. The
            question changes with the span, so the chart does.
          */}
          {singleMonth && daily.length > 1 && (
            <section className="mt-6">
              <CumulativeFlow
                series={daily}
                comparison={dailyBefore}
                color={SECTION_COLORS.household}
                formatValue={(cents, digits) => formatAxisValue(cents, 'household', digits)}
                scrubIndex={scrubIndex}
                onScrub={onScrub}
                onSelect={selectDay}
                selectedIndex={pinnedDayIndex === -1 ? null : pinnedDayIndex}
                describePoint={(index) => {
                  const point = daily[Math.min(Math.max(index, 0), daily.length - 1)]
                  return point === undefined
                    ? ''
                    : `${formatShortDate(point.date)}: ${formatCents(point.cumulativeCents)}`
                }}
                scrubLabel={CASH_FLOW_COPY.runningTotal}
                elapsedCount={elapsedDays}
                tableLabel={CASH_FLOW_COPY.runningTotal}
                comparisonLabel={CASH_FLOW_COPY.monthBeforeColumn}
              />
            </section>
          )}

          {summary.periods.length > 1 && (
            <div className="mt-4">
            <MonthlyBars
              periods={summary.periods}
              mode="net"
              formatValue={formatCents}
              averageLabel={CASH_FLOW_COPY.average}
              scrubIndex={monthIndex}
              onScrub={setMonthIndex}
              onSelect={selectMonth}
              selectedIndex={pinnedMonthIndex === -1 ? null : pinnedMonthIndex}
              tableLabel={CASH_FLOW_COPY.net}
              describePoint={(index) => describeMonth(summary.periods, index, 'net')}
              scrubLabel={CASH_FLOW_COPY.byMonthReading}
            />

            {/* The label belongs to the chart, not to what scrolls past beneath it. */}
            <ReadingSlot
              reading={monthReading === null ? null : formatMonth(monthReading.month)}
              held={heldLabel}
            />
            </div>
          )}
          </div>

          {/* Kept below the chart: this is its table fallback as much as it is detail. */}
          {!singleMonth && (
            <>
              <h2 className="mt-6 text-sm font-semibold">{CASH_FLOW_COPY.byMonth}</h2>
              <ul className="mt-2 space-y-3">
                {[...(selection === null ? summary.periods : shownSummary.periods)]
                  .reverse()
                  .map((period) => (
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
          {singleMonth && (
            <section className="mt-6">
              {entries.length === 0 ? (
                <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                  {CASH_FLOW_COPY.activityEmpty}
                </p>
              ) : (
                <ul
                  ref={listRef}
                  onScroll={onListScroll}
                  /* No padding: a pinned header sits at the padding edge, and any would show through. */
                  className="max-h-96 overflow-y-auto p-0"
                  /*
                   * `-webkit-overflow-scrolling` here, on this container only.
                   *
                   * It used to be set on `html`, and taking it off fixed pinned elements drifting
                   * across the whole app — but it also changed how iOS composites *this* box, and
                   * the sticky date started letting a strip of the row behind it show again. The
                   * property governs scroll containers, so it belongs on the one that scrolls
                   * rather than on the document, which does not need it: iOS has done momentum by
                   * default since 13, and the page-wide cost was every pinned element rendering a
                   * frame late.
                   */
                  style={{ WebkitOverflowScrolling: 'touch' }}
                >
                  {/*
                    Grouped under a date, with the category on the row.
                    
                    The date was repeated on every row and the category was nowhere, which is the
                    wrong way round: consecutive rows usually share a date and never share a
                    category. A heading says it once for the group, and the row spends its second
                    line on the thing that actually differs.
                  */}
                  {/*
                    Never filtered by the selection.
                    
                    The aggregates above narrow to what is selected; this is the record they are
                    drawn from, and the reading indexes into it rather than cutting it down. Filtering
                    it would also break the other direction — scrolling it moves the point on the
                    chart, and a list that shortened as the point moved would be chasing itself.
                  */}
                  {groupByDate(entries).map(([date, rows]) => (
                    <li key={date} data-on-or-before={date}>
                      <h3
                        className={cn(
                          /*
                           * Pinned a few pixels above the scroll box's edge, not flush with it.
                           *
                           * Flush, a strip of the row crossing the top stayed visible above the
                           * date. `-top-2` pins the header eight pixels higher so those eight
                           * pixels are clipped away, and `pt-4` puts them back as padding — the
                           * date sits exactly where it did, and the header's background covers the
                           * strip that was showing above it.
                           */
                          'sticky -top-2 z-20 border-b pb-2 pt-4 text-xs font-semibold tabular-nums',
                          'border-slate-200 bg-slate-50 text-slate-700',
                          'dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300',
                        )}
                      >
                        {formatShortDate(date)}
                      </h3>

                      <ul className="divide-y divide-slate-200 dark:divide-slate-800">
                        {rows.map((entry) => (
                          <li key={entry.id}>
                            {/* The same page every other transaction list opens. */}
                            <Link
                              href={withReturn(`/transactions/${entry.id}`, here)}
                              className="flex items-baseline justify-between gap-3 py-2.5 focus-visible:outline-2 focus-visible:outline-sky-500"
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
                            </Link>
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
          singleMonth={singleMonth}
          daily={daily}
          dailyBefore={dailyBefore}
          elapsedCount={elapsedDays}
          mode={tab === 'income' ? 'income' : 'spending'}
          scrubIndex={scrubIndex}
          onScrub={onScrub}
          monthIndex={monthIndex}
          onMonthScrub={setMonthIndex}
          onSelectDay={selectDay}
          onSelectMonth={selectMonth}
          selectedDayIndex={pinnedDayIndex === -1 ? null : pinnedDayIndex}
          selectedMonthIndex={pinnedMonthIndex === -1 ? null : pinnedMonthIndex}
          heldLabel={heldLabel}
          reading={
            monthReading !== null
              ? formatMonth(monthReading.month)
              : dailyReading !== null
                ? formatShortDate(dailyReading.date)
                : heldDay !== null
                  ? formatShortDate(heldDay.date)
                  : null
          }
          totals={tab === 'income' ? shownIncome : shownSpending}
          totalCents={
            tab === 'income' ? shownSummary.incomeCents : -shownSummary.spendingCents
          }
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
  open,
  onToggle,
}: {
  pendingCount: number
  pendingCents: bigint
  uncategorizedCents: bigint
  direction: 'income' | 'spending'
  onReview: () => void
  open: boolean
  onToggle: (next: boolean) => void
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
        'mt-3 rounded-xl border px-3 py-2',
        'border-amber-200 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/30',
      )}
    >
      {/*
        Collapsible, because on a phone three lines of caveat above the chart is most of the screen
        — and a warning that costs you the thing you came to look at gets dismissed rather than read.

        The count stays visible while collapsed. Folding it away is meant to reclaim space, not to
        hide that anything is wrong.
      */}
      <button
        type="button"
        onClick={() => onToggle(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-xs font-semibold text-amber-900 focus-visible:outline-2 focus-visible:outline-amber-600 dark:text-amber-200"
      >
        <ChevronRight
          className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')}
          aria-hidden
        />
        {CASH_FLOW_COPY.caveatsHeading}
        <span className="rounded-full bg-amber-200 px-1.5 text-[11px] font-medium text-amber-900 dark:bg-amber-900 dark:text-amber-100">
          {entries.length}
        </span>
      </button>

      <ul className={cn('mt-1.5 space-y-1.5', !open && 'hidden')}>
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
  singleMonth,
  daily,
  dailyBefore,
  elapsedCount,
  mode,
  scrubIndex,
  onScrub,
  monthIndex,
  onMonthScrub,
  onSelectDay,
  onSelectMonth,
  selectedDayIndex,
  selectedMonthIndex,
  reading,
  heldLabel,
  totals,
  totalCents,
  label,
  heading,
  categories,
}: {
  periods: readonly CashFlowPeriod[]
  singleMonth: boolean
  daily: readonly { date: string; cumulativeCents: bigint }[]
  dailyBefore: readonly { date: string; cumulativeCents: bigint }[]
  elapsedCount: number
  mode: 'income' | 'spending'
  scrubIndex: number | null
  onScrub: (index: number | null) => void
  monthIndex: number | null
  onMonthScrub: (index: number | null) => void
  onSelectDay: (index: number, viaTap: boolean) => void
  onSelectMonth: (index: number, viaTap: boolean) => void
  selectedDayIndex: number | null
  selectedMonthIndex: number | null
  /** The label for what is being pointed at. The totals already follow it through `totalCents`. */
  reading: string | null
  /** What is held, if anything. Rendered as the chip once the pointer lets go. */
  heldLabel: string | null
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
      <div>
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
      {singleMonth && daily.length > 1 && (
        <section className="mt-4">
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
            scrubIndex={scrubIndex}
            onScrub={onScrub}
            onSelect={onSelectDay}
            selectedIndex={selectedDayIndex}
            describePoint={(index) => {
              const point = daily[Math.min(Math.max(index, 0), daily.length - 1)]
              return point === undefined
                ? ''
                : `${formatShortDate(point.date)}: ${formatCents(
                    mode === 'spending' ? -point.cumulativeCents : point.cumulativeCents,
                  )}`
            }}
            scrubLabel={CASH_FLOW_COPY.runningTotal}
          />
          <ReadingSlot reading={reading} held={heldLabel} />
        </section>
      )}

      {!singleMonth && (
        <div className="mt-4">
        <MonthlyBars
          periods={periods}
          mode={mode}
          scrubIndex={monthIndex}
          onScrub={onMonthScrub}
          onSelect={onSelectMonth}
          selectedIndex={selectedMonthIndex}
          describePoint={(index) => describeMonth(periods, index, mode)}
          scrubLabel={CASH_FLOW_COPY.byMonthReading}
          /* Follows `mode`, because the table stands in for whichever chart is showing. */
          tableLabel={MODE_TABLE_LABEL[mode]}
          /*
           * Negated for the label only, and only here. Spending stays negative in the data and is
           * drawn below the zero line as such; "Avg $-15,942" under a heading that already says
           * Expenses is the minus sign being reported twice.
           */
          formatValue={(cents) => formatCents(mode === 'spending' ? -cents : cents)}
          averageLabel={CASH_FLOW_COPY.average}
        />

        {/* The label belongs to the chart, not to what scrolls past beneath it. */}
        <ReadingSlot reading={reading} held={heldLabel} />
        </div>
      )}
      </div>

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

/** Read out as the month slider moves, so the figure is heard rather than only seen. */
function describeMonth(
  periods: readonly CashFlowPeriod[],
  index: number,
  mode: 'net' | 'income' | 'spending',
): string {
  const period = periods[Math.min(Math.max(index, 0), periods.length - 1)]
  if (period === undefined) return ''

  const cents =
    mode === 'income'
      ? period.incomeCents
      : mode === 'spending'
        ? -period.spendingCents
        : period.netCents

  return `${formatMonth(period.month)}: ${formatCents(cents)}`
}

/**
 * One slot under the chart for what is being read.
 *
 * The date and the chip are the same thing at two moments: while a finger is down it is a live
 * reading, and when it lets go on a point that reading becomes what is held. Two separate places
 * would mean the label jumping across the screen at the end of every drag.
 *
 * Always rendered, at a fixed height. It sat above the chart before, where appearing and
 * disappearing pushed the chart up and down — and a chart that moves as you point at it is one you
 * cannot point at twice.
 */
function ReadingSlot({
  reading,
  held,
}: {
  reading: string | null
  held: string | null
}): ReactNode {
  return (
    <div className="mt-2 flex min-h-7 items-center">
      {reading !== null ? (
        <p role="status" className="truncate text-xs font-medium tabular-nums">
          {reading}
        </p>
      ) : held !== null ? (
        /*
         * A sentence, not a chip.
         *
         * Tapping the bar again clears it, so a button to do the same thing was a second control
         * for one action — and a bordered pill reads as something you must dismiss rather than
         * something you did. What is worth keeping is the statement: without it the totals below
         * describe a month while nothing on screen says which.
         */
        <p role="status" className="truncate text-xs font-medium tabular-nums">
          {held}
        </p>
      ) : null}
    </div>
  )
}
