import { useState, type ReactNode } from 'react'
import { Link, useLocation } from 'wouter'
import { MoreHorizontal } from 'lucide-react'
import { cn } from '../../lib/cn.js'
import {
  destinationForPath,
  overflowDestinations,
  type Destination,
} from '../../navigation/destinations.js'
import { useTabOrder } from '../../navigation/use-tab-order.js'
import { MoreSheet } from './MoreSheet.js'

/**
 * The mobile shell.
 *
 * Follows the app idiom rather than the web one: a fixed bottom bar that content scrolls *under*,
 * sheets instead of new pages, thumb-sized targets, and momentum scrolling. It should be
 * indistinguishable from an installed app once added to the home screen.
 *
 * This is a **separate component tree** from the desktop shell, not the same one with breakpoint
 * conditionals — that is how both layouts end up mediocre. All data logic, hooks and formatting are
 * shared; only the geometry differs.
 */
export function MobileShell({ children }: { children: ReactNode }): ReactNode {
  const [location] = useLocation()
  const { tabs } = useTabOrder()
  const [moreOpen, setMoreOpen] = useState(false)

  const active = destinationForPath(location)
  const overflow = overflowDestinations(tabs)
  // More stays lit while you are inside anything it contains, so the bar never shows nothing active.
  const activeInOverflow = active !== undefined && overflow.some((d) => d.key === active.key)

  return (
    <div className="flex min-h-[100dvh] flex-col bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      {/*
        Padded by the bar's height plus the home-indicator inset, so the last row of a list is not
        permanently hidden behind the chrome.
      */}
      <main className="flex-1 pb-[calc(4rem+env(safe-area-inset-bottom))]">{children}</main>

      <nav
        aria-label="Primary"
        className={cn(
          'fixed inset-x-0 bottom-0 z-40',
          'border-t border-slate-200 bg-white/95 backdrop-blur',
          'dark:border-slate-800 dark:bg-slate-900/95',
          // Respects the iPhone home indicator. Without this the bar sits under it and the last
          // few pixels of every tap target are unreachable.
          'pb-[env(safe-area-inset-bottom)]',
        )}
      >
        <ul className="mx-auto flex h-16 max-w-lg items-stretch">
          {tabs.map((tab) => (
            <TabButton key={tab.key} destination={tab} active={active?.key === tab.key} />
          ))}

          <li className="flex-1">
            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
              className={cn(
                'flex h-full w-full flex-col items-center justify-center gap-1',
                // 44pt minimum, the platform guidance for a reliable thumb target.
                'min-h-11 text-xs font-medium transition-colors',
                'focus-visible:outline-2 focus-visible:outline-offset--2 focus-visible:outline-sky-500',
                activeInOverflow
                  ? 'text-sky-600 dark:text-sky-400'
                  : 'text-slate-500 dark:text-slate-400',
              )}
            >
              <MoreHorizontal className="size-6" aria-hidden />
              <span>More</span>
            </button>
          </li>
        </ul>
      </nav>

      <MoreSheet open={moreOpen} onOpenChange={setMoreOpen} destinations={overflow} />
    </div>
  )
}

function TabButton({
  destination,
  active,
}: {
  destination: Destination
  active: boolean
}): ReactNode {
  const Icon = destination.icon

  return (
    <li className="flex-1">
      <Link
        href={destination.path}
        // The only reliable signal for a screen reader that this is the current screen; colour
        // alone conveys nothing.
        aria-current={active ? 'page' : undefined}
        onClick={(event) => {
          // Tapping the tab you are already on returns to the top, the way a native tab bar does.
          // A sub-route navigates back to the section root instead, which the Link already handles.
          if (active && window.location.pathname === destination.path) {
            event.preventDefault()
            window.scrollTo({ top: 0, behavior: 'smooth' })
          }
        }}
        className={cn(
          'flex h-full w-full flex-col items-center justify-center gap-1',
          'min-h-11 text-xs font-medium transition-colors',
          'focus-visible:outline-2 focus-visible:outline-offset--2 focus-visible:outline-sky-500',
          active ? 'text-sky-600 dark:text-sky-400' : 'text-slate-500 dark:text-slate-400',
        )}
      >
        <Icon className="size-6" aria-hidden />
        <span>{destination.short}</span>
      </Link>
    </li>
  )
}
