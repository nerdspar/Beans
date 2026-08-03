import * as Dialog from '@radix-ui/react-dialog'
import { Calendar, Check } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { cn } from '../lib/cn.js'

/**
 * The time range control.
 *
 * Appears on nearly every screen, and **changing it must feel instant** — the full daily series is
 * already in memory, so switching range is a local re-slice with no fetch and no spinner. Nothing
 * here is async on purpose.
 */

export type RangeKey =
  'this-month' | 'last-month' | '90-days' | '1-year' | 'ytd' | 'last-year' | 'custom'

export const RANGES: ReadonlyArray<{ key: RangeKey; label: string }> = [
  { key: 'this-month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
  { key: '90-days', label: '90 days' },
  { key: '1-year', label: '1 year' },
  { key: 'ytd', label: 'YTD' },
  { key: 'last-year', label: 'Last year' },
  { key: 'custom', label: 'Custom' },
]

export function rangeLabel(key: RangeKey): string {
  return RANGES.find((range) => range.key === key)?.label ?? '90 days'
}

export function RangeControl({
  value,
  onChange,
}: {
  value: RangeKey
  onChange: (value: RangeKey) => void
}): ReactNode {
  const [open, setOpen] = useState(false)

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        className={cn(
          'inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium',
          'border-slate-300 text-slate-700 dark:border-slate-700 dark:text-slate-200',
          'focus-visible:outline-2 focus-visible:outline-sky-500',
        )}
      >
        <Calendar className="size-4" aria-hidden />
        {rangeLabel(value)}
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/40 backdrop-blur-sm" />
        <Dialog.Content
          className={cn(
            'fixed inset-x-0 bottom-0 z-50 rounded-t-2xl',
            'border-t border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900',
            // Portalled to the document root, so text colour cannot be inherited from the shell.
            'text-slate-900 dark:text-slate-100',
            'pb-[env(safe-area-inset-bottom)]',
            'sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/4 sm:w-80 sm:-translate-x-1/2 sm:rounded-2xl sm:border',
          )}
        >
          <div className="flex justify-center pt-3 sm:hidden" aria-hidden>
            <div className="h-1 w-10 rounded-full bg-slate-300 dark:bg-slate-700" />
          </div>

          <Dialog.Title className="px-5 pt-3 text-base font-semibold">
            Select date range
          </Dialog.Title>
          <Dialog.Description className="sr-only">
            Choose the period the totals and chart cover.
          </Dialog.Description>

          <ul className="p-3">
            {RANGES.map((range) => {
              const selected = range.key === value
              return (
                <li key={range.key}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(range.key)
                      setOpen(false)
                    }}
                    className={cn(
                      'flex min-h-12 w-full items-center justify-between rounded-xl px-4 text-left text-sm',
                      'hover:bg-slate-100 dark:hover:bg-slate-800',
                      'focus-visible:outline-2 focus-visible:outline-sky-500',
                      selected && 'font-semibold',
                    )}
                  >
                    {range.label}
                    {/* A tick as well as weight — colour and boldness alone are not a state. */}
                    {selected && (
                      <Check
                        className="size-4 text-sky-600 dark:text-sky-400"
                        aria-label="Selected"
                      />
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/**
 * How many trailing days a range covers.
 *
 * Approximate for the calendar-relative options while this runs on fixtures; the real slice comes
 * from the working set once it exists, where "this month" means the actual month boundary rather
 * than a day count.
 */
export function rangeDays(key: RangeKey): number {
  switch (key) {
    case 'this-month':
      return 30
    case 'last-month':
      return 60
    case '90-days':
      return 90
    case 'ytd':
      return 215
    case '1-year':
    case 'last-year':
    case 'custom':
      return 365
  }
}
