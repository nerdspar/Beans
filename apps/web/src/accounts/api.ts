import type { AccountType } from '@beans/shared'

/** The account-management endpoints. Mirrors `apps/api/src/routes/accounts.ts`. */

export type ManagedAccount = {
  id: string
  connectionId: string | null
  institutionName: string | null
  name: string
  providerName: string | null
  mask: string | null
  type: AccountType
  taxTreatment: string
  /** Decimal string, signed as stored. Null when the account has never reported one. */
  balance: string | null
  isManual: boolean
  isClosed: boolean
  closedOn: string | null
  signInverted: boolean
  /** What deletion would take with it. */
  transactionCount: number
}

export type AccountPatch = {
  displayName?: string
  type?: AccountType
  taxTreatment?: string
  isClosed?: boolean
  /** Only read when closing. Defaults to today on the server, and clears when reopening. */
  closedOn?: string
  signInverted?: boolean
}

async function send<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Request failed with ${response.status}`)
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T)
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

export function listManagedAccounts(): Promise<ManagedAccount[]> {
  return send<{ accounts: ManagedAccount[] }>('/api/accounts').then((body) => body.accounts ?? [])
}

export function updateAccount(id: string, patch: AccountPatch): Promise<{ rebuilt: boolean }> {
  return send(`/api/accounts/${id}`, json('PATCH', patch))
}

export type ManualAccountInput = {
  name: string
  institutionName: string
  type: AccountType
  balance: string
  effectiveDate: string
  taxTreatment?: string
  /** Set when creating an account that no longer exists, so history ends on this date. */
  closedOn?: string
}

export function createManualAccount(input: ManualAccountInput): Promise<{ accountId: string }> {
  return send('/api/accounts', json('POST', input))
}

export function recordManualBalance(
  id: string,
  balance: string,
  effectiveDate: string,
): Promise<void> {
  return send(`/api/accounts/${id}/balance`, json('POST', { balance, effectiveDate }))
}

export function deleteAccount(id: string): Promise<{ transactionsDeleted: number }> {
  return send(`/api/accounts/${id}`, { method: 'DELETE' })
}
