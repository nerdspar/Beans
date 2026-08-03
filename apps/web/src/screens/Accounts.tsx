import {
  ACCOUNTS_COPY,
  ACCOUNT_TYPE_LABELS,
  CONNECTION_COPY,
  assessConnection,
  describeAge,
  formatCents,
  parseDecimalToCents,
  toIsoDate,
} from '@beans/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, RefreshCw } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { AccountEditor, ManualAccountForm, ManualBalanceForm } from '../accounts/AccountForms.js'
import { listManagedAccounts, type ManagedAccount } from '../accounts/api.js'
import {
  listConnections,
  syncConnection,
  type ConnectionSummary,
} from '../connections/api.js'
import { cn } from '../lib/cn.js'
import { WORKING_SET_KEY } from '../working-set/use-working-set.js'
import { Link } from 'wouter'

/**
 * Every account, grouped by where it comes from.
 *
 * Replaces a separate connections page that listed one connection and was otherwise empty. **A
 * connection is not a thing anybody thinks about** — it is how some accounts arrive. Grouping by it
 * puts sync health beside the accounts it affects, which is where it is actionable, and gives manual
 * accounts an obvious home as just another group.
 */

type Sheet =
  | { kind: 'none' }
  | { kind: 'edit'; account: ManagedAccount }
  | { kind: 'add-manual' }
  | { kind: 'update-balance'; account: ManagedAccount }

export function Accounts(): ReactNode {
  const [sheet, setSheet] = useState<Sheet>({ kind: 'none' })
  const [showClosed, setShowClosed] = useState(false)
  const queryClient = useQueryClient()

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: listManagedAccounts })
  const connections = useQuery({ queryKey: ['connections'], queryFn: listConnections })

  const refresh = async (): Promise<void> => {
    setSheet({ kind: 'none' })
    await queryClient.invalidateQueries({ queryKey: ['accounts'] })
    await queryClient.invalidateQueries({ queryKey: ['connections'] })
    // Balances and history may both have moved, so the working set is re-read rather than patched.
    await queryClient.invalidateQueries({ queryKey: WORKING_SET_KEY })
    await queryClient.invalidateQueries({ queryKey: ['working-set'] })
  }

  const all = accounts.data ?? []
  const visible = showClosed ? all : all.filter((account) => !account.isClosed)
  const hasClosed = all.some((account) => account.isClosed)

  const manual = visible.filter((account) => account.isManual)
  const byConnection = new Map<string, ManagedAccount[]>()
  for (const account of visible) {
    if (account.isManual || account.connectionId === null) continue
    byConnection.set(account.connectionId, [
      ...(byConnection.get(account.connectionId) ?? []),
      account,
    ])
  }

  return (
    <div className="mx-auto max-w-2xl px-5 pb-16 pt-6">
      <h1 className="text-2xl font-semibold">{ACCOUNTS_COPY.title}</h1>

      {accounts.data !== undefined && all.length === 0 && (
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          {ACCOUNTS_COPY.emptyDetail}
        </p>
      )}

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <Link
          href="/connections"
          className={cn(
            'flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl text-sm font-semibold',
            'bg-sky-600 text-white hover:bg-sky-500',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500',
          )}
        >
          <Plus className="size-4" aria-hidden />
          {CONNECTION_COPY.connect}
        </Link>

        <button
          type="button"
          onClick={() => setSheet({ kind: 'add-manual' })}
          className={cn(
            'flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl border text-sm font-semibold',
            'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800',
            'focus-visible:outline-2 focus-visible:outline-sky-500',
          )}
        >
          <Plus className="size-4" aria-hidden />
          {ACCOUNTS_COPY.addManual}
        </button>
      </div>

      {(connections.data ?? []).map((connection) => {
        const group = byConnection.get(connection.id) ?? []
        if (group.length === 0) return null

        return (
          <ConnectionGroup
            key={connection.id}
            connection={connection}
            accounts={group}
            onSynced={refresh}
            onEdit={(account) => setSheet({ kind: 'edit', account })}
          />
        )
      })}

      {manual.length > 0 && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold">{ACCOUNTS_COPY.manualGroup}</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {ACCOUNTS_COPY.manualGroupDetail}
          </p>

          <ul className="mt-2 divide-y divide-slate-200 dark:divide-slate-800">
            {manual.map((account) => (
              <AccountRow
                key={account.id}
                account={account}
                onEdit={() => setSheet({ kind: 'edit', account })}
                onUpdateBalance={() => setSheet({ kind: 'update-balance', account })}
              />
            ))}
          </ul>
        </section>
      )}

      {hasClosed && (
        <label className="mt-6 flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
          <input
            type="checkbox"
            checked={showClosed}
            onChange={(event) => setShowClosed(event.target.checked)}
            className="size-4 accent-sky-600"
          />
          {ACCOUNTS_COPY.showClosed}
        </label>
      )}

      {sheet.kind === 'edit' && (
        <AccountEditor
          account={sheet.account}
          onClose={() => setSheet({ kind: 'none' })}
          onSaved={refresh}
        />
      )}
      {sheet.kind === 'add-manual' && (
        <ManualAccountForm onClose={() => setSheet({ kind: 'none' })} onSaved={refresh} />
      )}
      {sheet.kind === 'update-balance' && (
        <ManualBalanceForm
          account={sheet.account}
          onClose={() => setSheet({ kind: 'none' })}
          onSaved={refresh}
        />
      )}
    </div>
  )
}

