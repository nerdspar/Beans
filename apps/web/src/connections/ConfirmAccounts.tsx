import {
  ACCOUNT_TYPE_LABELS,
  ACCOUNT_TYPES,
  CONNECTION_COPY,
  formatCents,
  isLiability,
  parseDecimalToCents,
  type AccountType,
} from '@beans/shared'
import { AlertTriangle } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { cn } from '../lib/cn.js'
import type { AccountConfirmation, DiscoveredAccount } from './api.js'

/**
 * The confirmation step — the one screen where a silent mistake is expensive.
 *
 * **SimpleFIN never specifies balance signs.** The protocol states a sign rule for transactions and
 * none for balances, so whether a credit card arrives as `-3386.39` or `3386.39` is up to the
 * institution, and the Bridge does not normalize. Get it backwards on a card and net worth is wrong
 * by twice the balance, in a direction that looks entirely plausible — the number is large, positive
 * and labelled with a real institution.
 *
 * That is why this screen exists and why it shows **both numbers**: what SimpleFIN sent, and what
 * Beans will record. The user is being asked to adjudicate between them, which they cannot do if
 * only the answer is shown. Everything else here — type, name, inclusion — is ordinary editing.
 */

type Draft = AccountConfirmation & { key: string }

function initialDraft(account: DiscoveredAccount): Draft {
  return {
    key: account.simplefinAccountId,
    simplefinAccountId: account.simplefinAccountId,
    type: account.suggestedType,
    /*
     * Defaults to *not* inverted when Beans declines to guess. A null suggestion means low
     * confidence or a zero balance, and quietly flipping a sign nobody asked about is precisely the
     * failure this screen exists to catch.
     */
    signInverted: account.suggestedSignInverted ?? false,
    include: true,
  }
}

export function ConfirmAccounts({
  accounts,
  errors,
  isPending,
  error,
  onConfirm,
}: {
  accounts: readonly DiscoveredAccount[]
  errors: readonly string[]
  isPending: boolean
  error: string | null
  onConfirm: (confirmations: AccountConfirmation[]) => void
}): ReactNode {
  const [drafts, setDrafts] = useState<Draft[]>(() => accounts.map(initialDraft))

  const update = (key: string, patch: Partial<Draft>): void => {
    setDrafts((current) =>
      current.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)),
    )
  }

  const includedCount = drafts.filter((draft) => draft.include).length

  return (
    <div className="mx-auto max-w-2xl px-5 pb-16 pt-6">
      <h1 className="text-2xl font-semibold">{CONNECTION_COPY.confirmTitle}</h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        {CONNECTION_COPY.confirmBlurb}
      </p>

      {errors.length > 0 && (
        <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/40">
          <p className="font-semibold text-amber-900 dark:text-amber-200">
            {CONNECTION_COPY.providerErrors}
          </p>
          <ul className="mt-1 list-disc pl-5 text-amber-800 dark:text-amber-300">
            {errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      )}

      <ul className="mt-5 space-y-3">
        {accounts.map((account) => {
          const draft = drafts.find((candidate) => candidate.key === account.simplefinAccountId)
          if (draft === undefined) return null

          return (
            <li key={account.simplefinAccountId}>
              <AccountCard
                account={account}
                draft={draft}
                onChange={(patch) => update(account.simplefinAccountId, patch)}
              />
            </li>
          )
        })}
      </ul>

      <p role="alert" className="mt-3 min-h-5 text-sm text-rose-600 dark:text-rose-400">
        {error}
      </p>

      <button
        type="button"
        disabled={isPending || includedCount === 0}
        onClick={() => onConfirm(drafts.map(({ key: _key, ...rest }) => rest))}
        className={cn(
          'min-h-12 w-full rounded-xl text-sm font-semibold',
          'bg-sky-600 text-white hover:bg-sky-500',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500',
          'disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400',
          'dark:disabled:bg-slate-800 dark:disabled:text-slate-600',
        )}
      >
        {isPending ? CONNECTION_COPY.confirming : CONNECTION_COPY.confirmAction}
      </button>
    </div>
  )
}

