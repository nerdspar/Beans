import {
  RETIREMENT_COPY,
  TAX_TREATMENTS,
  TAX_TREATMENT_LABELS,
  TRANSACTIONS_COPY,
  formatCents,
  parseDecimalToCents,
  type TaxTreatment,
} from '@beans/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'wouter'
import { localToday } from '../lib/today.js'
import {
  getRetirementPlan,
  makeScenarioDefault,
  patchProfile,
  patchScenario,
  setBuckets,
  setPlanFeatures,
  setRouting,
  setSpendingAnswer,
  type PlanScenario,
  type SpendingAnswer,
  type StoredSpendingAnswer,
} from '../retirement/api.js'
import { ReferenceBanner } from '../retirement/ReferenceBanner.js'
import { planAccounts, spendingReview, type PlanAccountRow } from '../retirement/setup-data.js'
import { useWorkingSet } from '../working-set/use-working-set.js'

/**
 * The rest of the setup: how accounts are taxed, what retirement costs, and the return
 * assumptions (ARCHITECTURE.md §19).
 *
 * Revisitable rather than a one-time flow. The spec calls it a wizard, and the ordering here keeps
 * its intent — accounts, then spending, then scenarios, moving from what Beans already knows to
 * what only the household does — but it is a page you can come back to and change one answer on,
 * because that is what people actually do with a plan.
 *
 * The spending review and the account list are computed from the working set, not fetched. The
 * server cannot group spending by category without decrypting every amount, and it runs the same
 * shared helpers over the same window, so the two cannot disagree.
 */

const PLAN_KEY = ['retirement', 'plan'] as const
const PROJECTION_KEY = ['retirement', 'projection'] as const

export function RetirementSetup(): ReactNode {
  const plan = useQuery({ queryKey: PLAN_KEY, queryFn: getRetirementPlan })

  if (plan.isPending) {
    return (
      <Page>
        <p className="mt-6 text-sm text-slate-500 dark:text-slate-400">
          {RETIREMENT_COPY.loading}
        </p>
      </Page>
    )
  }

  if (plan.isError || plan.data?.started !== true) {
    return (
      <Page>
        <p className="mt-6 text-sm text-slate-600 dark:text-slate-300">
          {RETIREMENT_COPY.empty.body}
        </p>
        <Link
          href="/retirement"
          className="mt-4 inline-block rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium dark:border-slate-700"
        >
          {RETIREMENT_COPY.title}
        </Link>
      </Page>
    )
  }

  return (
    <Page>
      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
        {RETIREMENT_COPY.setup.blurb}
      </p>

      <ReferenceBanner />

      <AccountsStep
        taxBuckets={plan.data.taxBuckets}
        routing={plan.data.routing}
        planFeatures={plan.data.planFeatures}
      />
      <SpendingStep
        loanPayoffYears={plan.data.loanPayoffYears}
        answers={plan.data.spendingAssumptions}
        pre65Healthcare={plan.data.profile.pre65HealthcareAnnual}
      />
      <ScenariosStep scenarios={plan.data.scenarios} />

      <Link
        href="/retirement"
        className="mt-10 inline-block rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white"
      >
        {RETIREMENT_COPY.setup.review.run}
      </Link>
    </Page>
  )
}

function Page({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="mx-auto max-w-2xl px-5 pb-16 pt-6">
      <h1 className="text-2xl font-semibold">{RETIREMENT_COPY.setup.title}</h1>
      {children}
    </div>
  )
}

function Section({
  title,
  blurb,
  children,
}: {
  title: string
  blurb: string
  children: ReactNode
}): ReactNode {
  const headingId = useId()

  return (
    <section aria-labelledby={headingId} className="mt-10">
      <h2 id={headingId} className="font-semibold">
        {title}
      </h2>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{blurb}</p>
      {children}
    </section>
  )
}

/* ------------------------------------------------------------------ accounts */

