import { workingSetResponseSchema, type WorkingSetResponse } from '@beans/shared'
import { applyDelta, clearWorkingSet, readSyncState } from './db.js'

/**
 * Delta sync on open (ARCHITECTURE.md §7.2).
 *
 * One request, one question: what changed since the cursor. The answer is validated before it
 * touches the store — a malformed money string reaching IndexedDB would be parsed into a wrong
 * amount rather than an error, and would then persist across reloads.
 */

export class NotSignedInError extends Error {
  override readonly name = 'NotSignedInError'
}

export class NoHouseholdYetError extends Error {
  override readonly name = 'NoHouseholdYetError'
}

export type SyncOutcome = {
  /** True when the store was emptied and refetched from scratch. */
  wasFullResync: boolean
  accounts: number
  balances: number
  transactions: number
}

async function request(cursor: string | null): Promise<WorkingSetResponse> {
  const url = new URL('/api/working-set', window.location.origin)
  if (cursor !== null) {
    url.searchParams.set('cursor', cursor)
  }

  const response = await fetch(url, { credentials: 'same-origin' })

  if (response.status === 401) throw new NotSignedInError('Not signed in')
  if (response.status === 409) throw new NoHouseholdYetError('No household yet')
  if (!response.ok) {
    throw new Error(`Working set sync failed with ${response.status}`)
  }

  /*
   * Parsed, not cast. This is the boundary where amounts stop being someone else's strings and
   * become money — a value that fails the decimal-string shape must not be written to a store the
   * whole app then reads as truth.
   */
  return workingSetResponseSchema.parse(await response.json())
}

export async function syncWorkingSet(): Promise<SyncOutcome> {
  const { cursor } = await readSyncState()
  let response = await request(cursor)

  /*
   * The server could not prove what was deleted, so the local set may contain rows that no longer
   * exist. Merging a fresh delta into it would leave those rows in place forever — the whole point
   * of the signal is that only starting over is safe.
   */
  if (response.fullResyncRequired) {
    await clearWorkingSet()
    response = await request(null)

    await applyDelta(response)
    return {
      wasFullResync: true,
      accounts: response.accounts.length,
      balances: response.balances.length,
      transactions: response.transactions.length,
    }
  }

  await applyDelta(response)
  return {
    wasFullResync: cursor === null,
    accounts: response.accounts.length,
    balances: response.balances.length,
    transactions: response.transactions.length,
  }
}
