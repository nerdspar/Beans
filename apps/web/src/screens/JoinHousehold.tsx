import { HOUSEHOLD_COPY } from '@beans/shared'
import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, type ReactNode } from 'react'
import { clearPendingInvite, readPendingInvite } from '../auth/pending-invite.js'
import { joinHousehold } from '../household/api.js'
import { cn } from '../lib/cn.js'

/**
 * Accepting an invite, immediately after signing in.
 *
 * Runs before the household gate rather than after it. The order is the whole point: a household is
 * created automatically for anyone who does not have one, so letting that run first would give an
 * invited person their own empty household and — with one household per user in v1 — no way left to
 * accept the invite they arrived holding.
 */
export function JoinHousehold(): ReactNode {
  const token = readPendingInvite()
  const started = useRef(false)

  const join = useMutation({
    mutationFn: () => joinHousehold(token ?? ''),
    onSuccess: () => {
      clearPendingInvite()
      /*
       * A full reload, matching sign-in and household creation. Membership changes which household
       * every subsequent query is scoped to, and the working-set sync that reports "no household"
       * is parked in an error state with retries disabled — invalidating it from here worked only
       * sometimes, which is worse than not working at all.
       */
      window.location.assign('/')
    },
  })

  // Guarded against StrictMode's deliberate double-invoke: an invite is single-use, so the second
  // call would consume nothing and report "already used" over a join that had just succeeded.
  useEffect(() => {
    if (started.current || token === null) return
    started.current = true
    join.mutate()
  }, [join, token])

  const dismiss = (): void => {
    clearPendingInvite()
    window.location.assign('/')
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6">
      <h1 className="text-2xl font-semibold">{HOUSEHOLD_COPY.joinHeading}</h1>

      {join.error instanceof Error ? (
        <>
          <p role="alert" className="mt-2 text-sm text-rose-600 dark:text-rose-400">
            {join.error.message}
          </p>
          {/* Never a dead end: a failed join still leaves a usable account behind. */}
          <button
            type="button"
            onClick={dismiss}
            className={cn(
              'mt-5 min-h-12 w-full rounded-xl text-sm font-semibold',
              'bg-sky-600 text-white hover:bg-sky-500',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500',
            )}
          >
            {HOUSEHOLD_COPY.joinContinue}
          </button>
        </>
      ) : (
        <p role="status" className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          {HOUSEHOLD_COPY.joining}…
        </p>
      )}
    </main>
  )
}
