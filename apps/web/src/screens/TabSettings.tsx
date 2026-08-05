import {
  CATEGORY_COPY,
  HISTORY_SETTING_COPY,
  HOUSEHOLD_COPY,
  IMPORT_COPY,
  SETTINGS_COPY,
} from '@beans/shared'
import { ChevronDown, ChevronRight, ChevronUp, Plus, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { cn } from '../lib/cn.js'
import { usePreferences } from '../preferences/use-preferences.js'
import { CategoryTree } from '../categories/CategoryTree.js'
import { RulesPanel } from '../categories/RulesPanel.js'
import { Household } from './Household.js'
import { Import } from './Import.js'
import { listCategories, listRules } from '../categories/api.js'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { WORKING_SET_KEY } from '../working-set/use-working-set.js'
import { TAB_SLOTS, tabbableDestinations } from '../navigation/destinations.js'
import { useTabOrder } from '../navigation/use-tab-order.js'

/**
 * Everything you can change, grouped by what kind of thing it is.
 *
 * ## Why it is grouped rather than listed
 *
 * This page grew by accretion: three collapsible sections, then two bare ones bolted underneath as
 * they were needed. **Two visual grammars on one page**, which is exactly why the bare two read as
 * homeless — they were not missing a home, they were the only things not in one.
 *
 * So everything is a row inside a labelled group now, and the groups are by *kind* rather than by
 * which screen a thing came from:
 *
 * - **Display** — changes what the app looks like. Cheap, reversible, no data touched.
 * - **Categorizing** — the taxonomy, and the automation over it. Two jobs on different schedules,
 *   which is why they are two rows: a category tree is edited a few times a year, rules whenever a
 *   statement throws up a merchant nobody has seen.
 * - **Household** — people, and getting data in.
 *
 * A boolean toggles in place; anything with an editor behind it expands. Making a checkbox take a
 * click to reveal would be consistent and worse.
 *
 * ## The tab reorder, which lives here
 *
 * **Up/down buttons rather than drag and drop.** With four items the reorder is two taps at most,
 * and a drag inside a scrolling settings page fights the scroll — on touch especially, where the
 * gesture is ambiguous until it has already gone wrong. Drag would be the flashier choice and the
 * worse one here.
 */
export function TabSettings(): ReactNode {
  const { tabs, setTabOrder, resetTabOrder, isSaving } = useTabOrder()
  const { preferences, patch } = usePreferences()
  const queryClient = useQueryClient()

  /*
   * Counts for the closed rows.
   *
   * A row that says only "Categories" makes you open it to learn anything, and these are cheap —
   * both lists are already cached by the panels behind them, so this shares a query rather than
   * adding one.
   */
  const categories = useQuery({ queryKey: ['categories'], queryFn: listCategories })
  const rules = useQuery({ queryKey: ['rules'], queryFn: listRules })

  const refreshCategories = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['categories'] })
    // Removing a category moves transactions, so the cached working set is stale.
    await queryClient.invalidateQueries({ queryKey: WORKING_SET_KEY })
  }

  const chosen = tabs
  const chosenKeys = chosen.map((tab) => tab.key)
  const available = tabbableDestinations().filter(
    (destination) => !chosenKeys.includes(destination.key),
  )
  const isFull = chosen.length >= TAB_SLOTS

  const move = (index: number, direction: -1 | 1): void => {
    const target = index + direction
    if (target < 0 || target >= chosenKeys.length) return

    const next = [...chosenKeys]
    const a = next[index]
    const b = next[target]
    if (a === undefined || b === undefined) return
    next[index] = b
    next[target] = a
    setTabOrder(next)
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-xl font-semibold tracking-tight">{SETTINGS_COPY.title}</h1>

      <Group title={SETTINGS_COPY.displayGroup}>
        <ExpandableRow title={SETTINGS_COPY.tabsTitle} summary={SETTINGS_COPY.tabsSummary}>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {SETTINGS_COPY.tabsHelp(TAB_SLOTS)}
          </p>
        <ol className="mt-4 space-y-2">
          {chosen.map((destination, index) => {
            const Icon = destination.icon
            return (
              <li
                key={destination.key}
                className={cn(
                  'flex items-center gap-3 rounded-xl border px-3 py-2',
                  'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900',
                )}
              >
                <Icon className="size-5 text-slate-500 dark:text-slate-400" aria-hidden />
                <span className="flex-1 text-sm font-medium">{destination.label}</span>

                <IconButton
                  label={`Move ${destination.label} up`}
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                >
                  <ChevronUp className="size-4" aria-hidden />
                </IconButton>

                <IconButton
                  label={`Move ${destination.label} down`}
                  onClick={() => move(index, 1)}
                  disabled={index === chosen.length - 1}
                >
                  <ChevronDown className="size-4" aria-hidden />
                </IconButton>

                <IconButton
                  label={`Remove ${destination.label}`}
                  onClick={() => setTabOrder(chosenKeys.filter((key) => key !== destination.key))}
                  // The bar must keep at least one tab; an empty one is not a state worth allowing.
                  disabled={chosen.length <= 1}
                >
                  <X className="size-4" aria-hidden />
                </IconButton>
              </li>
            )
          })}
        </ol>

        {available.length > 0 && (
          <>
            {/*
              The heading answers whichever question the user actually has. With room left it is
              "what can I add?"; when full it is "where did the rest go?" — the same list, relabelled,
              rather than a greyed-out control that answers neither.
            */}
            <h3 className="mt-6 text-sm font-medium text-slate-600 dark:text-slate-300">
              {isFull ? 'In the More menu' : 'Add a tab'}
            </h3>
            {isFull && (
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Remove one above to add another.
              </p>
            )}

            <ul className="mt-2 space-y-2">
              {available.map((destination) => {
                const Icon = destination.icon
                return (
                  <li key={destination.key}>
                    <button
                      type="button"
                      disabled={isFull}
                      onClick={() => setTabOrder([...chosenKeys, destination.key])}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left',
                        'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900',
                        'focus-visible:outline-2 focus-visible:outline-sky-500',
                        isFull ? 'opacity-60' : 'hover:border-sky-300 dark:hover:border-sky-700',
                      )}
                    >
                      <Icon className="size-5 text-slate-500 dark:text-slate-400" aria-hidden />
                      <span className="flex-1 text-sm font-medium">{destination.label}</span>
                      {!isFull && <Plus className="size-4 text-slate-400" aria-hidden />}
                    </button>
                  </li>
                )
              })}
            </ul>
          </>
        )}

        <button
          type="button"
          onClick={resetTabOrder}
          className="mt-6 text-sm font-medium text-sky-600 hover:underline dark:text-sky-400"
        >
          Reset to the default order
        </button>

        {/* Announced rather than shown, so a save does not shift the layout mid-interaction. */}
        <span aria-live="polite" className="sr-only">
          {isSaving ? 'Saving your tab order' : ''}
        </span>
        </ExpandableRow>

        {/*
          A boolean toggles in place. Hiding a checkbox behind a disclosure would be consistent with
          the rows around it and strictly worse — one extra tap to reach one tap.
        */}
        <ToggleRow
          title={HISTORY_SETTING_COPY.label}
          checked={preferences.showIncompleteHistory}
          onChange={(next) => patch({ showIncompleteHistory: next })}
          // The consequence of the state it is in, not of the switch. Describing the other option
          // is how a toggle ends up read backwards.
          detail={
            preferences.showIncompleteHistory
              ? HISTORY_SETTING_COPY.on
              : HISTORY_SETTING_COPY.off
          }
        />
      </Group>

      <Group title={SETTINGS_COPY.categorizingGroup}>
        <ExpandableRow
          title={CATEGORY_COPY.categoriesHeading}
          summary={
            categories.data === undefined
              ? undefined
              : SETTINGS_COPY.categoriesSummary(categories.data.length)
          }
        >
          <CategoryTree categories={categories.data ?? []} onChanged={refreshCategories} />
        </ExpandableRow>

        <ExpandableRow
          title={CATEGORY_COPY.rulesHeading}
          summary={
            rules.data === undefined ? undefined : SETTINGS_COPY.rulesSummary(rules.data.length)
          }
        >
          <RulesPanel />
        </ExpandableRow>
      </Group>

      <Group title={SETTINGS_COPY.householdGroup}>
        <ExpandableRow title={HOUSEHOLD_COPY.title}>
          <Household />
        </ExpandableRow>

        <ExpandableRow title={IMPORT_COPY.title} summary={SETTINGS_COPY.importSummary}>
          <Import />
        </ExpandableRow>
      </Group>
    </div>
  )
}