function AccountCard({
  account,
  draft,
  onChange,
}: {
  account: DiscoveredAccount
  draft: Draft
  onChange: (patch: Partial<Draft>) => void
}): ReactNode {
  /*
   * Recomputed from the user's current answers rather than taken from `interpretedBalance`, which
   * reflects the server's *suggestion*. The whole point is that this number moves as they toggle,
   * so they can see the consequence of the choice while making it.
   */
  const magnitude = absolute(parseDecimalToCents(account.providerBalance))
  const stored = draft.signInverted ? -magnitude : magnitude
  const readsAsDebt = stored < 0n

  // A liability recorded as positive, or an asset as negative, is the shape of the bug.
  const mismatch = isLiability(draft.type) !== readsAsDebt && stored !== 0n

  return (
    <div
      className={cn(
        'rounded-xl border p-4',
        draft.include
          ? 'border-slate-200 dark:border-slate-800'
          : 'border-dashed border-slate-300 opacity-60 dark:border-slate-700',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">
            {account.institutionName ?? account.providerName}
          </p>
          <p className="truncate text-xs text-slate-500 dark:text-slate-400">
            {account.providerName}
          </p>
        </div>

        <label className="flex shrink-0 items-center gap-2 text-xs font-medium">
          <input
            type="checkbox"
            checked={draft.include}
            onChange={(event) => onChange({ include: event.target.checked })}
            className="size-4 accent-sky-600"
          />
          {CONNECTION_COPY.include}
        </label>
      </div>

      {account.alreadyLinked && (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          {CONNECTION_COPY.alreadyLinked}
        </p>
      )}

      {/*
        The two numbers, side by side. This is the comparison the screen exists to make, so it is the
        most prominent thing on the card rather than a detail underneath the controls.
      */}
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Figure label={CONNECTION_COPY.provider} value={account.providerBalance} muted />
        <Figure
          label={CONNECTION_COPY.stored}
          value={formatCents(stored)}
          caption={readsAsDebt ? CONNECTION_COPY.asDebt : CONNECTION_COPY.asAsset}
          emphasis={readsAsDebt ? 'debt' : 'asset'}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="text-xs font-medium text-slate-600 dark:text-slate-400">
          {CONNECTION_COPY.accountType}
          <select
            value={draft.type}
            onChange={(event) => onChange({ type: event.target.value as AccountType })}
            className={cn(
              'ml-2 min-h-9 rounded-lg border px-2 text-sm',
              'border-slate-300 bg-white text-slate-900',
              'dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100',
            )}
          >
            {ACCOUNT_TYPES.map((type) => (
              <option key={type} value={type}>
                {ACCOUNT_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-xs font-medium">
          <input
            type="checkbox"
            checked={draft.signInverted}
            onChange={(event) => onChange({ signInverted: event.target.checked })}
            className="size-4 accent-sky-600"
          />
          {CONNECTION_COPY.flip}
        </label>
      </div>

      {account.typeConfidence === 'low' && (
        <Warning tone="caution">{CONNECTION_COPY.lowConfidence}</Warning>
      )}

      {/*
        Computed here rather than taken from the server's `anomaly`, because it has to react to the
        toggles. The server's is about its own suggestion; this is about the user's current answer.
      */}
      {mismatch && (
        <Warning tone="attention">
          {isLiability(draft.type)
            ? `A ${ACCOUNT_TYPE_LABELS[draft.type].toLowerCase()} is money you owe, but this would be recorded as money you have.`
            : `A ${ACCOUNT_TYPE_LABELS[draft.type].toLowerCase()} is money you have, but this would be recorded as money you owe.`}
        </Warning>
      )}
    </div>
  )
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value
}

function Figure({
  label,
  value,
  caption,
  muted,
  emphasis,
}: {
  label: string
  value: string
  caption?: string
  muted?: boolean
  emphasis?: 'debt' | 'asset'
}): ReactNode {
  return (
    <div>
      <p className="text-xs text-slate-500 dark:text-slate-400">{label}</p>
      <p
        className={cn(
          'mt-0.5 text-lg font-semibold tabular-nums',
          muted === true && 'text-slate-500 dark:text-slate-400',
          emphasis === 'debt' && 'text-rose-600 dark:text-rose-400',
          emphasis === 'asset' && 'text-emerald-600 dark:text-emerald-400',
        )}
      >
        {value}
      </p>
      {caption !== undefined && (
        <p className="text-xs text-slate-500 dark:text-slate-400">{caption}</p>
      )}
    </div>
  )
}

function Warning({
  tone,
  children,
}: {
  tone: 'caution' | 'attention'
  children: ReactNode
}): ReactNode {
  return (
    <p
      className={cn(
        'mt-3 flex items-start gap-2 rounded-lg p-2.5 text-xs',
        tone === 'attention'
          ? 'bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-300'
          : 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
      )}
    >
      <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
      {children}
    </p>
  )
}
