import { CATEGORY_COPY, formatCents, suggestRules } from '@beans/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import {
  applyRules,
  createRule,
  deleteRule,
  listCategories,
  listRules,
  updateRule,
  type Rule,
  type RuleInput,
} from '../categories/api.js'
import { CategoryTree } from '../categories/CategoryTree.js'
import { RuleBuilder } from '../categories/RuleBuilder.js'
import { cn } from '../lib/cn.js'
import { WORKING_SET_KEY, useWorkingSet } from '../working-set/use-working-set.js'

/**
 * Categories, and the rules that assign them.
 *
 * The rules half is the point. Creating one from the transactions screen was possible before this
 * existed, which meant a household could accumulate automation it had no way to see, reorder or
 * undo — worse than having none, because the effects are real and the cause is invisible.
 */

type Editing =
  | { kind: 'none' }
  /** `seed` pre-fills the builder from a suggestion, so it is approved rather than retyped. */
  | { kind: 'new'; seed?: { keywords: string[]; categoryId: string | null } }
  | { kind: 'edit'; rule: Rule }

/** Enough to be worth working through in one sitting. Past this it reads as a backlog. */
const SUGGESTION_LIMIT = 12

export function Categories(): ReactNode {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<Editing>({ kind: 'none' })

  const workingSet = useWorkingSet()
  const categories = useQuery({ queryKey: ['categories'], queryFn: listCategories })
  const rules = useQuery({ queryKey: ['rules'], queryFn: listRules })

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['rules'] })
    // Categorizing changes transactions, so the working set has to be re-read.
    await queryClient.invalidateQueries({ queryKey: ['working-set', 'sync'] })
    await queryClient.invalidateQueries({ queryKey: WORKING_SET_KEY })
  }

  const remove = useMutation({ mutationFn: deleteRule, onSuccess: refresh })
  const apply = useMutation({ mutationFn: applyRules, onSuccess: refresh })

  /*
   * Saving a rule applies it immediately, to uncategorized transactions only — a rule never
   * overwrites an answer somebody gave by hand.
   */
  const save = useMutation({
    mutationFn: (input: RuleInput) =>
      editing.kind === 'edit' ? updateRule(editing.rule.id, input) : createRule(input),
    onSuccess: async () => {
      setEditing({ kind: 'none' })
      await refresh()
    },
  })

  /*
   * Merchants worth a rule, from this household's own transactions.
   *
   * Computed here rather than fetched: the working set already holds every transaction, so a round
   * trip would buy nothing and this stays correct the moment a sync lands.
   *
   * Suggestions a rule already covers disappear on their own — a covered transaction gets a
   * category, and only uncategorized ones are counted.
   */
  const suggestions = useMemo(
    () =>
      suggestRules(
        workingSet.transactions
          .filter((transaction) => transaction.status !== 'void')
          .map((transaction) => ({
            payee: transaction.payee,
            description: transaction.description,
            amountCents: transaction.amountCents,
            categoryId: transaction.categoryId,
          })),
      ).slice(0, SUGGESTION_LIMIT),
    [workingSet.transactions],
  )

  const refreshCategories = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['categories'] })
    // Removing a category moves transactions, so the cached working set is stale.
    await queryClient.invalidateQueries({ queryKey: WORKING_SET_KEY })
  }

  return (
    <div>

      <div className="mt-2 flex items-baseline justify-between gap-3">
        <p className="text-xs text-slate-500 dark:text-slate-400">{CATEGORY_COPY.ruleScope}</p>
        <div className="flex shrink-0 gap-2">
        <button
          type="button"
          onClick={() => setEditing(editing.kind === 'new' ? { kind: 'none' } : { kind: 'new' })}
          className={cn(
            'inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium',
            'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800',
            'focus-visible:outline-2 focus-visible:outline-sky-500',
          )}
        >
          <Plus className="size-3.5" aria-hidden />
          {CATEGORY_COPY.ruleAdd}
        </button>
        <button
          type="button"
          onClick={() => apply.mutate()}
          disabled={apply.isPending || (rules.data ?? []).length === 0}
          className={cn(
            'inline-flex shrink-0 min-h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium',
            'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800',
            'focus-visible:outline-2 focus-visible:outline-sky-500 disabled:opacity-50',
          )}
        >
          <RefreshCw className={cn('size-3.5', apply.isPending && 'animate-spin')} aria-hidden />
          {CATEGORY_COPY.ruleApply}
        </button>
        </div>
      </div>

      {/*
        The long tail, as a short list.
        
        Four hundred uncategorized transactions are usually twenty merchants. Categorizing them one
        at a time is what nobody does; this is the same work as a handful of decisions.
        
        Each one opens the builder pre-filled rather than creating a rule outright — the keyword is
        a guess at where the merchant name ends, and it is far easier to approve than to undo.
      */}
      {editing.kind === 'none' && suggestions.length > 0 && (
        <div className="mt-4">
          <h2 className="text-sm font-semibold">{CATEGORY_COPY.suggestionsHeading}</h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {CATEGORY_COPY.suggestionsNote}
          </p>

          <ul className="mt-2 space-y-1.5">
            {suggestions.map((suggestion) => (
              <li key={suggestion.keyword}>
                <button
                  type="button"
                  onClick={() =>
                    setEditing({
                      kind: 'new',
                      seed: {
                        keywords: [suggestion.keyword],
                        categoryId: suggestion.categoryId,
                      },
                    })
                  }
                  className={cn(
                    'flex w-full items-center justify-between gap-3 rounded-xl border p-3 text-left',
                    'border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-900',
                    'focus-visible:outline-2 focus-visible:outline-sky-500',
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {suggestion.keyword}
                    </span>
                    <span className="block text-xs text-slate-500 dark:text-slate-400">
                      {CATEGORY_COPY.suggestionDetail(
                        suggestion.count,
                        categories.data?.find((one) => one.id === suggestion.categoryId)?.name ??
                          null,
                      )}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm tabular-nums text-slate-500 dark:text-slate-400">
                    {formatCents(suggestion.totalCents)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {editing.kind !== 'none' && (
        <div className="mt-3">
          <RuleBuilder
            categories={categories.data ?? []}
            {...(editing.kind === 'edit' ? { rule: editing.rule } : {})}
            {...(editing.kind === 'new' && editing.seed !== undefined
              ? { seed: editing.seed }
              : {})}
            isPending={save.isPending}
            error={save.error instanceof Error ? save.error.message : null}
            onSubmit={(input) => save.mutate(input)}
            onCancel={() => setEditing({ kind: 'none' })}
          />
        </div>
      )}

      {/* Reported, because "nothing happened" and "nothing matched" look identical otherwise. */}
      {apply.data !== undefined && (
        <p
          role="status"
          className="mt-2 rounded-lg bg-emerald-50 p-2.5 text-xs text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
        >
          {CATEGORY_COPY.ruleCreated(apply.data.categorized)}
        </p>
      )}

      {(remove.error instanceof Error || apply.error instanceof Error) && (
        <p role="alert" className="mt-2 text-xs text-rose-600 dark:text-rose-400">
          {(remove.error instanceof Error ? remove.error : (apply.error as Error)).message}
        </p>
      )}

      {(rules.data ?? []).length === 0 ? (
        <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
          {CATEGORY_COPY.rulesEmpty}
        </p>
      ) : (
        <>
          <ol className="mt-4 space-y-2">
            {(rules.data ?? []).map((rule, index) => (
              <li key={rule.id}>
                <RuleRow
                  rule={rule}
                  order={index + 1}
                  isPending={remove.isPending}
                  onEdit={() => setEditing({ kind: 'edit', rule })}
                  onDelete={() => remove.mutate(rule.id)}
                />
              </li>
            ))}
          </ol>

          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            {CATEGORY_COPY.ruleDeleteNote}
          </p>
        </>
      )}

      <h2 className="mt-8 text-sm font-semibold">{CATEGORY_COPY.categoriesHeading}</h2>
      <div className="mt-2">
        <CategoryTree categories={categories.data ?? []} onChanged={refreshCategories} />
      </div>
    </div>
  )
}

function RuleRow({
  rule,
  order,
  isPending,
  onEdit,
  onDelete,
}: {
  rule: Rule
  order: number
  isPending: boolean
  onEdit: () => void
  onDelete: () => void
}): ReactNode {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
      <div className="min-w-0">
        <p className="truncate text-sm">
          {/*
            The order is shown because it decides outcomes: the first matching rule wins, so which
            one is third rather than first is the difference between two categories.
          */}
          <span className="mr-2 text-xs text-slate-400 tabular-nums">{order}</span>
          <span className="font-medium">{describeKeywords(rule)}</span>
          <span className="text-slate-500 dark:text-slate-400"> → {rule.categoryName}</span>
        </p>
        {rule.matchType === 'regex' && (
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {CATEGORY_COPY.ruleRegex}
          </p>
        )}
      </div>

      <span className="flex shrink-0 gap-1">
      <button
        type="button"
        onClick={onEdit}
        aria-label={`${CATEGORY_COPY.ruleEditAction}: ${describeKeywords(rule)}`}
        className={cn(
          'rounded-lg border p-2',
          'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800',
          'focus-visible:outline-2 focus-visible:outline-sky-500',
        )}
      >
        <Pencil className="size-4" aria-hidden />
      </button>

      <button
        type="button"
        onClick={onDelete}
        disabled={isPending}
        aria-label={`${CATEGORY_COPY.ruleDelete}: ${describeKeywords(rule)}`}
        className={cn(
          'shrink-0 rounded-lg border p-2',
          'border-slate-300 hover:bg-rose-50 dark:border-slate-700 dark:hover:bg-rose-950/40',
          'focus-visible:outline-2 focus-visible:outline-rose-600 disabled:opacity-50',
        )}
      >
        <Trash2 className="size-4 text-rose-600 dark:text-rose-400" aria-hidden />
      </button>
      </span>
    </div>
  )
}

/**
 * A rule's terms, as one readable line.
 *
 * The joiner is the rule's own mode spelled out, because "and" versus "or" is the whole difference
 * between a rule that fires on everything from a merchant and one that almost never fires.
 */
function describeKeywords(rule: Rule): string {
  if (rule.keywords.length === 0) return '—'
  return rule.keywords.join(rule.keywordMode === 'all' ? ' and ' : ' or ')
}
