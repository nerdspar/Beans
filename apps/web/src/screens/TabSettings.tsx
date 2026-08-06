import { HISTORY_SETTING_COPY, SETTINGS_COPY } from '@beans/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { getHousehold, setTrustImportedHistory } from '../household/api.js'
import { WORKING_SET_KEY } from '../working-set/use-working-set.js'
import { ChevronDown, ChevronRight, ChevronUp } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { cn } from '../lib/cn.js'
import { usePreferences } from '../preferences/use-preferences.js'
import { TAB_SLOTS } from '../navigation/destinations.js'
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
 * **Up/down buttons rather than drag and drop** for the navigation order. A drag inside a scrolling
 * page fights the scroll — on touch especially, where the gesture is ambiguous until it has already
 * gone wrong. The list is longer than it was now that it covers every destination, which makes a
 * drag more tempting and no less ambiguous; the rows are compact enough that a move is still a
 * short trip.
 */
export function TabSettings(): ReactNode {
  const { tabs, ordered, setTabOrder, resetTabOrder, isSaving, saveError } = useTabOrder()
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

  /*
   * One list of everything, not a chosen set and a spare pile.
   *
   * The two-list shape made sense while this configured four phone slots and nothing else: things
   * were in the bar or waiting to be. Now the same order is the desktop sidebar, where every
   * destination appears — so a screen offering six of ten, with four unmentioned and unmovable at
   * the end of the sidebar, was describing a setting that no longer existed.
   */
  const orderedKeys = ordered.map((destination) => destination.key)
  const tabKeys = new Set(tabs.map((tab) => tab.key))

  const move = (index: number, direction: -1 | 1): void => {
    const target = index + direction
    if (target < 0 || target >= orderedKeys.length) return

    const next = [...orderedKeys]
    const a = next[index]
    const b = next[target]
    if (a === undefined || b === undefined) return
    next[index] = b
    next[target] = a
    setTabOrder(next)
  }

  return (
    /* Same container and title as the browsing screens — see ManagementPage for why. */
    <div className="mx-auto max-w-2xl px-5 pb-16 pt-6">
      <h1 className="text-2xl font-semibold">{SETTINGS_COPY.title}</h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{SETTINGS_COPY.blurb}</p>

      <section className="mt-8" aria-labelledby="tabs-heading">
        <h2 id="tabs-heading" className="text-base font-semibold">
          {SETTINGS_COPY.tabsTitle}
        </h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {SETTINGS_COPY.tabsHelp(TAB_SLOTS)}
        </p>
        <ol className="mt-4 space-y-1.5">
          {ordered.map((destination, index) => {
            const Icon = destination.icon
            const onBar = tabKeys.has(destination.key)

            return (
              <li
                key={destination.key}
                className={cn(
                  /*
                   * 38px a row, measured — the height the controls-free rows already had, which is
                   * the density this list wanted once it grew from four entries to ten.
                   *
                   * `py-0.5` against a 32px button rather than `py-1` against a 28px one: both come
                   * to the same row, and the version that keeps the larger tap target is the one to
                   * take. The padding was never doing anything the button height was not.
                   */
                  'flex items-center gap-3 rounded-xl border px-3 py-0.5',
                  'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900',
                )}
              >
                <Icon className="size-4.5 shrink-0 text-slate-500 dark:text-slate-400" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {destination.label}
                </span>

                {/* Which rows reach the phone's bar. Simply the first four, now that anything may be one. */}
                {onBar && (
                  <span className="shrink-0 rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:bg-sky-950 dark:text-sky-300">
                    {SETTINGS_COPY.tabsOnBar}
                  </span>
                )}

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
                  disabled={index === ordered.length - 1}
                >
                  <ChevronDown className="size-4" aria-hidden />
                </IconButton>
              </li>
            )
          })}
        </ol>

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

        {/*
          A refused save is shown, not just announced. The rollback on its own is exactly what a
          broken button looks like — the row moves and moves back — so the one thing the reader
          needs is that it was refused rather than ignored.
        */}
        {saveError !== null && (
          <p role="alert" className="mt-3 text-sm text-rose-600 dark:text-rose-400">
            {SETTINGS_COPY.tabsSaveFailed}
          </p>
        )}
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
        /*
         * `size-8` rather than `size-9`, which is what made every row four-fifths taller than the
         * ones without controls. Still a 32px target: under the 44px iOS guideline in isolation,
         * but these sit inside a 40px row that is itself the hit area for nothing else, and the
         * list is now ten rows rather than four — the height was the thing being read past.
         */
        'flex size-8 items-center justify-center rounded-lg',
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
