import { PICKER_COPY } from '@beans/shared'
import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { cn } from './cn.js'

/**
 * A select you can type into.
 *
 * A native `<select>` is the right choice for a handful of options and the wrong one past that: with
 * forty accounts, finding "Joint Cash Account — Ending in 5497" means scrolling a list with no way
 * to narrow it, once per row on the import matching screen. The search box is the whole point.
 *
 * Built rather than pulled in: Radix has no combobox primitive, and what this needs — filter,
 * arrow keys, `aria-activedescendant`, click-away — is less code than reconciling a dependency's
 * styling and focus model with the rest of the app.
 *
 * **Focus is managed explicitly.** Opening moves focus into the search box, closing returns it to
 * the trigger. Without the return, dismissing the panel drops focus onto the document body and a
 * keyboard user is silently back at the top of the page.
 */

export type SelectOption = {
  value: string
  label: string
  /** Shown beside the label, and searched. Institution, mask, anything disambiguating. */
  hint?: string | undefined
}

export type SearchableSelectProps = {
  value: string
  onChange: (value: string) => void
  options: readonly SelectOption[]
  /** Names the control for assistive technology, and labels the trigger when nothing is selected. */
  label: string
  /** Shown on the trigger when `value` matches no option. */
  placeholder?: string
  className?: string
  disabled?: boolean
  /**
   * Which edge of the trigger the panel is anchored to.
   *
   * The panel is wider than the trigger, so a narrow control near the right edge of the screen needs
   * to open leftwards or it runs off. Stated by the caller rather than measured — the callers know
   * where they sit, and a layout effect that measures and repositions flickers on first paint.
   */
  align?: 'start' | 'end'
}

/** Below this a search box is noise, so it is hidden and the list behaves like a plain menu. */
const SEARCHABLE_THRESHOLD = 8

