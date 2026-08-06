import { type ReactNode } from 'react'
import { LogOut } from 'lucide-react'
import { Link, useLocation } from 'wouter'
import { AUTH_COPY, SHELL_COPY } from '@beans/shared'
import { useSignOut } from '../../auth/use-session.js'
import { cn } from '../../lib/cn.js'
import { MAIN_REGION_ID, SkipLink } from '../../lib/main-region.js'
import { destinationForPath } from '../../navigation/destinations.js'
import { useTabOrder } from '../../navigation/use-tab-order.js'

/**
 * The desktop shell.
 *
 * A **persistent sidebar**, not a hamburger — the width is there, so hiding navigation behind a
 * tap is spending a click to buy nothing.
 *
 * The other half of this shell is the content area, which is deliberately a two-pane grid rather
 * than a single scrolling column. Where mobile stacks a chart above a list, desktop fixes the chart
 * beside the list so it stays visible while the user moves through accounts. `DesktopPanes` below
 * is what screens use to opt into that.
 *
 * A **separate component tree** from the mobile shell, but not a separate navigation order. This
 * used to render the static registry on the reasoning that the preference configured a bar which
 * does not exist here — true of the *four slots*, and wrong about the ordering. The effect was a
 * setting that silently applied to half the app: reorder navigation on a phone, open a laptop, find
 * it unchanged.
 *
 * So the same list drives both, read to different depths. The sidebar has room for everything and
 * still shows everything; it just shows it in the order the reader asked for.
 */
export function DesktopShell({ children }: { children: ReactNode }): ReactNode {
  const [location] = useLocation()
  const active = destinationForPath(location)

  const { signOut, isPending } = useSignOut()

  /*
   * The same preference the bottom bar reads, to its full depth rather than its first four. The
   * sidebar used to render the static registry, so reordering navigation on a phone changed nothing
   * here — the setting quietly applied to half the app.
   */
  const { ordered } = useTabOrder()

  return (
    <div className="relative flex min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      {/* First in the DOM so the first Tab reaches it, before the whole sidebar. */}
      <SkipLink />

      <nav
        aria-label="Primary"
        className={cn(
          'sticky top-0 flex h-screen w-60 shrink-0 flex-col',
          'border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900',
        )}
      >
        <div className="px-5 py-5 text-lg font-semibold tracking-tight">Beans</div>

        <ul className="flex-1 space-y-0.5 px-3">
          {ordered.map((destination) => {
            const Icon = destination.icon
            const isActive = active?.key === destination.key

            return (
              <li key={destination.key}>
                <Link
                  href={destination.path}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                    'focus-visible:outline-2 focus-visible:outline-sky-500',
                    isActive
                      ? 'bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300'
                      : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
                  )}
                >
                  <Icon className="size-4.5" aria-hidden />
                  {destination.label}
                </Link>
              </li>
            )
          })}
        </ul>

        {/* Pinned to the bottom of the sidebar, away from the destinations it is not one of. */}
        <div className="border-t border-slate-200 p-3 dark:border-slate-800">
          <button
            type="button"
            onClick={signOut}
            disabled={isPending}
            className={cn(
              'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium',
              'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
              'focus-visible:outline-2 focus-visible:outline-sky-500 disabled:opacity-50',
            )}
          >
            <LogOut className="size-4.5" aria-hidden />
            {AUTH_COPY.signOut}
          </button>
        </div>
      </nav>

      {/*
        `tabIndex={-1}` makes this focusable by script and by the skip link without putting it in
        the tab order itself. Without it the skip link moves the *page* but not the focus, and the
        next Tab carries on from the navigation the reader just skipped.
      */}
      <main
        id={MAIN_REGION_ID}
        tabIndex={-1}
        aria-label={SHELL_COPY.mainRegion}
        className="min-w-0 flex-1 focus:outline-none"
      >
        {children}
      </main>
    </div>
  )
}

/**
 * The two-pane desktop layout: a fixed summary pane beside a scrolling list.
 *
 * The aside is `sticky` rather than `fixed` so it participates in the grid and cannot overlap the
 * list at narrow widths. Keeping the chart visible while the list scrolls under it is the whole
 * reason desktop is a separate shell — on mobile the same content stacks, and stacking here would
 * waste the width that justifies the layout.
 */
export function DesktopPanes({
  aside,
  children,
}: {
  aside: ReactNode
  children: ReactNode
}): ReactNode {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_28rem] gap-6 p-6">
      <div className="min-w-0">{children}</div>
      <aside className="sticky top-6 h-fit">{aside}</aside>
    </div>
  )
}