function AccountsStep({
  taxBuckets,
  routing,
  planFeatures,
}: {
  taxBuckets: Parameters<typeof planAccounts>[0]['taxBuckets']
  routing: Parameters<typeof planAccounts>[0]['routing']
  planFeatures: Parameters<typeof planAccounts>[0]['planFeatures']
}): ReactNode {
  const workingSet = useWorkingSet()

  const rows = useMemo(
    () =>
      planAccounts({
        accounts: workingSet.data?.byId.values() ?? [],
        taxBuckets,
        routing,
        planFeatures,
      }),
    [workingSet.data, taxBuckets, routing, planFeatures],
  )

  return (
    <Section
      title={RETIREMENT_COPY.setup.steps.accounts}
      blurb={RETIREMENT_COPY.setup.accounts.blurb}
    >
      <ul className="mt-4 space-y-3">
        {rows.map((row) => (
          <li
            key={row.id}
            className="rounded-xl border border-slate-200 p-4 dark:border-slate-800"
          >
            <AccountRow row={row} />
          </li>
        ))}
      </ul>
    </Section>
  )
}

function AccountRow({ row }: { row: PlanAccountRow }): ReactNode {
  const [open, setOpen] = useState<'none' | 'split' | 'plan'>('none')

  const latest = row.anchors.at(-1)

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{row.name}</p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            {TAX_TREATMENT_LABELS[row.taxTreatment as TaxTreatment] ?? row.taxTreatment}
            {row.balanceCents !== null && ` · ${formatCents(row.balanceCents)}`}
          </p>
          {latest !== undefined && (
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {latest.buckets
                .map(
                  (bucket) =>
                    `${TAX_TREATMENT_LABELS[bucket.treatment]} ${formatCents(
                      parseDecimalToCents(bucket.balance),
                    )}`,
                )
                .join(' · ')}
              {` (${latest.asOfDate})`}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          {/*
           * The tax treatment itself is edited on the account, not here. Two screens writing one
           * field is how they come to disagree about it.
           */}
          <Link
            href={`/accounts/${row.id}`}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs dark:border-slate-700"
          >
            Edit account
          </Link>
          <button
            type="button"
            onClick={() => setOpen(open === 'split' ? 'none' : 'split')}
            aria-expanded={open === 'split'}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs dark:border-slate-700"
          >
            {RETIREMENT_COPY.setup.accounts.split}
          </button>
          {row.offersPlanQuestions && (
            <button
              type="button"
              onClick={() => setOpen(open === 'plan' ? 'none' : 'plan')}
              aria-expanded={open === 'plan'}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs dark:border-slate-700"
            >
              {RETIREMENT_COPY.setup.accounts.planFeatures}
            </button>
          )}
        </div>
      </div>

      {open === 'split' && <SplitForm row={row} onDone={() => setOpen('none')} />}
      {open === 'plan' && <PlanFeaturesForm row={row} onDone={() => setOpen('none')} />}
    </div>
  )
}

/**
 * A dated breakdown, entered as the provider showed it.
 *
 * The whole anchor is saved at once, because a partial anchor is a wrong anchor: the carry-forward
 * reads proportions across every bucket at a date, so a half-saved breakdown would model a split
 * nobody entered.
 */
function SplitForm({ row, onDone }: { row: PlanAccountRow; onDone: () => void }): ReactNode {
  const queryClient = useQueryClient()
  const dateId = useId()
  const routeId = useId()
  const routeAmountId = useId()

  const latest = row.anchors.at(-1)
  const [asOfDate, setAsOfDate] = useState(latest?.asOfDate ?? localToday())
  const [amounts, setAmounts] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {}
    for (const bucket of latest?.buckets ?? []) seed[bucket.treatment] = bucket.balance
    return seed
  })

  const existingRoute = row.routing[0]
  const [routeTreatment, setRouteTreatment] = useState<TaxTreatment>(
    existingRoute?.treatment ?? 'roth',
  )
  const [routeAmount, setRouteAmount] = useState(existingRoute?.annualAmount ?? '')

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: PLAN_KEY })
    await queryClient.invalidateQueries({ queryKey: PROJECTION_KEY })
  }

  const save = useMutation({
    mutationFn: async () => {
      const buckets = Object.entries(amounts)
        .filter(([, value]) => value.trim() !== '')
        .map(([treatment, balance]) => ({ treatment: treatment as TaxTreatment, balance: balance.trim() }))

      await setBuckets(row.id, asOfDate, buckets)

      if (routeAmount.trim() !== '') {
        await setRouting(row.id, { treatment: routeTreatment, annualAmount: routeAmount.trim() })
      }
    },
    onSuccess: async () => {
      onDone()
      await refresh()
    },
  })

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate()
      }}
      className="mt-4 space-y-3 border-t border-slate-200 pt-4 text-sm dark:border-slate-800"
    >
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {RETIREMENT_COPY.setup.accounts.splitNote}
      </p>

      <div>
        <label htmlFor={dateId} className="text-slate-500 dark:text-slate-400">
          {RETIREMENT_COPY.setup.accounts.asOf}
        </label>
        <input
          id={dateId}
          type="date"
          value={asOfDate}
          onChange={(event) => setAsOfDate(event.target.value)}
          required
          className={inputClass}
        />
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {RETIREMENT_COPY.setup.accounts.anchorNote}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {/* `none` is not a bucket anybody splits into — it is the absence of a treatment. */}
        {TAX_TREATMENTS.filter((treatment) => treatment !== 'none').map((treatment) => (
          <BucketField
            key={treatment}
            treatment={treatment}
            value={amounts[treatment] ?? ''}
            onChange={(value) => setAmounts((prior) => ({ ...prior, [treatment]: value }))}
          />
        ))}
      </div>

      <fieldset className="space-y-2">
        <legend className="text-slate-500 dark:text-slate-400">
          {RETIREMENT_COPY.setup.accounts.contributions}
        </legend>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {RETIREMENT_COPY.setup.accounts.contributionsNote}
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor={routeId} className="sr-only">
              {RETIREMENT_COPY.setup.accounts.contributions}
            </label>
            <select
              id={routeId}
              value={routeTreatment}
              onChange={(event) => setRouteTreatment(event.target.value as TaxTreatment)}
              className={inputClass}
            >
              {TAX_TREATMENTS.filter((treatment) => treatment !== 'none').map((treatment) => (
                <option key={treatment} value={treatment}>
                  {TAX_TREATMENT_LABELS[treatment]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={routeAmountId} className="sr-only">
              {RETIREMENT_COPY.setup.accounts.contributions}
            </label>
            <input
              id={routeAmountId}
              inputMode="decimal"
              placeholder="0.00"
              value={routeAmount}
              onChange={(event) => setRouteAmount(event.target.value)}
              pattern="-?\d+(\.\d{1,2})?"
              className={inputClass}
            />
          </div>
        </div>
      </fieldset>

      <FormActions pending={save.isPending} onCancel={onDone} />
    </form>
  )
}

function BucketField({
  treatment,
  value,
  onChange,
}: {
  treatment: TaxTreatment
  value: string
  onChange: (value: string) => void
}): ReactNode {
  const id = useId()

  return (
    <div>
      <label htmlFor={id} className="text-xs text-slate-500 dark:text-slate-400">
        {TAX_TREATMENT_LABELS[treatment]}
      </label>
      <input
        id={id}
        inputMode="decimal"
        placeholder="—"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        pattern="-?\d+(\.\d{1,2})?"
        className={inputClass}
      />
    </div>
  )
}

/**
 * What the employer plan allows.
 *
 * Three states per question, and the third is the point: `null` is "not asked", which is different
 * from "no". Defaulting to no would make an unanswered plan look restrictive and silently suppress
 * a rule that might apply to it.
 */
function PlanFeaturesForm({
  row,
  onDone,
}: {
  row: PlanAccountRow
  onDone: () => void
}): ReactNode {
  const queryClient = useQueryClient()
  const matchId = useId()

  const [answers, setAnswers] = useState({
    isEmployerPlan: row.features?.isEmployerPlan ?? null,
    allowsAfterTaxContributions: row.features?.allowsAfterTaxContributions ?? null,
    allowsInPlanRothConversion: row.features?.allowsInPlanRothConversion ?? null,
    allowsInServiceWithdrawal: row.features?.allowsInServiceWithdrawal ?? null,
    acceptsIraRollIns: row.features?.acceptsIraRollIns ?? null,
  })
  const [match, setMatch] = useState(row.features?.employerMatchDescription ?? '')

  const save = useMutation({
    mutationFn: () =>
      setPlanFeatures(row.id, {
        ...answers,
        employerMatchDescription: match.trim() === '' ? null : match.trim(),
      }),
    onSuccess: async () => {
      onDone()
      await queryClient.invalidateQueries({ queryKey: PLAN_KEY })
    },
  })

  const questions: { key: keyof typeof answers; label: string }[] = [
    /*
     * First, because the pro-rata rule is blocked without it and because the other questions only
     * make sense for an employer plan. Beans cannot tell a 401(k) from an IRA on its own — both
     * arrive as an investment account with a traditional treatment.
     */
    { key: 'isEmployerPlan', label: RETIREMENT_COPY.setup.accounts.isEmployerPlan },
    { key: 'allowsAfterTaxContributions', label: RETIREMENT_COPY.setup.accounts.allowsAfterTax },
    { key: 'allowsInPlanRothConversion', label: RETIREMENT_COPY.setup.accounts.allowsInPlanRoth },
    { key: 'allowsInServiceWithdrawal', label: RETIREMENT_COPY.setup.accounts.allowsInService },
    { key: 'acceptsIraRollIns', label: RETIREMENT_COPY.setup.accounts.acceptsRollIns },
  ]

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate()
      }}
      className="mt-4 space-y-4 border-t border-slate-200 pt-4 text-sm dark:border-slate-800"
    >
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {RETIREMENT_COPY.setup.accounts.planFeaturesNote}
      </p>

      {questions.map((question) => (
        <TriState
          key={question.key}
          label={question.label}
          value={answers[question.key]}
          onChange={(value) =>
            setAnswers((prior) => ({ ...prior, [question.key]: value }))
          }
        />
      ))}

      <div>
        <label htmlFor={matchId} className="text-slate-500 dark:text-slate-400">
          {RETIREMENT_COPY.setup.accounts.employerMatch}
        </label>
        <input
          id={matchId}
          value={match}
          onChange={(event) => setMatch(event.target.value)}
          maxLength={500}
          className={inputClass}
        />
      </div>

      <FormActions pending={save.isPending} onCancel={onDone} />
    </form>
  )
}

