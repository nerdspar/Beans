import { CATEGORY_COPY, type KeywordMode } from '@beans/shared'
import { X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { Category, Rule, RuleInput } from './api.js'
import { cn } from '../lib/cn.js'

/**
 * Building a rule from keywords.
 *
 * **Keywords as chips rather than one text field.** The same merchant reaches a statement spelled
 * several ways — `AMZN Mktp`, `AMAZON.COM`, `Amazon Prime` — and the alternative to a list is making
 * somebody write `AMZN|AMAZON` and learn what a pipe means to express something entirely ordinary.
 *
 * The and/or choice is a visible control rather than an advanced option, because it changes what a
 * rule does more than any other field: *any* fires on a merchant's several spellings, *all* narrows
 * one broad word with a second. Getting it backwards produces a rule that fires on everything or
 * one that never fires, and both look identical until transactions are already categorized.
 */

export function RuleBuilder({
  categories,
  rule,
  isPending,
  error,
  onSubmit,
  onCancel,
}: {
  categories: readonly Category[]
  /** Present when editing. Absent when adding. */
  rule?: Rule
  isPending: boolean
  error: string | null
  onSubmit: (input: RuleInput) => void
  onCancel?: () => void
}): ReactNode {
  const [keywords, setKeywords] = useState<string[]>(() => rule?.keywords ?? [])
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<KeywordMode>(rule?.keywordMode ?? 'any')
  const [matchType, setMatchType] = useState<'contains' | 'regex'>(rule?.matchType ?? 'contains')
  const [categoryId, setCategoryId] = useState<string>(rule?.categoryId ?? '')

  /*
   * Committed on Enter *and* on comma, and again when the field loses focus.
   *
   * Losing focus matters more than it sounds: the commonest way to lose a keyword is to type it,
   * reach straight for Save, and have the chip never form — the rule then saves without the term
   * the user was looking at when they pressed the button.
   */
  const commit = (): void => {
    const trimmed = draft.trim()
    if (trimmed === '') return
    if (!keywords.includes(trimmed)) setKeywords([...keywords, trimmed])
    setDraft('')
  }

  const pending = draft.trim()
  const effective = pending !== '' && !keywords.includes(pending) ? [...keywords, pending] : keywords

  const canSave = effective.length > 0 && categoryId !== ''

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (!canSave) return
        onSubmit({ keywords: effective, keywordMode: mode, matchType, categoryId })
      }}
      className="rounded-xl border border-slate-200 p-3 dark:border-slate-800"
    >
      <p className="text-sm font-medium">
        {rule === undefined ? CATEGORY_COPY.ruleNew : CATEGORY_COPY.ruleEdit}
      </p>

      <label className="mt-2 block text-xs font-medium" htmlFor="rule-keyword">
        {CATEGORY_COPY.ruleKeywordsLabel}
      </label>

      {keywords.length > 0 && (
        <ul className="mt-1.5 flex flex-wrap gap-1.5">
          {keywords.map((keyword) => (
            <li key={keyword}>
              <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 py-1 pl-2.5 pr-1 text-xs dark:bg-slate-800">
                {keyword}
                <button
                  type="button"
                  onClick={() => setKeywords(keywords.filter((one) => one !== keyword))}
                  aria-label={CATEGORY_COPY.ruleKeywordRemove(keyword)}
                  className="rounded-full p-0.5 hover:bg-slate-300 dark:hover:bg-slate-700"
                >
                  <X className="size-3" aria-hidden />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <input
        id="rule-keyword"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',') {
            // Enter would submit the form with the chip uncommitted, which loses the term.
            event.preventDefault()
            commit()
          }
          if (event.key === 'Backspace' && draft === '' && keywords.length > 0) {
            setKeywords(keywords.slice(0, -1))
          }
        }}
        placeholder={CATEGORY_COPY.ruleKeywordPlaceholder}
        className={cn(
          'mt-1.5 w-full rounded-lg border px-3 py-2 text-sm',
          'border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900',
          'focus-visible:outline-2 focus-visible:outline-sky-500',
        )}
      />

      {keywords.length > 1 && (
        <fieldset className="mt-3">
          <legend className="text-xs font-medium">{CATEGORY_COPY.ruleModeLabel}</legend>
          <div className="mt-1 flex gap-2">
            {(['any', 'all'] as const).map((option) => (
              <label
                key={option}
                className={cn(
                  'flex-1 cursor-pointer rounded-lg border px-3 py-2 text-xs',
                  mode === option
                    ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/40'
                    : 'border-slate-300 dark:border-slate-700',
                )}
              >
                <input
                  type="radio"
                  name="keyword-mode"
                  value={option}
                  checked={mode === option}
                  onChange={() => setMode(option)}
                  className="sr-only"
                />
                <span className="block font-medium">{CATEGORY_COPY.ruleMode[option]}</span>
                <span className="block text-slate-500 dark:text-slate-400">
                  {CATEGORY_COPY.ruleModeHelp[option]}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <label className="mt-3 block text-xs font-medium" htmlFor="rule-category">
        {CATEGORY_COPY.ruleCategoryLabel}
      </label>
      <select
        id="rule-category"
        value={categoryId}
        onChange={(event) => setCategoryId(event.target.value)}
        className={cn(
          'mt-1 w-full rounded-lg border px-3 py-2 text-sm',
          'border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900',
          'focus-visible:outline-2 focus-visible:outline-sky-500',
        )}
      >
        <option value="">{CATEGORY_COPY.rulePickCategory}</option>
        {/* Parents then their children, so the list reads as the two-level tree it is. */}
        {categories
          .filter((category) => category.parentId === null)
          .flatMap((parent) => [
            <option key={parent.id} value={parent.id}>
              {parent.name}
            </option>,
            ...categories
              .filter((child) => child.parentId === parent.id)
              .map((child) => (
                <option key={child.id} value={child.id}>
                  {'  '}
                  {child.name}
                </option>
              )),
          ])}
      </select>

      <label className="mt-3 flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={matchType === 'regex'}
          onChange={(event) => setMatchType(event.target.checked ? 'regex' : 'contains')}
          className="size-4 accent-sky-600"
        />
        {CATEGORY_COPY.ruleRegexToggle}
      </label>

      {error !== null && (
        <p role="alert" className="mt-2 text-xs text-rose-600 dark:text-rose-400">
          {error}
        </p>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="submit"
          disabled={!canSave || isPending}
          className={cn(
            'min-h-9 rounded-lg bg-sky-600 px-3 text-xs font-medium text-white',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500',
            'disabled:bg-slate-200 disabled:text-slate-400 dark:disabled:bg-slate-800',
          )}
        >
          {isPending ? CATEGORY_COPY.ruleSaving : CATEGORY_COPY.ruleSave}
        </button>

        {onCancel !== undefined && (
          <button
            type="button"
            onClick={onCancel}
            className={cn(
              'min-h-9 rounded-lg border px-3 text-xs font-medium',
              'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800',
            )}
          >
            {CATEGORY_COPY.ruleCancel}
          </button>
        )}
      </div>
    </form>
  )
}
