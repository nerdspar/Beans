import {
  CATEGORY_COPY,
  HISTORY_SETTING_COPY,
  HOUSEHOLD_COPY,
  IMPORT_COPY,
} from '@beans/shared'
import { ChevronDown, ChevronRight, ChevronUp, Plus, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { cn } from '../lib/cn.js'
import { usePreferences } from '../preferences/use-preferences.js'
import { Categories } from './Categories.js'
import { Household } from './Household.js'
import { Import } from './Import.js'
import { TAB_SLOTS, tabbableDestinations } from '../navigation/destinations.js'
import { useTabOrder } from '../navigation/use-tab-order.js'

/**
 * Choosing which destinations occupy the four configurable tab slots, and in what order.
 *
 * **Up/down buttons rather than drag and drop.** With four items the reorder is two taps at most,
 * and a drag inside a scrolling settings page fights the scroll — on touch especially, where the
 * gesture is ambiguous until it has already gone wrong. Drag would be the flashier choice and the
 * worse one here.
 */
export function TabSettings(): ReactNode {
  const { tabs, setTabOrder, resetTabOrder, isSaving } = useTabOrder()
  const { preferences, patch } = usePreferences()

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
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>

      {/*
        Household, categories and import live here rather than as destinations of their own.
        
        Each is something you set up once and revisit rarely — a tab spent on any of them is a tab
        not spent on the four screens used daily. Collapsed by default so the page reads as a list
        of what can be changed, rather than three screens stacked on top of each other.
      */}
      <Collapsible title={HOUSEHOLD_COPY.title}>
        <Household />
      </Collapsible>

      <Collapsible title={CATEGORY_COPY.rulesHeading}>
        <Categories />
      </Collapsible>

      <Collapsible title={IMPORT_COPY.title}>
        <Import />
      </Collapsible>

      <section className="mt-8" aria-labelledby="history-heading">
        <h2 id="history-heading" className="text-base font-semibold">
          {HISTORY_SETTING_COPY.heading}
        </h2>

        <label className="mt-3 flex items-start gap-3">
          <input
            type="checkbox"
            checked={preferences.showIncompleteHistory}
            onChange={(event) => patch({ showIncompleteHistory: event.target.checked })}
            className="mt-0.5 size-4 shrink-0 accent-sky-600"
          />
          <span className="text-sm">
            <span className="font-medium">{HISTORY_SETTING_COPY.label}</span>
            {/*
              The consequence of the current state, not of the switch. Describing the other option
              is how a toggle ends up read backwards.
            */}
            <span className="mt-0.5 block text-slate-500 dark:text-slate-400">
              {preferences.showIncompleteHistory
                ? HISTORY_SETTING_COPY.on
                : HISTORY_SETTING_COPY.off}
            </span>
          </span>
        </label>
      </section>

      <section className="mt-8" aria-labelledby="tabs-heading">
        <h2 id="tabs-heading" className="text-base font-semibold">
          Bottom tabs
        </h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Pick up to {TAB_SLOTS} and put them in order. More always fills the last slot and holds
          everything else.
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
      </section>
    </div>
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

/**
 * A settings section that opens on demand.
 *
 * Mounted only while open, which is not just tidiness: each of these fetches on mount — the
 * household and its invites, the category list and its rules — and three screens' worth of requests
 * fired for a page somebody opened to reorder their tabs would be most of the cost of the screen.
 */
function Collapsible({ title, children }: { title: string; children: ReactNode }): ReactNode {
  const [open, setOpen] = useState(false)

  return (
    <section className="mt-8 border-t border-slate-200 pt-6 dark:border-slate-800">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-base font-semibold focus-visible:outline-2 focus-visible:outline-sky-500"
      >
        <ChevronRight
          className={cn('size-4 shrink-0 transition-transform', open && 'rotate-90')}
          aria-hidden
        />
        {title}
      </button>

      {open && <div className="mt-4">{children}</div>}
    </section>
  )
}