function ConnectionGroup({
  connection,
  accounts,
  onSynced,
  onEdit,
}: {
  connection: ConnectionSummary
  accounts: readonly ManagedAccount[]
  onSynced: () => Promise<void>
  onEdit: (account: ManagedAccount) => void
}): ReactNode {
  const sync = useMutation({ mutationFn: () => syncConnection(connection.id), onSuccess: onSynced })

  const assessment = assessConnection(
    {
      status: connection.status,
      lastSuccessAt: connection.lastSuccessAt,
      consecutiveFailures: connection.status === 'error' ? 3 : 0,
    },
    toIsoDate(new Date()),
  )

  // The institution name is on the accounts, not the connection — one connection can span several.
  const institutions = [...new Set(accounts.map((account) => account.institutionName ?? ''))]
    .filter((name) => name.length > 0)
    .join(', ')

  return (
    <section className="mt-6">
      {/*
        Stacked at phone width. Side by side, two buttons squeeze the institution name down to
        "Bank of Am…" — and the name is what tells the user which connection they are acting on, so
        it is the one thing that must not be the part that gives way.
      */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">{institutions || 'Connected'}</h2>
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
            Last synced{' '}
            {describeAge(
              assessment.daysSinceSuccess,
              connection.lastSuccessAt === null
                ? null
                : new Date(connection.lastSuccessAt).toLocaleDateString(),
            )}
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

          {/* Reconnect and re-confirmation stay on the connections screen: both are about the
              credential and the provider's answers, not about one account. */}
          <Link
            href="/connections"
            className={cn(
              'inline-flex min-h-9 items-center rounded-lg border px-3 text-xs font-medium',
              'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800',
              'focus-visible:outline-2 focus-visible:outline-sky-500',
            )}
          >
            {CONNECTION_COPY.review}
          </Link>
        </div>
      </div>

      <ul className="mt-2 divide-y divide-slate-200 dark:divide-slate-800">
        {accounts.map((account) => (
          <AccountRow key={account.id} account={account} onEdit={() => onEdit(account)} />
        ))}
      </ul>
    </section>
  )
}

function AccountRow({
  account,
  onEdit,
  onUpdateBalance,
}: {
  account: ManagedAccount
  onEdit: () => void
  onUpdateBalance?: () => void
}): ReactNode {
  return (
    <li className="flex items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">
          {account.name}
          {account.mask !== null && (
            <span className="text-slate-500 dark:text-slate-400"> · {account.mask}</span>
          )}
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {ACCOUNT_TYPE_LABELS[account.type]}
          {account.isClosed && ` · ${ACCOUNTS_COPY.closed}`}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <span className="text-sm font-medium tabular-nums">
          {account.balance === null ? '—' : formatCents(parseDecimalToCents(account.balance))}
        </span>

        {onUpdateBalance !== undefined && (
          <button
            type="button"
            onClick={onUpdateBalance}
            className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            {ACCOUNTS_COPY.updateBalance}
          </button>
        )}

        <button
          type="button"
          onClick={onEdit}
          className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-sky-500 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          {ACCOUNTS_COPY.edit}
        </button>
      </div>
    </li>
  )
}
