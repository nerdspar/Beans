import {
  ACCOUNTS_COPY,
  ACCOUNT_TYPE_LABELS,
  CONNECTION_COPY,
  assessConnection,
  describeAge,
  formatCents,
  parseDecimalToCents,
} from '@beans/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Plus, RefreshCw, Upload } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { AccountEditor, ManualAccountForm, ManualBalanceForm } from '../accounts/AccountForms.js'
import { listManagedAccounts, type ManagedAccount } from '../accounts/api.js'
import { formatSyncMoment, localDaysSince } from '../accounts/display.js'
import { ConfirmAccounts } from '../connections/ConfirmAccounts.js'
import { TokenForm } from '../connections/TokenForm.js'
import {
  claimSetupToken,
  confirmAccounts,
  listConnections,
  reconnectConnection,
  rediscover,
  syncConnection,
  type AccountConfirmation,
  type ConnectionSummary,
  type Discovery,
} from '../connections/api.js'
import { setPendingImportFile } from '../import/pending-file.js'
import { cn } from '../lib/cn.js'
import { WORKING_SET_KEY } from '../working-set/use-working-set.js'
import { Link, useLocation } from 'wouter'
import { localToday } from '../lib/today.js'

/**
 * Every account, and everything you can do to one.
 *
 * There is no separate connections screen. There was, and it listed a single connection and hosted
 * three flows this page linked out to — claiming a connection, re-confirming the provider's answers,
 * and replacing a credential. A page that exists only to be bounced to is worse than the flows
 * living where the accounts are, so they are stages here.
 *
 * **A connection is not a thing anybody thinks about.** It is how some accounts arrive. Its health
 * sits at the top, once; the accounts below are grouped by institution, which is the distinction a
 * person actually makes.
 */

type Sheet =
  | { kind: 'none' }
  | { kind: 'edit'; account: ManagedAccount }
  | { kind: 'add-manual' }
  | { kind: 'update-balance'; account: ManagedAccount }

/**
 * The connection flows, which take over the whole screen rather than opening a sheet.
 *
 * Confirmation is a decision about every account behind a connection and needs the room; the token
 * forms are short but lead into it, so they read as steps of one thing.
 */
type Stage =
  | { kind: 'list' }
  | { kind: 'claim' }
  | { kind: 'confirm'; discovery: Discovery; isReview: boolean }
  | { kind: 'reconnect'; connectionId: string }

