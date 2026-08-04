import { HOUSEHOLD_COPY, NET_WORTH_STATE_COPY } from '@beans/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, Trash2 } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import {
  createInvite,
  getHousehold,
  listInvites,
  renameHousehold,
  revokeInvite,
  type CreatedInvite,
} from '../household/api.js'
import { useSession } from '../auth/use-session.js'
import { cn } from '../lib/cn.js'

/**
 * Who shares this household, and how to add someone.
 *
 * Inviting is the one action in Beans whose effect reaches another person, and it is irreversible in
 * the sense that matters: once somebody has seen the balances, revoking the invite does not unsee
 * them. The copy says what joining exposes rather than leaving it to be discovered.
 */

export function Household(): ReactNode {
  const queryClient = useQueryClient()
  const session = useSession()

  const household = useQuery({ queryKey: ['household'], queryFn: getHousehold })
  const invites = useQuery({ queryKey: ['invites'], queryFn: listInvites })

  const [name, setName] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [created, setCreated] = useState<CreatedInvite | null>(null)
  const [copied, setCopied] = useState(false)

  const invite = useMutation({
    mutationFn: () => createInvite(email.trim()),
    onSuccess: async (result) => {
      setCreated(result)
      setEmail('')
      await queryClient.invalidateQueries({ queryKey: ['invites'] })
    },
  })

  const rename = useMutation({
    mutationFn: (next: string) => renameHousehold(next),
    onSuccess: async () => {
      setName(null)
      await queryClient.invalidateQueries({ queryKey: ['household'] })
    },
  })

  const revoke = useMutation({
    mutationFn: revokeInvite,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invites'] }),
  })

  if (household.isLoading) {
    return <p className="p-6 text-sm text-slate-500">{HOUSEHOLD_COPY.loading}</p>
  }

  if (household.error instanceof Error) {
    return (
      <div className="mx-auto max-w-2xl px-5 py-16 text-center">
        <p className="text-base font-medium">{NET_WORTH_STATE_COPY.failed}</p>
        <p className="mt-2 font-mono text-xs text-slate-500">{household.error.message}</p>
      </div>
    )
  }

  const isOwner = household.data?.role === 'owner'

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (email.trim().length > 0 && !invite.isPending) invite.mutate()
  }

  return (
    <div className="mx-auto max-w-2xl px-5 pb-16 pt-5">
      <h1 className="text-2xl font-semibold">{household.data?.name ?? HOUSEHOLD_COPY.title}</h1>

      {/*
        Renaming lives here because the name is no longer asked for at sign-up — a household of one
        needs no name, and the moment it starts to matter is the moment somebody else will see it.
        Owners only: a member renaming the household under everyone else is not their call.
      */}
      {isOwner && (
        <form
          className="mt-3 flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            const next = (name ?? '').trim()
            if (next.length > 0 && !rename.isPending) rename.mutate(next)
          }}
        >
          <label className="min-w-0 flex-1 text-xs font-medium text-slate-600 dark:text-slate-400">
            {HOUSEHOLD_COPY.nameHeading}
            <input
              type="text"
              value={name ?? household.data?.name ?? ''}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
              className={cn(
                'mt-1 block min-h-11 w-full rounded-lg border px-3 text-base',
                'border-slate-300 bg-white text-slate-900',
                'dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100',
                'focus-visible:outline-2 focus-visible:outline-sky-500',
              )}
            />
          </label>
          <button
            type="submit"
            disabled={rename.isPending || (name ?? '').trim().length === 0}
            className={cn(
              'min-h-11 shrink-0 rounded-lg border px-4 text-sm font-medium',
              'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800',
              'focus-visible:outline-2 focus-visible:outline-sky-500 disabled:opacity-50',
            )}
          >
            {rename.isPending ? HOUSEHOLD_COPY.nameSaving : HOUSEHOLD_COPY.nameSave}
          </button>
        </form>
      )}

      <p className="mt-1 min-h-4 text-xs text-slate-500 dark:text-slate-400">
        {rename.error instanceof Error ? (
          <span className="text-rose-600 dark:text-rose-400">{HOUSEHOLD_COPY.nameFailed}</span>
        ) : (
          isOwner && HOUSEHOLD_COPY.nameHelp
        )}
      </p>

      <h2 className="mt-6 text-sm font-semibold">{HOUSEHOLD_COPY.membersHeading}</h2>
      <ul className="mt-2 divide-y divide-slate-200 dark:divide-slate-800">
        {(household.data?.members ?? []).map((member) => (
          <li key={member.userId} className="flex items-center justify-between gap-3 py-3 text-sm">
            <span className="truncate">
              {/*
                The member list carries user ids, not emails — the household endpoint deliberately
                does not expose other people's addresses. Marking yourself is the useful distinction.
              */}
              {member.userId === session.user?.id ? HOUSEHOLD_COPY.you : member.userId.slice(0, 8)}
            </span>
            <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
              {member.role === 'owner' ? HOUSEHOLD_COPY.owner : HOUSEHOLD_COPY.member}
            </span>
          </li>
        ))}
      </ul>

      <h2 className="mt-8 text-sm font-semibold">{HOUSEHOLD_COPY.inviteHeading}</h2>

      {!isOwner ? (
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          {HOUSEHOLD_COPY.ownerOnly}
        </p>
      ) : (
        <>
          {/* Stated before the field, not after the fact. */}
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {HOUSEHOLD_COPY.inviteBlurb}
          </p>

          <form className="mt-3 flex gap-2" onSubmit={submit}>
            <label className="flex-1">
              <span className="sr-only">{HOUSEHOLD_COPY.inviteEmail}</span>
              <input
                type="email"
                value={email}
                placeholder={HOUSEHOLD_COPY.inviteEmail}
                onChange={(event) => setEmail(event.target.value)}
                className={cn(
                  'min-h-11 w-full rounded-lg border px-3 text-base',
                  'border-slate-300 bg-white text-slate-900',
                  'dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100',
                  'focus-visible:outline-2 focus-visible:outline-sky-500',
                )}
              />
            </label>
            <button
              type="submit"
              disabled={email.trim().length === 0 || invite.isPending}
              className={cn(
                'min-h-11 shrink-0 rounded-lg px-4 text-sm font-semibold',
                'bg-sky-600 text-white hover:bg-sky-500 disabled:opacity-50',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500',
              )}
            >
              {invite.isPending ? HOUSEHOLD_COPY.inviteSending : HOUSEHOLD_COPY.inviteSend}
            </button>
          </form>

          <p role="alert" className="mt-2 min-h-4 text-xs text-rose-600 dark:text-rose-400">
            {invite.error instanceof Error ? invite.error.message : null}
          </p>

          {created !== null && (
            <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
              <p className="text-xs font-medium">{HOUSEHOLD_COPY.inviteLink}</p>
              <p className="mt-1 break-all font-mono text-xs text-slate-600 dark:text-slate-300">
                {created.link}
              </p>
              <div className="mt-2 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(created.link).then(() => setCopied(true))
                  }}
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-300 px-3 text-xs font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
                >
                  {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
                  {copied ? HOUSEHOLD_COPY.copied : HOUSEHOLD_COPY.copy}
                </button>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {HOUSEHOLD_COPY.inviteDelivery[created.delivery]}
                </span>
              </div>
            </div>
          )}

          <h2 className="mt-8 text-sm font-semibold">{HOUSEHOLD_COPY.pendingHeading}</h2>
          {(invites.data ?? []).length === 0 ? (
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              {HOUSEHOLD_COPY.pendingNone}
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-200 dark:divide-slate-800">
              {(invites.data ?? []).map((pending) => (
                <li key={pending.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm">{pending.email}</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {HOUSEHOLD_COPY.expires} {new Date(pending.expiresAt).toLocaleDateString()}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => revoke.mutate(pending.id)}
                    disabled={revoke.isPending}
                    aria-label={`${HOUSEHOLD_COPY.revoke}: ${pending.email}`}
                    className="shrink-0 rounded-lg border border-slate-300 p-2 hover:bg-rose-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-rose-950/40"
                  >
                    <Trash2 className="size-4 text-rose-600 dark:text-rose-400" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
