import { CATEGORY_COPY } from '@beans/shared'
import * as Dialog from '@radix-ui/react-dialog'
import { useMutation } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { cn } from '../lib/cn.js'
import { assignCategory, createRule, type Category } from './api.js'

/**
 * Assigning a category, and offering to remember the decision.
 *
 * The offer is the point. Categorizing a few hundred transactions by hand is tedious once and
 * impossible to keep up with after every sync, so the moment somebody makes a decision is exactly
 * when to ask whether it should apply generally.
 */

export type CategorizableTransaction = {
  id: string
  payee: string | null
  description: string | null
  categoryId: string | null
}

export function CategorySheet({
  transaction,
  categories,
  onClose,
  onSaved,
}: {
  transaction: CategorizableTransaction
  categories: readonly Category[]
  onClose: () => void
  onSaved: () => Promise<void>
}): ReactNode {
  const [chosen, setChosen] = useState<string | null>(transaction.categoryId)
  const [alsoRule, setAlsoRule] = useState(false)

  /*
   * The text a rule would match on. Payee first because it is the merchant name at most institutions
   * and the description often carries a reference number that would never match twice.
   */
  const matchText = (transaction.payee ?? transaction.description ?? '').trim()

  const save = useMutation({
    mutationFn: async () => {
      await assignCategory(transaction.id, chosen)

      if (alsoRule && chosen !== null && matchText !== '') {
        await createRule({ matchDescription: matchText, matchType: 'contains', categoryId: chosen })
      }
    },
    onSuccess: onSaved,
  })

  const chosenName = categories.find((category) => category.id === chosen)?.name ?? ''

  // Parents first, each followed by its children, so the picker reads as the two-level tree it is.
  const grouped = categories
    .filter((category) => category.parentId === null)
    .map((parent) => ({
      parent,
      children: categories.filter((category) => category.parentId === parent.id),
    }))

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/40 backdrop-blur-sm" />
        <Dialog.Content
          className={cn(
            'fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-2xl',
            'border-t border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900',
            'text-slate-900 dark:text-slate-100',
            'sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-12 sm:w-96 sm:-translate-x-1/2 sm:rounded-2xl sm:border',
          )}
        >
          <div className="flex justify-center pt-3 sm:hidden" aria-hidden>
            <div className="h-1 w-10 rounded-full bg-slate-300 dark:bg-slate-700" />
          </div>

          <Dialog.Title className="px-5 pt-3 text-base font-semibold">
            {CATEGORY_COPY.assign}
          </Dialog.Title>
          <Dialog.Description className="truncate px-5 text-xs text-slate-500 dark:text-slate-400">
            {matchText || '—'}
          </Dialog.Description>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            <Option
              label={CATEGORY_COPY.uncategorized}
              selected={chosen === null}
              onSelect={() => setChosen(null)}
            />

            {grouped.map(({ parent, children }) => (
              <div key={parent.id} className="mt-2">
                <Option
                  label={parent.name}
                  selected={chosen === parent.id}
                  onSelect={() => setChosen(parent.id)}
                />
                {children.map((child) => (
                  <Option
                    key={child.id}
                    label={child.name}
                    indented
                    selected={chosen === child.id}
                    onSelect={() => setChosen(child.id)}
                  />
                ))}
              </div>
            ))}
          </div>

          <div className="border-t border-slate-200 p-5 dark:border-slate-800">
            {chosen !== null && matchText !== '' && (
              <label className="flex items-start gap-2 text-xs font-medium">
                <input
                  type="checkbox"
                  checked={alsoRule}
                  onChange={(event) => setAlsoRule(event.target.checked)}
                  className="mt-0.5 size-4 shrink-0 accent-sky-600"
                />
                <span>
                  {CATEGORY_COPY.ruleFrom}
                  <span className="mt-0.5 block font-normal text-slate-500 dark:text-slate-400">
                    {CATEGORY_COPY.rulePrompt(matchText, chosenName)} {CATEGORY_COPY.ruleScope}
                  </span>
                </span>
              </label>
            )}

            <p role="alert" className="mt-2 min-h-4 text-xs text-rose-600 dark:text-rose-400">
              {save.error instanceof Error ? save.error.message : null}
            </p>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={onClose}
                className="min-h-12 flex-1 rounded-xl border border-slate-300 text-sm font-semibold hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => save.mutate()}
                disabled={save.isPending}
                className={cn(
                  'min-h-12 flex-1 rounded-xl text-sm font-semibold',
                  'bg-sky-600 text-white hover:bg-sky-500 disabled:opacity-50',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500',
                )}
              >
                {save.isPending ? CATEGORY_COPY.ruleCreating : 'Save'}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Option({
  label,
  selected,
  indented,
  onSelect,
}: {
  label: string
  selected: boolean
  indented?: boolean
  onSelect: () => void
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex min-h-11 w-full items-center rounded-lg px-3 text-left text-sm',
        'hover:bg-slate-100 dark:hover:bg-slate-800',
        'focus-visible:outline-2 focus-visible:outline-sky-500',
        indented === true && 'pl-7 text-slate-600 dark:text-slate-300',
        selected && 'bg-sky-50 font-semibold text-sky-800 dark:bg-sky-950 dark:text-sky-200',
      )}
    >
      {label}
    </button>
  )
}
