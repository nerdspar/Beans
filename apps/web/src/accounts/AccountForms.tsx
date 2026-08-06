import {
  ACCOUNTS_COPY,
  ACCOUNT_TYPE_LABELS,
  ACCOUNT_TYPES,
  TAX_TREATMENTS,
  TAX_TREATMENT_LABELS,
  isLiability,
  type AccountType,
} from '@beans/shared'
import * as Dialog from '@radix-ui/react-dialog'
import { useMutation } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import { cn } from '../lib/cn.js'
import {
  createManualAccount,
  deleteAccount,
  recordManualBalance,
  updateAccount,
  type ManagedAccount,
} from './api.js'
import { localToday } from '../lib/today.js'

/**
 * The account editing sheets.
 *
 * Sheets rather than routes: each is a short edit on a list the user is already reading, and
 * navigating away and back would lose their place in it.
 */

function Sheet({
  title,
  children,
  onClose,
}: {
  title: string
  children: ReactNode
  onClose: () => void
}): ReactNode {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/40 backdrop-blur-sm" />
        <Dialog.Content
          className={cn(
            'fixed inset-x-0 bottom-0 z-50 max-h-[90dvh] overflow-y-auto rounded-t-2xl',
            'border-t border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900',
            // Portalled to the document root, so colour cannot be inherited from the shell.
            'text-slate-900 dark:text-slate-100',
            'pb-[max(1rem,env(safe-area-inset-bottom))]',
            'sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-16 sm:w-96 sm:-translate-x-1/2 sm:rounded-2xl sm:border',
          )}
        >
          <div className="flex justify-center pt-3 sm:hidden" aria-hidden>
            <div className="h-1 w-10 rounded-full bg-slate-300 dark:bg-slate-700" />
          </div>
          <Dialog.Title className="px-5 pt-3 text-base font-semibold">{title}</Dialog.Title>
          <Dialog.Description className="sr-only">{title}</Dialog.Description>
          <div className="p-5 pt-3">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

const fieldClass = cn(
  'mt-1 block min-h-11 w-full rounded-lg border px-3 text-base',
  'border-slate-300 bg-white text-slate-900',
  'dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100',
  'focus-visible:outline-2 focus-visible:outline-sky-500',
)

const labelClass = 'mt-3 block text-xs font-medium text-slate-600 dark:text-slate-400'

function Actions({
  pending,
  pendingLabel,
  label,
  disabled,
  onCancel,
}: {
  pending: boolean
  pendingLabel: string
  label: string
  disabled?: boolean
  onCancel: () => void
}): ReactNode {
  return (
    <div className="mt-5 flex gap-3">
      <button
        type="button"
        onClick={onCancel}
        className="min-h-12 flex-1 rounded-xl border border-slate-300 text-sm font-semibold hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
      >
        {ACCOUNTS_COPY.cancel}
      </button>
      <button
        type="submit"
        disabled={pending || disabled === true}
        className={cn(
          'min-h-12 flex-1 rounded-xl text-sm font-semibold',
          'bg-sky-600 text-white hover:bg-sky-500',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500',
          'disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400',
          'dark:disabled:bg-slate-800 dark:disabled:text-slate-600',
        )}
      >
        {pending ? pendingLabel : label}
      </button>
    </div>
  )
}

export function AccountEditor({
  account,
  onClose,
  onSaved,
}: {
  account: ManagedAccount
  onClose: () => void
  onSaved: () => Promise<void>
}): ReactNode {
  const [name, setName] = useState(account.name)
  const [type, setType] = useState<AccountType>(account.type)
  const [taxTreatment, setTaxTreatment] = useState(account.taxTreatment)
  const [isClosed, setIsClosed] = useState(account.isClosed)
  const [closedOn, setClosedOn] = useState(account.closedOn ?? '')
  const [signInverted, setSignInverted] = useState(account.signInverted)
  const [isShared, setIsShared] = useState(account.isShared)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const remove = useMutation({ mutationFn: () => deleteAccount(account.id), onSuccess: onSaved })

  const closeInstead = useMutation({
    mutationFn: () => updateAccount(account.id, { isClosed: true }),
    onSuccess: onSaved,
  })

  const save = useMutation({
    mutationFn: () =>
      updateAccount(account.id, {
        displayName: name.trim(),
        type,
        taxTreatment,
        isClosed,
        // Only meaningful when closing. The server clears it on reopening and defaults it to
        // today when closing without one, so an empty field is never a missing answer.
        ...(isClosed && closedOn !== '' ? { closedOn } : {}),
        // Only sent for a synced account: a manual balance is typed with the sign already decided,
        // so there is no provider convention to invert.
        ...(account.isManual ? {} : { signInverted }),
        isShared,
      }),
    onSuccess: onSaved,
  })

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (name.trim().length > 0 && !save.isPending) save.mutate()
  }

  return (
    <Sheet title={ACCOUNTS_COPY.editTitle} onClose={onClose}>
      <form onSubmit={submit}>
        <label className={labelClass}>
          {ACCOUNTS_COPY.name}
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={fieldClass}
          />
        </label>

        <label className={labelClass}>
          {ACCOUNTS_COPY.type}
          <select
            value={type}
            onChange={(event) => setType(event.target.value as AccountType)}
            className={fieldClass}
          >
            {ACCOUNT_TYPES.map((option) => (
              <option key={option} value={option}>
                {ACCOUNT_TYPE_LABELS[option]}
              </option>
            ))}
          </select>
        </label>

        {/*
          Only for investments. A checking account has no tax treatment worth choosing, and offering
          one on every account would make the portfolio split look like it applied to all of them.
        */}
        {type === 'investment' && (
          <label className={labelClass}>
            {ACCOUNTS_COPY.taxTreatment}
            <select
              value={taxTreatment}
              onChange={(event) => setTaxTreatment(event.target.value)}
              className={fieldClass}
            >
              {TAX_TREATMENTS.map((option) => (
                <option key={option} value={option}>
                  {TAX_TREATMENT_LABELS[option]}
                </option>
              ))}
            </select>
            <span className="mt-1 block font-normal text-slate-500 dark:text-slate-400">
              {ACCOUNTS_COPY.taxTreatmentHelp}
            </span>
          </label>
        )}

        {!account.isManual && (
          <label className="mt-4 flex items-start gap-2 text-xs font-medium">
            <input
              type="checkbox"
              checked={signInverted}
              onChange={(event) => setSignInverted(event.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-sky-600"
            />
            <span>
              {ACCOUNTS_COPY.signInverted}
              <span className="mt-0.5 block font-normal text-slate-500 dark:text-slate-400">
                {ACCOUNTS_COPY.signInvertedHelp}
              </span>
            </span>
          </label>
        )}

        {/*
          Sharing, offered for every account including manual ones — a private valuation is as
          reasonable a thing to want as a private brokerage.
        */}
        <label className="mt-4 flex items-start gap-2 text-xs font-medium">
          <input
            type="checkbox"
            checked={isShared}
            onChange={(event) => setIsShared(event.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-sky-600"
          />
          <span>
            {ACCOUNTS_COPY.isShared}
            <span className="mt-0.5 block font-normal text-slate-500 dark:text-slate-400">
              {ACCOUNTS_COPY.isSharedHelp}
            </span>
          </span>
        </label>

        <label className="mt-4 flex items-start gap-2 text-xs font-medium">
          <input
            type="checkbox"
            checked={isClosed}
            onChange={(event) => setIsClosed(event.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-sky-600"
          />
          {ACCOUNTS_COPY.markClosed}
        </label>

        {/*
          The date is what makes closing safe to chart. Without it there are only two behaviours and
          both are wrong: carry the last balance forward and a dead account sits in net worth
          forever, or drop the account and every past point loses money the household really had.
        */}
        {isClosed && (
          <label className="mt-3 block text-xs font-medium text-slate-600 dark:text-slate-400">
            {ACCOUNTS_COPY.closedOnLabel}
            <input
              type="date"
              value={closedOn}
              onChange={(event) => setClosedOn(event.target.value)}
              className={cn(
                'mt-1 block min-h-11 rounded-lg border px-3 text-base',
                'border-slate-300 bg-white text-slate-900',
                'dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100',
                'focus-visible:outline-2 focus-visible:outline-sky-500',
              )}
            />
            <span className="mt-1 block font-normal text-slate-500 dark:text-slate-400">
              {ACCOUNTS_COPY.closedOnHelp}
            </span>
          </label>
        )}

        <p role="alert" className="mt-2 min-h-5 text-xs text-rose-600 dark:text-rose-400">
          {save.error instanceof Error ? ACCOUNTS_COPY.saveFailed : null}
        </p>

        <Actions
          pending={save.isPending}
          pendingLabel={ACCOUNTS_COPY.saving}
          label={ACCOUNTS_COPY.save}
          disabled={name.trim().length === 0}
          onCancel={onClose}
        />
      </form>

      {/*
        Below the save action and behind a confirmation, because it is the one thing here that cannot
        be undone. Deliberately a plain text button rather than a red one until it is armed — a
        destructive control styled to draw the eye invites the press it is trying to prevent.
      */}
      <div className="mt-6 border-t border-slate-200 pt-4 dark:border-slate-800">
        {confirmingDelete ? (
          <div>
            <p className="text-sm font-semibold">{ACCOUNTS_COPY.deleteTitle}</p>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {ACCOUNTS_COPY.deleteBlurb}
            </p>
            {/* The concrete stake, so the warning is a number rather than an adjective. */}
            <p className="mt-1 text-xs font-medium">
              {ACCOUNTS_COPY.deleteCounts(account.transactionCount)}
            </p>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              {ACCOUNTS_COPY.deleteSuggestion}
            </p>

            <p role="alert" className="mt-2 min-h-4 text-xs text-rose-600 dark:text-rose-400">
              {remove.error instanceof Error ? ACCOUNTS_COPY.deleteFailed : null}
            </p>

            <div className="mt-2 flex flex-col gap-2">
              {/* The non-destructive option first and styled as the primary one. */}
              {!account.isClosed && (
                <button
                  type="button"
                  onClick={() => closeInstead.mutate()}
                  disabled={closeInstead.isPending}
                  className={cn(
                    'min-h-11 rounded-xl text-sm font-semibold',
                    'bg-sky-600 text-white hover:bg-sky-500 disabled:opacity-50',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500',
                  )}
                >
                  {ACCOUNTS_COPY.closeInstead}
                </button>
              )}

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  className="min-h-11 flex-1 rounded-xl border border-slate-300 text-sm font-semibold hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
                >
                  {ACCOUNTS_COPY.cancel}
                </button>
                <button
                  type="button"
                  onClick={() => remove.mutate()}
                  disabled={remove.isPending}
                  className={cn(
                    'min-h-11 flex-1 rounded-xl text-sm font-semibold',
                    'bg-rose-600 text-white hover:bg-rose-500 disabled:opacity-50',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600',
                  )}
                >
                  {remove.isPending ? ACCOUNTS_COPY.deleting : ACCOUNTS_COPY.deleteConfirm}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            className="text-xs font-medium text-rose-600 hover:underline dark:text-rose-400"
          >
            {ACCOUNTS_COPY.delete}
          </button>
        )}
      </div>
    </Sheet>
  )
}

/**
 * Signs the typed value for the chosen type.
 *
 * The user enters what a thing is worth or what they owe — a positive number either way, which is
 * how people say it. Storage needs it signed so it adds directly to net worth, and doing that here
 * means nobody has to type a minus sign to record a debt correctly.
 */
function signedForType(amount: string, type: AccountType): string {
  const magnitude = amount.trim().replace(/^-/, '')
  return isLiability(type) && magnitude !== '' && Number(magnitude) !== 0
    ? `-${magnitude}`
    : magnitude
}

export function ManualAccountForm({
  onClose,
  onSaved,
}: {
  onClose: () => void
  onSaved: () => Promise<void>
}): ReactNode {
  const [name, setName] = useState('')
  const [institutionName, setInstitutionName] = useState('')
  const [type, setType] = useState<AccountType>('other_asset')
  const [balance, setBalance] = useState('')
  const [effectiveDate, setEffectiveDate] = useState(localToday())

  const create = useMutation({
    mutationFn: () =>
      createManualAccount({
        name: name.trim(),
        institutionName: institutionName.trim() || name.trim(),
        type,
        balance: signedForType(balance, type),
        effectiveDate,
      }),
    onSuccess: onSaved,
  })

  const valid = name.trim().length > 0 && /^\d+(\.\d{1,2})?$/.test(balance.trim().replace(/^-/, ''))

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (valid && !create.isPending) create.mutate()
  }

  return (
    <Sheet title={ACCOUNTS_COPY.addManualTitle} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="text-sm text-slate-500 dark:text-slate-400">{ACCOUNTS_COPY.addManualBlurb}</p>

        <label className={labelClass}>
          {ACCOUNTS_COPY.name}
          <input
            type="text"
            value={name}
            placeholder={ACCOUNTS_COPY.namePlaceholder}
            onChange={(event) => setName(event.target.value)}
            className={fieldClass}
          />
        </label>

        <label className={labelClass}>
          {ACCOUNTS_COPY.institution}
          <input
            type="text"
            value={institutionName}
            placeholder="Home"
            onChange={(event) => setInstitutionName(event.target.value)}
            className={fieldClass}
          />
        </label>

        <label className={labelClass}>
          {ACCOUNTS_COPY.type}
          <select
            value={type}
            onChange={(event) => setType(event.target.value as AccountType)}
            className={fieldClass}
          >
            {ACCOUNT_TYPES.map((option) => (
              <option key={option} value={option}>
                {ACCOUNT_TYPE_LABELS[option]}
              </option>
            ))}
          </select>
        </label>

        <label className={labelClass}>
          {ACCOUNTS_COPY.balance}
          <input
            type="text"
            inputMode="decimal"
            value={balance}
            placeholder="250000.00"
            onChange={(event) => setBalance(event.target.value)}
            className={fieldClass}
          />
          <span className="mt-1 block font-normal text-slate-500 dark:text-slate-400">
            {ACCOUNTS_COPY.balanceHelp}
          </span>
        </label>

        <label className={labelClass}>
          {ACCOUNTS_COPY.asOf}
          <input
            type="date"
            value={effectiveDate}
            max={localToday()}
            onChange={(event) => setEffectiveDate(event.target.value)}
            className={fieldClass}
          />
          <span className="mt-1 block font-normal text-slate-500 dark:text-slate-400">
            {ACCOUNTS_COPY.asOfHelp}
          </span>
        </label>

        <p role="alert" className="mt-2 min-h-5 text-xs text-rose-600 dark:text-rose-400">
          {create.error instanceof Error ? ACCOUNTS_COPY.createFailed : null}
        </p>

        <Actions
          pending={create.isPending}
          pendingLabel={ACCOUNTS_COPY.creating}
          label={ACCOUNTS_COPY.create}
          disabled={!valid}
          onCancel={onClose}
        />
      </form>
    </Sheet>
  )
}

export function ManualBalanceForm({
  account,
  onClose,
  onSaved,
}: {
  account: ManagedAccount
  onClose: () => void
  onSaved: () => Promise<void>
}): ReactNode {
  const [balance, setBalance] = useState(
    account.balance === null ? '' : account.balance.replace(/^-/, ''),
  )
  const [effectiveDate, setEffectiveDate] = useState(localToday())

  const record = useMutation({
    mutationFn: () =>
      recordManualBalance(account.id, signedForType(balance, account.type), effectiveDate),
    onSuccess: onSaved,
  })

  const valid = /^\d+(\.\d{1,2})?$/.test(balance.trim())

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (valid && !record.isPending) record.mutate()
  }

  return (
    <Sheet title={ACCOUNTS_COPY.updateBalanceTitle} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {ACCOUNTS_COPY.updateBalanceBlurb}
        </p>

        <label className={labelClass}>
          {ACCOUNTS_COPY.balance}
          <input
            type="text"
            inputMode="decimal"
            value={balance}
            onChange={(event) => setBalance(event.target.value)}
            className={fieldClass}
          />
        </label>

        <label className={labelClass}>
          {ACCOUNTS_COPY.asOf}
          <input
            type="date"
            value={effectiveDate}
            max={localToday()}
            onChange={(event) => setEffectiveDate(event.target.value)}
            className={fieldClass}
          />
        </label>

        <p role="alert" className="mt-2 min-h-5 text-xs text-rose-600 dark:text-rose-400">
          {record.error instanceof Error ? ACCOUNTS_COPY.saveFailed : null}
        </p>

        <Actions
          pending={record.isPending}
          pendingLabel={ACCOUNTS_COPY.saving}
          label={ACCOUNTS_COPY.record}
          disabled={!valid}
          onCancel={onClose}
        />
      </form>
    </Sheet>
  )
}
