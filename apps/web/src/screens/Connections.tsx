import { CONNECTION_COPY, assessConnection, describeAge, toIsoDate } from '@beans/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, RefreshCw } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import {
  claimSetupToken,
  confirmAccounts,
  listConnections,
  reconnectConnection,
  syncConnection,
  type AccountConfirmation,
  type ConnectionSummary,
  type Discovery,
} from '../connections/api.js'
import { ConfirmAccounts } from '../connections/ConfirmAccounts.js'
import { cn } from '../lib/cn.js'
import { WORKING_SET_KEY } from '../working-set/use-working-set.js'

/**
 * Connecting institutions, and the health of the ones already connected.
 *
 * The flow is claim → confirm → sync, and confirmation is the part that matters: SimpleFIN does not
 * specify balance signs, so a human has to look at the numbers once before they count toward net
 * worth. See {@link ConfirmAccounts}.
 */

type Stage =
  | { kind: 'list' }
  | { kind: 'claim' }
  | { kind: 'confirm'; discovery: Discovery }
  | { kind: 'reconnect'; connectionId: string }
  | { kind: 'done'; summary: string }

export function Connections(): ReactNode {
  const [stage, setStage] = useState<Stage>({ kind: 'list' })
  const queryClient = useQueryClient()

  const connections = useQuery({ queryKey: ['connections'], queryFn: listConnections })

  /** A new connection changes accounts and balances, so the working set has to be re-read. */
  const refreshEverything = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['connections'] })
    await queryClient.invalidateQueries({ queryKey: ['working-set'] })
    await queryClient.invalidateQueries({ queryKey: WORKING_SET_KEY })
  }

  const claim = useMutation({
    mutationFn: claimSetupToken,
    onSuccess: (discovery) => setStage({ kind: 'confirm', discovery }),
  })

  const confirm = useMutation({
    mutationFn: ({ id, accounts }: { id: string; accounts: AccountConfirmation[] }) =>
      confirmAccounts(id, accounts),
    onSuccess: async (result) => {
      await refreshEverything()
      setStage({
        kind: 'done',
        summary: CONNECTION_COPY.accountsConnected(result.created, result.updated),
      })
    },
  })

  const reconnect = useMutation({
    mutationFn: ({ id, token }: { id: string; token: string }) => reconnectConnection(id, token),
    onSuccess: async () => {
      await refreshEverything()
      setStage({ kind: 'list' })
    },
  })

  if (stage.kind === 'confirm') {
    return (
      <ConfirmAccounts
        accounts={stage.discovery.accounts}
        errors={stage.discovery.errors}
        isPending={confirm.isPending}
        error={confirm.error instanceof Error ? confirm.error.message : null}
        onConfirm={(accounts) => confirm.mutate({ id: stage.discovery.connectionId, accounts })}
      />
    )
  }

  if (stage.kind === 'claim') {
    return (
      <TokenForm
        title={CONNECTION_COPY.connectTitle}
        blurb={CONNECTION_COPY.setupTokenHelp}
        action={CONNECTION_COPY.claim}
        pendingLabel={CONNECTION_COPY.claiming}
        isPending={claim.isPending}
        error={claim.error instanceof Error ? claim.error.message : null}
        onCancel={() => {
          claim.reset()
          setStage({ kind: 'list' })
        }}
        onSubmit={(token) => claim.mutate(token)}
      />
    )
  }

  if (stage.kind === 'reconnect') {
    return (
      <TokenForm
        title={CONNECTION_COPY.reconnectTitle}
        blurb={CONNECTION_COPY.reconnectBlurb}
        action={CONNECTION_COPY.reconnectAction}
        pendingLabel={CONNECTION_COPY.claiming}
        isPending={reconnect.isPending}
        error={reconnect.error instanceof Error ? reconnect.error.message : null}
        onCancel={() => {
          reconnect.reset()
          setStage({ kind: 'list' })
        }}
        onSubmit={(token) => reconnect.mutate({ id: stage.connectionId, token })}
      />
    )
  }

  return (
    <div className="mx-auto max-w-2xl px-5 pb-16 pt-6">
      <h1 className="text-2xl font-semibold">{CONNECTION_COPY.title}</h1>

      {stage.kind === 'done' && (
        <p
          role="status"
          className="mt-3 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
        >
          {stage.summary}
        </p>
      )}

      {connections.data !== undefined && connections.data.length === 0 && (
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
          {CONNECTION_COPY.emptyDetail}
        </p>
      )}

      <button
        type="button"
        onClick={() => setStage({ kind: 'claim' })}
        className={cn(
          'mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold',
          'bg-sky-600 text-white hover:bg-sky-500',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500',
        )}
      >
        <Plus className="size-4" aria-hidden />
        {CONNECTION_COPY.connect}
      </button>

      <ul className="mt-4 space-y-3">
        {(connections.data ?? []).map((connection) => (
          <li key={connection.id}>
            <ConnectionRow
              connection={connection}
              onReconnect={() => setStage({ kind: 'reconnect', connectionId: connection.id })}
              onSynced={refreshEverything}
            />
          </li>
        ))}
      </ul>
    </div>
  )
}

function ConnectionRow({
  connection,
  onReconnect,
  onSynced,
}: {
  connection: ConnectionSummary
  onReconnect: () => void
  onSynced: () => Promise<void>
}): ReactNode {
  const sync = useMutation({
    mutationFn: () => syncConnection(connection.id),
    onSuccess: onSynced,
  })

  const assessment = assessConnection(
    {
      status: connection.status,
      lastSuccessAt: connection.lastSuccessAt,
      // Not exposed by the list endpoint; status and age carry the verdict here.
      consecutiveFailures: connection.status === 'error' ? 3 : 0,
    },
    toIsoDate(new Date()),
  )

  const age = describeAge(
    assessment.daysSinceSuccess,
    connection.lastSuccessAt === null
      ? null
      : new Date(connection.lastSuccessAt).toLocaleDateString(),
  )

  return (
    <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">
            {connection.accountCount} account{connection.accountCount === 1 ? '' : 's'}
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            {assessment.severity !== 'ok' && (
              <span
                className={cn(
                  'size-2 shrink-0 rounded-full',
                  assessment.severity === 'attention' ? 'bg-rose-500' : 'bg-amber-500',
                )}
                aria-hidden
              />
            )}
            Last synced {age}
          </p>
        </div>

        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => sync.mutate()}
            disabled={sync.isPending}
            className={cn(
              'inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium',
              'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800',
              'focus-visible:outline-2 focus-visible:outline-sky-500 disabled:opacity-50',
            )}
          >
            <RefreshCw className={cn('size-3.5', sync.isPending && 'animate-spin')} aria-hidden />
            {sync.isPending ? CONNECTION_COPY.syncing : CONNECTION_COPY.syncNow}
          </button>

          <button
            type="button"
            onClick={onReconnect}
            className={cn(
              'min-h-9 rounded-lg border px-3 text-xs font-medium',
              'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800',
              'focus-visible:outline-2 focus-visible:outline-sky-500',
            )}
          >
            {CONNECTION_COPY.reconnect}
          </button>
        </div>
      </div>

      {/* Provider complaints are surfaced, never swallowed: they are the only warning that an
          institution behind a green-looking connection has stalled. */}
      {(connection.errors.length > 0 || sync.error !== null) && (
        <p role="status" className="mt-2 text-xs text-rose-600 dark:text-rose-400">
          {sync.error instanceof Error ? sync.error.message : connection.errors.join(' · ')}
        </p>
      )}
    </div>
  )
}

function TokenForm({
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
