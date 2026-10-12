import { RETIREMENT_COPY, formatCents, parseDecimalToCents } from '@beans/shared'
import { useQuery } from '@tanstack/react-query'
import { useId, type ReactNode } from 'react'
import { Link } from 'wouter'
import { localToday } from '../lib/today.js'
import { getOpportunities, type Opportunity } from '../retirement/api.js'
import { ReferenceBanner } from '../retirement/ReferenceBanner.js'

/**
 * This year's opportunities (ARCHITECTURE.md §19.6).
 *
 * **Every rule shows, including the ones that cannot answer.** A rule that silently produces
 * nothing is indistinguishable from one that does not exist, and "why doesn't it mention tax-loss
 * harvesting" deserves an answer on the screen rather than in somebody's head.
 *
 * Nothing here is phrased as a recommendation. Each entry states what a mechanism is, shows the
 * household's own figure against it, and links to the authority.
 */
export function RetirementOpportunities(): ReactNode {
  const taxYear = Number(localToday().slice(0, 4))

  const query = useQuery({
    queryKey: ['retirement', 'opportunities', taxYear],
    queryFn: () => getOpportunities(taxYear),
  })

  return (
    <div className="mx-auto max-w-2xl px-5 pb-16 pt-6">
      <h1 className="text-2xl font-semibold">
        {RETIREMENT_COPY.opportunities.title} · {taxYear}
      </h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        {RETIREMENT_COPY.opportunities.blurb}
      </p>

      <ReferenceBanner />

      {query.isPending && (
        <p className="mt-6 text-sm text-slate-500 dark:text-slate-400">
          {RETIREMENT_COPY.loading}
        </p>
      )}

      <ul className="mt-5 space-y-3">
        {query.data?.opportunities.map((entry) => (
          <li
            key={entry.key}
            className="rounded-xl border border-slate-200 p-4 dark:border-slate-800"
          >
            <Rule entry={entry} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function Rule({ entry }: { entry: Opportunity }): ReactNode {
  const headingId = useId()

  return (
    <section aria-labelledby={headingId}>
      <div className="flex items-start justify-between gap-3">
        <h2 id={headingId} className="text-sm font-medium">
          {entry.title}
        </h2>
        <Badge outcome={entry.outcome} />
      </div>

      {/* The mechanism, always. It is what the rule is for, whether or not it has a figure. */}
      <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">{entry.mechanism}</p>

      <Detail outcome={entry.outcome} />

      <a
        href={entry.sourceUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="mt-2 inline-block text-xs text-sky-600 underline dark:text-sky-400"
      >
        {RETIREMENT_COPY.opportunities.source}
      </a>
    </section>
  )
}

/**
 * The status chip.
 *
 * An informational rule gets no chip at all — the figure beneath it is the statement, and
 * labelling it would be labelling the normal case. Chips are for the four ways a rule can decline
 * to answer, which are the cases a reader would otherwise have to guess at.
 */
function Badge({ outcome }: { outcome: Opportunity['outcome'] }): ReactNode {
  const copy = RETIREMENT_COPY.opportunities.outcome

  const label =
    outcome.kind === 'not_applicable'
      ? copy.notApplicable
      : outcome.kind === 'needs_reference'
        ? copy.needsReference
        : outcome.kind === 'needs_answer'
          ? copy.needsAnswer
          : outcome.kind === 'unavailable'
            ? copy.unavailable
            : null

  if (label === null) return null

  return (
    <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">{label}</span>
  )
}

function Detail({ outcome }: { outcome: Opportunity['outcome'] }): ReactNode {
  const copy = RETIREMENT_COPY.opportunities

  switch (outcome.kind) {
    case 'informational':
      return (
        <div className="mt-2">
          {outcome.amount !== undefined && (
            <p className="text-lg font-semibold tabular-nums">
              {formatCents(parseDecimalToCents(outcome.amount))}
            </p>
          )}
          <p className="text-xs text-slate-600 dark:text-slate-300">{outcome.detail}</p>
        </div>
      )

    case 'needs_reference':
      return (
        <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">
          {copy.needsReferenceNote}{' '}
          <Link href="/retirement/reference" className="underline">
            {RETIREMENT_COPY.reference.action}
          </Link>
        </p>
      )

    case 'needs_answer':
      return (
        <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">
          {copy.needsAnswerNote(outcome.question)}{' '}
          <Link href="/retirement/setup" className="underline">
            {RETIREMENT_COPY.setup.title}
          </Link>
        </p>
      )

    /*
     * Both remaining cases carry a reason, and it is always shown. "Does not apply" with no
     * explanation reads as a bug; with one, it reads as an answer.
     */
    case 'not_applicable':
    case 'unavailable':
      return (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{outcome.reason}</p>
      )
  }
}
