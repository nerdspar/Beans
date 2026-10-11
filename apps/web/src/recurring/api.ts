import type { RecurringDecision } from '@beans/shared'

/** The recurring-decision endpoints. Mirrors `apps/api/src/routes/recurring.ts`. */

async function send(path: string, init: RequestInit): Promise<void> {
  const response = await fetch(path, { credentials: 'same-origin', ...init })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Request failed with ${response.status}`)
  }
}

export function setRecurringDecision(input: {
  merchantKey: string
  decision: RecurringDecision
  accountId: string
}): Promise<void> {
  return send('/api/recurring-decisions', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function clearRecurringDecision(id: string): Promise<void> {
  return send(`/api/recurring-decisions/${id}`, { method: 'DELETE' })
}
