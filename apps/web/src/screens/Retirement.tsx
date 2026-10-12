import {
  RETIREMENT_COPY,
  TAX_TREATMENT_LABELS,
  formatCents,
  parseDecimalToCents,
  type TaxTreatment,
} from '@beans/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type ReactNode } from 'react'
import { Link } from 'wouter'
import { ProjectionBand } from '../charts/ProjectionBand.js'
import { cn } from '../lib/cn.js'
import {
  addMember,
  getProjection,
  getRetirementPlan,
  removeMember,
  startPlan,
  updateMember,
  type MemberInput,
  type PlanMember,
} from '../retirement/api.js'
import { dashboardView, percentFromBasisPoints } from '../retirement/present.js'
import { ReferenceBanner } from '../retirement/ReferenceBanner.js'

/**
 * The retirement dashboard (ARCHITECTURE.md §19).
 *
 * **Every number on this screen has its assumption beside it**, on the same screen, not behind a
 * settings panel — which is the spec's first ground rule and the reason the assumptions block is
 * not collapsible.
 *
 * Nothing here is phrased as a recommendation, and nothing is funny. A depletion year and a funding
 * gap are both numbers moving badly for the person reading them, and they are stated flat. The
 * copy module is where that discipline lives; this file only has to not undermine it.
 */

const PLAN_KEY = ['retirement', 'plan'] as const
const PROJECTION_KEY = ['retirement', 'projection'] as const

/**
 * The band chart's axis labels.
 *
 * Compact — `$2.6M` rather than `$2,600,000.00` — because five full-precision labels stacked down
 * the left edge of a forty-year chart are unreadable, and the axis is there to convey scale. The
 * exact figures are in the headline and the table fallback. `fractionDigits` comes from the chart,
 * which is the only thing that knows how close together its own ticks are.
 */
const axisValue = (cents: bigint, fractionDigits: number): string =>
  formatCents(cents, { compact: true, compactFractionDigits: fractionDigits })

export function Retirement(): ReactNode {
  const queryClient = useQueryClient()

  const plan = useQuery({ queryKey: PLAN_KEY, queryFn: getRetirementPlan })
  const projection = useQuery({
    queryKey: PROJECTION_KEY,
    queryFn: getProjection,
    // Nothing to project until the plan exists.
    enabled: plan.data?.started === true,
  })

  const begin = useMutation({
    mutationFn: startPlan,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: PLAN_KEY })
      await queryClient.invalidateQueries({ queryKey: PROJECTION_KEY })
    },
  })

  if (plan.isPending) {
    return (
      <Page>
        <p className="mt-6 text-sm text-slate-500 dark:text-slate-400">
          {RETIREMENT_COPY.loading}
        </p>
      </Page>
    )
  }

  if (plan.isError) {
    return (
      <Page>
        <ErrorState onRetry={() => void plan.refetch()} />
      </Page>
    )
  }

  if (plan.data?.started !== true) {
    return (
      <Page>
        <section className="mt-6 rounded-xl border border-slate-200 p-5 dark:border-slate-800">
          <h2 className="font-semibold">{RETIREMENT_COPY.empty.title}</h2>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            {RETIREMENT_COPY.empty.body}
          </p>
          <button
            type="button"
            onClick={() => begin.mutate()}
            disabled={begin.isPending}
            className="mt-4 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {RETIREMENT_COPY.empty.action}
          </button>
        </section>
      </Page>
    )
  }

  const view = dashboardView(
    projection.data,
    plan.data.scenarios,
    plan.data.started,
  )

  return (
    <Page>
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        {RETIREMENT_COPY.realDollarsNote}
      </p>

      <ReferenceBanner />

      {projection.isError && <ErrorState onRetry={() => void projection.refetch()} />}

      {view.kind === 'incomplete' && <Missing missing={view.missing} />}

      <Link
        href="/retirement/setup"
        className="mt-5 inline-block rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium dark:border-slate-700"
      >
        {RETIREMENT_COPY.setup.title}
      </Link>

      {view.kind === 'ready' && (
        <>
          <Headline view={view} />
          <ProjectionBand
            className="mt-5"
            points={view.band.map((point) => ({
              year: point.year,
              low: parseDecimalToCents(point.low),
              high: parseDecimalToCents(point.high),
              headline: parseDecimalToCents(point.headline),
            }))}
            formatValue={axisValue}
            tableLabel={RETIREMENT_COPY.table.caption}
            tableSampledNote={RETIREMENT_COPY.table.sampledNote}
            tableColumns={[
              RETIREMENT_COPY.table.year,
              RETIREMENT_COPY.table.total,
              'Low',
              'High',
            ]}
          />
          <Assumptions
            effectiveRateBasisPoints={plan.data.profile.retirementEffectiveRateBasisPoints}
            scenarios={plan.data.scenarios}
            heldBack={view.headline.heldBack}
          />
          <TaxBreakdown view={view} />
          <Disclosures factors={view.disclosures} />
          <SpendingNotes
            unreviewedCount={view.unreviewedCount}
            monthsObserved={view.monthsObserved}
            annualized={view.annualizedFromPartialYear}
          />
        </>
      )}

      <People members={plan.data.members} />
    </Page>
  )
}

