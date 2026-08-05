import {
  ACCOUNT_COPY,
  HOLDINGS_COPY,
  NET_WORTH_SCRUB_COPY,
  NET_WORTH_STATE_COPY,
  PORTFOLIO_COPY,
  carriedNotice,
  compareDates,
  dayChange,
  formatCents,
  isLiabilitySection,
  latestMove,
  TAX_TREATMENT_LABELS,
  type NetWorthSection,
  type TaxTreatment,
} from '@beans/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ChevronLeft, Info, Pencil, Plus } from 'lucide-react'
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'wouter'
import { AccountEditor, ManualBalanceForm } from '../accounts/AccountForms.js'
import { listManagedAccounts, type ManagedAccount } from '../accounts/api.js'
import { accountHealth, formatLastUpdated } from '../accounts/display.js'
import { Holdings } from '../accounts/Holdings.js'
import { useBackTarget } from '../lib/back.js'
import { CategoryChart } from '../charts/CategoryChart.js'
import { cn } from '../lib/cn.js'
import { SECTION_COLORS, SECTION_LABELS } from '../net-worth/colors.js'
import {
  describeChange,
  formatAxisValue,
  formatShortDate,
  toChartSeries,
} from '../net-worth/display.js'
import type { DerivedAccount } from '../working-set/derive.js'
import { WORKING_SET_KEY, useWorkingSet } from '../working-set/use-working-set.js'
import type { StoredTransaction } from '../working-set/db.js'
import { RangeControl } from '../net-worth/RangeControl.js'
import { DEFAULT_RANGE, resolveWindow, sliceToWindow, todayIso, type RangeSelection } from '../net-worth/range.js'

/**
 * One account, in detail.
 *
 * Reached by tapping a row on net worth. Deliberately the *same* chart, range control and sign
 * conventions as the section above it — an account is a smaller slice of the same thing, not a
 * different kind of screen, and inventing a second visual language for it would make the
 * relationship between the two harder to see rather than easier.
 */

const CHART_HEIGHT = 190

/** Below this the flat stretch is a few pixels wide and captioning it says more than it explains. */
const MIN_CARRIED_DAYS_TO_MENTION = 3

/** Enough to recognize the account's rhythm without becoming the Activity screen. */
const RECENT_TRANSACTION_COUNT = 8

export function AccountDetail({ params }: { params: { id: string } }): ReactNode {
  const [range, setRange] = useState<RangeSelection>(DEFAULT_RANGE)
  const workingSet = useWorkingSet()

  /*
   * Newest first, and computed before the early returns so the hook order does not change between
   * a loading account and a loaded one.
   */
  const recent = useMemo(
    () =>
      workingSet.transactions
        .filter((transaction) => transaction.accountId === params.id)
        .sort(
          (left, right) =>
            compareDates(right.postedDate, left.postedDate) || left.id.localeCompare(right.id),
        )
        .slice(0, RECENT_TRANSACTION_COUNT),
    [workingSet.transactions, params.id],
  )

  /*
   * What this account did in its last move, market only — the portfolio screen's figure, computed
   * the same way so the two screens can never disagree about one account's day.
   *
   * `latestMove` rather than the last two days: an investment series holds each reading flat until
   * the next, so yesterday-to-today is routinely zero. Contributions over the same span come out,
   * because money paid in is not performance.
   *
   * Computed here rather than alongside the display, because the flow has to be netted against
   * *every* transaction in the span. The list below is capped at a handful for display, and a
   * contribution that fell outside that cap would silently be counted as market movement.
   */
  const accountMove = useMemo(() => {
    const account = workingSet.data?.byId.get(params.id)
    if (account === undefined || account.type !== 'investment') return null

    const move = latestMove(account.series)
    if (move === null) return null

    const flow = workingSet.transactions
      .filter(
        (transaction) =>
          transaction.accountId === params.id &&
          transaction.postedDate > move.fromDate &&
          transaction.postedDate <= move.toDate &&
          transaction.status !== 'void',
      )
      .reduce((sum, transaction) => sum + transaction.amountCents, 0n)

    return { change: dayChange(move.openingCents, move.closingCents, flow), asOf: move.toDate }
  }, [workingSet.data, workingSet.transactions, params.id])

  if (workingSet.isLoading) {
    return <div className="p-6 text-sm text-slate-500">{NET_WORTH_STATE_COPY.loading}</div>
  }

  const account = workingSet.data?.byId.get(params.id)
  if (account === undefined) {
    return <NotFound />
  }

  return (
    <AccountView
      account={account}
      section={account.section}
      range={range}
      onRange={setRange}
      recent={recent}
      accountMove={accountMove}
    />
  )
}

