/** Household membership and invites. Mirrors `apps/api/src/routes/households.ts`. */

export type Household = {
  id: string
  name: string
  role: 'owner' | 'member'
  members: Array<{ userId: string; role: 'owner' | 'member' }>
}

export type Invite = { id: string; email: string; expiresAt: string }

export type CreatedInvite = { link: string; expiresAt: string; emailed: boolean }

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
