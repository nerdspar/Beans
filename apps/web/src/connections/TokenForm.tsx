import { CONNECTION_COPY } from '@beans/shared'
import { useState, type FormEvent, type ReactNode } from 'react'
import { cn } from '../lib/cn.js'

/**
 * The setup-token form, used for both claiming a connection and replacing its credential.
 *
 * A SimpleFIN setup token is a long base64 blob, so every browser convenience that might rewrite it
 * is turned off — autocorrect and autocapitalize would silently corrupt it, and a password manager
 * offering to remember it helps nobody.
 */
export function TokenForm({
  title,
  blurb,
  action,
  pendingLabel,
  isPending,
  error,
  onSubmit,
  onCancel,
}: {
  title: string
  blurb: string
  action: string
  pendingLabel: string
  isPending: boolean
  error: string | null
  onSubmit: (token: string) => void
  onCancel: () => void
}): ReactNode {
  const [token, setToken] = useState('')

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (token.trim().length > 0 && !isPending) onSubmit(token.trim())
  }

  return (
    <form className="mx-auto max-w-md px-5 pb-16 pt-6" onSubmit={submit}>
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{blurb}</p>

      <label className="mt-5 block text-xs font-medium text-slate-600 dark:text-slate-400">
        {CONNECTION_COPY.setupTokenLabel}
        <textarea
          value={token}
          onChange={(event) => setToken(event.target.value)}
          rows={4}
          // A setup token is a long base64 blob. `off` everywhere because a browser offering to
          // remember or autocorrect it is only ever going to corrupt it.
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className={cn(
            'mt-1 block w-full rounded-lg border p-3 font-mono text-xs break-all',
            'border-slate-300 bg-white text-slate-900',
            'dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100',
            'focus-visible:outline-2 focus-visible:outline-sky-500',
          )}
        />
      </label>

      <p role="alert" className="mt-2 min-h-5 text-xs text-rose-600 dark:text-rose-400">
        {error}
      </p>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="min-h-12 flex-1 rounded-xl border border-slate-300 text-sm font-semibold hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={token.trim().length === 0 || isPending}
          className={cn(
            'min-h-12 flex-1 rounded-xl text-sm font-semibold',
            'bg-sky-600 text-white hover:bg-sky-500',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500',
            'disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400',
            'dark:disabled:bg-slate-800 dark:disabled:text-slate-600',
          )}
        >
          {isPending ? pendingLabel : action}
        </button>
      </div>
    </form>
  )
}
