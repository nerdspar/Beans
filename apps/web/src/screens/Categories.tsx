import { CATEGORY_COPY } from '@beans/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
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
import { WORKING_SET_KEY } from '../working-set/use-working-set.js'

/**
 * Categories, and the rules that assign them.
 *
 * The rules half is the point. Creating one from the transactions screen was possible before this
 * existed, which meant a household could accumulate automation it had no way to see, reorder or
 * undo — worse than having none, because the effects are real and the cause is invisible.
 */

type Editing = { kind: 'none' } | { kind: 'new' } | { kind: 'edit'; rule: Rule }

export function Categories(): ReactNode {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<Editing>({ kind: 'none' })

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

      {editing.kind !== 'none' && (
        <div className="mt-3">
          <RuleBuilder
            categories={categories.data ?? []}
            {...(editing.kind === 'edit' ? { rule: editing.rule } : {})}
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
