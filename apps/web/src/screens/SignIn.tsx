import { AUTH_COPY } from '@beans/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import { SESSION_KEY, useCapabilities } from '../auth/use-session.js'
import { cn } from '../lib/cn.js'

/**
 * Signing in and signing up.
 *
 * One screen with a mode toggle rather than two routes: the fields differ by exactly one, and the
 * common case for a self-hosted app is a household of two people who each do this once. A second
 * route for a form used twice ever is not worth the navigation.
 *
 * Credentials go straight to Better Auth over the same origin and are never held anywhere but React
 * state for the duration of the submit.
 */

const MIN_PASSWORD_LENGTH = 8

type Mode = 'sign-in' | 'sign-up'

export function SignIn(): ReactNode {
  const [mode, setMode] = useState<Mode>('sign-in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')

  const capabilities = useCapabilities()
  const queryClient = useQueryClient()

  const submit = useMutation({
    mutationFn: async () => {
      const path = mode === 'sign-in' ? '/api/auth/sign-in/email' : '/api/auth/sign-up/email'
      const body =
        mode === 'sign-in' ? { email, password } : { email, password, name: name.trim() || email }

      /*
       * A failure to reach the server is not a failure to authenticate, and must not be reported as
       * one. Telling somebody their password was wrong when the API was simply down sends them off
       * to reset a password that was never the problem — and on a self-hosted app, "the server is
       * not answering" is genuinely actionable where "wrong password" is not.
       */
      let response: Response
      try {
        response = await fetch(path, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      } catch {
        throw new Error(AUTH_COPY.offline)
      }

      // 5xx is the server failing, not the credentials being refused. Better Auth answers 401/422
      // for a genuine mismatch.
      if (response.status >= 500) {
        throw new Error(AUTH_COPY.offline)
      }

      /*
       * Throttling is a wait, not a rejection, and must never be reported as one. Sign-up allows
       * three attempts per five minutes and sign-in five per minute, so this is reachable by a
       * household setting up two accounts — and read as "wrong password" it sends somebody to reset
       * a password that was fine. `x-retry-after` carries the remaining seconds.
       */
      if (response.status === 429) {
        throw new Error(
          AUTH_COPY.rateLimited(Number(response.headers.get('x-retry-after') ?? 0) || 0),
        )
      }

      if (!response.ok) {
        /*
         * The server's own message wins when it has one — "User already exists" is both true and
         * actionable, where a guess from here is neither. The generic is only for a failure the
         * server declined to explain.
         */
        const body = (await response.json().catch(() => null)) as { message?: string } | null
        throw new Error(
          body?.message ?? (mode === 'sign-in' ? AUTH_COPY.signInFailed : AUTH_COPY.signUpFailed),
        )
      }
    },
    onSuccess: async () => {
      // The session cookie is set; re-reading it is what flips the app out of this screen.
      await queryClient.invalidateQueries({ queryKey: SESSION_KEY })
    },
  })

  /*
   * Editing clears the last failure. A rejection that stays on screen while the user retypes is
   * reporting on input they have already replaced, and reads as the new attempt failing before it
   * was made — which is exactly the moment somebody starts doubting they know their own password.
   */
  const edit = (set: (value: string) => void) => (value: string) => {
    if (submit.isError) submit.reset()
    set(value)
  }

  const tooShort = mode === 'sign-up' && password.length > 0 && password.length < MIN_PASSWORD_LENGTH
  const canSubmit = email.trim().length > 0 && password.length > 0 && !tooShort

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault()
    if (canSubmit && !submit.isPending) submit.mutate()
  }

  const error = tooShort
    ? AUTH_COPY.passwordTooShort
    : submit.error instanceof Error
      ? submit.error.message
      : null

  return (
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-12">
      <h1 className="text-2xl font-semibold">
        {mode === 'sign-in' ? AUTH_COPY.signInTitle : AUTH_COPY.signUpTitle}
      </h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        {mode === 'sign-in' ? AUTH_COPY.signInBlurb : AUTH_COPY.signUpBlurb}
      </p>

      <form className="mt-6" onSubmit={onSubmit}>
        {mode === 'sign-up' && (
          <Field
            label={AUTH_COPY.name}
            type="text"
            autoComplete="name"
            value={name}
            onChange={edit(setName)}
          />
        )}

        <Field
          label={AUTH_COPY.email}
          type="email"
          autoComplete="email"
          value={email}
          onChange={edit(setEmail)}
          required
        />

        <Field
          label={AUTH_COPY.password}
          type="password"
          // Tells a password manager which of the two this is, so it offers to fill rather than to
          // save on sign-in, and to generate on sign-up.
          autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
          value={password}
          onChange={edit(setPassword)}
          required
        />

        {/*
          Reserved height, so the form does not jump when a message appears. `role="alert"` because
          a submit failure is exactly the moment a screen reader user needs to be interrupted.
        */}
        <p role="alert" className="mt-2 min-h-5 text-xs text-rose-600 dark:text-rose-400">
          {error}
        </p>

        <button
          type="submit"
          disabled={!canSubmit || submit.isPending}
          className={cn(
            'mt-2 min-h-12 w-full rounded-xl text-sm font-semibold',
            'bg-sky-600 text-white hover:bg-sky-500',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500',
            'disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400',
            'dark:disabled:bg-slate-800 dark:disabled:text-slate-600',
          )}
        >
          {submit.isPending
            ? AUTH_COPY.working
            : mode === 'sign-in'
              ? AUTH_COPY.signIn
              : AUTH_COPY.signUp}
        </button>
      </form>

      {capabilities.googleSignIn && (
        <>
          <div className="my-5 flex items-center gap-3" aria-hidden>
            <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
            <span className="text-xs text-slate-400">{AUTH_COPY.or}</span>
            <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
          </div>

          {/*
           * A full navigation, not fetch. The OAuth flow leaves the origin and comes back, and an
           * XHR cannot carry the browser through a third-party consent screen.
           */}
          <a
            href="/api/auth/sign-in/google"
            className={cn(
              'flex min-h-12 w-full items-center justify-center rounded-xl border text-sm font-semibold',
              'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800',
              'focus-visible:outline-2 focus-visible:outline-sky-500',
            )}
          >
            {AUTH_COPY.google}
          </a>
        </>
      )}

      <button
        type="button"
        onClick={() => {
          setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')
          submit.reset()
        }}
        className="mt-6 text-sm font-medium text-sky-600 hover:underline dark:text-sky-400"
      >
        {mode === 'sign-in' ? AUTH_COPY.toSignUp : AUTH_COPY.toSignIn}
      </button>
    </div>
  )
}

function Field({
  label,
  type,
  autoComplete,
  value,
  onChange,
  required,
}: {
  label: string
  type: 'text' | 'email' | 'password'
  autoComplete: string
  value: string
  onChange: (value: string) => void
  required?: boolean
}): ReactNode {
  return (
    <label className="mt-3 block text-xs font-medium text-slate-600 dark:text-slate-400">
      {label}
      <input
        type={type}
        autoComplete={autoComplete}
        value={value}
        required={required ?? false}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          'mt-1 block min-h-12 w-full rounded-lg border px-3 text-base',
          'border-slate-300 bg-white text-slate-900',
          'dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100',
          'focus-visible:outline-2 focus-visible:outline-sky-500',
        )}
      />
    </label>
  )
}
