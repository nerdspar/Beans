import { SHELL_COPY } from '@beans/shared'
import { useEffect, useRef, type ReactNode } from 'react'
import { useLocation } from 'wouter'

/**
 * Getting to the content, and landing on it after a navigation.
 *
 * Two problems that look separate and are the same one: where the keyboard is.
 *
 * A single-page app moves focus nowhere when the route changes. The URL changes, the screen is
 * replaced, and focus stays on the tab that was clicked — so the next Tab continues through the
 * navigation the reader has already finished with, and a screen reader announces nothing at all,
 * because from its point of view nothing happened. The reader is on a new screen with no way to
 * know it and no way to reach it except tabbing past every destination again.
 *
 * The skip link is the same problem before the first navigation: without it, reaching the content
 * means tabbing through the whole tab bar on every single load.
 */

/** The id the skip link targets and the focus lands on. One region, one name. */
export const MAIN_REGION_ID = 'beans-main'

/**
 * The first focusable thing in the document, visible only while focused.
 *
 * `sr-only focus:not-sr-only` is the whole trick: it occupies no space and is unreachable by
 * pointer until a Tab reveals it, so it costs a sighted mouse user nothing and saves a keyboard
 * user the entire navigation on every load.
 */
export function SkipLink(): ReactNode {
  return (
    <a
      href={`#${MAIN_REGION_ID}`}
      className="sr-only rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 dark:bg-slate-100 dark:text-slate-900"
    >
      {SHELL_COPY.skipToContent}
    </a>
  )
}

/**
 * Moves focus to the main region when the route changes.
 *
 * Not on first render. On load the browser has already put focus at the top of the document, which
 * is where a reader expects to start — stealing it to the content would skip the navigation before
 * anyone asked to.
 *
 * `preventScroll` matters more here than it looks. The net worth screen drives its chart from the
 * scroll position, so a focus call that also scrolled would reset the category to the top one every
 * time the reader arrived — a visible, wrong change to the screen, caused by an accessibility fix.
 */
export function useRouteFocus(): void {
  const [location] = useLocation()
  const isFirst = useRef(true)

  useEffect(() => {
    if (isFirst.current) {
      isFirst.current = false
      return
    }

    const main = document.getElementById(MAIN_REGION_ID)
    main?.focus({ preventScroll: true })
  }, [location])
}
