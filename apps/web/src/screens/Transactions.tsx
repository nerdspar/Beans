import {
  CATEGORY_COPY,
  NET_WORTH_STATE_COPY,
  TRANSACTIONS_COPY,
  compareDates,
  formatCents,
  resolveWindow,
  sliceToWindow,
  toIsoDate,
} from '@beans/shared'
import { Search } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useDeferredValue, useMemo, useState, type ReactNode } from 'react'
import { CategorySheet } from '../categories/CategorySheet.js'
import { listCategories } from '../categories/api.js'
import { cn } from '../lib/cn.js'
import { RangeControl } from '../net-worth/RangeControl.js'
import { DEFAULT_RANGE, type RangeSelection } from '../net-worth/range.js'
import { WORKING_SET_KEY, useWorkingSet } from '../working-set/use-working-set.js'

/**
 * Everything that happened, filtered locally.
 *
 * **No request is made when the search box changes.** Every transaction is already in IndexedDB, so
 * searching and filtering are a pass over an array — which is the entire reason the working set
 * exists (ARCHITECTURE.md §7): descriptions and amounts are ciphertext in Postgres and cannot be
 * searched there at all, so the work has to happen wherever the plaintext is.
 */

export function Transactions(): ReactNode {
  const workingSet = useWorkingSet()
  const queryClient = useQueryClient()

  /*
   * Read from the API rather than the working set, because this list also needs `isSystem` and the
   * full parent/child shape to build a grouped picker. The working set carries the flat subset the
   * rest of the app needs to *name* a category.
   */
  const categories = useQuery({ queryKey: ['categories'], queryFn: listCategories })
  const [editing, setEditing] = useState<Entry | null>(null)

  const [range, setRange] = useState<RangeSelection>(DEFAULT_RANGE)
  const [accountId, setAccountId] = useState<string>('')
  const [query, setQuery] = useState('')

  /*
   * Deferred so typing stays responsive on a large set. The list re-filters at React's convenience
   * rather than on every keystroke, and the input itself never lags behind the keyboard.
   */
  const deferredQuery = useDeferredValue(query)

  const accounts = workingSet.data?.byId
  const today = toIsoDate(new Date())

  const { visible, total } = useMemo(() => {
    const window = resolveWindow(range, today)
    const inWindow = sliceToWindow(
      workingSet.transactions.map((transaction) => ({ ...transaction, date: transaction.postedDate })),
      window,
    )

    const needle = deferredQuery.trim().toLowerCase()

    const matched = inWindow.filter((transaction) => {
      if (accountId !== '' && transaction.accountId !== accountId) return false
      if (needle === '') return true

      /*
       * Amount is searchable as well as text. "43.20" is how people look for a specific charge they
       * half-remember, and it is the one field they can be certain of.
       */
      const haystack = [
        transaction.payee ?? '',
        transaction.description ?? '',
        formatCents(transaction.amountCents),
      ]
        .join(' ')
        .toLowerCase()

      return haystack.includes(needle)
    })

    // Newest first, with a stable tiebreaker so same-day rows do not shuffle between renders.
    matched.sort(
      (left, right) =>
        compareDates(right.postedDate, left.postedDate) || left.id.localeCompare(right.id),
    )

    return { visible: matched, total: inWindow.length }
  }, [workingSet.transactions, range, today, accountId, deferredQuery])

  if (workingSet.isLoading) {
    return <Message title={TRANSACTIONS_COPY.loading} />
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

  const byDate = groupByDate(visible)

  return (
    <div className="mx-auto max-w-2xl pb-16">
      <div className="sticky top-0 z-10 bg-slate-50/95 px-5 pb-3 pt-5 backdrop-blur dark:bg-slate-950/95">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-2xl font-semibold">{TRANSACTIONS_COPY.title}</h1>
          <RangeControl value={range} onChange={setRange} />
        </div>

        <label className="relative mt-3 block">
          <span className="sr-only">{TRANSACTIONS_COPY.search}</span>
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400"
            aria-hidden
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={TRANSACTIONS_COPY.searchPlaceholder}
            className={cn(
              'min-h-11 w-full rounded-lg border pl-9 pr-3 text-base',
              'border-slate-300 bg-white text-slate-900',
              'dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100',
              'focus-visible:outline-2 focus-visible:outline-sky-500',
            )}
          />
        </label>

        <div className="mt-2 flex items-center justify-between gap-3">
          <select
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            className={cn(
              'min-h-9 max-w-[60%] rounded-lg border px-2 text-sm',
              'border-slate-300 bg-white text-slate-900',
              'dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100',
            )}
          >
            <option value="">{TRANSACTIONS_COPY.allAccounts}</option>
            {[...(accounts?.values() ?? [])].map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>

          {/* So a filtered list is never mistaken for the whole of it. */}
          <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
            {TRANSACTIONS_COPY.showing(visible.length, total)}
          </span>
        </div>
      </div>

      {visible.length === 0 ? (
        <Message
          title={total === 0 ? TRANSACTIONS_COPY.empty : TRANSACTIONS_COPY.noMatches}
          detail={total === 0 ? TRANSACTIONS_COPY.emptyDetail : TRANSACTIONS_COPY.noMatchesDetail}
        />
      ) : (
        byDate.map(([date, group]) => (
          <section key={date}>
            <h2 className="sticky top-[9.5rem] z-[5] bg-slate-100 px-5 py-1.5 text-xs font-semibold text-slate-600 dark:bg-slate-900 dark:text-slate-300">
              {formatDate(date)}
            </h2>
            <ul>
              {group.map((transaction) => (
                <Row
                  key={transaction.id}
                  transaction={transaction}
                  accountName={accounts?.get(transaction.accountId)?.name ?? ''}
                  categoryName={
                    transaction.categoryId === null
                      ? null
                      : (workingSet.categories.get(transaction.categoryId)?.name ?? null)
                  }
                  onEdit={() => setEditing(transaction)}
                />
              ))}
            </ul>
          </section>
        ))
      )}

      {editing !== null && (
        <CategorySheet
          transaction={editing}
          categories={categories.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null)
            // The category lives on the transaction, so the working set has to be re-read.
            await queryClient.invalidateQueries({ queryKey: ['working-set', 'sync'] })
            await queryClient.invalidateQueries({ queryKey: WORKING_SET_KEY })
          }}
        />
      )}
    </div>
  )
}