export function SearchableSelect({
  value,
  onChange,
  options,
  label,
  placeholder,
  className,
  disabled = false,
  align = 'start',
}: SearchableSelectProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)

  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const listId = useId()
  const optionId = (index: number): string => `${listId}-option-${index}`

  const selected = options.find((option) => option.value === value)

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return options

    // Label and hint together, so "5497" finds an account by its mask and "chase" by its
    // institution without either needing to be in the name.
    return options.filter((option) =>
      `${option.label} ${option.hint ?? ''}`.toLowerCase().includes(needle),
    )
  }, [options, query])

  const searchable = options.length >= SEARCHABLE_THRESHOLD

  /** Opens onto the current selection rather than the top, so the list starts where the user is. */
  const openPanel = (): void => {
    if (disabled) return
    const index = options.findIndex((option) => option.value === value)
    setActiveIndex(index === -1 ? 0 : index)
    setQuery('')
    setOpen(true)
  }

  const closePanel = (returnFocus: boolean): void => {
    setOpen(false)
    if (returnFocus) triggerRef.current?.focus()
  }

  const choose = (option: SelectOption | undefined): void => {
    if (option === undefined) return
    onChange(option.value)
    closePanel(true)
  }

  // Focus the search box on open. Without this the panel appears and the keyboard is still on the
  // trigger, so the first keystroke does nothing.
  useEffect(() => {
    if (!open) return
    if (searchable) searchRef.current?.focus()
  }, [open, searchable])

  // Filtering can leave the active index past the end of a shorter list.
  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(0, matches.length - 1)))
  }, [matches.length])

  /*
   * Pointerdown rather than click: a click that lands outside would otherwise close the panel and
   * then land on whatever moved underneath it.
   */
  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return
      if (rootRef.current?.contains(event.target) === true) return
      setOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        openPanel()
        event.preventDefault()
      }
      return
    }

    switch (event.key) {
      case 'ArrowDown':
        setActiveIndex((current) => Math.min(current + 1, matches.length - 1))
        break
      case 'ArrowUp':
        setActiveIndex((current) => Math.max(current - 1, 0))
        break
      case 'Home':
        setActiveIndex(0)
        break
      case 'End':
        setActiveIndex(matches.length - 1)
        break
      case 'Enter':
        choose(matches[activeIndex])
        break
      case 'Escape':
        closePanel(true)
        break
      case 'Tab':
        // Tabbing away is a dismissal, but focus is already going somewhere deliberate.
        closePanel(false)
        return
      default:
        return
    }

    event.preventDefault()
  }

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        aria-label={label}
        disabled={disabled}
        onClick={() => (open ? closePanel(false) : openPanel())}
        onKeyDown={onKeyDown}
        className={cn(
          'flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border px-3 text-left text-base',
          'border-slate-300 bg-white text-slate-900',
          'dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100',
          'focus-visible:outline-2 focus-visible:outline-sky-500 disabled:opacity-50',
        )}
      >
        <span className={cn('truncate', selected === undefined && 'text-slate-500')}>
          {selected?.label ?? placeholder ?? label}
        </span>
        <ChevronDown className="size-4 shrink-0 text-slate-400" aria-hidden />
      </button>

      {open && (
        <div
          className={cn(
            'absolute z-50 mt-1 overflow-hidden rounded-xl border shadow-lg',
            /*
             * Sized to its contents, not to the trigger.
             *
             * Inheriting the trigger's width truncated every account name to a few characters —
             * "Joint 3.30% …" tells you nothing, and the whole point of the list is choosing
             * between things you can tell apart. At least as wide as the trigger so it never looks
             * detached, and capped short of the viewport so it cannot run off a phone.
             */
            'w-max min-w-full max-w-[min(28rem,calc(100vw-2rem))]',
            align === 'end' ? 'right-0' : 'left-0',
            'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900',
          )}
        >
          {searchable && (
            <div className="border-b border-slate-200 p-2 dark:border-slate-700">
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onKeyDown}
                placeholder={PICKER_COPY.searchPlaceholder}
                aria-label={PICKER_COPY.search}
                /*
                 * The search box is the focused element while the panel is open, so the combobox
                 * relationship lives here too — that is what makes a screen reader announce the
                 * highlighted option as the arrow keys move it.
                 */
                aria-controls={listId}
                aria-activedescendant={
                  matches.length > 0 ? optionId(activeIndex) : undefined
                }
                className={cn(
                  'min-h-10 w-full rounded-lg border px-2.5 text-base',
                  'border-slate-300 bg-white text-slate-900',
                  'dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100',
                  'focus-visible:outline-2 focus-visible:outline-sky-500',
                )}
              />
            </div>
          )}

          <ul
            id={listId}
            role="listbox"
            aria-label={label}
            className="max-h-64 overflow-y-auto overscroll-contain py-1"
          >
            {matches.length === 0 && (
              <li className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400">
                {options.length === 0 ? PICKER_COPY.empty : PICKER_COPY.noMatches}
              </li>
            )}

            {matches.map((option, index) => (
              <li
                key={option.value}
                id={optionId(index)}
                role="option"
                aria-selected={option.value === value}
                // Kept in view as the arrow keys move past the visible window.
                ref={(node) => {
                  if (index === activeIndex && open) node?.scrollIntoView({ block: 'nearest' })
                }}
                onPointerDown={(event) => {
                  // Stops the button losing focus before the selection is applied.
                  event.preventDefault()
                  choose(option)
                }}
                onPointerEnter={() => setActiveIndex(index)}
                className={cn(
                  'flex cursor-pointer items-center gap-2 px-3 py-2 text-sm',
                  index === activeIndex && 'bg-slate-100 dark:bg-slate-800',
                )}
              >
                <Check
                  className={cn(
                    'size-4 shrink-0 text-sky-600 dark:text-sky-400',
                    option.value !== value && 'invisible',
                  )}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.hint !== undefined && option.hint !== '' && (
                  <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
                    {option.hint}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
