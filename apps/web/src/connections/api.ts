import type { AccountType } from '@beans/shared'

/**
 * The connection endpoints, as the client sees them.
 *
 * Mirrors `apps/api/src/routes/connections.ts`. Nothing here ever receives an access URL — the
 * server does not return one, in whole or in part, and this file should never grow a field for one.
 */

export type DiscoveredAccount = {
  simplefinAccountId: string
  providerName: string
  institutionName: string | null
  currency: string | null
  /** Exactly what SimpleFIN sent, as a decimal string. */
  providerBalance: string
  /** What Beans would store, given the suggestions below. */
  interpretedBalance: string
  suggestedType: AccountType
  typeConfidence: 'high' | 'medium' | 'low'
  typeBasis: string
  /** Null when Beans declines to guess — a low-confidence type, or a zero balance. */
  suggestedSignInverted: boolean | null
  anomaly: { severity: 'blocking' | 'warning'; reason: string } | null
  alreadyLinked: boolean
  /** What is stored today. Present only for an account this connection already owns. */
  current: { type: AccountType; signInverted: boolean } | null
}

export type Discovery = {
  connectionId: string
  accounts: DiscoveredAccount[]
  errors: string[]
}

export type ConnectionSummary = {
  id: string
  status: 'healthy' | 'stale' | 'error'
  lastSuccessAt: string | null
  accountCount: number
  errors: string[]
}

/** The answers the confirmation screen collects, one per discovered account. */
export type AccountConfirmation = {
  simplefinAccountId: string
  type: AccountType
  signInverted: boolean
  include: boolean
  displayName?: string
}

export class ConnectionRequestError extends Error {
  override readonly name = 'ConnectionRequestError'
}

async function send<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init })

  if (!response.ok) {
    /*
     * The server's message is used verbatim when it has one. These are provider errors — "this
     * token has already been claimed", "the institution needs re-authentication" — and a generic
     * replacement would throw away the only actionable thing the user is going to get.
     */
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ConnectionRequestError(body?.error ?? `Request failed with ${response.status}`)
  }

  return response.status === 204 ? (undefined as T) : ((await response.json()) as T)
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

export function listConnections(): Promise<ConnectionSummary[]> {
  return send<{ connections: ConnectionSummary[] }>('/api/connections').then(
    (body) => body.connections ?? [],
  )
}

export function claimSetupToken(setupToken: string): Promise<Discovery> {
  return send<Discovery>('/api/connections', json({ setupToken }))
}

export function rediscover(connectionId: string): Promise<Omit<Discovery, 'connectionId'>> {
  return send(`/api/connections/${connectionId}/discover`)
}

export function confirmAccounts(
  connectionId: string,
  accounts: AccountConfirmation[],
): Promise<{ created: number; updated: number; synced: boolean }> {
  return send(`/api/connections/${connectionId}/confirm`, json({ accounts }))
}

export function reconnectConnection(connectionId: string, setupToken: string): Promise<void> {
  return send(`/api/connections/${connectionId}/reconnect`, json({ setupToken }))
}

export function syncConnection(connectionId: string): Promise<{
  accountsUpdated: number
  transactionsUpserted: number
  errors: string[]
}> {
  return send(`/api/connections/${connectionId}/sync`, { method: 'POST' })
}