export type Entry = {
  id: string
  accountId: string
  postedDate: string
  amountCents: bigint
  description: string | null
  payee: string | null
  categoryId: string | null
  pending: boolean
  status: 'active' | 'void'
}

function groupByDate(entries: readonly Entry[]): Array<[string, Entry[]]> {
  const groups = new Map<string, Entry[]>()
  for (const entry of entries) {
    groups.set(entry.postedDate, [...(groups.get(entry.postedDate) ?? []), entry])
  }
  return [...groups.entries()]
}

const DATE_HEADING = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  // UTC for the same reason as everywhere else a YYYY-MM-DD meets Date.
  timeZone: 'UTC',
})

function formatDate(date: string): string {
  return DATE_HEADING.format(new Date(`${date}T00:00:00Z`))
}

function Row({
  transaction,
  accountName,
  categoryName,
  onEdit,
}: {
  transaction: Entry
  accountName: string
  categoryName: string | null
  onEdit: () => void
}): ReactNode {
  const voided = transaction.status === 'void'

  /*
   * Money in is green; money out is left plain.
   *
   * Colouring every outgoing amount red would paint an ordinary week of groceries as a page of
   * errors — spending is not a problem, it is the point of a current account. Green marks the rarer
   * thing, which is what makes it informative.
   */
  const incoming = transaction.amountCents > 0n

  return (
    <li
      className={cn(
        'flex items-center justify-between gap-3 border-b px-5 py-3',
        'border-slate-200 dark:border-slate-800',
        voided && 'opacity-60',
      )}
    >
      <button
        type="button"
        onClick={onEdit}
        className="min-w-0 flex-1 text-left focus-visible:outline-2 focus-visible:outline-sky-500"
      >
        <p className={cn('truncate text-sm font-medium', voided && 'line-through')}>
          {transaction.payee ?? transaction.description ?? '—'}
        </p>
        <p className="truncate text-xs text-slate-500 dark:text-slate-400">
          {accountName}
          {transaction.pending && ` · ${TRANSACTIONS_COPY.pending}`}
          {voided && ` · ${TRANSACTIONS_COPY.voided}`}
        </p>
        {/* Uncategorized is stated rather than left blank: blank reads as "nothing to say here". */}
        <p
          className={cn(
            'mt-0.5 truncate text-xs',
            categoryName === null
              ? 'text-slate-400 dark:text-slate-500'
              : 'text-sky-700 dark:text-sky-400',
          )}
        >
          {categoryName ?? CATEGORY_COPY.uncategorized}
        </p>
      </button>

      <span
        className={cn(
          'shrink-0 text-sm font-medium tabular-nums',
          incoming && 'text-emerald-600 dark:text-emerald-400',
        )}
      >
        {formatCents(transaction.amountCents, { signDisplay: incoming ? 'exceptZero' : 'auto' })}
      </span>
    </li>
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
