import type { ReactNode } from 'react'

/**
 * Page chrome for a destination reached from More.
 *
 * These screens were built as panels embedded in settings, so none of them carries a title or a
 * container of its own. This supplies both, in one place, rather than four near-identical wrappers.
 *
 * **No back control.** These are top-level destinations, like Net worth or Accounts — the tab bar
 * is how you leave. A back button would imply somewhere specific to go back *to*, and there is not
 * one: you can arrive here from the More sheet, the desktop sidebar, or a bookmark.
 */
export function ManagementPage({
  title,
  blurb,
  children,
}: {
  title: string
  /** One line on what this screen is for, where that is not obvious from the title. */
  blurb?: string
  children: ReactNode
}): ReactNode {
  return (
    /*
     * The same container and title as every browsing screen — `max-w-2xl`, the same padding, the
     * same `text-2xl` heading. It was `max-w-3xl p-6` with a smaller title, which made Categories
     * and Household read as a different kind of page from Accounts and Portfolio. They are not:
     * they are top-level destinations reached the same way, and looking like a settings sub-page
     * was a leftover from when they genuinely were one.
     */
    <div className="mx-auto max-w-2xl px-5 pb-16 pt-6">
      <h1 className="text-2xl font-semibold">{title}</h1>
      {blurb !== undefined && (
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{blurb}</p>
      )}
      <div className="mt-5">{children}</div>
    </div>
  )
}
