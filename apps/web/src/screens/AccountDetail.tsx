import {
  ACCOUNT_COPY,
  NET_WORTH_STATE_COPY,
  carriedNotice,
  compareDates,
  defaultTaxTreatment,
  formatCents,
  isLiabilitySection,
  type AccountType,
  type NetWorthSection,
  type TaxTreatment,
} from '@beans/shared'
import { AlertTriangle, ChevronLeft, Info } from 'lucide-react'
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'wouter'
import { accountHealth, formatLastUpdated } from '../accounts/display.js'
import { CategoryChart } from '../charts/CategoryChart.js'
import { cn } from '../lib/cn.js'
import { SECTION_COLORS, SECTION_LABELS } from '../net-worth/colors.js'
import { describeChange, formatAxisValue, toChartSeries } from '../net-worth/display.js'
import type { DerivedAccount } from '../working-set/derive.js'
import { useWorkingSet } from '../working-set/use-working-set.js'
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

export function AccountDetail({ params }: { params: { id: string } }): ReactNode {
  const [range, setRange] = useState<RangeSelection>(DEFAULT_RANGE)
  const workingSet = useWorkingSet()

  if (workingSet.isLoading) {
    return <div className="p-6 text-sm text-slate-500">{NET_WORTH_STATE_COPY.loading}</div>
  }

  const account = workingSet.data?.byId.get(params.id)
  if (account === undefined) {
    return <NotFound />
  }

  return (
    <AccountView account={account} section={account.section} range={range} onRange={setRange} />
  )
}

function AccountView({
  account,
  section,
  range,
  onRange,
}: {
  account: DerivedAccount
  section: NetWorthSection
  range: RangeSelection
  onRange: (value: RangeSelection) => void
}): ReactNode {
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

  const total = series.at(-1)?.value ?? account.currentBalanceCents ?? 0n
  const change = total - (series[0]?.value ?? total)
  const described = describeChange(change, section)

  return (
    <div className="mx-auto max-w-2xl pb-10">
      <div className="flex items-center gap-1 px-3 pt-3">
        <Link
          href="/"
          className={cn(
            'inline-flex items-center gap-1 rounded-lg py-1.5 pl-1 pr-2.5 text-sm font-medium',
            'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-900',
            'focus-visible:outline-2 focus-visible:outline-sky-500',
          )}
        >
          <ChevronLeft className="size-5" aria-hidden />
          {ACCOUNT_COPY.backToNetWorth}
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
        />
      )}

      {account.isManual && (
        <Note>
          <span className="font-medium">{ACCOUNT_COPY.manualAccount}.</span>{' '}
          {ACCOUNT_COPY.manualAccountDetail}
        </Note>
      )}

      <div className="flex items-baseline justify-between gap-3 px-5 pt-4">
        <div>
          <div className="text-3xl font-semibold tabular-nums">{formatCents(total)}</div>
          <div
            className={cn(
              'mt-0.5 text-sm font-medium tabular-nums',
              described.favourable
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-rose-600 dark:text-rose-400',
            )}
          >
            {described.text}
          </div>
        </div>
        <RangeControl value={range} onChange={onRange} />
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
        <Field
          label={ACCOUNT_COPY.accountNumber}
          value={account.mask === null ? ACCOUNT_COPY.noAccountNumber : `Ending in ${account.mask}`}
        />
        <Field
          label={ACCOUNT_COPY.taxTreatment}
          value={TAX_LABELS[defaultTaxTreatment(account.type as AccountType)]}
        />
        <Field label={ACCOUNT_COPY.lastUpdated} value={formatLastUpdated(account)} />
      </dl>

      <h2 className="px-5 pb-1 pt-6 text-sm font-semibold">{ACCOUNT_COPY.activityHeading}</h2>
      <p className="px-5 text-sm text-slate-500 dark:text-slate-400">
        {ACCOUNT_COPY.activityUnavailable}
      </p>

      {/* Signs are decided at ingest; this only names the convention so the screen is self-explaining. */}
      {isLiabilitySection(section) && (
        <p className="px-5 pt-6 text-xs text-slate-500 dark:text-slate-400">
          Shown as a negative amount because it is money owed.
        </p>
      )}
    </div>
  )
}

const TAX_LABELS: Record<TaxTreatment, string> = {
  taxable: 'Taxable',
  traditional: 'Traditional',
  roth: 'Roth',
  hsa: 'HSA',
  education: 'Education',
  none: 'Not applicable',
}

function ConnectionBanner({
  copy,
  severity,
}: {
  copy: { title: string; detail: string; actionLabel: string | null }
  severity: 'attention' | 'caution'
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
            <button
              type="button"
              className={cn(
                'mt-3 min-h-11 rounded-lg px-4 text-sm font-semibold text-white',
                'focus-visible:outline-2 focus-visible:outline-offset-2',
                attention
                  ? 'bg-rose-600 hover:bg-rose-500 focus-visible:outline-rose-600'
                  : 'bg-amber-600 hover:bg-amber-500 focus-visible:outline-amber-600',
              )}
            >
              {copy.actionLabel}
            </button>
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
