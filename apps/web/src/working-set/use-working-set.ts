import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'
import { SESSION_KEY } from '../auth/use-session.js'
import {
  clearWorkingSet,
  readAll,
  type StoredCategory,
  type StoredTransaction,
} from './db.js'
import { usePreferences } from '../preferences/use-preferences.js'
import { deriveWorkingSet, type DerivedWorkingSet } from './derive.js'
import { NoHouseholdYetError, NotSignedInError, syncWorkingSet } from './sync.js'

/**
 * The working set, as the screens see it.
 *
 * TanStack Query is the **in-memory view** over IndexedDB, never a second persistent cache — no
 * persister plugin, no second TTL (ARCHITECTURE.md §7.2). The query below reads the store; the sync
 * effect writes it and invalidates. That separation is what keeps one source of truth.
 */

export const WORKING_SET_KEY = ['working-set'] as const

export type WorkingSetState = {
  data: DerivedWorkingSet | null
  /** Every cached transaction, unsorted. The screens that want them do their own filtering. */
  transactions: StoredTransaction[]
  /** Transaction ids in a confirmed transfer pair (ARCHITECTURE.md §9). */
  confirmedTransferIds: ReadonlySet<string>
  /** Every category, by id. */
  categories: ReadonlyMap<string, StoredCategory>
  isLoading: boolean
  /** Signed in but not yet in a household — onboarding, not a failure. */
  needsHousehold: boolean
  needsSignIn: boolean
  error: Error | null
  /** True once the store has been read and there is genuinely nothing in it. */
  isEmpty: boolean
}

export function useWorkingSet(): WorkingSetState {
  const queryClient = useQueryClient()

  const stored: UseQueryResult<{
    accounts: unknown[]
    balances: unknown[]
    transactions: unknown[]
    confirmedTransferIds: string[]
    categories: StoredCategory[]
  }> = useQuery({
    queryKey: WORKING_SET_KEY,
    queryFn: readAll,
    // The store is local. Nothing goes stale behind our back — the sync effect invalidates when it
    // actually changes something.
    staleTime: Infinity,
  })

  const sync = useQuery({
    queryKey: ['working-set', 'sync'],
    queryFn: syncWorkingSet,
    staleTime: 60 * 1000,
    // A signed-out user and a user without a household are both settled answers, not flakes.
    retry: (count, error) =>
      error instanceof NotSignedInError || error instanceof NoHouseholdYetError ? false : count < 1,
  })

  /*
   * Re-read the store after a sync that changed something. Invalidating unconditionally would
   * re-derive on every poll, which for a large working set is real work for an identical result.
   */
  const changed =
    sync.data === undefined
      ? 0
      : sync.data.accounts + sync.data.balances + sync.data.transactions

  useEffect(() => {
    if (changed > 0) {
      void queryClient.invalidateQueries({ queryKey: WORKING_SET_KEY })
    }
  }, [changed, queryClient, sync.dataUpdatedAt])

  const { preferences } = usePreferences()

  const derived = useMemo(() => {
    if (stored.data === undefined) return null
    return deriveWorkingSet(
      stored.data.accounts as Parameters<typeof deriveWorkingSet>[0],
      stored.data.balances as Parameters<typeof deriveWorkingSet>[1],
      { showIncompleteHistory: preferences.showIncompleteHistory },
    )
  }, [stored.data, preferences.showIncompleteHistory])

  /*
   * Kept out of `deriveWorkingSet`, which builds the balance series. Transactions do not participate
   * in that and there can be a great many of them — folding them in would re-derive every account's
   * series whenever one posted.
   */
  const transactions = useMemo(
    () => (stored.data?.transactions ?? []) as StoredTransaction[],
    [stored.data],
  )

  /** Members of a confirmed transfer pair, which cash flow must not count as income or spending. */
  const confirmedTransferIds = useMemo(
    () => new Set(stored.data?.confirmedTransferIds ?? []),
    [stored.data],
  )

  const categories = useMemo(
    () => new Map((stored.data?.categories ?? []).map((category) => [category.id, category])),
    [stored.data],
  )

  const syncError = sync.error instanceof Error ? sync.error : null

  /*
   * A session that expired while the tab was open is a sign-out that nobody clicked, and §7.4 makes
   * no distinction: the decrypted working set must not outlive the session. Without this the store
   * would sit in the browser profile until the user happened to sign in and out again.
   */
  const expired = syncError instanceof NotSignedInError
  useEffect(() => {
    if (!expired) return

    void clearWorkingSet().then(() => {
      // Re-read the session so the app falls back to the sign-in screen rather than sitting on a
      // populated view it can no longer refresh.
      void queryClient.invalidateQueries({ queryKey: SESSION_KEY })
    })
  }, [expired, queryClient])

  return {
    data: derived,
    transactions,
    confirmedTransferIds,
    categories,
    // Loading only while there is nothing to show. Once the store has content, a sync in flight is
    // a background refresh and must not blank the screen the user is reading.
    isLoading: stored.isLoading || (derived === null && sync.isLoading),
    needsHousehold: syncError instanceof NoHouseholdYetError,
    needsSignIn: syncError instanceof NotSignedInError,
    error:
      syncError instanceof NoHouseholdYetError || syncError instanceof NotSignedInError
        ? null
        : syncError,
    isEmpty: derived !== null && derived.sections.length === 0 && !sync.isLoading,
  }
}
