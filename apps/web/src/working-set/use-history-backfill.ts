import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { readSyncState } from './db.js'
import { backfillWorkingSet } from './sync.js'
import { WORKING_SET_KEY } from './use-working-set.js'

/**
 * Fetches history older than the cache holds, when a range asks for it.
 *
 * The working set carries about two years by default: eager-loading a decade across forty accounts
 * is tens of megabytes on a phone, which is the wrong default for the screens people actually open
 * (ARCHITECTURE.md §7.2). The design always said the rest would be fetched on demand — this is that.
 *
 * Without it, selecting a custom range reaching back to 2019 drew nothing before the window and gave
 * no reason why. The data existed on the server and the chart was simply empty, which reads as
 * missing history rather than as unfetched history.
 *
 * Triggered by the range rather than by a button, because "load more" is a question about the
 * client's cache and the reader is asking a question about their money.
 */
export function useHistoryBackfill(windowStart: string | undefined): {
  isLoading: boolean
  error: Error | null
} {
  const queryClient = useQueryClient()

  /** What the cache currently reaches back to. Null until it has ever synced. */
  const state = useQuery({
    queryKey: ['working-set', 'coverage'],
    queryFn: readSyncState,
    staleTime: 5 * 1000,
  })

  const coverageFrom = state.data?.coverageFrom ?? null

  const backfill = useMutation({
    mutationFn: backfillWorkingSet,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['working-set', 'coverage'] })
      await queryClient.invalidateQueries({ queryKey: WORKING_SET_KEY })
    },
  })

  /*
   * Only when the range genuinely starts earlier than what is held.
   *
   * `coverageFrom` only ever moves earlier (see `applyDelta`), so once a range has been fetched,
   * revisiting it is free — and a range inside the window never fires this at all.
   */
  const needed =
    windowStart !== undefined && coverageFrom !== null && windowStart < coverageFrom
      ? windowStart
      : null

  const { mutate, isPending } = backfill

  useEffect(() => {
    // Guarded on `isPending` as well as on the target: without it, the invalidation this triggers
    // re-runs the effect while the request is still in flight and starts a second one.
    if (needed !== null && !isPending) {
      mutate(needed)
    }
  }, [needed, isPending, mutate])

  return {
    isLoading: backfill.isPending,
    error: backfill.error instanceof Error ? backfill.error : null,
  }
}