/** Yes / No / Don't know, as a real radio group so it reads correctly and keyboards correctly. */
function TriState({
  label,
  value,
  onChange,
}: {
  label: string
  value: boolean | null
  onChange: (value: boolean | null) => void
}): ReactNode {
  const name = useId()

  const options: { label: string; option: boolean | null }[] = [
    { label: RETIREMENT_COPY.setup.accounts.yes, option: true },
    { label: RETIREMENT_COPY.setup.accounts.no, option: false },
    { label: RETIREMENT_COPY.setup.accounts.unknown, option: null },
  ]

  return (
    <fieldset>
      <legend className="text-slate-600 dark:text-slate-300">{label}</legend>
      <div className="mt-1 flex gap-4">
        {options.map((entry) => (
          <label key={String(entry.option)} className="flex items-center gap-1.5 text-xs">
            <input
              type="radio"
              name={name}
              checked={value === entry.option}
              onChange={() => onChange(entry.option)}
            />
            {entry.label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

/* ------------------------------------------------------------------ spending */

function SpendingStep({
  loanPayoffYears,
  answers,
  pre65Healthcare,
}: {
  loanPayoffYears: readonly { accountId: string; payoffYear: number }[]
  answers: readonly StoredSpendingAnswer[]
  /** Stored negative, like all spending. The field below shows it as a positive cost. */
  pre65Healthcare: string | null
}): ReactNode {
  const workingSet = useWorkingSet()
  const today = localToday()

  const answerByCategory = useMemo(
    () => new Map(answers.map((answer) => [answer.categoryId, answer])),
    [answers],
  )

  const review = useMemo(
    () =>
      spendingReview({
        transactions: workingSet.transactions,
        categories: workingSet.categories.values(),
        confirmedTransferIds: workingSet.confirmedTransferIds,
        today,
        uncategorizedLabel: TRANSACTIONS_COPY.uncategorized,
      }),
    [workingSet.transactions, workingSet.categories, workingSet.confirmedTransferIds, today],
  )

  const payoffYear = loanPayoffYears[0]?.payoffYear

  return (
    <Section
      title={RETIREMENT_COPY.setup.steps.spending}
      blurb={RETIREMENT_COPY.spending.baselineNote}
    >
      {review.monthsObserved < 12 && review.monthsObserved > 0 && (
        <p className="mt-3 text-xs text-slate-600 dark:text-slate-300">
          {RETIREMENT_COPY.spending.partialYear(review.monthsObserved)}
        </p>
      )}

      <HealthcareBridge stored={pre65Healthcare} />

      <ul className="mt-4 space-y-2">
        {review.rows.map((row) => (
          <li
            key={row.categoryId ?? 'uncategorized'}
            className="rounded-xl border border-slate-200 p-4 dark:border-slate-800"
          >
            <SpendingRowForm
              /*
               * Keyed by the stored answer as well as the category, so that re-fetching after a
               * save remounts the row with the saved values. Without it the form keeps its own
               * initial state forever and a reload would appear to lose the answer.
               */
              key={`${row.categoryId ?? 'uncategorized'}:${
                answerByCategory.get(row.categoryId ?? '')?.reviewedAt ?? 'none'
              }`}
              categoryId={row.categoryId}
              name={row.name}
              annualCents={row.annualCents}
              payoffYear={payoffYear}
              answer={
                row.categoryId === null ? undefined : answerByCategory.get(row.categoryId)
              }
            />
          </li>
        ))}
      </ul>
    </Section>
  )
}

/**
 * Healthcare between retiring and 65, asked for separately.
 *
 * The single largest unknown for anybody stopping work before Medicare. Averaged into a category
 * it disappears, which produces a cheerful and wrong projection for exactly the people who most
 * need an accurate one.
 */
function HealthcareBridge({ stored }: { stored: string | null }): ReactNode {
  const queryClient = useQueryClient()
  const id = useId()

  /*
   * Shown as a positive cost because that is how somebody thinks about a bill, and negated on the
   * way out. This is the ingest edge for this field — the one place its sign is decided (§3.2).
   */
  const [amount, setAmount] = useState(stored === null ? '' : stored.replace(/^-/, ''))

  const save = useMutation({
    mutationFn: () =>
      patchProfile({
        pre65HealthcareAnnual:
          amount.trim() === '' ? null : `-${amount.trim().replace(/^-/, '')}`,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: PLAN_KEY })
      await queryClient.invalidateQueries({ queryKey: PROJECTION_KEY })
    },
  })

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate()
      }}
      className="mt-4 rounded-xl border border-slate-200 p-4 text-sm dark:border-slate-800"
    >
      <label htmlFor={id} className="font-medium">
        {RETIREMENT_COPY.spending.healthcareBridge}
      </label>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        {RETIREMENT_COPY.spending.healthcareBridgeNote}
      </p>
      <div className="mt-2 flex gap-2">
        <input
          id={id}
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          pattern="\d+(\.\d{1,2})?"
          className={`${inputClass} flex-1`}
        />
        <button
          type="submit"
          disabled={save.isPending}
          className="mt-1 shrink-0 rounded-lg border border-slate-300 px-3 py-2 text-xs disabled:opacity-60 dark:border-slate-700"
        >
          Save
        </button>
      </div>
    </form>
  )
}

/**
 * One category's answer.
 *
 * Uncategorized spending has no category id to store an answer against, so it is shown with its
 * amount and no controls — counted as continuing, and visible rather than hidden. Dropping the row
 * would make the baseline wrong by that amount with nothing on screen to explain it.
 */
function SpendingRowForm({
  categoryId,
  name,
  annualCents,
  payoffYear,
  answer,
}: {
  categoryId: string | null
  name: string
  annualCents: bigint
  payoffYear: number | undefined
  /** The answer already given, if any. Absent means nobody has reviewed this category. */
  answer: StoredSpendingAnswer | undefined
}): ReactNode {
  const queryClient = useQueryClient()
  const groupName = useId()
  const percentId = useId()
  const untilId = useId()

  /*
   * `continues` is the default for an unreviewed category, matching the server — and the row says
   * so, because a default that cannot be told apart from an answer makes an untouched review look
   * finished.
   */
  const [treatment, setTreatment] = useState<SpendingAnswer['treatment']>(
    answer?.treatment ?? 'continues',
  )
  const [percent, setPercent] = useState(
    answer?.adjustmentBasisPoints === null || answer?.adjustmentBasisPoints === undefined
      ? ''
      : String(answer.adjustmentBasisPoints / 100),
  )
  const [until, setUntil] = useState(
    answer?.lastYear === null || answer?.lastYear === undefined ? '' : String(answer.lastYear),
  )

  const save = useMutation({
    mutationFn: () => {
      if (categoryId === null) return Promise.resolve()
      return setSpendingAnswer(categoryId, {
        treatment,
        adjustmentBasisPoints:
          treatment === 'adjusted' && percent.trim() !== ''
            ? Math.round(Number(percent) * 100)
            : null,
        lastYear: until.trim() === '' ? null : Number(until),
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: PROJECTION_KEY })
    },
  })

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p className="truncate font-medium">
          {name}
          {categoryId !== null && answer === undefined && (
            <span className="ml-2 text-xs font-normal text-slate-500 dark:text-slate-400">
              {RETIREMENT_COPY.spending.unreviewed}
            </span>
          )}
        </p>
        {/* Negated at the point of display, and nowhere earlier. */}
        <p className="shrink-0 tabular-nums">{formatCents(-annualCents)}</p>
      </div>

      {categoryId === null ? (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          {RETIREMENT_COPY.spending.uncategorizedNote}
        </p>
      ) : (
        <div className="mt-3 space-y-2 text-sm">
          <fieldset>
            <legend className="sr-only">{name}</legend>
            <div className="flex flex-wrap gap-4">
              {(
                [
                  ['continues', RETIREMENT_COPY.spending.continues],
                  ['stops', RETIREMENT_COPY.spending.stops],
                  ['adjusted', RETIREMENT_COPY.spending.adjusted],
                ] as const
              ).map(([option, label]) => (
                <label key={option} className="flex items-center gap-1.5 text-xs">
                  <input
                    type="radio"
                    name={groupName}
                    checked={treatment === option}
                    onChange={() => setTreatment(option)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid grid-cols-2 gap-3">
            {treatment === 'adjusted' && (
              <div>
                <label htmlFor={percentId} className="text-xs text-slate-500 dark:text-slate-400">
                  {RETIREMENT_COPY.spending.adjustedLabel}
                </label>
                <input
                  id={percentId}
                  inputMode="decimal"
                  value={percent}
                  onChange={(event) => setPercent(event.target.value)}
                  className={inputClass}
                />
              </div>
            )}

            <div>
              <label htmlFor={untilId} className="text-xs text-slate-500 dark:text-slate-400">
                {RETIREMENT_COPY.spending.untilLabel}
              </label>
              <input
                id={untilId}
                type="number"
                inputMode="numeric"
                value={until}
                onChange={(event) => setUntil(event.target.value)}
                min={2_000}
                max={2_200}
                className={inputClass}
              />
              {/*
               * Offered, never applied. Which category pays which loan is something only the
               * household knows, and guessing wrong drops a whole category on the wrong date.
               */}
              {payoffYear !== undefined && until.trim() === '' && (
                <button
                  type="button"
                  onClick={() => setUntil(String(payoffYear))}
                  className="mt-1 text-xs text-sky-600 underline dark:text-sky-400"
                >
                  {RETIREMENT_COPY.spending.payoffPrefill(payoffYear)}
                </button>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs disabled:opacity-60 dark:border-slate-700"
          >
            Save
          </button>
        </div>
      )}
    </div>
  )
}

/* ----------------------------------------------------------------- scenarios */

function ScenariosStep({ scenarios }: { scenarios: readonly PlanScenario[] }): ReactNode {
  return (
    <Section
      title={RETIREMENT_COPY.setup.steps.scenarios}
      blurb={RETIREMENT_COPY.setup.scenarios.blurb}
    >
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        {RETIREMENT_COPY.setup.scenarios.realNote} {RETIREMENT_COPY.setup.scenarios.deRiskNote}
      </p>

      <ul className="mt-4 space-y-3">
        {scenarios.map((scenario) => (
          <li
            key={scenario.id}
            className="rounded-xl border border-slate-200 p-4 dark:border-slate-800"
          >
            <ScenarioForm scenario={scenario} />
          </li>
        ))}
      </ul>
    </Section>
  )
}

function ScenarioForm({ scenario }: { scenario: PlanScenario }): ReactNode {
  const queryClient = useQueryClient()
  const preId = useId()
  const postId = useId()

  /** Basis points as a percent string for editing, and back again on save. */
  const [pre, setPre] = useState(String(scenario.preRetirementReturnBasisPoints / 100))
  const [post, setPost] = useState(String(scenario.postRetirementReturnBasisPoints / 100))

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: PLAN_KEY })
    await queryClient.invalidateQueries({ queryKey: PROJECTION_KEY })
  }

  const save = useMutation({
    mutationFn: () =>
      patchScenario(scenario.id, {
        preRetirementReturnBasisPoints: Math.round(Number(pre) * 100),
        postRetirementReturnBasisPoints: Math.round(Number(post) * 100),
      }),
    onSuccess: refresh,
  })

  const promote = useMutation({ mutationFn: () => makeScenarioDefault(scenario.id), onSuccess: refresh })

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-medium">{scenario.name}</p>
        {scenario.isDefault ? (
          <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
            {RETIREMENT_COPY.setup.scenarios.isDefault}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => promote.mutate()}
            disabled={promote.isPending}
            className="shrink-0 text-xs text-sky-600 underline disabled:opacity-60 dark:text-sky-400"
          >
            {RETIREMENT_COPY.setup.scenarios.makeDefault}
          </button>
        )}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault()
          save.mutate()
        }}
        className="mt-3 grid grid-cols-2 gap-3 text-sm"
      >
        <div>
          <label htmlFor={preId} className="text-xs text-slate-500 dark:text-slate-400">
            {RETIREMENT_COPY.setup.scenarios.preRetirement}
          </label>
          <input
            id={preId}
            inputMode="decimal"
            value={pre}
            onChange={(event) => setPre(event.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor={postId} className="text-xs text-slate-500 dark:text-slate-400">
            {RETIREMENT_COPY.setup.scenarios.postRetirement}
          </label>
          <input
            id={postId}
            inputMode="decimal"
            value={post}
            onChange={(event) => setPost(event.target.value)}
            className={inputClass}
          />
        </div>
        <div className="col-span-2">
          <button
            type="submit"
            disabled={save.isPending}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs disabled:opacity-60 dark:border-slate-700"
          >
            Save
          </button>
        </div>
      </form>
    </div>
  )
}

/* -------------------------------------------------------------------- shared */

const inputClass =
  'mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900'

function FormActions({
  pending,
  onCancel,
}: {
  pending: boolean
  onCancel: () => void
}): ReactNode {
  return (
    <div className="flex gap-2 pt-1">
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        Save
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="rounded-lg border border-slate-300 px-4 py-2 text-sm dark:border-slate-700"
      >
        Cancel
      </button>
    </div>
  )
}
