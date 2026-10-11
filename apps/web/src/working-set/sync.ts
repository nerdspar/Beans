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
  /** Decisions arrive whole, so a change is reported as a flag rather than a count. */
  recurringDecisionsChanged: boolean
}

async function request(cursor: string | null, from?: string): Promise<WorkingSetResponse> {
  const url = new URL('/api/working-set', window.location.origin)
  if (cursor !== null) {
    url.searchParams.set('cursor', cursor)
  }
  /*
   * How far back to reach. Omitted for an ordinary sync, which gets the default window.
   *
   * Sent without a cursor when backfilling, because a delta is "what changed since X" and nothing
   * about an old balance has changed — it was simply never sent. Asking for a delta with an earlier
   * `from` would return nothing at all.
   */
  if (from !== undefined) {
    url.searchParams.set('from', from)
  }

  const response = await fetch(url, { credentials: 'same-origin' })

  if (response.status === 401) throw new NotSignedInError('Not signed in')
  if (response.status === 409) throw new NoHouseholdYetError('No household yet')

  if (!response.ok) {
    /*
     * The server's message is included when it has one. Beans is self-hosted, so the person seeing
     * this failure is also the person who can fix it — withholding what went wrong to keep the
     * screen tidy costs them the only clue they had.
     */
    const detail = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(
      detail?.error === undefined
        ? `The server answered ${response.status}.`
        : `${detail.error} (${response.status})`,
    )
  }

  /*
   * Parsed, not cast. This is the boundary where amounts stop being someone else's strings and
   * become money — a value that fails the decimal-string shape must not be written to a store the
   * whole app then reads as truth.
   */
  const parsed = workingSetResponseSchema.safeParse(await response.json())
  if (!parsed.success) {
    /*
     * Names the first offending field. A response that is well-formed JSON but the wrong shape is
     * the hardest failure to diagnose from the outside — "expected string, received date at
     * balances.0.asOfDate" points straight at the cause, where "could not load" points nowhere.
     */
    const first = parsed.error.issues[0]
    throw new Error(
      first === undefined
        ? 'The server sent something Beans could not read.'
        : `Unexpected data from the server: ${first.message} at ${first.path.join('.') || 'the response root'}.`,
    )
  }

  return parsed.data
}

export async function syncWorkingSet(): Promise<SyncOutcome> {
  const { cursor, householdId } = await readSyncState()
  let response = await request(cursor)

  /*
   * The cache belongs to somebody else.
   *
   * Sign-out clears the store, so in the ordinary case this never fires. It exists for the cases
   * where sign-out did not happen — a failed request, a tab closed mid-flight, a cookie that expired
   * and a different person signing in on the same device. Syncing a delta on top of the previous
   * household's rows would merge two people's finances into one net worth, and nothing downstream
   * would notice.
   */
  if (householdId !== null && householdId !== response.householdId) {
    await clearWorkingSet()
    response = await request(null)
  }

  /*
   * The server could not prove what was deleted, so the local set may contain rows that no longer
   * exist. Merging a fresh delta into it would leave those rows in place forever — the whole point
   * of the signal is that only starting over is safe.
   */
  if (response.fullResyncRequired) {
    await clearWorkingSet()
    response = await request(null)

    const applied = await applyDelta(response)
    return {
      wasFullResync: true,
      accounts: response.accounts.length,
      balances: response.balances.length,
      transactions: response.transactions.length,
      recurringDecisionsChanged: applied.recurringDecisionsChanged,
    }
  }

  const applied = await applyDelta(response)
  return {
    wasFullResync: cursor === null,
    accounts: response.accounts.length,
    balances: response.balances.length,
    transactions: response.transactions.length,
    recurringDecisionsChanged: applied.recurringDecisionsChanged,
  }
}

/**
 * Fetches history older than the cache currently holds.
 *
 * The working set carries about two years by default, because eager-loading a decade across forty
 * accounts is tens of megabytes on a phone (ARCHITECTURE.md §7.2). The design always said older
 * data would be "fetched on demand when the user extends the range past it" — this is that, and
 * without it selecting a custom range reaching back further simply drew nothing, with no
 * explanation, because the client had nothing to draw.
 *
 * **A full read, not a delta.** Deltas answer "what changed since X", and nothing about a 2019
 * balance has changed — it was never sent. So this asks with `from` and no cursor, and lets the
 * upsert absorb the rows it already has.
 *
 * Deliberately does not move the stored cursor. This request is about *widening* the window, and a
 * cursor written from it would be indistinguishable from an ordinary sync having happened.
 */
export async function backfillWorkingSet(from: string): Promise<SyncOutcome> {
  const response = await request(null, from)

  const applied = await applyDelta(response, { keepCursor: true })

  return {
    wasFullResync: false,
    accounts: response.accounts.length,
    balances: response.balances.length,
    transactions: response.transactions.length,
    recurringDecisionsChanged: applied.recurringDecisionsChanged,
  }
}