function Page({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="mx-auto max-w-2xl px-5 pb-16 pt-6">
      <h1 className="text-2xl font-semibold">{RETIREMENT_COPY.title}</h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{RETIREMENT_COPY.blurb}</p>
      {children}
    </div>
  )
}

function ErrorState({ onRetry }: { onRetry: () => void }): ReactNode {
  return (
    <section
      role="alert"
      className="mt-6 rounded-xl border border-slate-200 p-5 dark:border-slate-800"
    >
      <h2 className="font-semibold">{RETIREMENT_COPY.error.title}</h2>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
        {RETIREMENT_COPY.error.body}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium dark:border-slate-700"
      >
        {RETIREMENT_COPY.error.action}
      </button>
    </section>
  )
}

/**
 * The headline, as a range across the scenarios.
 *
 * Never a single figure. The spread *is* the information — three return assumptions produce three
 * answers, and collapsing them to one would imply a precision the model does not have.
 */
function Headline({
  view,
}: {
  view: Extract<ReturnType<typeof dashboardView>, { kind: 'ready' }>
}): ReactNode {
  const headingId = useId()

  return (
    <section aria-labelledby={headingId} className="mt-5">
      <h2 id={headingId} className="text-xs text-slate-500 dark:text-slate-400">
        {RETIREMENT_COPY.headline.label}
      </h2>
      <p className="mt-1 text-2xl font-semibold tabular-nums">
        {RETIREMENT_COPY.headline.range(
          formatCents(parseDecimalToCents(view.terminalLow)),
          formatCents(parseDecimalToCents(view.terminalHigh)),
        )}
      </p>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        {RETIREMENT_COPY.headline.bandNote}
      </p>

      <p className="mt-3 text-sm text-slate-700 dark:text-slate-200">
        {view.outcome.kind === 'no-horizon' && RETIREMENT_COPY.funded.noHorizon}
        {view.outcome.kind === 'covered' && RETIREMENT_COPY.funded.lasts}
        {view.outcome.kind === 'short' && (
          /*
           * Two flat statements, no adornment. This is the moment the no-jokes rule is for: the
           * reader has just been told their plan runs out, and what helps is the year and the
           * number, not a tone.
           */
          <>
            {RETIREMENT_COPY.funded.depletes(view.outcome.depletionYear)}
            {' · '}
            {RETIREMENT_COPY.funded.gap(
              formatCents(parseDecimalToCents(view.outcome.gap)),
            )}
            {' · '}
            {RETIREMENT_COPY.funded.value(
              percentFromBasisPoints(view.outcome.fundedRatioBasisPoints),
            )}
          </>
        )}
      </p>

      {/*
       * Said whenever any scenario runs out, even when the headline one does not. Without it the
       * screen reads "Lasts the whole plan" above a band whose lower edge touches zero.
       */}
      {view.earliestDepletion !== null && view.outcome.kind !== 'short' && (
        <p className="mt-1 text-sm text-slate-700 dark:text-slate-200">
          {RETIREMENT_COPY.funded.depletesUnder(
            view.earliestDepletion.year,
            view.earliestDepletion.scenarioName,
          )}
        </p>
      )}
    </section>
  )
}

