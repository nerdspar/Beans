import * as Dialog from '@radix-ui/react-dialog'
import { RANGE_COPY } from '@beans/shared'
import { Calendar, Check, ChevronLeft } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { cn } from '../lib/cn.js'
import {
  PRESETS,
  rangeDetail,
  rangeLabel,
  resolveWindow,
  todayIso,
  validateCustomRange,
  type RangeSelection,
} from './range.js'

/**
 * The time range control.
 *
 * Appears on nearly every screen, and **changing it must feel instant** — the full daily series is
 * already in memory, so switching range is a local re-slice with no fetch and no spinner. Nothing
 * here is async on purpose.
 */

export function RangeControl({
  value,
  onChange,
}: {
  value: RangeSelection
  onChange: (value: RangeSelection) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [showCustom, setShowCustom] = useState(false)

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        // Always reopen on the preset list. Landing back inside the custom form because that is
        // where the sheet was last closed is disorienting.
        if (!next) setShowCustom(false)
      }}
    >
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

          <Dialog.Title className="flex items-center gap-1 px-5 pt-3 text-base font-semibold">
            {showCustom && (
              <button
                type="button"
                onClick={() => setShowCustom(false)}
                className="-ml-2 rounded p-1 focus-visible:outline-2 focus-visible:outline-sky-500"
                aria-label={RANGE_COPY.backToPresets}
              >
                <ChevronLeft className="size-5" aria-hidden />
              </button>
            )}
            {showCustom ? RANGE_COPY.customTitle : RANGE_COPY.title}
          </Dialog.Title>
          <Dialog.Description className="sr-only">
            {RANGE_COPY.description}
          </Dialog.Description>

          {showCustom ? (
            <CustomRangeForm
              value={value}
              onApply={(selection) => {
                onChange(selection)
                setOpen(false)
                setShowCustom(false)
              }}
            />
          ) : (
            <ul className="p-3">
              {PRESETS.map((preset) => {
                const selected = value.kind === 'preset' && preset.key === value.key
                return (
                  <li key={preset.key}>
                    <RangeOption
                      label={preset.label}
                      selected={selected}
                      onClick={() => {
                        onChange({ kind: 'preset', key: preset.key })
                        setOpen(false)
                      }}
                    />
                  </li>
                )
              })}
              <li>
                <RangeOption
                  label="Custom"
                  detail={rangeDetail(value)}
                  selected={value.kind === 'custom'}
                  onClick={() => setShowCustom(true)}
                />
              </li>
            </ul>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function RangeOption({
  label,
  detail,
  selected,
  onClick,
}: {
  label: string
  /** The concrete dates behind the label, for Custom. */
  detail?: string | null
  selected: boolean
  onClick: () => void
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex min-h-12 w-full items-center justify-between rounded-xl px-4 text-left text-sm',
        'hover:bg-slate-100 dark:hover:bg-slate-800',
        'focus-visible:outline-2 focus-visible:outline-sky-500',
        selected && 'font-semibold',
      )}
    >
      <span className="flex items-baseline gap-2">
        {label}
        {detail !== null && detail !== undefined && (
          <span className="text-xs font-normal text-slate-500 dark:text-slate-400">{detail}</span>
        )}
      </span>
      {/* A tick as well as weight — colour and boldness alone are not a state. */}
      {selected && <Check className="size-4 text-sky-600 dark:text-sky-400" aria-label={RANGE_COPY.selected} />}
    </button>
  )
}

const ERROR_TEXT = {
  order: RANGE_COPY.errorOrder,
  future: RANGE_COPY.errorFuture,
} as const

/**
 * Two native date inputs.
 *
 * Native rather than a hand-built calendar: `<input type="date">` already gives the iOS wheel, the
 * Android picker, keyboard entry, locale-correct display and screen reader support, and its value is
 * `YYYY-MM-DD` — the exact shape the range model wants, with no parsing in between. A custom
 * calendar would be several hundred lines to arrive back here with worse accessibility.
 */
function CustomRangeForm({
  value,
  onApply,
}: {
  value: RangeSelection
  onApply: (selection: RangeSelection) => void
}): ReactNode {
  const today = todayIso()
  // Seeded from the window currently on screen, so opening this is a starting point rather than a
  // blank form — most custom ranges are an adjustment of what the user is already looking at.
  const initial = resolveWindow(value, today)

  const [start, setStart] = useState(initial.start)
  const [end, setEnd] = useState(initial.end)

  const error = validateCustomRange(start, end, today)
  const incomplete = start === '' || end === ''

  return (
    <form
      className="p-3 pt-1"
      onSubmit={(event) => {
        event.preventDefault()
        if (error !== null || incomplete) return
        onApply({ kind: 'custom', start, end })
      }}
    >
      <div className="flex gap-3">
        <DateField label="Start" value={start} max={today} onChange={setStart} />
        <DateField label="End" value={end} max={today} onChange={setEnd} />
      </div>

      {/*
        Live so the message is announced when it appears, and the button is disabled as well — an
        error that only shows on submit means finding out after committing to the change.
      */}
      <p
        role="status"
        className={cn(
          'mt-2 min-h-5 px-1 text-xs',
          error === null ? 'text-transparent' : 'text-rose-600 dark:text-rose-400',
        )}
      >
        {error === null ? '.' : ERROR_TEXT[error]}
      </p>

      <button
        type="submit"
        disabled={error !== null || incomplete}
        className={cn(
          'mt-1 min-h-12 w-full rounded-xl text-sm font-semibold',
          'bg-sky-600 text-white hover:bg-sky-500',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500',
          'disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400',
          'dark:disabled:bg-slate-800 dark:disabled:text-slate-600',
        )}
      >
        Apply
      </button>
    </form>
  )
}

function DateField({
  label,
  value,
  max,
  onChange,
}: {
  label: string
  value: string
  max: string
  onChange: (value: string) => void
}): ReactNode {
  return (
    <label className="flex-1 text-xs font-medium text-slate-600 dark:text-slate-400">
      {label}
      <input
        type="date"
        value={value}
        max={max}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          'mt-1 block min-h-11 w-full rounded-lg border px-3 text-sm',
          'border-slate-300 bg-white text-slate-900',
          'dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100',
          'focus-visible:outline-2 focus-visible:outline-sky-500',
        )}
      />
    </label>
  )
}
