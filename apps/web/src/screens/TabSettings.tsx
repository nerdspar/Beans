import { HISTORY_SETTING_COPY, SETTINGS_COPY } from '@beans/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { getHousehold, setTrustImportedHistory } from '../household/api.js'
import { WORKING_SET_KEY } from '../working-set/use-working-set.js'
import { ChevronDown, ChevronRight, ChevronUp, Plus, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { cn } from '../lib/cn.js'
import { usePreferences } from '../preferences/use-preferences.js'
import { TAB_SLOTS, tabbableDestinations } from '../navigation/destinations.js'
import { useTabOrder } from '../navigation/use-tab-order.js'

/**
 * Preferences. Only preferences.
 *
 * This page was a junk drawer: the household, categories, rules and import were all folded into it
 * as expanding sections, and grouping them better did not help because the shape was wrong. Each is
 * a screen's worth of interface inside a list row — opening one shoved everything below it down —
 * and none had a URL, so none could be linked to, backed out of, or survive a reload.
 *
 * They are destinations now (see `navigation/destinations.ts`), which is what every platform does
 * with this: a settings *list* navigates, it does not unfold. What is left is the two things that
 * genuinely are settings — which is also why they used to look homeless here. They were not missing
 * a home; they were sharing one with four things that had no business being in it.
 *
 * **Up/down buttons rather than drag and drop** for the tab order. With four items the reorder is
 * two taps at most, and a drag inside a scrolling page fights the scroll — on touch especially,
 * where the gesture is ambiguous until it has already gone wrong.
 */
export function TabSettings(): ReactNode {
  const { tabs, setTabOrder, resetTabOrder, isSaving } = useTabOrder()
  const { preferences, patch } = usePreferences()
  const queryClient = useQueryClient()

  const household = useQuery({ queryKey: ['household'], queryFn: getHousehold })

  /*
   * Rebuilds every account server-side, so this is slow by nature rather than by accident. The
   * button says what it is doing rather than just going quiet.
   */
  const trust = useMutation({
    mutationFn: setTrustImportedHistory,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['household'] })
      // Every chart in the app is drawn from the working set, which just changed shape.
      await queryClient.invalidateQueries({ queryKey: WORKING_SET_KEY })
      await queryClient.invalidateQueries({ queryKey: ['working-set', 'sync'] })
    },
  })

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
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{SETTINGS_COPY.blurb}</p>

      <section className="mt-8" aria-labelledby="tabs-heading">
        <h2 id="tabs-heading" className="text-base font-semibold">
          {SETTINGS_COPY.tabsTitle}
        </h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
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
              {isFull ? SETTINGS_COPY.tabsInMore : SETTINGS_COPY.tabsAdd}
            </h3>
            {isFull && (
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {SETTINGS_COPY.tabsFull}
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
          {SETTINGS_COPY.tabsReset}
        </button>

        {/* Announced rather than shown, so a save does not shift the layout mid-interaction. */}
        <span aria-live="polite" className="sr-only">
          {isSaving ? SETTINGS_COPY.tabsSaving : ''}
        </span>
      </section>

      {/*
        The trust switch.
        
        Beside the incomplete-history toggle because they are about the same doubt: one decides
        whether a partly-known stretch is drawn at all, this decides how far back "known" reaches.
      */}
      <section className="mt-10" aria-labelledby="trust-heading">
        <h2 id="trust-heading" className="text-base font-semibold">
          {SETTINGS_COPY.historyTrustTitle}
        </h2>

        <label className="mt-3 flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={household.data?.trustImportedHistory ?? false}
            disabled={household.data === undefined || trust.isPending}
            onChange={(event) => trust.mutate(event.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-sky-600"
          />
          <span className="text-sm">
            <span className="font-medium">{SETTINGS_COPY.historyTrustLabel}</span>
            {/* The consequence of the state it is in, not of the switch. */}
            <span className="mt-0.5 block text-slate-500 dark:text-slate-400">
              {household.data?.trustImportedHistory === true
                ? SETTINGS_COPY.historyTrustOn
                : SETTINGS_COPY.historyTrustOff}
            </span>
            <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
              {SETTINGS_COPY.historyTrustReversible}
            </span>
          </span>
        </label>

        {trust.isPending && (
          <p className="mt-2 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            {SETTINGS_COPY.historyTrustRebuilding}
          </p>
        )}

        {trust.data !== undefined && !trust.isPending && (
          <p role="status" className="mt-2 text-xs text-emerald-700 dark:text-emerald-400">
            {SETTINGS_COPY.historyTrustDone(trust.data.accounts)}
          </p>
        )}

        {trust.error instanceof Error && (
          <p role="alert" className="mt-2 text-xs text-rose-600 dark:text-rose-400">
            {trust.error.message}
          </p>
        )}
      </section>

      <section className="mt-10" aria-labelledby="history-heading">
        <h2 id="history-heading" className="text-base font-semibold">
          {HISTORY_SETTING_COPY.heading}
        </h2>

        <label className="mt-3 flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={preferences.showIncompleteHistory}
            onChange={(event) => patch({ showIncompleteHistory: event.target.checked })}
            className="mt-0.5 size-4 shrink-0 accent-sky-600"
          />
          <span className="text-sm">
            <span className="font-medium">{HISTORY_SETTING_COPY.label}</span>
            {/*
              The consequence of the state it is in, not of the switch. Describing the other option
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
