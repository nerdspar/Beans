import { useQuery } from '@tanstack/react-query'
import { readImportProgress, type ImportProgress } from './api.js'

/**
 * How far the running import has got, polled while it runs.
 *
 * **Only polls while something is in flight.** An interval left running against an idle endpoint is
 * a request every half second forever, for a screen most people open twice.
 *
 * The interval is a compromise: fast enough that the count moves as work happens rather than
 * arriving in visible jumps, slow enough that it is a rounding error beside fourteen thousand row
 * inserts.
 */
const POLL_MS = 500

export function useImportProgress(isRunning: boolean): ImportProgress | null {
  const query = useQuery({
    queryKey: ['import-progress'],
    queryFn: readImportProgress,
    enabled: isRunning,
    refetchInterval: isRunning ? POLL_MS : false,
    /*
     * Never served from cache. A stale reading is worse than none: it would show the previous run's
     * final count the instant the next one starts, which reads as "already nearly done".
     */
    gcTime: 0,
    staleTime: 0,
  })

  /*
   * Nothing once the work stops.
   *
   * The last poll of a finished run and the first of the next are the same query, so returning the
   * cached value after `isRunning` goes false would leave a completed bar on screen.
   */
  return isRunning ? (query.data?.progress ?? null) : null
}
