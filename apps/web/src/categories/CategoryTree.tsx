import { CATEGORY_COPY } from '@beans/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import {
  createCategory,
  deleteCategory,
  listCategories,
  updateCategory,
  type Category,
  type CategoryKind,
} from './api.js'
import { cn } from '../lib/cn.js'
import { WORKING_SET_KEY } from '../working-set/use-working-set.js'

/**
 * The category tree, and everything you can do to it.
 *
 * **Two levels, and the shape is the constraint rather than a starting point.** A category with a
 * parent may not itself be a parent — enforced by a database trigger, by the repository, and by this
 * screen never offering a child as a parent. Arbitrary depth makes rollups ambiguous and is
 * unfixable once real data exists.
 *
 * Deleting asks where things go **before** doing it. "Deleted" quietly meaning "and uncategorized
 * four hundred transactions" is something a person finds a month later in a cash flow chart, at
 * which point they cannot tell what changed.
 */

type Editing =
  | { kind: 'none' }
  | { kind: 'add'; parentId: string | null }
  | { kind: 'rename'; category: Category }
  | { kind: 'delete'; category: Category }

export function CategoryTree({
  categories,
  onChanged,
}: {
  categories: readonly Category[]
  onChanged: () => Promise<void> | void
}): ReactNode {
  const [editing, setEditing] = useState<Editing>({ kind: 'none' })
  const [notice, setNotice] = useState<string | null>(null)

  const done = async (): Promise<void> => {
    setEditing({ kind: 'none' })
    await onChanged()
  }

  const parents = categories.filter((category) => category.parentId === null)

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {CATEGORY_COPY.categoriesNote}
        </p>
        <button
          type="button"
          onClick={() => setEditing({ kind: 'add', parentId: null })}
          className={cn(
            'inline-flex shrink-0 min-h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium',
            'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800',
            'focus-visible:outline-2 focus-visible:outline-sky-500',
          )}
        >
          <Plus className="size-3.5" aria-hidden />
          {CATEGORY_COPY.categoryAdd}
        </button>
      </div>

      {notice !== null && (
        <p
          role="status"
          className="mt-2 rounded-lg bg-emerald-50 p-2.5 text-xs text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
        >
          {notice}
        </p>
      )}

      {editing.kind === 'add' && editing.parentId === null && (
        <div className="mt-3">
          <CategoryForm categories={categories} parentId={null} onDone={done} onCancel={done} />
        </div>
      )}

      <ul className="mt-3 space-y-4">
        {parents.map((parent) => {
          const children = categories.filter((category) => category.parentId === parent.id)

          return (
            <li key={parent.id}>
              <div className="flex items-baseline justify-between gap-2">
                <p className="min-w-0 text-sm font-medium">
                  <span className="truncate">{parent.name}</span>
                  <span className="ml-2 text-xs font-normal text-slate-500 dark:text-slate-400">
                    {CATEGORY_COPY.kindLabel[parent.kind]}
                  </span>
                </p>
                <Actions
                  category={parent}
                  onAddChild={() => setEditing({ kind: 'add', parentId: parent.id })}
                  onRename={() => setEditing({ kind: 'rename', category: parent })}
                  onDelete={() => setEditing({ kind: 'delete', category: parent })}
                />
              </div>

              {editing.kind === 'rename' && editing.category.id === parent.id && (
                <div className="mt-2">
                  <CategoryForm
                    categories={categories}
                    category={parent}
                    parentId={null}
                    onDone={done}
                    onCancel={done}
                  />
                </div>
              )}

              {editing.kind === 'delete' && editing.category.id === parent.id && (
                <div className="mt-2">
                  <DeleteForm
                    category={parent}
                    categories={categories}
                    onDone={async (message) => {
                      setNotice(message)
                      await done()
                    }}
                    onCancel={done}
                  />
                </div>
              )}

              {editing.kind === 'add' && editing.parentId === parent.id && (
                <div className="mt-2">
                  <CategoryForm
                    categories={categories}
                    parentId={parent.id}
                    onDone={done}
                    onCancel={done}
                  />
                </div>
              )}

              {children.length > 0 && (
                <ul className="mt-1.5 space-y-1">
                  {children.map((child) => (
                    <li key={child.id}>
                      <div className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5 dark:bg-slate-900">
                        <span className="min-w-0 truncate text-xs">{child.name}</span>
                        <Actions
                          category={child}
                          onRename={() => setEditing({ kind: 'rename', category: child })}
                          onDelete={() => setEditing({ kind: 'delete', category: child })}
                        />
                      </div>

                      {editing.kind === 'rename' && editing.category.id === child.id && (
                        <div className="mt-2">
                          <CategoryForm
                            categories={categories}
                            category={child}
                            parentId={child.parentId}
                            onDone={done}
                            onCancel={done}
                          />
                        </div>
                      )}

                      {editing.kind === 'delete' && editing.category.id === child.id && (
                        <div className="mt-2">
                          <DeleteForm
                            category={child}
                            categories={categories}
                            onDone={async (message) => {
                              setNotice(message)
                              await done()
                            }}
                            onCancel={done}
                          />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ul>

      <p className="mt-3 text-[11px] text-slate-500 dark:text-slate-400">
        {CATEGORY_COPY.categorySystemNote}
      </p>
    </div>
  )
}

function Actions({
  category,
  onAddChild,
  onRename,
  onDelete,
}: {
  category: Category
  onAddChild?: () => void
  onRename: () => void
  onDelete: () => void
}): ReactNode {
  const button = cn(
    'rounded-lg border p-1.5',
    'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800',
    'focus-visible:outline-2 focus-visible:outline-sky-500',
  )

  return (
    <span className="flex shrink-0 gap-1">
      {onAddChild !== undefined && (
        <button
          type="button"
          onClick={onAddChild}
          aria-label={`${CATEGORY_COPY.categoryAddChild}: ${category.name}`}
          className={button}
        >
          <Plus className="size-3.5" aria-hidden />
        </button>
      )}
      <button
        type="button"
        onClick={onRename}
        aria-label={`${CATEGORY_COPY.categoryRename}: ${category.name}`}
        className={button}
      >
        <Pencil className="size-3.5" aria-hidden />
      </button>
      {/*
        A built-in has no delete control at all, rather than one that fails when pressed. The
        defaults are what rules and import presets reference by slug — a household that removed
        "Transfers" would break transfer exclusion entirely.
      */}
      {!category.isSystem && (
        <button
          type="button"
          onClick={onDelete}
          aria-label={`${CATEGORY_COPY.categoryDelete}: ${category.name}`}
          className={button}
        >
          <Trash2 className="size-3.5 text-rose-600 dark:text-rose-400" aria-hidden />
        </button>
      )}
    </span>
  )
}

function CategoryForm({
  categories,
  category,
  parentId,
  onDone,
  onCancel,
}: {
  categories: readonly Category[]
  /** Present when renaming. Absent when adding. */
  category?: Category
  parentId: string | null
  onDone: () => Promise<void> | void
  onCancel: () => void
}): ReactNode {
  const [name, setName] = useState(category?.name ?? '')

  /*
   * A child takes its parent's kind and is not asked. A "Groceries" expense under "Income" breaks
   * every rollup that sums by kind, and there is no reading of it that is useful.
   */
  const parent = categories.find((candidate) => candidate.id === parentId)
  const [kind, setKind] = useState<CategoryKind>(category?.kind ?? parent?.kind ?? 'expense')

  const save = useMutation({
    mutationFn: async () => {
      if (category !== undefined) {
        await updateCategory(category.id, { name })
        return
      }
      await createCategory({ name, kind: parent?.kind ?? kind, parentId })
    },
    onSuccess: onDone,
  })

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (name.trim() !== '') save.mutate()
      }}
      className="rounded-xl border border-slate-200 p-3 dark:border-slate-800"
    >
      <label className="block text-xs font-medium" htmlFor="category-name">
        {CATEGORY_COPY.categoryName}
      </label>
      <input
        id="category-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        autoFocus
        className={cn(
          'mt-1 w-full rounded-lg border px-3 py-2 text-sm',
          'border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900',
          'focus-visible:outline-2 focus-visible:outline-sky-500',
        )}
      />

      {/* Only a top-level category has a kind to choose; a child inherits its parent's. */}
      {category === undefined && parentId === null && (
        <>
          <label className="mt-3 block text-xs font-medium" htmlFor="category-kind">
            {CATEGORY_COPY.categoryKind}
          </label>
          <select
            id="category-kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as CategoryKind)}
            className={cn(
              'mt-1 w-full rounded-lg border px-3 py-2 text-sm',
              'border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900',
              'focus-visible:outline-2 focus-visible:outline-sky-500',
            )}
          >
            {(['expense', 'income', 'transfer'] as const).map((option) => (
              <option key={option} value={option}>
                {CATEGORY_COPY.kindLabel[option]}
              </option>
            ))}
          </select>
        </>
      )}

      {save.error instanceof Error && (
        <p role="alert" className="mt-2 text-xs text-rose-600 dark:text-rose-400">
          {save.error.message}
        </p>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="submit"
          disabled={name.trim() === '' || save.isPending}
          className={cn(
            'min-h-9 rounded-lg bg-sky-600 px-3 text-xs font-medium text-white',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500',
            'disabled:bg-slate-200 disabled:text-slate-400 dark:disabled:bg-slate-800',
          )}
        >
          {save.isPending ? CATEGORY_COPY.categorySaving : CATEGORY_COPY.categorySave}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className={cn(
            'min-h-9 rounded-lg border px-3 text-xs font-medium',
            'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800',
          )}
        >
          {CATEGORY_COPY.categoryCancel}
        </button>
      </div>
    </form>
  )
}

function DeleteForm({
  category,
  categories,
  onDone,
  onCancel,
}: {
  category: Category
  categories: readonly Category[]
  onDone: (message: string) => Promise<void> | void
  onCancel: () => void
}): ReactNode {
  const [reassignTo, setReassignTo] = useState<string>('')

  const remove = useMutation({
    mutationFn: () => deleteCategory(category.id, reassignTo === '' ? null : reassignTo),
    onSuccess: (result) =>
      onDone(CATEGORY_COPY.categoryDeleted(result.transactionsMoved, result.rulesMoved)),
  })

  return (
    <div className="rounded-xl border border-rose-300 p-3 dark:border-rose-900">
      <p className="text-sm font-medium">{CATEGORY_COPY.categoryDeleteTitle(category.name)}</p>

      <label className="mt-2 block text-xs" htmlFor="reassign-to">
        {CATEGORY_COPY.categoryDeletePrompt}
      </label>
      <select
        id="reassign-to"
        value={reassignTo}
        onChange={(event) => setReassignTo(event.target.value)}
        className={cn(
          'mt-1 w-full rounded-lg border px-3 py-2 text-sm',
          'border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900',
          'focus-visible:outline-2 focus-visible:outline-sky-500',
        )}
      >
        <option value="">{CATEGORY_COPY.categoryDeleteUncategorized}</option>
        {categories
          .filter((candidate) => candidate.id !== category.id)
          .map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
      </select>

      {remove.error instanceof Error && (
        <p role="alert" className="mt-2 text-xs text-rose-600 dark:text-rose-400">
          {remove.error.message}
        </p>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => remove.mutate()}
          disabled={remove.isPending}
          className={cn(
            'min-h-9 rounded-lg bg-rose-600 px-3 text-xs font-medium text-white',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500',
            'disabled:opacity-50',
          )}
        >
          {CATEGORY_COPY.categoryDelete}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className={cn(
            'min-h-9 rounded-lg border px-3 text-xs font-medium',
            'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800',
          )}
        >
          {CATEGORY_COPY.categoryCancel}
        </button>
      </div>
    </div>
  )
}

/**
 * The tree, fetching its own data.
 *
 * The tree component takes its categories as a prop because the settings page used to have them
 * already. As a destination of its own there is nothing above it holding them, so this is the
 * wrapper that makes it droppable anywhere.
 */
export function CategoriesPanel(): ReactNode {
  const queryClient = useQueryClient()
  const categories = useQuery({ queryKey: ['categories'], queryFn: listCategories })

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['categories'] })
    // Removing a category moves transactions, so the cached working set is stale.
    await queryClient.invalidateQueries({ queryKey: WORKING_SET_KEY })
  }

  return <CategoryTree categories={categories.data ?? []} onChanged={refresh} />
}