function AccountView({
  account,
  section,
  range,
  onRange,
  recent,
  accountMove,
}: {
  account: DerivedAccount
  section: NetWorthSection
  range: RangeSelection
  onRange: (value: RangeSelection) => void
  recent: readonly StoredTransaction[]
  /** Null for anything that is not an investment, or that has never moved. */
  accountMove: { change: ReturnType<typeof dayChange>; asOf: string } | null
}): ReactNode {
  const back = useBackTarget({ href: '/', label: ACCOUNT_COPY.backToNetWorth })
  const [sheet, setSheet] = useState<'none' | 'edit' | 'value'>('none')
  const [scrubIndex, setScrubIndex] = useState<number | null>(null)
  const queryClient = useQueryClient()

  /*
   * The editors take the managed shape, which carries fields the working set does not — the sign
   * convention flag, the tax treatment, whether the type was user-set.
   */
  const managed = useQuery({ queryKey: ['accounts'], queryFn: listManagedAccounts })

  const managedAccount: ManagedAccount | undefined = managed.data?.find(
    (candidate) => candidate.id === account.id,
  )

  const afterSave = async (): Promise<void> => {
    setSheet('none')
    await queryClient.invalidateQueries({ queryKey: ['accounts'] })
    // Editing changes balances and history, both of which this screen is drawing.
    await queryClient.invalidateQueries({ queryKey: ['working-set', 'sync'] })
    await queryClient.invalidateQueries({ queryKey: WORKING_SET_KEY })
  }
  const today = todayIso()
  const { assessment, banner } = accountHealth(account, today)

  const series = useMemo(
    () => sliceToWindow(account.series, resolveWindow(range, today)),
    [account.series, range, today],
  )

  /*
   * Only worth saying when the carried stretch is actually on screen *and* long enough to look
   * flat. A window ending before the break has no flat tail at all, and a tail of a day or two is a
   * couple of pixels — captioning that is noise, and noise is what makes the caption ignorable in
   * the cases that matter.
   */
  const lastReal = account.observedThrough
  const carriedDays =
    lastReal === null
      ? 0
      : series.filter((point) => compareDates(point.date, lastReal) > 0).length

  const carriedFrom = carriedDays >= MIN_CARRIED_DAYS_TO_MENTION ? formatLastUpdated(account) : null

  const formatValue = useCallback(
    (cents: bigint, digits: number) => formatAxisValue(cents, section, digits),
    [section],
  )

  /*
   * The day being read off the chart, as an index into the sliced series.
   *
   * Same interaction as net worth, one account at a time. Changing the range drops it: the window
   * is rewritten underneath, so an index held across it would come to mean a different date.
   *
   * Clamped rather than trusted — a sync landing mid-read can shorten the series, and an index past
   * the end would read as zero, which is a balance this account never had.
   */
  /*
   * Clamped rather than trusted, and cleared on release.
   *
   * Nothing is filtered by a reading here — the chart is the whole screen — so a date left behind
   * after the finger lifts is a number frozen at a moment nobody asked to keep. Letting go returns
   * to the latest, which is what the screen is for.
   */
  const reading =
    scrubIndex === null ? null : (series[Math.min(scrubIndex, series.length - 1)] ?? null)

  const latest = series.at(-1)?.value ?? account.currentBalanceCents ?? 0n
  const total = reading?.value ?? latest
  const change = latest - (series[0]?.value ?? latest)
  const described = describeChange(change, section)

  const describePoint = useCallback(
    (index: number): string => {
      const point = series[Math.min(Math.max(index, 0), series.length - 1)]
      return point === undefined
        ? ''
        : NET_WORTH_SCRUB_COPY.describe(formatShortDate(point.date), formatCents(point.value))
    },
    [series],
  )

  return (
    <div className="mx-auto max-w-2xl pb-10">
      <div className="flex items-center gap-1 px-3 pt-3">
        <Link
          href={back.href}
          className={cn(
            'inline-flex items-center gap-1 rounded-lg py-1.5 pl-1 pr-2.5 text-sm font-medium',
            'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-900',
            'focus-visible:outline-2 focus-visible:outline-sky-500',
          )}
        >
          <ChevronLeft className="size-5" aria-hidden />
          {back.label}
        </Link>
      </div>

      <div className="px-5 pt-2">
        <h1 className="text-xl font-semibold">{account.institutionName ?? account.name}</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {account.name}
          {account.mask !== null && ` - Ending in ${account.mask}`}
        </p>
      </div>

      {/*
        Above the balance, not below it. The banner exists to say the number underneath may be
        wrong, and a caveat placed after the thing it qualifies has already been missed.
      */}
      {banner !== null && (
        <ConnectionBanner
          copy={banner}
          severity={assessment.severity === 'attention' ? 'attention' : 'caution'}
          /*
           * Every action on this banner goes to the accounts screen. Reconnecting needs a fresh
           * setup token, and syncing acts on the connection rather than the account — this screen
           * has an account id and no way to turn one into the other, because the working set carries
           * connection *health* per account but not the connection's identity.
           */
          href="/accounts"
        />
      )}

      {account.isManual && (
        <>
          <Note>
            <span className="font-medium">{ACCOUNT_COPY.manualAccount}.</span>{' '}
            {ACCOUNT_COPY.manualAccountDetail}
          </Note>

        </>
      )}

      {/*
        Renaming belongs here, not only on the accounts list.
        
        Provider names are frequently unusable — Wealthfront publishes investment accounts through
        SimpleFIN as "Joint (7E56)", where the parenthetical is a fragment of their internal id and
        matches nothing the account holder has ever seen. Sync never overwrites `display_name`, so a
        rename is permanent, and this is the screen somebody is on when they notice.

        Recording a value is manual-only: a synced account gets its balance from the provider, and
        typing one over the top would be overwritten by the next sync.
      */}
      <div className="flex gap-2 px-5 pt-3">
        <ActionButton
          icon={<Pencil className="size-4" aria-hidden />}
          label={ACCOUNT_COPY.manualEdit}
          disabled={managedAccount === undefined}
          onClick={() => setSheet('edit')}
        />
        {account.isManual && (
          <ActionButton
            icon={<Plus className="size-4" aria-hidden />}
            label={ACCOUNT_COPY.manualRecord}
            disabled={managedAccount === undefined}
            onClick={() => setSheet('value')}
          />
        )}
      </div>

      <div className="flex items-baseline justify-between gap-3 px-5 pt-4">
        <div>
          <div className="text-3xl font-semibold tabular-nums">{formatCents(total)}</div>
          {/* Matching net worth: the date replaces the change while a day is being read. */}
          {reading === null ? (
            <div
              className={cn(
                'mt-0.5 h-5 truncate text-sm font-medium tabular-nums',
                described.favourable
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-rose-600 dark:text-rose-400',
              )}
            >
              {described.text}
            </div>
          ) : (
            <div
              className="mt-0.5 h-5 truncate text-sm font-medium tabular-nums text-slate-500 dark:text-slate-400"
              role="status"
            >
              {formatShortDate(reading.date)}
            </div>
          )}
        </div>
        <RangeControl
          value={range}
          onChange={(next) => {
            setScrubIndex(null)
            onRange(next)
          }}
        />
      </div>

      {/*
        Padding goes on a wrapper, never on CategoryChart itself: its layers are `absolute inset-0`,
        which resolves against the padding box and so ignores the padding entirely.
      */}
      <div className="mt-3 px-5">
        <CategoryChart
          categoryKey={account.id}
          series={toChartSeries(series, section)}
          color={SECTION_COLORS[section]}
          formatValue={formatValue}
          height={CHART_HEIGHT}
          scrubIndex={scrubIndex}
          onScrub={setScrubIndex}
          describePoint={describePoint}
          scrubLabel={NET_WORTH_SCRUB_COPY.label}
        />
      </div>

      {carriedFrom !== null && (
        <p className="px-5 pt-1 text-xs text-slate-500 dark:text-slate-400">
          {carriedNotice(carriedFrom)}
        </p>
      )}

      <h2 className="px-5 pb-1 pt-6 text-sm font-semibold">{ACCOUNT_COPY.detailsHeading}</h2>
      <dl className="px-5">
        <Field
          label={ACCOUNT_COPY.institution}
          value={account.institutionName ?? ACCOUNT_COPY.manualAccount}
        />
        <Field label={ACCOUNT_COPY.accountType} value={SECTION_LABELS[section]} />
        {/*
          No account number row. Nothing populates `mask` — SimpleFIN v1 has no such field, and
          neither manual creation nor the editor sets one — so it read "Not provided" on every
          account forever, which implies it might one day be provided. Institutions that publish the
          last four put them in the name, where they are already visible.
        */}
        {/*
          The stored treatment, not the type's default. Showing `defaultTaxTreatment(type)` meant an
          account set to Roth still displayed as Taxable here while the portfolio counted it as
          Roth — the screen contradicting the split it feeds.
        */}
        {account.type === 'investment' && (
          <Field
            label={ACCOUNT_COPY.taxTreatment}
            value={TAX_TREATMENT_LABELS[account.taxTreatment as TaxTreatment]}
          />
        )}
        <Field label={ACCOUNT_COPY.lastUpdated} value={formatLastUpdated(account)} />
      </dl>

      {/*
        Positions, for investment accounts only.

        Below the balance chart rather than above it: the chart is what this account is worth, which
        is the question the screen is opened to answer. What is inside it is the follow-up.
      */}
      {account.type === 'investment' && (
        <>
          <div className="flex items-baseline justify-between gap-3 px-5 pb-1 pt-6">
            <h2 className="text-sm font-semibold">{HOLDINGS_COPY.heading}</h2>
            {/*
              The account's own move, the same figure the portfolio list shows for this row.

              Beside the positions rather than beside the balance at the top, because the two
              belong together: the individual changes below should roughly account for this one,
              and putting them apart makes that impossible to check. It is deliberately the same
              computation as the portfolio screen — two places disagreeing about one account's day
              would be worse than not showing it twice.
            */}
            {accountMove !== null && (
              <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
                <span
                  className={cn(
                    'font-medium',
                    accountMove.change.marketCents > 0n
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : accountMove.change.marketCents < 0n
                        ? 'text-rose-600 dark:text-rose-400'
                        : '',
                  )}
                >
                  {accountMove.change.marketCents > 0n ? '+' : ''}
                  {formatCents(accountMove.change.marketCents)}
                  {accountMove.change.fraction === null
                    ? ''
                    : ` (${accountMove.change.marketCents > 0n ? '+' : ''}${(
                        accountMove.change.fraction * 100
                      ).toFixed(2)}%)`}
                </span>{' '}
                {PORTFOLIO_COPY.asOfDay(formatShortDate(accountMove.asOf))}
              </span>
            )}
          </div>
          <Holdings
            accountId={account.id}
            accountName={account.name}
            headingDate={accountMove?.asOf ?? null}
          />
        </>
      )}

      <div className="flex items-baseline justify-between gap-3 px-5 pb-1 pt-6">
        <h2 className="text-sm font-semibold">{ACCOUNT_COPY.activityHeading}</h2>
        {recent.length > 0 && (
          <Link
            href={`/transactions?account=${encodeURIComponent(account.id)}`}
            className="text-xs font-medium text-sky-700 hover:underline dark:text-sky-400"
          >
            {ACCOUNT_COPY.activityAll}
          </Link>
        )}
      </div>

      {recent.length === 0 ? (
        <p className="px-5 text-sm text-slate-500 dark:text-slate-400">
          {ACCOUNT_COPY.activityUnavailable}
        </p>
      ) : (
        <ul className="divide-y divide-slate-200 px-5 dark:divide-slate-800">
          {recent.map((transaction) => (
            <li key={transaction.id} className="flex items-baseline justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm">
                  {transaction.payee ?? transaction.description ?? '—'}
                </p>
                <p className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
                  {transaction.postedDate}
                </p>
              </div>
              {/*
                Money in is called out, money out is not. Every account here is dominated by
                spending, so colouring the outflows would tint the whole list and distinguish
                nothing — and Beans does not decorate a number moving the wrong way.
              */}
              <span
                className={cn(
                  'shrink-0 text-sm tabular-nums',
                  transaction.amountCents > 0n && 'text-emerald-600 dark:text-emerald-400',
                )}
              >
                {formatCents(transaction.amountCents)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* Signs are decided at ingest; this only names the convention so the screen is self-explaining. */}
      {isLiabilitySection(section) && (
        <p className="px-5 pt-6 text-xs text-slate-500 dark:text-slate-400">
          Shown as a negative amount because it is money owed.
        </p>
      )}

      {sheet === 'edit' && managedAccount !== undefined && (
        <AccountEditor
          account={managedAccount}
          onClose={() => setSheet('none')}
          onSaved={afterSave}
        />
      )}
      {sheet === 'value' && managedAccount !== undefined && (
        <ManualBalanceForm
          account={managedAccount}
          onClose={() => setSheet('none')}
          onSaved={afterSave}
        />
      )}
    </div>
  )
}

function ActionButton({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: ReactNode
  label: string
  disabled: boolean
  onClick: () => void
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 text-sm font-medium',
        'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800',
        'focus-visible:outline-2 focus-visible:outline-sky-500 disabled:opacity-50',
      )}
    >
      {icon}
      {label}
    </button>
  )
}

function ConnectionBanner({
  copy,
  severity,
  href,
}: {
  copy: { title: string; detail: string; actionLabel: string | null }
  severity: 'attention' | 'caution'
  href: string
}): ReactNode {
  const attention = severity === 'attention'

  return (
    <div
      /*
       * `alert` only for the red case. A stale balance is worth reading and not worth interrupting
       * a screen reader mid-sentence for; using the assertive role for both would make the one that
       * genuinely needs attention indistinguishable from the one that does not.
       */
      role={attention ? 'alert' : 'status'}
      className={cn(
        'mx-5 mt-4 rounded-xl border p-4',
        attention
          ? 'border-rose-300 bg-rose-50 dark:border-rose-900 dark:bg-rose-950/40'
          : 'border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40',
      )}
    >
      <div className="flex gap-2.5">
        <AlertTriangle
          className={cn(
            'mt-0.5 size-4 shrink-0',
            attention ? 'text-rose-600 dark:text-rose-400' : 'text-amber-600 dark:text-amber-400',
          )}
          aria-hidden
        />
        <div className="min-w-0">
          <p
            className={cn(
              'text-sm font-semibold',
              attention ? 'text-rose-900 dark:text-rose-200' : 'text-amber-900 dark:text-amber-200',
            )}
          >
            {copy.title}
          </p>
          <p
            className={cn(
              'mt-1 text-sm',
              attention ? 'text-rose-800 dark:text-rose-300' : 'text-amber-800 dark:text-amber-300',
            )}
          >
            {copy.detail}
          </p>

          {copy.actionLabel !== null && (
            <Link
              href={href}
              className={cn(
                'mt-3 inline-flex min-h-11 items-center rounded-lg px-4 text-sm font-semibold text-white',
                'focus-visible:outline-2 focus-visible:outline-offset-2',
                attention
                  ? 'bg-rose-600 hover:bg-rose-500 focus-visible:outline-rose-600'
                  : 'bg-amber-600 hover:bg-amber-500 focus-visible:outline-amber-600',
              )}
            >
              {copy.actionLabel}
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}

function Note({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="mx-5 mt-4 flex gap-2.5 rounded-xl bg-slate-100 p-4 text-sm dark:bg-slate-900">
      <Info className="mt-0.5 size-4 shrink-0 text-slate-500" aria-hidden />
      <p className="text-slate-600 dark:text-slate-300">{children}</p>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-slate-200 py-3 text-sm dark:border-slate-800">
      <dt className="text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  )
}

function NotFound(): ReactNode {
  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="text-lg font-semibold">{ACCOUNT_COPY.notFound}</h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        {ACCOUNT_COPY.notFoundDetail}
      </p>
      <Link href="/" className="mt-4 inline-block text-sm font-medium text-sky-600 dark:text-sky-400">
        {ACCOUNT_COPY.backToNetWorth}
      </Link>
    </div>
  )
}
