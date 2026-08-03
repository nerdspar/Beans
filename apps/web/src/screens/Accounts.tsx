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

  /*
   * Grouped by institution, not by connection. One connection covers every institution in a Bridge
   * account, so grouping by it produces a single bucket containing everything — which tells the user
   * nothing. The institution is the distinction they actually make.
   */
  const byInstitution = new Map<string, ManagedAccount[]>()
  for (const account of visible) {
    if (account.isManual) continue
    const key = account.institutionName ?? 'Other'
    byInstitution.set(key, [...(byInstitution.get(key) ?? []), account])
  }

  const institutions = [...byInstitution.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )

  return (
    <div className="mx-auto max-w-2xl px-5 pb-16 pt-6">
      <h1 className="text-2xl font-semibold">{ACCOUNTS_COPY.title}</h1>

      {accounts.data !== undefined && all.length === 0 && (
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          {ACCOUNTS_COPY.emptyDetail}
        </p>
      )}

      {/*
        Connection status once, at the top — not repeated per group.
        
        A SimpleFIN Bridge account is a single connection covering every institution linked inside
        it, so "sync" and "review" are things you do to *the connection*, and rendering them beside
        each institution implied they were per-institution. A second connection exists only for a
        second household member with their own Bridge account, which is why adding one is a quiet
        link rather than a primary action.
      */}
      <section className="mt-5">
        <h2 className="text-sm font-semibold">{ACCOUNTS_COPY.connectionHeading}</h2>

        {connections.data !== undefined && connections.data.length === 0 ? (
          <>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {ACCOUNTS_COPY.notConnectedDetail}
            </p>
            <Link
              href="/connections"
              className={cn(
                'mt-3 flex min-h-12 items-center justify-center gap-2 rounded-xl text-sm font-semibold',
                'bg-sky-600 text-white hover:bg-sky-500',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500',
              )}
            >
              <Plus className="size-4" aria-hidden />
              {CONNECTION_COPY.connect}
            </Link>
          </>
        ) : (
          <ul className="mt-2 space-y-2">
            {(connections.data ?? []).map((connection) => (
              <li key={connection.id}>
                <ConnectionCard connection={connection} onSynced={refresh} />
              </li>
            ))}
          </ul>
        )}

        {connections.data !== undefined && connections.data.length > 0 && (
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            <Link href="/connections" className="font-medium text-sky-600 dark:text-sky-400">
              {ACCOUNTS_COPY.addAnotherConnection}
            </Link>{' '}
            {ACCOUNTS_COPY.addAnotherHelp}
          </p>
        )}
      </section>

      {institutions.map(([institution, group]) => (
        <section key={institution} className="mt-6">
          <h2 className="text-sm font-semibold">{institution}</h2>
          <ul className="mt-1 divide-y divide-slate-200 dark:divide-slate-800">
            {group.map((account) => (
              <AccountRow
                key={account.id}
                account={account}
                onEdit={() => setSheet({ kind: 'edit', account })}
              />
            ))}
          </ul>
        </section>
      ))}

      <section className="mt-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">{ACCOUNTS_COPY.manualGroup}</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {ACCOUNTS_COPY.manualGroupDetail}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setSheet({ kind: 'add-manual' })}
            className={cn(
              'shrink-0 rounded-lg border px-3 py-2 text-xs font-medium',
              'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800',
              'focus-visible:outline-2 focus-visible:outline-sky-500',
            )}
          >
            {ACCOUNTS_COPY.addManual}
          </button>
        </div>

        {manual.length > 0 && (
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
        )}
      </section>

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

/**
 * One SimpleFIN connection: its health, and the three things you can do to it.
 *
 * `Sync now` and `Review accounts` act on the **connection**, never on a single account — which is
 * exactly why they live here rather than beside each institution, where their scope was misread.
 */
function ConnectionCard({
  connection,
  onSynced,
}: {
  connection: ConnectionSummary
  onSynced: () => Promise<void>
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

  return (
    <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
      <div className="flex items-center gap-2">
        {assessment.severity !== 'ok' && (
          <span
            className={cn(
              'size-2 shrink-0 rounded-full',
              assessment.severity === 'attention' ? 'bg-rose-500' : 'bg-amber-500',
            )}
            aria-hidden
          />
        )}
        <p className="text-sm font-medium">{ACCOUNTS_COPY.connected}</p>
      </div>

      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
        {ACCOUNTS_COPY.accountsBehind(connection.accountCount)} · last synced{' '}
        {describeAge(
          assessment.daysSinceSuccess,
          connection.lastSuccessAt === null
            ? null
            : new Date(connection.lastSuccessAt).toLocaleDateString(),
        )}
      </p>

      {connection.errors.length > 0 && (
        <p role="status" className="mt-2 text-xs text-rose-600 dark:text-rose-400">
          {connection.errors.join(' · ')}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
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

        {/* Both live on the connections screen: one re-asks the provider's questions, the other
            replaces the credential. Neither is about an individual account. */}
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

        <Link
          href="/connections"
          className={cn(
            'inline-flex min-h-9 items-center rounded-lg border px-3 text-xs font-medium',
            'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800',
            'focus-visible:outline-2 focus-visible:outline-sky-500',
          )}
        >
          {CONNECTION_COPY.reconnect}
        </Link>
      </div>
    </div>
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
