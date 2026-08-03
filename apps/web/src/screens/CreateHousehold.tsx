import { AUTH_COPY } from '@beans/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import { cn } from '../lib/cn.js'

/**
 * The step between signing up and having anywhere to put money.
 *
 * A user exists the moment they sign up; a household does not, and every financial table is keyed to
 * one. Without this screen a new account signs in successfully and lands on a net worth page that
 * can only tell them they have no household — a dead end reachable by doing everything right.
 */

export function CreateHousehold(): ReactNode {
  const [name, setName] = useState('')
  const queryClient = useQueryClient()

  const create = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/households', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      })

      if (!response.ok) throw new Error(AUTH_COPY.householdFailed)
    },
    onSuccess: async () => {
      // The working set query is what reports "no household"; re-running it is what moves the user
      // on, rather than a redirect this screen would have to know how to perform.
      await queryClient.invalidateQueries()
    },
  })

  const canSubmit = name.trim().length > 0

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault()
    if (canSubmit && !create.isPending) create.mutate()
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-12">
      <h1 className="text-2xl font-semibold">{AUTH_COPY.householdTitle}</h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{AUTH_COPY.householdBlurb}</p>

      <form className="mt-6" onSubmit={onSubmit}>
        <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
          {AUTH_COPY.householdNameLabel}
          <input
            type="text"
            value={name}
            autoComplete="off"
            placeholder={AUTH_COPY.householdPlaceholder}
            onChange={(event) => setName(event.target.value)}
            className={cn(
              'mt-1 block min-h-12 w-full rounded-lg border px-3 text-base',
              'border-slate-300 bg-white text-slate-900',
              'dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100',
              'focus-visible:outline-2 focus-visible:outline-sky-500',
            )}
          />
        </label>

        <p role="alert" className="mt-2 min-h-5 text-xs text-rose-600 dark:text-rose-400">
          {create.error instanceof Error ? create.error.message : null}
        </p>

        <button
          type="submit"
          disabled={!canSubmit || create.isPending}
          className={cn(
            'mt-2 min-h-12 w-full rounded-xl text-sm font-semibold',
            'bg-sky-600 text-white hover:bg-sky-500',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500',
            'disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400',
            'dark:disabled:bg-slate-800 dark:disabled:text-slate-600',
          )}
        >
          {create.isPending ? AUTH_COPY.working : AUTH_COPY.createHousehold}
        </button>
      </form>
    </div>
  )
}
