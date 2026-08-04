/** Household membership and invites. Mirrors `apps/api/src/routes/households.ts`. */

export type Household = {
  id: string
  name: string
  role: 'owner' | 'member'
  members: Array<{ userId: string; role: 'owner' | 'member' }>
}

export type Invite = { id: string; email: string; expiresAt: string }

export type CreatedInvite = {
  link: string
  expiresAt: string
  emailed: boolean
  /** Why it was or was not emailed. `emailed` is kept only for older clients. */
  delivery: 'sent' | 'not-configured' | 'failed' | 'no-address'
}

async function send<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Request failed with ${response.status}`)
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T)
}

export function getHousehold(): Promise<Household> {
  return send('/api/households/me')
}

export function listInvites(): Promise<Invite[]> {
  return send<{ invites: Invite[] }>('/api/households/invites').then((b) => b.invites ?? [])
}

export function createInvite(email: string): Promise<CreatedInvite> {
  return send('/api/households/invites', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  })
}

export function revokeInvite(id: string): Promise<void> {
  return send(`/api/households/invites/${id}`, { method: 'DELETE' })
}

export function joinHousehold(token: string): Promise<{ householdId: string }> {
  return send('/api/households/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
}

export function renameHousehold(name: string): Promise<{ name: string }> {
  return send('/api/households/me', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

/**
 * Creates the household a signed-in user does not yet have.
 *
 * Deduplicated by a module-level promise. React StrictMode invokes effects twice in development,
 * and two concurrent creates would race: the second violates `unique(user_id)` on
 * household_members and surfaces as a failure over a household that had just been created
 * successfully.
 */
let creating: Promise<void> | null = null

export function ensureHousehold(name: string): Promise<void> {
  creating ??= send<unknown>('/api/households', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then(() => undefined)

  return creating
}
