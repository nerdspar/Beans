import { type ReactNode } from 'react'
import type { Destination } from '../navigation/destinations.js'

/**
 * A stand-in until each screen is built.
 *
 * Exists so the shells can be navigated and judged for feel now, rather than only once there is
 * something to put in them — the scroll-linked net worth behavior in particular needs the chrome
 * settled before it can be worked on.
 */
export function Placeholder({ destination }: { destination: Destination }): ReactNode {
  const Icon = destination.icon

  return (
    <div className="mx-auto max-w-3xl p-6">
      <header className="mb-6 flex items-center gap-3">
        <Icon className="size-6 text-sky-600 dark:text-sky-400" aria-hidden />
        <h1 className="text-xl font-semibold tracking-tight">{destination.label}</h1>
      </header>

      <p className="text-sm text-slate-500 dark:text-slate-400">Not built yet.</p>

      {/* Enough height to exercise scrolling under the bottom bar. */}
      <div className="mt-6 space-y-2" aria-hidden>
        {Array.from({ length: 24 }, (_, index) => (
          <div
            key={index}
            className="h-14 rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
          />
        ))}
      </div>
    </div>
  )
}