/**
 * What the portfolio is worth after the assumed tax, beside what it nominally is.
 *
 * **Never instead of net worth.** Net worth is a fact — the sum of what the institutions report —
 * and this is a fact plus an assumption, so both are shown and the assumption travels with the
 * figure. Replacing one with the other would trade something true for something defensible, which
 * is the wrong direction for a headline number in a finance app.
 *
 * It lives here rather than on the net worth screen deliberately. Most households never open the
 * planner, and putting a rate-dependent figure on the main screen would mean showing everybody a
 * number resting on a default nobody chose.
 */
function TaxBreakdown({
  view,
}: {
  view: Extract<ReturnType<typeof dashboardView>, { kind: 'ready' }>
}): ReactNode {
  const headingId = useId()
  if (view.openingBuckets.length === 0) return null

  const deferred = parseDecimalToCents(view.afterTax.deferredTax)

  return (
    <section aria-labelledby={headingId} className="mt-8">
      <h2 id={headingId} className="font-semibold">
        {RETIREMENT_COPY.afterTax.label}
      </h2>

      <dl className="mt-3 grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-slate-200 px-4 py-3 dark:border-slate-800">
          <dt className="text-xs text-slate-500 dark:text-slate-400">
            {RETIREMENT_COPY.table.total}
          </dt>
          <dd className="mt-1 text-xl font-semibold tabular-nums">
            {formatCents(parseDecimalToCents(view.afterTax.nominal))}
          </dd>
        </div>
        <div className="rounded-xl border border-slate-200 px-4 py-3 dark:border-slate-800">
          <dt className="text-xs text-slate-500 dark:text-slate-400">
            {RETIREMENT_COPY.afterTax.label}
          </dt>
          <dd className="mt-1 text-xl font-semibold tabular-nums">
            {formatCents(parseDecimalToCents(view.afterTax.afterTax))}
          </dd>
        </div>
      </dl>

      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        {RETIREMENT_COPY.afterTax.note(percentFromBasisPoints(view.effectiveRateBasisPoints))}
      </p>

      {/* Only when something is actually owed. Shown always, it becomes furniture. */}
      {deferred !== 0n && (
        <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
          {RETIREMENT_COPY.afterTax.deferredTax(formatCents(deferred))}
        </p>
      )}

      {view.afterTax.ignoresEmbeddedGains && (
        <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
          {RETIREMENT_COPY.afterTax.ignoresGains}
        </p>
      )}

      <ul className="mt-3 space-y-1 text-sm">
        {view.openingBuckets.map((bucket) => (
          <li key={bucket.treatment} className="flex justify-between gap-3">
            <span className="text-slate-500 dark:text-slate-400">
              {TAX_TREATMENT_LABELS[bucket.treatment as TaxTreatment] ?? bucket.treatment}
            </span>
            <span className="tabular-nums">
              {formatCents(parseDecimalToCents(bucket.balance))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Assumptions({
  effectiveRateBasisPoints,
  scenarios,
  heldBack,
}: {
  effectiveRateBasisPoints: number
  scenarios: readonly { id: string; name: string; preRetirementReturnBasisPoints: number; postRetirementReturnBasisPoints: number; isDefault: boolean }[]
  heldBack: string
}): ReactNode {
  const headingId = useId()
  const heldBackCents = parseDecimalToCents(heldBack)

  return (
    <section aria-labelledby={headingId} className="mt-8">
      <h2 id={headingId} className="font-semibold">
        {RETIREMENT_COPY.assumptions.heading}
      </h2>

      <dl className="mt-3 space-y-3 text-sm">
        <div>
          <dt className="text-slate-500 dark:text-slate-400">
            {RETIREMENT_COPY.assumptions.effectiveRate}
          </dt>
          <dd className="tabular-nums">{percentFromBasisPoints(effectiveRateBasisPoints)}</dd>
          <dd className="text-xs text-slate-500 dark:text-slate-400">
            {RETIREMENT_COPY.assumptions.effectiveRateNote}
          </dd>
        </div>

        <div>
          <dt className="text-slate-500 dark:text-slate-400">
            {RETIREMENT_COPY.assumptions.returns}
          </dt>
          {scenarios.map((scenario) => (
            <dd key={scenario.id} className="tabular-nums">
              {scenario.name}: {percentFromBasisPoints(scenario.preRetirementReturnBasisPoints)}
              {' / '}
              {percentFromBasisPoints(scenario.postRetirementReturnBasisPoints)}
              {scenario.isDefault && (
                <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                  {RETIREMENT_COPY.setup.scenarios.isDefault}
                </span>
              )}
            </dd>
          ))}
          <dd className="text-xs text-slate-500 dark:text-slate-400">
            {RETIREMENT_COPY.assumptions.returnsNote}
          </dd>
        </div>

        <div>
          <dt className="text-slate-500 dark:text-slate-400">
            {RETIREMENT_COPY.assumptions.withdrawalOrder}
          </dt>
          <dd className="text-xs text-slate-500 dark:text-slate-400">
            {RETIREMENT_COPY.assumptions.withdrawalOrderNote}
          </dd>
        </div>

        {/* Only when there is something held back. Shown always, it becomes furniture. */}
        {heldBackCents !== 0n && (
          <div>
            <dt className="text-slate-500 dark:text-slate-400">
              {RETIREMENT_COPY.assumptions.heldBack(formatCents(heldBackCents))}
            </dt>
            <dd className="text-xs text-slate-500 dark:text-slate-400">
              {RETIREMENT_COPY.assumptions.heldBackNote}
            </dd>
          </div>
        )}
      </dl>
    </section>
  )
}

/**
 * What the projection leaves out, beside the figures rather than in a footnote.
 *
 * A projection missing required distributions is optimistic by an amount the reader cannot see.
 * Each entry says what the omission does to the number, because "not included yet" on its own is
 * not a disclosure.
 */
function Disclosures({ factors }: { factors: readonly string[] }): ReactNode {
  const headingId = useId()
  if (factors.length === 0) return null

  return (
    <section aria-labelledby={headingId} className="mt-8">
      <h2 id={headingId} className="text-sm font-semibold">
        {RETIREMENT_COPY.notModelled.heading}
      </h2>
      <ul className="mt-2 space-y-2 text-xs text-slate-600 dark:text-slate-300">
        {factors.map((factor) => (
          <li key={factor}>
            {RETIREMENT_COPY.notModelled[factor as keyof typeof RETIREMENT_COPY.notModelled] ??
              factor}
          </li>
        ))}
      </ul>
    </section>
  )
}

function SpendingNotes({
  unreviewedCount,
  monthsObserved,
  annualized,
}: {
  unreviewedCount: number
  monthsObserved: number
  annualized: boolean
}): ReactNode {
  if (unreviewedCount === 0 && !annualized) return null

  return (
    <div className="mt-6 space-y-2 text-xs text-slate-600 dark:text-slate-300">
      {unreviewedCount > 0 && <p>{RETIREMENT_COPY.spending.unreviewedNote(unreviewedCount)}</p>}
      {annualized && <p>{RETIREMENT_COPY.spending.partialYear(monthsObserved)}</p>}
    </div>
  )
}

/** Everything still needed, all of it — the first gap is rarely the only one. */
function Missing({ missing }: { missing: readonly string[] }): ReactNode {
  const headingId = useId()

  return (
    <section aria-labelledby={headingId} className="mt-6 rounded-xl border border-slate-200 p-5 dark:border-slate-800">
      <h2 id={headingId} className="font-semibold">
        {RETIREMENT_COPY.setup.missing.heading}
      </h2>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-300">
        {missing.map((item) => (
          <li key={item}>
            {RETIREMENT_COPY.setup.missing[
              item as keyof typeof RETIREMENT_COPY.setup.missing
            ] ?? item}
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * Who the plan covers.
 *
 * Separate from household membership on purpose: a spouse who never signs in still retires on a
 * date and claims on a schedule, and a plan that cannot represent them is wrong for most
 * households.
 */
function People({ members }: { members: readonly PlanMember[] }): ReactNode {
  const headingId = useId()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<string | 'new' | null>(null)

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: PLAN_KEY })
    await queryClient.invalidateQueries({ queryKey: PROJECTION_KEY })
  }

  const save = useMutation({
    mutationFn: async (input: { id: string | null; member: MemberInput }) =>
      input.id === null ? void (await addMember(input.member)) : updateMember(input.id, input.member),
    onSuccess: async () => {
      setEditing(null)
      await refresh()
    },
  })

  const drop = useMutation({ mutationFn: removeMember, onSuccess: refresh })

  return (
    <section aria-labelledby={headingId} className="mt-10">
      <h2 id={headingId} className="font-semibold">
        {RETIREMENT_COPY.setup.steps.who}
      </h2>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        {RETIREMENT_COPY.setup.who.blurb}
      </p>

      <ul className="mt-4 space-y-3">
        {members.map((member) => (
          <li
            key={member.id}
            className="rounded-xl border border-slate-200 p-4 dark:border-slate-800"
          >
            {editing === member.id ? (
              <MemberForm
                member={member}
                pending={save.isPending}
                onCancel={() => setEditing(null)}
                onSave={(input) => save.mutate({ id: member.id, member: input })}
              />
            ) : (
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium">{member.displayName}</p>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                    {member.birthYear}
                    {member.targetRetirementDate !== null &&
                      ` · ${RETIREMENT_COPY.setup.who.retirementDate.toLowerCase()} ${member.targetRetirementDate}`}
                    {member.lifeExpectancy !== null && ` · through ${member.lifeExpectancy}`}
                  </p>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {member.socialSecurityAnnualBenefit === null
                      ? RETIREMENT_COPY.setup.socialSecurity.missing
                      : `${formatCents(parseDecimalToCents(member.socialSecurityAnnualBenefit))}/yr${
                          member.socialSecurityClaimAge === null
                            ? ''
                            : ` at ${member.socialSecurityClaimAge}`
                        }`}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => setEditing(member.id)}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs dark:border-slate-700"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => drop.mutate(member.id)}
                    disabled={drop.isPending}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs disabled:opacity-60 dark:border-slate-700"
                  >
                    {RETIREMENT_COPY.setup.who.remove}
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>

      {editing === 'new' ? (
        <div className="mt-3 rounded-xl border border-slate-200 p-4 dark:border-slate-800">
          <MemberForm
            pending={save.isPending}
            onCancel={() => setEditing(null)}
            onSave={(input) => save.mutate({ id: null, member: input })}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setEditing('new')}
          className="mt-3 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium dark:border-slate-700"
        >
          {RETIREMENT_COPY.setup.who.add}
        </button>
      )}
    </section>
  )
}

/**
 * One person's details.
 *
 * Every field carries a real `<label>` bound by id. The life-expectancy note is deliberately
 * blunt: it moves the result more than almost anything else on this screen, and Beans will not pick
 * one on somebody's behalf.
 */
function MemberForm({
  member,
  pending,
  onSave,
  onCancel,
}: {
  member?: PlanMember | undefined
  pending: boolean
  onSave: (input: MemberInput) => void
  onCancel: () => void
}): ReactNode {
  const ids = {
    name: useId(),
    birthYear: useId(),
    retirementDate: useId(),
    lifeExpectancy: useId(),
    claimAge: useId(),
    benefit: useId(),
  }

  const [name, setName] = useState(member?.displayName ?? '')
  const [birthYear, setBirthYear] = useState(String(member?.birthYear ?? ''))
  const [retirementDate, setRetirementDate] = useState(member?.targetRetirementDate ?? '')
  const [lifeExpectancy, setLifeExpectancy] = useState(String(member?.lifeExpectancy ?? ''))
  const [claimAge, setClaimAge] = useState(String(member?.socialSecurityClaimAge ?? ''))
  const [benefit, setBenefit] = useState(member?.socialSecurityAnnualBenefit ?? '')

  /** Blank means "not entered", which is a real answer and not zero. */
  const numberOrNull = (value: string): number | null =>
    value.trim() === '' ? null : Number(value)

  const submit = (): void => {
    const year = Number(birthYear)
    if (name.trim() === '' || !Number.isFinite(year)) return

    onSave({
      displayName: name.trim(),
      birthYear: year,
      targetRetirementDate: retirementDate.trim() === '' ? null : retirementDate,
      lifeExpectancy: numberOrNull(lifeExpectancy),
      socialSecurityClaimAge: numberOrNull(claimAge),
      socialSecurityAnnualBenefit: benefit.trim() === '' ? null : benefit.trim(),
    })
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
      className="space-y-3 text-sm"
    >
      <Field id={ids.name} label={RETIREMENT_COPY.setup.who.name}>
        <input
          id={ids.name}
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={120}
          className={inputClass}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field id={ids.birthYear} label={RETIREMENT_COPY.setup.who.birthYear}>
          <input
            id={ids.birthYear}
            type="number"
            inputMode="numeric"
            value={birthYear}
            onChange={(event) => setBirthYear(event.target.value)}
            required
            min={1_900}
            max={2_100}
            className={inputClass}
          />
        </Field>

        <Field id={ids.retirementDate} label={RETIREMENT_COPY.setup.who.retirementDate}>
          <input
            id={ids.retirementDate}
            type="date"
            value={retirementDate}
            onChange={(event) => setRetirementDate(event.target.value)}
            className={inputClass}
          />
        </Field>
      </div>

      <Field
        id={ids.lifeExpectancy}
        label={RETIREMENT_COPY.setup.who.lifeExpectancy}
        note={RETIREMENT_COPY.setup.who.lifeExpectancyNote}
      >
        <input
          id={ids.lifeExpectancy}
          type="number"
          inputMode="numeric"
          value={lifeExpectancy}
          onChange={(event) => setLifeExpectancy(event.target.value)}
          min={50}
          max={120}
          className={inputClass}
        />
      </Field>

      <fieldset className="space-y-3">
        <legend className="text-slate-500 dark:text-slate-400">
          {RETIREMENT_COPY.setup.steps.socialSecurity}
        </legend>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {RETIREMENT_COPY.setup.socialSecurity.blurb}{' '}
          {/*
           * The link is required, not decorative: every figure that depends on law points at its
           * source. `rel` is set because this leaves the app.
           */}
          <a
            href={RETIREMENT_COPY.setup.socialSecurity.sourceUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="underline"
          >
            {RETIREMENT_COPY.setup.socialSecurity.sourceLabel}
          </a>
        </p>

        <div className="grid grid-cols-2 gap-3">
          <Field id={ids.claimAge} label={RETIREMENT_COPY.setup.socialSecurity.claimAge}>
            <input
              id={ids.claimAge}
              type="number"
              inputMode="numeric"
              value={claimAge}
              onChange={(event) => setClaimAge(event.target.value)}
              min={50}
              max={80}
              className={inputClass}
            />
          </Field>

          <Field id={ids.benefit} label={RETIREMENT_COPY.setup.socialSecurity.benefit}>
            <input
              id={ids.benefit}
              inputMode="decimal"
              value={benefit}
              onChange={(event) => setBenefit(event.target.value)}
              // Money stays a string the whole way. The server parses it exactly.
              pattern="-?\d+(\.\d{1,2})?"
              className={inputClass}
            />
          </Field>
        </div>
      </fieldset>

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
    </form>
  )
}

const inputClass =
  'mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900'

function Field({
  id,
  label,
  note,
  children,
}: {
  id: string
  label: string
  note?: string
  children: ReactNode
}): ReactNode {
  const noteId = useId()

  return (
    <div>
      <label htmlFor={id} className="text-slate-500 dark:text-slate-400">
        {label}
      </label>
      {children}
      {note !== undefined && (
        <p id={noteId} className={cn('mt-1 text-xs text-slate-500 dark:text-slate-400')}>
          {note}
        </p>
      )}
    </div>
  )
}