/** A labelled set of rows. The label is what stops anything reading as bolted on underneath. */
function Group({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className="mt-8">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {title}
      </h2>
      <div className="mt-2 divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
        {children}
      </div>
    </section>
  )
}

/**
 * A row that opens on demand.
 *
 * Mounted only while open, which is not tidiness: each of these fetches on mount — the household
 * and its invites, the rule list, the import history — and firing all of them for a page somebody
 * opened to reorder their tabs would be most of the cost of the screen.
 */
function ExpandableRow({
  title,
  summary,
  children,
}: {
  title: string
  /** Shown while closed, so the row says what is inside without being opened. */
  summary?: string | undefined
  children: ReactNode
}): ReactNode {
  const [open, setOpen] = useState(false)

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={cn(
          'flex w-full items-center gap-3 px-4 py-3 text-left',
          'hover:bg-slate-50 dark:hover:bg-slate-900',
          'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sky-500',
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{title}</span>
          {summary !== undefined && (
            <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
              {summary}
            </span>
          )}
        </span>
        <ChevronRight
          className={cn('size-4 shrink-0 text-slate-400 transition-transform', open && 'rotate-90')}
          aria-hidden
        />
      </button>

      {open && <div className="border-t border-slate-200 px-4 py-4 dark:border-slate-800">{children}</div>}
    </div>
  )
}

/** A row that is its own control, for a setting small enough to have no screen behind it. */
function ToggleRow({
  title,
  detail,
  checked,
  onChange,
}: {
  title: string
  detail: string
  checked: boolean
  onChange: (next: boolean) => void
}): ReactNode {
  return (
    <label className="flex cursor-pointer items-start gap-3 px-4 py-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-sky-600"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">{detail}</span>
      </span>
    </label>
  )
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      // The icon alone says nothing to a screen reader; the label is the only description.
      aria-label={label}
      className={cn(
        'flex size-9 items-center justify-center rounded-lg',
        'text-slate-500 dark:text-slate-400',
        'hover:bg-slate-100 dark:hover:bg-slate-800',
        'focus-visible:outline-2 focus-visible:outline-sky-500',
        'disabled:pointer-events-none disabled:opacity-30',
      )}
    >
      {children}
    </button>
  )
}
