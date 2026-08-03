import * as Dialog from '@radix-ui/react-dialog'
import { type ReactNode } from 'react'
import { Link } from 'wouter'
import { cn } from '../../lib/cn.js'
import type { Destination } from '../../navigation/destinations.js'

/**
 * The fifth slot: everything that did not fit, plus settings.
 *
 * A sheet rather than a page, per the app idiom — it slides over the current screen and dismisses
 * back to it, so tapping More never loses your place.
 *
 * Built on Radix rather than a hand-rolled overlay because focus trapping, restoring focus on
 * close, Escape handling, scroll locking and `aria-modal` are all things that must be right for
 * this to be usable with a keyboard or a screen reader, and all things that are quietly wrong in
 * most hand-rolled versions.
 */
export function MoreSheet({
  open,
  onOpenChange,
  destinations,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  destinations: readonly Destination[]
}): ReactNode {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-slate-950/40 backdrop-blur-sm',
            'data-[state=open]:animate-in data-[state=open]:fade-in',
            // Honors prefers-reduced-motion: the sheet still opens, it just does not slide.
            'motion-reduce:animate-none',
          )}
        />

        <Dialog.Content
          className={cn(
            'fixed inset-x-0 bottom-0 z-50 rounded-t-2xl',
            'border-t border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900',
            /*
             * Text colour is set here rather than inherited. Radix renders the sheet through a
             * portal at the document root, outside the shell element that establishes colour — so
             * without this the title inherits the browser default and comes out black on a dark
             * sheet.
             */
            'text-slate-900 dark:text-slate-100',
            'pb-[env(safe-area-inset-bottom)]',
            'motion-reduce:animate-none',
          )}
        >
          {/* A grab handle, matching the platform affordance for a dismissible sheet. */}
          <div className="flex justify-center pt-3" aria-hidden>
            <div className="h-1 w-10 rounded-full bg-slate-300 dark:bg-slate-700" />
          </div>

          <Dialog.Title className="px-5 pt-3 text-base font-semibold">More</Dialog.Title>
          <Dialog.Description className="sr-only">
            Everything not shown in the tab bar.
          </Dialog.Description>

          <ul className="grid grid-cols-2 gap-1 p-4">
            {destinations.map((destination) => {
              const Icon = destination.icon
              return (
                <li key={destination.key}>
                  <Link
                    href={destination.path}
                    onClick={() => onOpenChange(false)}
                    className={cn(
                      'flex min-h-14 items-center gap-3 rounded-xl px-4 py-3',
                      'text-sm font-medium text-slate-700 dark:text-slate-200',
                      'hover:bg-slate-100 dark:hover:bg-slate-800',
                      'focus-visible:outline-2 focus-visible:outline-sky-500',
                    )}
                  >
                    <Icon className="size-5 text-slate-500 dark:text-slate-400" aria-hidden />
                    {destination.label}
                  </Link>
                </li>
              )
            })}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
