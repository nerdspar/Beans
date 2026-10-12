import { RETIREMENT_COPY } from '@beans/shared'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode } from 'react'
import { Link } from 'wouter'
import { getReference } from './api.js'

/**
 * The unapproved-reference-data warning.
 *
 * **The only red banner in Beans**, and it is worth saying why it earns an exception. Everywhere
 * else a caveat is a quiet note, because what is being caveated is an assumption the reader can
 * see and argue with — a return rate, a spending baseline. This is different in kind: a
 * contribution limit is not an assumption, it is a fact with a right answer, published, that
 * somebody could act on and be wrong about by law.
 *
 * It disappears entirely once every figure for the year is approved. A banner that is always there
 * is furniture, and furniture is not a warning.
 */
export const REFERENCE_KEY = ['retirement', 'reference'] as const

export function ReferenceBanner(): ReactNode {
  const reference = useQuery({ queryKey: REFERENCE_KEY, queryFn: () => getReference() })

  // Silent while loading and silent on error. A banner that flashes on every page load is noise,
  // and one that appears because a request failed is a lie about the data.
  if (reference.data === undefined || reference.data.ready) return null

  const pending = reference.data.figures.filter((figure) => !figure.verified).length

  return (
    <section
      /*
       * `alert` rather than `status`: this is not a passive update, it is a condition the reader
       * needs to know about before they trust anything derived from tax law on this screen.
       */
      role="alert"
      className="mt-4 rounded-xl border border-red-300 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/40"
    >
      <h2 className="text-sm font-semibold text-red-900 dark:text-red-200">
        {RETIREMENT_COPY.reference.title}
      </h2>
      <p className="mt-1 text-xs text-red-900/90 dark:text-red-200/90">
        {RETIREMENT_COPY.reference.body}
      </p>
      <p className="mt-2 text-xs font-medium text-red-900 dark:text-red-200 tabular-nums">
        {RETIREMENT_COPY.reference.pending(pending)}
      </p>
      <Link
        href="/retirement/reference"
        className="mt-3 inline-block rounded-lg border border-red-400 px-3 py-1.5 text-xs font-medium text-red-900 dark:border-red-800 dark:text-red-200"
      >
        {RETIREMENT_COPY.reference.action}
      </Link>
    </section>
  )
}
