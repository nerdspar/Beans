import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from './cn.js'

/**
 * An explanation that is worth having and not worth reading twice.
 *
 * Some things genuinely need saying — why an investment chart starts where it does, why a return
 * percentage disagrees with the balance. Each of those has cost real hours of confusion, and a
 * screen that omits them sends the reader to check their bank instead. But they only need saying
 * *once*. Printed permanently under a chart, an explanation stops being read by the third visit,
 * and everything around it gets a little less legible for its presence.
 *
 * So: the question is always visible, the answer is one tap away. Someone who has never wondered
 * skips a short line; someone who is wondering has the answer exactly where the question occurred
 * to them, rather than in documentation they would have to know exists.
 *
 * Native `<details>` rather than a tooltip. A tooltip needs a hover, which phones do not have, and
 * a popover library, which is a dependency and a focus trap to get wrong. This is keyboard
 * operable, screen-reader announced as expandable, and findable by the browser's own in-page search
 * even while collapsed — none of which is true of a tooltip, and all for no JavaScript at all.
 */

export function InfoNote({
  question,
  children,
  className,
}: {
  /** What the reader is wondering, phrased as they would ask it. Not "Note" or "Details". */
  question: string
  children: ReactNode
  className?: string
}): ReactNode {
  return (
    <details className={cn('group mt-1 text-[11px] text-slate-500 dark:text-slate-400', className)}>
      <summary
        className={cn(
          'flex cursor-pointer list-none items-center gap-1 rounded',
          'hover:text-slate-700 dark:hover:text-slate-200',
          'focus-visible:outline-2 focus-visible:outline-sky-500',
          // Safari renders a disclosure triangle through `list-none`; this removes it so the
          // chevron below is the only marker and the two do not both appear.
          '[&::-webkit-details-marker]:hidden',
        )}
      >
        <ChevronRight
          className="size-3 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none"
          aria-hidden
        />
        {question}
      </summary>
      <p className="mt-1 pl-4">{children}</p>
    </details>
  )
}
