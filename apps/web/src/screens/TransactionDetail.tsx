import { CATEGORY_COPY, TRANSACTIONS_COPY, formatCents } from '@beans/shared'
import { useQueryClient } from '@tanstack/react-query'
import { ChevronLeft } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'wouter'
import { CategorySheet } from '../categories/CategorySheet.js'
import { useBackTarget, withReturn } from '../lib/back.js'
import { cn } from '../lib/cn.js'
import { formatShortDate } from '../net-worth/display.js'
import { WORKING_SET_KEY, useWorkingSet } from '../working-set/use-working-set.js'

/**
 * One transaction, in full.
 *
 * **The description is the reason this screen exists.** Lists truncate to a line, and the payee is
 * usually the readable half — but the description is where the institution puts the reference code
 * that actually identifies a charge. When a name is ambiguous, that string is the answer, and until
 * now the only way to read it was to log into the bank.
 *
 * So nothing here truncates. A forty-character reference wraps rather than ending in an ellipsis,
 * because half of one is no more use than none.
 */

export function TransactionDetail({ params }: { params: { id: string } }): ReactNode {
  const workingSet = useWorkingSet()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)

  const back = useBackTarget({
    href: '/transactions',
    label: TRANSACTIONS_COPY.title,
  })

  const transaction = workingSet.transactions.find((candidate) => candidate.id === params.id)

  if (workingSet.isLoading) {
    return <p className="p-6 text-sm text-slate-500">{TRANSACTIONS_COPY.loading}</p>
  }

  if (transaction === undefined) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <p className="text-sm font-medium">{TRANSACTIONS_COPY.notFound}</p>
        <Link href="/transactions" className="mt-2 inline-block text-sm text-sky-600">
          {TRANSACTIONS_COPY.title}
        </Link>
      </div>
    )
  }

  const account = workingSet.data?.byId.get(transaction.accountId)
  const category =
    transaction.categoryId === null
      ? null
      : (workingSet.categories.get(transaction.categoryId)?.name ?? null)

  const incoming = transaction.amountCents > 0n
  const voided = transaction.status === 'void'

  const afterSave = async (): Promise<void> => {
    setEditing(false)
    await queryClient.invalidateQueries({ queryKey: WORKING_SET_KEY })
    await queryClient.invalidateQueries({ queryKey: ['working-set', 'sync'] })
  }

  return (
    <div className="mx-auto max-w-2xl pb-16">
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
        {/* Wraps rather than truncating — see the note above. */}
        <h1 className="break-words text-xl font-semibold">
          {transaction.payee ?? transaction.description ?? '—'}
        </h1>

        <p
          className={cn(
            'mt-1 text-3xl font-semibold tabular-nums',
            voided
              ? 'text-slate-400 line-through dark:text-slate-500'
              : incoming
                ? 'text-emerald-600 dark:text-emerald-400'
                : '',
          )}
        >
          {formatCents(transaction.amountCents)}
        </p>

        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {formatShortDate(transaction.postedDate)}
          {transaction.pending && ` · ${TRANSACTIONS_COPY.pending}`}
          {voided && ` · ${TRANSACTIONS_COPY.voided}`}
        </p>
      </div>

      <dl className="mt-6 divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-800 dark:border-slate-800">
        <Field label={TRANSACTIONS_COPY.detailAccount}>
          {account === undefined ? (
            '—'
          ) : (
            <Link
              href={withReturn(`/accounts/${account.id}`, {
                href: `/transactions/${transaction.id}`,
                label: transaction.payee ?? TRANSACTIONS_COPY.title,
              })}
              className="text-sky-700 hover:underline dark:text-sky-400"
            >
              {account.name}
            </Link>
          )}
        </Field>

        {/*
          The raw string, whole and unstyled-for-reading.

          Shown even when it duplicates the payee: a reader checking an ambiguous charge needs to
          know whether the institution sent one string or two, and hiding the duplicate would leave
          them wondering whether it was withheld or absent.
        */}
        <Field label={TRANSACTIONS_COPY.detailDescription}>
          <span className="break-words font-mono text-xs">
            {transaction.description ?? '—'}
          </span>
        </Field>

        <Field label={CATEGORY_COPY.assign}>
          <span className={category === null ? 'text-slate-400 dark:text-slate-500' : ''}>
            {category ?? CATEGORY_COPY.uncategorized}
          </span>
        </Field>
      </dl>

      <div className="px-5 pt-5">
        {/*
          One control, not two.

          The sheet already offers "always categorize like this", which is the rule-making path —
          a separate "add rule" button here would be a second route to the same place, and rules
          made away from a transaction are the ones with nothing to check them against.
        */}
        <button
          type="button"
          onClick={() => setEditing(true)}
          className={cn(
            'min-h-11 w-full rounded-xl bg-sky-600 text-sm font-semibold text-white',
            'hover:bg-sky-500 focus-visible:outline-2 focus-visible:outline-offset-2',
            'focus-visible:outline-sky-500',
          )}
        >
          {TRANSACTIONS_COPY.detailCategorize}
        </button>
      </div>

      {editing && (
        <CategorySheet
          transaction={transaction}
          categories={[...workingSet.categories.values()].map((category) => ({
            id: category.id,
            slug: category.slug,
            name: category.name,
            kind: category.kind,
            parentId: category.parentId,
            isSystem: false,
          }))}
          onClose={() => setEditing(false)}
          onSaved={afterSave}
        />
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex items-baseline justify-between gap-4 px-5 py-3">
      <dt className="shrink-0 text-xs text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="min-w-0 text-right text-sm">{children}</dd>
    </div>
  )
}
