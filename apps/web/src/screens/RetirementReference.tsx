import { RETIREMENT_COPY } from '@beans/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type ReactNode } from 'react'
import { localToday } from '../lib/today.js'
import {
  approveReference,
  getReference,
  revokeReference,
  type ReferenceFigure,
} from '../retirement/api.js'
import { REFERENCE_KEY } from '../retirement/ReferenceBanner.js'

/**
 * Checking the statutory figures and approving them one at a time (ARCHITECTURE.md §19.5).
 *
 * This screen exists because Beans refuses to invent these numbers. Contribution limits, catch-up
 * tiers and the RMD age change every year and several have phased in on staggered schedules, so a
 * value recalled rather than read is confidently wrong about real money.
 *
 * **Each figure is approved on its own**, against its own source, and approving a year never
 * carries into the next. The projection and the phase B rules refuse any figure that has not been
 * through here.
 */
export function RetirementReference(): ReactNode {
  const thisYear = Number(localToday().slice(0, 4))
  const [taxYear, setTaxYear] = useState(thisYear)
  const yearId = useId()

  const reference = useQuery({
    queryKey: [...REFERENCE_KEY, taxYear],
    queryFn: () => getReference(taxYear),
  })

  return (
    <div className="mx-auto max-w-2xl px-5 pb-16 pt-6">
      <h1 className="text-2xl font-semibold">{RETIREMENT_COPY.reference.reviewTitle}</h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        {RETIREMENT_COPY.reference.reviewBlurb}
      </p>
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        {RETIREMENT_COPY.reference.whyBlurb}
      </p>

      <div className="mt-5">
        <label htmlFor={yearId} className="text-sm text-slate-500 dark:text-slate-400">
          {RETIREMENT_COPY.reference.year}
        </label>
        <input
          id={yearId}
          type="number"
          inputMode="numeric"
          value={taxYear}
          onChange={(event) => setTaxYear(Number(event.target.value))}
          min={2_000}
          max={2_200}
          className="mt-1 w-32 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
        />
      </div>

      {reference.data?.canApprove === false && (
        <p className="mt-4 text-sm text-slate-600 dark:text-slate-300">
          {RETIREMENT_COPY.reference.ownerOnly}
        </p>
      )}

      <ul className="mt-5 space-y-3">
        {reference.data?.figures.map((figure) => (
          <li
            key={figure.key}
            className="rounded-xl border border-slate-200 p-4 dark:border-slate-800"
          >
            <FigureRow
              figure={figure}
              taxYear={taxYear}
              canApprove={reference.data.canApprove}
            />
          </li>
        ))}
      </ul>
    </div>
  )
}

function FigureRow({
  figure,
  taxYear,
  canApprove,
}: {
  figure: ReferenceFigure
  taxYear: number
  canApprove: boolean
}): ReactNode {
  const queryClient = useQueryClient()
  const valueId = useId()
  const sourceId = useId()

  const [value, setValue] = useState(figure.value ?? '')
  const [sourceUrl, setSourceUrl] = useState(figure.sourceUrl)

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: REFERENCE_KEY })
    // The projection is gated on these, so it has to be re-read once one changes.
    await queryClient.invalidateQueries({ queryKey: ['retirement', 'projection'] })
  }

  const approve = useMutation({
    mutationFn: () => approveReference({ taxYear, key: figure.key, value, sourceUrl }),
    onSuccess: refresh,
  })

  const revoke = useMutation({
    mutationFn: () => revokeReference(taxYear, figure.key),
    onSuccess: refresh,
  })

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium">{figure.label}</p>
        <span
          className={
            figure.verified
              ? 'shrink-0 text-xs text-slate-500 dark:text-slate-400'
              : 'shrink-0 text-xs font-medium text-red-700 dark:text-red-300'
          }
        >
          {figure.verified
            ? RETIREMENT_COPY.reference.approved
            : RETIREMENT_COPY.reference.needsFigure}
        </span>
      </div>

      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        {RETIREMENT_COPY.reference.unitHint[figure.unit]}
      </p>

      <div className="mt-3 space-y-2 text-sm">
        <div>
          <label htmlFor={valueId} className="text-xs text-slate-500 dark:text-slate-400">
            {RETIREMENT_COPY.reference.value}
          </label>
          <input
            id={valueId}
            inputMode="numeric"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            disabled={!canApprove}
            // A plain integer in the figure's own unit. No decimal point, so nobody can enter
            // dollars where cents are wanted and have it quietly accepted.
            pattern="\d{1,15}"
            className={inputClass}
          />
        </div>

        <div>
          <label htmlFor={sourceId} className="text-xs text-slate-500 dark:text-slate-400">
            {RETIREMENT_COPY.reference.source}
          </label>
          <input
            id={sourceId}
            type="url"
            value={sourceUrl}
            onChange={(event) => setSourceUrl(event.target.value)}
            disabled={!canApprove}
            className={inputClass}
          />
          {/*
           * The link is the point of the screen: a figure with no checkable source can only be
           * believed, which is the thing being avoided. It opens in a new tab so a half-filled
           * form is not lost.
           */}
          <a
            href={figure.sourceUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-1 inline-block text-xs text-sky-600 underline dark:text-sky-400"
          >
            {RETIREMENT_COPY.reference.source}
          </a>
        </div>

        {canApprove && (
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={() => approve.mutate()}
              disabled={approve.isPending || value.trim() === ''}
              className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
            >
              {RETIREMENT_COPY.reference.approve}
            </button>
            {figure.verified && (
              <button
                type="button"
                onClick={() => revoke.mutate()}
                disabled={revoke.isPending}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs disabled:opacity-60 dark:border-slate-700"
              >
                {RETIREMENT_COPY.reference.revoke}
              </button>
            )}
          </div>
        )}

        {(approve.error ?? revoke.error) instanceof Error && (
          <p role="alert" className="text-xs text-red-700 dark:text-red-300">
            {((approve.error ?? revoke.error) as Error).message}
          </p>
        )}
      </div>
    </div>
  )
}

const inputClass =
  'mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900'
