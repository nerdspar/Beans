import { AUTH_COPY, HOUSEHOLD_COPY } from '@beans/shared'
import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, type ReactNode } from 'react'
import { ensureHousehold } from '../household/api.js'
import { cn } from '../lib/cn.js'

/**
 * The household a signed-in user does not yet have, created without asking.
 *
 * A user exists the moment they sign up; a household does not, and every financial table is keyed
 * to one — so something has to create it before the app is usable. This used to be a form asking
 * for a name, which is a strange first thing to demand: a household of one needs no name, and the
 * person being asked has no concept yet of what it is for. The name is asked for on the household
 * page instead, at the point it starts to matter, which is when somebody else is about to see it.
 *
 * Deliberately **not** reached when an invite is pending — see the gate in App.tsx. Creating a
 * household for an invited person would consume their one allowed membership and strand them.
 */
export function CreateHousehold(): ReactNode {
  const started = useRef(false)

  const create = useMutation({
    mutationFn: () => ensureHousehold(HOUSEHOLD_COPY.defaultName),
    /*
     * Reload, matching sign-in and sign-out. The query that reports "no household" is the
     * working-set sync, which is parked in an error state with retries disabled — invalidating it
     * from here worked only sometimes, which is worse than not working at all.
     */
    onSuccess: () => {
      window.location.assign('/')
    },
  })

  // StrictMode invokes effects twice; `ensureHousehold` dedupes as well, so this is belt and
  // braces against creating two households for one person.
  useEffect(() => {
    if (started.current) return
    started.current = true
    create.mutate()
  }, [create])

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6">
      {create.error instanceof Error ? (
        <>
          <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
            {AUTH_COPY.householdFailed}
          </p>
          <button
            type="button"
            onClick={() => create.mutate()}
            disabled={create.isPending}
            className={cn(
              'mt-5 min-h-12 w-full rounded-xl text-sm font-semibold',
              'bg-sky-600 text-white hover:bg-sky-500 disabled:opacity-50',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500',
            )}
          >
            {AUTH_COPY.retry}
          </button>
        </>
      ) : (
        // Near-instant in practice, so this is a fallback for a slow connection rather than a
        // step the user is expected to watch.
        <p role="status" className="text-sm text-slate-500 dark:text-slate-400">
          {AUTH_COPY.settingUp}
        </p>
      )}
    </main>
  )
}
