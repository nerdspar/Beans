/** The transfer endpoints. Mirrors `apps/api/src/routes/transfers.ts`. */

export type ProposedTransfer = {
  id: string
  pairKey: string
  /** The outflow's magnitude, as a decimal string. Both sides are equal by construction. */
  amount: string
  fromTransactionId: string
  fromAccountName: string
  fromDate: string
  toTransactionId: string
  toAccountName: string
  toDate: string
}

async function send<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Request failed with ${response.status}`)
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T)
}

export function listProposedTransfers(): Promise<ProposedTransfer[]> {
  return send<{ transfers: ProposedTransfer[] }>('/api/transfers/proposed').then(
    (body) => body.transfers ?? [],
  )
}

export function detectTransfers(): Promise<{ proposed: number }> {
  return send('/api/transfers/detect', { method: 'POST' })
}

export function resolveTransfer(id: string, decision: 'confirmed' | 'rejected'): Promise<void> {
  return send(`/api/transfers/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision }),
  })
}