export function Accounts(): ReactNode {
  const [, navigate] = useLocation()
  const [sheet, setSheet] = useState<Sheet>({ kind: 'none' })
  const [stage, setStage] = useState<Stage>({ kind: 'list' })
  const [showClosed, setShowClosed] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: listManagedAccounts })
  const connections = useQuery({ queryKey: ['connections'], queryFn: listConnections })

  const refresh = async (): Promise<void> => {
    setSheet({ kind: 'none' })
    setStage({ kind: 'list' })
    await queryClient.invalidateQueries({ queryKey: ['accounts'] })
    await queryClient.invalidateQueries({ queryKey: ['connections'] })
    // Balances and history may both have moved, so the working set is re-read rather than patched.
    await queryClient.invalidateQueries({ queryKey: WORKING_SET_KEY })
    await queryClient.invalidateQueries({ queryKey: ['working-set'] })
  }

  const claim = useMutation({
    mutationFn: claimSetupToken,
    onSuccess: (discovery) => setStage({ kind: 'confirm', discovery, isReview: false }),
  })

  /*
   * Re-opens confirmation for a connection that already exists — the way back from a sign or a type
   * answered wrongly at setup. Discovery returns each linked account's stored configuration, so this
   * defaults to what is saved rather than re-proposing a guess over it.
   */
  const review = useMutation({
    mutationFn: async (id: string) => ({ connectionId: id, ...(await rediscover(id)) }),
    onSuccess: (discovery) => setStage({ kind: 'confirm', discovery, isReview: true }),
  })

  const confirm = useMutation({
    mutationFn: ({ id, entries }: { id: string; entries: AccountConfirmation[] }) =>
      confirmAccounts(id, entries),
    onSuccess: async (result) => {
      setDone(CONNECTION_COPY.accountsConnected(result.created, result.updated))
      await refresh()
    },
  })

  const reconnect = useMutation({
    mutationFn: ({ id, token }: { id: string; token: string }) => reconnectConnection(id, token),
    onSuccess: refresh,
  })

  if (stage.kind === 'confirm') {
    return (
      <ConfirmAccounts
        accounts={stage.discovery.accounts}
        errors={stage.discovery.errors}
        isPending={confirm.isPending}
        error={confirm.error instanceof Error ? confirm.error.message : null}
        {...(stage.isReview ? { blurb: CONNECTION_COPY.reviewBlurb } : {})}
        onConfirm={(entries) => confirm.mutate({ id: stage.discovery.connectionId, entries })}
      />
    )
  }

  if (stage.kind === 'claim' || stage.kind === 'reconnect') {
    const reconnecting = stage.kind === 'reconnect'
    const pending = reconnecting ? reconnect : claim

    return (
      <TokenForm
        title={reconnecting ? CONNECTION_COPY.reconnectTitle : CONNECTION_COPY.connectTitle}
        blurb={reconnecting ? CONNECTION_COPY.reconnectBlurb : CONNECTION_COPY.setupTokenHelp}
        action={reconnecting ? CONNECTION_COPY.reconnectAction : CONNECTION_COPY.claim}
        pendingLabel={CONNECTION_COPY.claiming}
        isPending={pending.isPending}
        error={pending.error instanceof Error ? pending.error.message : null}
        onCancel={() => {
          pending.reset()
          setStage({ kind: 'list' })
        }}
        onSubmit={(token) =>
          stage.kind === 'reconnect'
            ? reconnect.mutate({ id: stage.connectionId, token })
            : claim.mutate(token)
        }
      />
    )
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

      {done !== null && (
        <p
          role="status"
          className="mt-3 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
        >
          {done}
        </p>
      )}

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
            {/* The prominent one: with nothing connected, this is the only thing worth doing. */}
            <button
              type="button"
              onClick={() => setStage({ kind: 'claim' })}
              className={cn(
                'mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold',
                'bg-sky-600 text-white hover:bg-sky-500',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500',
              )}
            >
              <Plus className="size-4" aria-hidden />
              {CONNECTION_COPY.connect}
            </button>
          </>
        ) : (
          <ul className="mt-2 space-y-2">
            {(connections.data ?? []).map((connection) => (
              <li key={connection.id}>
                <ConnectionCard
                  connection={connection}
                  onSynced={refresh}
                  onReview={() => review.mutate(connection.id)}
                  isReviewing={review.isPending}
                  onReconnect={() => setStage({ kind: 'reconnect', connectionId: connection.id })}
                />
              </li>
            ))}
          </ul>
        )}

        {connections.data !== undefined && connections.data.length > 0 && (
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            <button
              type="button"
              onClick={() => setStage({ kind: 'claim' })}
              className="font-medium text-sky-600 hover:underline dark:text-sky-400"
            >
              {ACCOUNTS_COPY.addAnotherConnection}
            </button>{' '}
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

      {/*
        The way into importing.

        It used to be a top-level destination, which put a task most people do at the start — and
        then rarely — permanently in the navigation. It is here because this is the same job as the
        rest of the screen: getting account data into Beans. It keeps its own URL, so nothing about
        the page or a link to it changed; only where it is found.
      */}
      <section className="mt-8 rounded-xl border border-slate-200 p-4 dark:border-slate-800">
        <h2 className="text-sm font-semibold">{ACCOUNTS_COPY.importHeading}</h2>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {ACCOUNTS_COPY.importDetail}
        </p>
        {/*
          A real file input, not a link.

          It used to be a link labelled "Import a file" that led to a page with a file picker on it
          — the label promised the action and delivered a journey. Choosing the file is the first
          step of importing, so it happens on the first click, and the page opens at the mapping
          with the file already read.
        */}
        <label
          className={cn(
            'mt-3 inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm font-medium',
            'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800',
            'focus-within:outline-2 focus-within:outline-sky-500',
          )}
        >
          <Upload className="size-4" aria-hidden />
          {ACCOUNTS_COPY.importAction}
          <input
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file === undefined) return
              setPendingImportFile(file)
              navigate('/import')
            }}
          />
        </label>

        {/*
          The other reason to open that page, and the reason it cannot simply be a file dialog: it
          also lists past imports and is where an import gets undone. Quiet, because it is the
          second thing somebody wants here, but present, because nothing else reaches it.
        */}
        <Link
          href="/import"
          className={cn(
            'ml-3 text-xs font-medium text-sky-600 hover:underline dark:text-sky-400',
            'focus-visible:outline-2 focus-visible:outline-sky-500',
          )}
        >
          {ACCOUNTS_COPY.importHistoryLink}
        </Link>
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
  onReview,
  isReviewing,
  onReconnect,
}: {
  connection: ConnectionSummary
  onSynced: () => Promise<void>
  onReview: () => void
  isReviewing: boolean
  onReconnect: () => void
}): ReactNode {
  const sync = useMutation({ mutationFn: () => syncConnection(connection.id), onSuccess: onSynced })

  const assessment = assessConnection(
    {
      status: connection.status,
      lastSuccessAt: connection.lastSuccessAt,
      consecutiveFailures: connection.status === 'error' ? 3 : 0,
    },
    localToday(),
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
        {ACCOUNTS_COPY.accountsBehind(connection.accountCount)} ·{' '}
        {ACCOUNTS_COPY.lastSynced(
          describeAge(
            localDaysSince(connection.lastSuccessAt, new Date()),
            formatSyncMoment(connection.lastSuccessAt),
          ),
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

        {/* Both act on the connection, never on one account: one re-asks the provider's questions,
            the other replaces the credential. */}
        <button
          type="button"
          onClick={onReview}
          disabled={isReviewing}
          className={cn(
            'inline-flex min-h-9 items-center rounded-lg border px-3 text-xs font-medium',
            'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800',
            'focus-visible:outline-2 focus-visible:outline-sky-500 disabled:opacity-50',
          )}
        >
          {CONNECTION_COPY.review}
        </button>

        <button
          type="button"
          onClick={onReconnect}
          className={cn(
            'inline-flex min-h-9 items-center rounded-lg border px-3 text-xs font-medium',
            'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800',
            'focus-visible:outline-2 focus-visible:outline-sky-500',
          )}
        >
          {CONNECTION_COPY.reconnect}
        </button>

        {/*
          Out to the SimpleFIN server's own `/create` page.
          
          Linking a bank is the one thing that genuinely cannot happen in Beans: the protocol is
          read-only — `/info`, `/create`, `/claim`, `/accounts` — with nothing that links or unlinks
          an institution. `/create` is the protocol's own answer, a page an application sends the
          user to, so it is linked rather than explained away.
          
          `noreferrer` alongside `noopener`: the destination has no business knowing which screen of
          a private finance app sent somebody there.
        */}
        {connection.createUrl !== null && (
          <a
            href={connection.createUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              'inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium',
              'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800',
              'focus-visible:outline-2 focus-visible:outline-sky-500',
            )}
          >
            {CONNECTION_COPY.manageAtBridge}
            <ExternalLink className="size-3.5" aria-hidden />
          </a>
        )}
      </div>

      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        {CONNECTION_COPY.manageAtBridgeHelp}
      </p>
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
